# Operação — Cenário Gestão

## Ambientes

| `APP_ENV`     | Uso                      | Exigências da API                                   |
| ------------- | ------------------------ | --------------------------------------------------- |
| `development` | Máquina do desenvolvedor | —                                                   |
| `test`        | Testes automatizados     | Bancos com `test` no nome, apagados a cada execução |
| `staging`     | Homologação              | HTTPS, `COOKIE_SECURE=true`, `NODE_ENV=production`  |
| `production`  | Produção                 | Idem; banco, segredos e armazenamento próprios      |

Cada ambiente tem seu **próprio** banco, `TOKEN_HASH_SECRET` e `STORAGE_DIR`. Nunca reutilize
segredos entre ambientes. Todas as variáveis estão descritas em `.env.example`.

## Deploy (referência — nenhum deploy foi feito nesta fase)

1. `pnpm install --frozen-lockfile`
2. `pnpm db:migrate` (aplica migrations pendentes; nunca use `migrate dev`/`reset` fora do
   desenvolvimento)
3. API: `pnpm --filter @cenario/api build` e `node apps/api/dist/server.js` (com as variáveis do
   ambiente).
4. Web: `API_INTERNAL_URL=<url interna da API> pnpm --filter @cenario/web build` e
   `pnpm --filter @cenario/web start`. **O `API_INTERNAL_URL` é gravado no build.**
5. Proxy reverso com HTTPS encaminhando `/api/*` (incluindo WebSocket) direto à API e o resto
   ao Next.js — exemplo em `infra/Caddyfile.example`. Defina `TRUST_PROXY` na API.
6. Verificação: `GET /api/health` (processo) e `GET /api/ready` (banco).

A API encerra com segurança em `SIGTERM` (fecha conexões e tarefas em até 10 s). Várias
instâncias da API podem rodar juntas: eventos circulam pelo PostgreSQL e as tarefas de fundo
usam bloqueios no banco.

## Atualização da Fase 1 para a Fase 2

A migration `20261008100000_comercial_oficina` é aditiva (só cria tabelas, índices,
restrições e triggers; não altera dados existentes) e concede à função Gestor as novas
permissões. Procedimento: backup (`pnpm backup`) → `pnpm db:migrate` → reiniciar API e web.
Funções de produção não recebem permissões comerciais automaticamente: o gestor concede o
que for necessário (ex.: `recebimentos.registrar` para quem confere a chegada de peças).

## Atualização da Fase 2 para a Fase 3

A migration `20261008200000_medicoes_materiais` é aditiva: cria as tabelas de medições e
solicitações, amplia `material_requirements` com colunas opcionais (origem, unidade
estruturada, cor, referência, densidade, dimensões, aprovação), amplia
`domain_events.audience` para 400 caracteres e concede à função Gestor as permissões
`medicoes.gerenciar`, `materiais.ver` e `materiais.aprovar`. Nenhum dado existente é apagado.
Procedimento: backup (`pnpm backup`) → `pnpm db:migrate` → reiniciar API e web.

Depois da atualização, o gestor concede aos tapeceiros que podem receber medições delegadas a
permissão **Executar medições atribuídas** (Funcionários → Editar → Permissões adicionais).
Mudança de regra: o registro direto de medidas na OS passa a ser exclusivo do painel com
`os.gerenciar`; tapeceiros medem pela área **Medições atribuídas** do tablet.

## Backup e restauração

```bash
pnpm backup                           # usa DATABASE_URL e STORAGE_DIR; grava em ./backups
bash scripts/backup.sh /caminho/seguro
bash scripts/restore.sh backups/cenario-production-20261008T000000Z \
  --target postgresql://…/banco_destino --storage ./storage --yes
pnpm test:backup                      # teste automático de backup + restauração
```

- O backup contém o banco (formato custom do `pg_dump`, verificado após a geração), os arquivos
  privados (fotos de funcionários e dos registros) e checksums SHA-256. O teste automático
  restaura também dados da Fase 2 (cliente, pedido, recebimento) e confere a imutabilidade. Retenção padrão: 30 dias (`BACKUP_RETENTION_DAYS`).
- A restauração exige destino explícito e `--yes`, confere os checksums e roda numa única
  transação.
- Após restaurar, os clientes conectados recebem `resync.required` e recarregam os dados.
- Recomendação: agendar `scripts/backup.sh` diariamente (cron/systemd) e copiar o diretório
  para um local externo criptografado; testar a restauração mensalmente.

## Rotina de manutenção automática

A cada 15 min (uma instância por vez): remove chaves de idempotência expiradas, contadores de
login antigos e sessões encerradas há mais de 90 dias. Auditoria e eventos não são apagados.

## Logs

JSON estruturado no stdout (um objeto por linha, com `requestId`). Em desenvolvimento com
terminal interativo, saída formatada. Nível por `LOG_LEVEL`.
