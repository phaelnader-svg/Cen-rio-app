-- Exclusão DEFINITIVA de uma empresa (tapeçaria) e de todos os dados dela.
-- Uso (no container do postgres, como superusuário):
--   psql -v ON_ERROR_STOP=1 -v empresa=1 -v conexoes=2 -v confirmar='Cenário Estofados' -f excluir-empresa.sql
-- empresa   = número da empresa a apagar (nunca o registro da plataforma)
-- conexoes  = número da empresa que passa a usar as conexões do servidor (0 = não mexe)
-- confirmar = nome da empresa, exatamente como está gravado (trava contra número errado)
-- Antes: recovery_point_create + backup_validate. Tudo numa transação: qualquer erro desfaz tudo.
-- As travas de "não apagar" (registros imutáveis) são desligadas só dentro desta transação.
\set ON_ERROR_STOP 1
BEGIN;
SELECT set_config('cenario.excluir_empresa', :'empresa', true),
       set_config('cenario.excluir_conexoes', :'conexoes', true),
       set_config('cenario.excluir_nome', :'confirmar', true);
DO $$
DECLARE
  alvo int := current_setting('cenario.excluir_empresa')::int;
  dest int := nullif(current_setting('cenario.excluir_conexoes'), '0')::int;
  nome text := current_setting('cenario.excluir_nome');
  t record;
  fk record;
  n bigint;
  restantes int;
  progresso boolean;
  rodada int := 0;
  orfaos bigint;
  q text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM company_settings WHERE id = alvo AND NOT is_platform) THEN
    RAISE EXCEPTION 'Empresa % não existe (ou é a plataforma). Nada foi apagado.', alvo;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM company_settings WHERE id = alvo AND trade_name = nome) THEN
    RAISE EXCEPTION 'O nome não confere com a empresa %. Nada foi apagado.', alvo;
  END IF;
  IF dest IS NOT NULL AND (dest = alvo OR NOT EXISTS (
       SELECT 1 FROM company_settings WHERE id = dest AND NOT is_platform AND canceled_at IS NULL)) THEN
    RAISE EXCEPTION 'Empresa % não pode receber as conexões. Nada foi apagado.', dest;
  END IF;

  -- Desliga as travas (gatilhos) só nesta transação; as chaves estrangeiras continuam valendo.
  FOR t IN SELECT c.relname FROM pg_class c
            WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
              AND EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = c.oid AND NOT g.tgisinternal) LOOP
    EXECUTE format('ALTER TABLE public.%I DISABLE TRIGGER USER', t.relname);
  END LOOP;

  -- Apaga em rodadas: tabela barrada por outra (chave estrangeira ou regra) tenta de novo na próxima rodada.
  LOOP
    rodada := rodada + 1;
    progresso := false;
    restantes := 0;
    FOR t IN SELECT c.table_name FROM information_schema.columns c
               JOIN information_schema.tables b USING (table_schema, table_name)
              WHERE c.table_schema = 'public' AND c.column_name = 'company_id'
                AND b.table_type = 'BASE TABLE' AND c.table_name <> 'company_settings'
              ORDER BY c.table_name LOOP
      BEGIN
        EXECUTE format('DELETE FROM public.%I WHERE company_id = $1', t.table_name) USING alvo;
        GET DIAGNOSTICS n = ROW_COUNT;
        IF n > 0 THEN
          progresso := true;
          RAISE NOTICE 'rodada %: % apagados de %', rodada, n, t.table_name;
        END IF;
      EXCEPTION WHEN integrity_constraint_violation THEN
        restantes := restantes + 1;
      END;
    END LOOP;
    EXIT WHEN restantes = 0;
    IF NOT progresso OR rodada > 50 THEN
      -- Sobrou só o que uma tabela aponta para a outra e vice-versa (ciclo). Apaga o resto com as
      -- chaves estrangeiras suspensas; a conferência logo abaixo garante que nada ficou solto.
      RAISE NOTICE 'rodada %: % tabelas presas umas nas outras, apagando o resto juntas', rodada, restantes;
      PERFORM set_config('session_replication_role', 'replica', true);
      FOR t IN SELECT c.table_name FROM information_schema.columns c
                 JOIN information_schema.tables b USING (table_schema, table_name)
                WHERE c.table_schema = 'public' AND c.column_name = 'company_id'
                  AND b.table_type = 'BASE TABLE' AND c.table_name <> 'company_settings'
                ORDER BY c.table_name LOOP
        EXECUTE format('DELETE FROM public.%I WHERE company_id = $1', t.table_name) USING alvo;
        GET DIAGNOSTICS n = ROW_COUNT;
        IF n > 0 THEN
          RAISE NOTICE 'rodada %: % apagados de %', rodada, n, t.table_name;
        END IF;
      END LOOP;
      PERFORM set_config('session_replication_role', 'origin', true);
      EXIT;
    END IF;
  END LOOP;

  DELETE FROM company_settings WHERE id = alvo;
  RAISE NOTICE 'empresa % apagada', alvo;

  -- Conferência: nenhuma linha de nenhuma tabela pode ter ficado apontando para algo apagado.
  FOR fk IN SELECT conrelid::regclass AS filho, confrelid::regclass AS pai, conkey, confkey, conname
              FROM pg_constraint WHERE contype = 'f' AND connamespace = 'public'::regnamespace LOOP
    SELECT format('SELECT count(*) FROM %s f WHERE %s AND NOT EXISTS (SELECT 1 FROM %s p WHERE %s)',
                  fk.filho,
                  string_agg(format('f.%I IS NOT NULL', a.attname), ' AND '),
                  fk.pai,
                  string_agg(format('p.%I = f.%I', b.attname, a.attname), ' AND '))
      INTO q
      FROM unnest(fk.conkey, fk.confkey) AS k(ck, pk)
      JOIN pg_attribute a ON a.attrelid = fk.filho AND a.attnum = k.ck
      JOIN pg_attribute b ON b.attrelid = fk.pai AND b.attnum = k.pk;
    EXECUTE q INTO orfaos;
    IF orfaos > 0 THEN
      RAISE EXCEPTION 'Sobrou % registro(s) soltos em % (%). Nada foi apagado.', orfaos, fk.filho, fk.conname;
    END IF;
  END LOOP;

  IF dest IS NOT NULL THEN
    UPDATE company_settings SET server_connections = false WHERE server_connections AND id <> dest;
    UPDATE company_settings SET server_connections = true WHERE id = dest;
    RAISE NOTICE 'conexões do servidor agora na empresa %', dest;
  END IF;

  FOR t IN SELECT c.relname FROM pg_class c
            WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
              AND EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = c.oid AND NOT g.tgisinternal) LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE TRIGGER USER', t.relname);
  END LOOP;
END $$;
INSERT INTO platform_audit_logs (id, action, target_company_id, summary)
VALUES (gen_random_uuid(), 'platform.company_deleted', current_setting('cenario.excluir_empresa')::int,
        format('Empresa nº %s (%s) apagada de vez com todos os dados, a pedido do dono.',
               current_setting('cenario.excluir_empresa'), current_setting('cenario.excluir_nome')));
COMMIT;
\echo 'EMPRESA APAGADA'
