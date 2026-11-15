# Deploy `0a2546f` — autorização de aplicativos (Firma Viva) em modo consulta

Pedido do dono: conectar a conta real do Cenário Gestão ao Firma Viva (`https://firmaviva.com.br`),
primeiro em **modo consulta** (nada de OS, estoque ou financeiro é alterado).

## 1. Situação verificada (15/11/2026, só leitura)

| Item                                       | Resultado                                                                                                                                                                         |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Produção (`cenariogestao.com.br`)          | `environment: production`, versão ativa **`696e3e9`** (etiqueta, pilha, candidata e migrada), portão **fechado**, runner 2.2.0 — `operar.py verificar` com o operador de produção |
| Rotas de autorização na produção           | **ausentes**: `POST /api/oauth/token` → 404, `/autorizar` → 404                                                                                                                   |
| Mapa da oficina (somente leitura)          | presente na linha de produção: `GET /api/v1/workshop-map`                                                                                                                         |
| Próxima versão já autorizada               | `9fb6b03` (E1 + S1), homologada, **não promovida** (`operar.py imagens 9fb6b03…`: api/web inexistentes em `cenario-prod`)                                                         |
| Homologação (`teste.cenariogestao.com.br`) | atrás da senha do proxy (401); esta sessão não tem o operador da homologação                                                                                                      |

## 2. Versão candidata

`0a2546f33f9b568e89899b69f39080d655c2084d` (branch `claude/autorizacao-apps-9fb6b03`) = **`9fb6b03` +
autorização de aplicativos**. Assim a produção recebe uma única versão nova (E1 + S1 + autorização);
promover `9fb6b03` sozinha depois conflitaria com a migration nova.

O que muda:

- Tela oficial `/autorizar` (o login é sempre o do Cenário), `POST /api/oauth/authorize`,
  `/api/oauth/token` (código + PKCE S256 + segredo do cliente; renovação com rotação),
  `/api/oauth/revoke`, `GET /api/v1/apps/me`.
- **Escopo único `consulta`**: `painel.acessar`, `empresa.ver`, `os.ver`, `producao.ver`,
  `entregas.ver` — somente leitura. Permissão efetiva = permissões do usuário ∩ escopo. Rotas de
  login, sessões e WebSocket nunca aceitam o token do aplicativo.
- **Administração → Aplicativos conectados** (`/painel/aplicativos`): cadastro do aplicativo com o
  endereço de retorno **exato** (só HTTPS; quem tem `empresa.configurar`), segredo mostrado **uma
  vez** (só o hash é guardado), lista e revogação das autorizações, desativação do aplicativo.
- Auditoria com `[via Firma Viva · <organização> · <pessoa>]`.
- Migration **aditiva** `20270330000000_autorizacao_aplicativos`: 4 tabelas novas
  (`oauth_clients`, `oauth_codes`, `oauth_grants`, `oauth_access_tokens`). Nenhuma tabela, coluna ou
  dado existente é alterado. Reversão: `packages/db/rollback/20270330000000_autorizacao_aplicativos.down.sql`.

Testes no commit exato (bancos locais descartáveis): API **1065 passaram**, 0 falhas (17 "expected
fail" já existentes na linha); web **44 passaram**; lint e tipos limpos. Inclui a suíte nova
`autorizacao-aplicativos.test.ts` (PKCE, código de uso único, segredo/verificador errados, recusa,
consulta só lê — escrita 403, financeiro 403 —, rotação, revogação, cadastro pelo painel com HTTPS
e retorno exato) e a matriz de segurança atualizada. Drift do schema: só os 2 índices de
`service_order_materials` que já divergem em `9fb6b03` (não vêm desta mudança).

Ensaio de ponta a ponta (local, mesmo código): cadastro do aplicativo pelo painel → Firma Viva →
Conectar → login oficial → autorização mostrando "Cenário Estofados" e só "Consulta (somente
leitura)" → volta → 8 peças de 4 OS no mapa → tentativa de planejar recusada (403) → **OS, peças,
estoque, tarefas, pagamentos e auditoria (fora login/autorização) idênticos antes e depois**.
Capturas: `docs/evidencias/firma-viva/producao-consulta/` na branch `claude/jogo-cenario-estofados`.

## 3. Homologação (sessão do ambiente de HOMOLOGAÇÃO do Claude Code — operador `claude-operador`)

```bash
python3 infra/homolog/gcp/autonomia/operar.py verificar
python3 infra/homolog/gcp/autonomia/operar.py build-iniciar 0a2546f33f9b568e89899b69f39080d655c2084d
python3 infra/homolog/gcp/autonomia/operar.py build-acompanhar 0a2546f33f9b568e89899b69f39080d655c2084d
python3 infra/homolog/gcp/autonomia/operar.py op gate_open
python3 infra/homolog/gcp/autonomia/operar.py op prepare_version version=0a2546f33f9b568e89899b69f39080d655c2084d
python3 infra/homolog/gcp/autonomia/operar.py op migration_precheck version=0a2546f33f9b568e89899b69f39080d655c2084d   # esperado: 1 pendente (autorizacao_aplicativos)
python3 infra/homolog/gcp/autonomia/operar.py op maintenance_on
python3 infra/homolog/gcp/autonomia/operar.py op recovery_point_create
python3 infra/homolog/gcp/autonomia/operar.py op migrate version=0a2546f33f9b568e89899b69f39080d655c2084d
python3 infra/homolog/gcp/autonomia/operar.py op activate_version version=0a2546f33f9b568e89899b69f39080d655c2084d
python3 infra/homolog/gcp/autonomia/operar.py op gate_close
python3 infra/homolog/gcp/autonomia/operar.py op migration_verify
python3 infra/homolog/gcp/autonomia/operar.py op smoke_test
python3 infra/homolog/gcp/autonomia/operar.py op run_homologation_tests suite=acesso
python3 infra/homolog/gcp/autonomia/operar.py op container_logs service=api lines=300
```

Anote os **digests** de `api` e `web` do build (saída do `build-acompanhar`/`version`): a produção
recebe exatamente essas imagens. Conferência pela tela (você, com a senha do proxy):
`https://teste.cenariogestao.com.br/painel/aplicativos` abre, cadastra um aplicativo de teste com
retorno HTTPS e mostra o segredo uma vez; `https://teste.cenariogestao.com.br/autorizar?…` exige login.

## 4. Promoção das imagens (Cloud Shell, sua conta)

Mesmo procedimento e mesmo `promover-imagens.sh` (árvore `9ff142e`) da promoção de `696e3e9`
(`docs/PRODUCAO-DEPLOY-696e3e9-CLOUDSHELL.md`), só com a versão e os digests novos:

```bash
bash infra/prod/gcp/promover-imagens.sh 0a2546f33f9b568e89899b69f39080d655c2084d <digest-api-homologado> <digest-web-homologado>
```

**O que altera:** só acrescenta a etiqueta `0a2546f…` no Artifact Registry `cenario-prod`, apontando
para os digests homologados. Recusa se o digest de origem divergir e nunca sobrescreve etiqueta
existente. Não toca VM, banco, portão, IAM, segredos nem DNS.

## 5. Produção (sessão do ambiente "Cenário — Produção" — operador `claude-operador-prod`)

Só depois da sua autorização expressa. Indisponibilidade esperada: ~2–3 min (como em `9fb6b03`
na homologação).

| #   | Operação                                                                       | Prova                                                           |
| --- | ------------------------------------------------------------------------------ | --------------------------------------------------------------- |
| 1   | `verificar`, `version`, `disk_status`, `imagens 0a2546f…`                      | ativa `696e3e9`; imagens promovidas por digest                  |
| 2   | `gate_open`, `prepare_version version=0a2546f…`                                | digests conferidos na VM                                        |
| 3   | `migration_precheck version=0a2546f…`                                          | exatamente 1 pendente: `20270330000000_autorizacao_aplicativos` |
| 4   | `maintenance_on`, `recovery_point_create`, `backup_validate folder=…`          | ponto de recuperação com restauração IDÊNTICA, no bucket        |
| 5   | `migrate version=0a2546f…`, `database_fingerprint`                             | 1 aplicada; tabelas antigas idênticas                           |
| 6   | `activate_version version=0a2546f…`, `gate_close`                              | contêineres saudáveis; portão fechado                           |
| 7   | `migration_verify`, `health`, `smoke_test`, `websocket_test`, `container_logs` | 0 pendentes, HTTPS, 0 erros 5xx                                 |

**Retorno:** `rollback_to_recovery_point` (banco e versão voltam ao ponto do passo 4; a autorização
de aplicativos some). `rollback_version 696e3e9` sozinho deixaria as 4 tabelas novas no banco (sem
uso pela versão antiga).

## 6. Ligar o Firma Viva à produção (você)

1. `https://cenariogestao.com.br/painel/aplicativos` → **Aplicativos cadastrados**: identificador
   `firma-viva`, nome `Firma Viva`, retorno **`https://firmaviva.com.br/api/conexoes/cenario/retorno`**
   → **Salvar e gerar segredo** → **Copiar** (não envie por chat nem e-mail).
2. Cloud Shell, no clone do repositório, branch `claude/jogo-cenario-estofados` (versão do Firma
   Viva com o modo consulta):

   ```bash
   bash infra/firma-viva/teste/firma-teste.sh atualizar
   bash infra/firma-viva/teste/firma-teste.sh producao
   ```

   `producao` pede o segredo sem mostrá-lo, grava só no `.env` da VM do Firma Viva (root),
   configura `CENARIO_API_URL`/`CENARIO_WEB_URL=https://cenariogestao.com.br` e
   `FIRMA_CENARIO_SCOPES=consulta`, desconecta as conexões antigas (que apontavam para o Cenário de
   teste), reconstrói o Firma Viva e confere, sem efeito, que a produção reconhece o aplicativo.

## 7. Teste final (modo consulta)

`https://firmaviva.com.br` → Central de Conexões → **Conectar Cenário Gestão** → login oficial em
`cenariogestao.com.br` → a tela mostra **Cenário Estofados** e só **Consulta (somente leitura)** →
**Autorizar** → de volta ao Firma Viva com "👁️ Modo consulta · somente leitura" → OS reais no mapa
(Tapeçaria), na área da posição registrada no Cenário ou em "Sem localização registrada".
