-- Conferência de isolamento entre empresas no Firma Viva (incidente de 19/11/2026).
-- Recebe a tabela temporária "mapa" (pessoa do Cenário → número da empresa dela), montada antes
-- deste arquivo com os dados do Cenário, e a variável psql "modo" (conferir | corrigir).
-- Só lê, a não ser em "corrigir": aí tira da organização quem é de OUTRA empresa (a conta, o
-- histórico e a auditoria ficam; só o acesso à organização errada sai).
\pset footer off
\pset null '-'

-- Empresa do Cenário de cada organização: a da pessoa que criou a organização.
CREATE TEMP TABLE org_empresa AS
SELECT o.id AS org_id, o.name AS organizacao,
  (SELECT m.cid FROM cenario_logins l JOIN mapa m ON m.cuid = l.cenario_user_id
    WHERE l.user_id = o.created_by_id ORDER BY l.created_at LIMIT 1) AS empresa
FROM organizations o;

-- Membros que só entraram pelo Cenário com contas de OUTRA empresa.
CREATE TEMP TABLE intrusos AS
SELECT oe.org_id, oe.organizacao, oe.empresa, ms.user_id, ms.role AS papel, u.name AS nome,
  u.email, max(m.cid) AS empresa_da_pessoa, min(l.created_at) AS desde
FROM org_empresa oe
JOIN memberships ms ON ms.org_id = oe.org_id
JOIN users u ON u.id = ms.user_id
JOIN cenario_logins l ON l.user_id = ms.user_id
JOIN mapa m ON m.cuid = l.cenario_user_id
WHERE oe.empresa IS NOT NULL
GROUP BY 1, 2, 3, 4, 5, 6, 7
HAVING bool_and(m.cid <> oe.empresa);

\echo
\echo '== Organizações do jogo e a empresa do Cenário de cada uma'
SELECT oe.organizacao, oe.empresa AS "empresa nº", c.status AS conexao,
  (SELECT count(*) FROM memberships x WHERE x.org_id = oe.org_id) AS membros
FROM org_empresa oe LEFT JOIN cenario_connections c ON c.org_id = oe.org_id
ORDER BY oe.empresa NULLS LAST, oe.organizacao;

\echo
\echo '== Pessoas de OUTRA empresa dentro de uma organização (deveria estar vazio)'
SELECT organizacao, empresa AS "empresa nº", nome, email, papel,
  empresa_da_pessoa AS "é da empresa nº", to_char(desde AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI') AS "entrou em"
FROM intrusos ORDER BY desde;

\echo
\echo '== O que essas pessoas fizeram no jogo (auditoria do Firma Viva)'
SELECT to_char(a.created_at AT TIME ZONE 'America/Sao_Paulo', 'DD/MM HH24:MI') AS quando, i.nome, a.action AS acao, a.summary AS resumo
FROM audit_logs a JOIN intrusos i ON a.user_id = i.user_id AND a.org_id = i.org_id
ORDER BY a.created_at LIMIT 200;

-- Para a conferência do lado do Cenário (linhas "DESDE empresa data").
\pset tuples_only on
SELECT 'DESDE ' || empresa || ' ' || to_char(min(desde), 'YYYY-MM-DD"T"HH24:MI:SS"Z"') FROM intrusos GROUP BY empresa;
\pset tuples_only off

\if :{?modo}
\else
\set modo conferir
\endif
SELECT :'modo' = 'corrigir' AS corrigir \gset
\if :corrigir
BEGIN;
UPDATE sessions s SET revoked_at = now()
  FROM intrusos i WHERE s.user_id = i.user_id AND s.org_id = i.org_id AND s.revoked_at IS NULL;
INSERT INTO audit_logs (id, org_id, action, summary, created_at)
  SELECT gen_random_uuid(), i.org_id, 'isolamento.membro_removido',
    left(i.nome || ' (empresa nº ' || i.empresa_da_pessoa || ' do Cenário) saiu desta organização: tinha entrado pela falha de isolamento corrigida em 19/11/2026.', 400), now()
  FROM intrusos i;
DELETE FROM memberships ms USING intrusos i WHERE ms.org_id = i.org_id AND ms.user_id = i.user_id;
COMMIT;
\echo
SELECT count(*) AS "acessos removidos" FROM intrusos;
\endif
