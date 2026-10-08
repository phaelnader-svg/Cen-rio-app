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

## Atualização da Fase 3 para a Fase 4

A migration `20261009000000_compras_estoque` é aditiva: cria fornecedores, pedidos de compra,
recebimentos de materiais, estornos, estoque (catálogo, movimentações, reservas) e sobras; acrescenta
`service_orders.materials_readiness` (padrão `SEM_LEVANTAMENTO`; o valor exibido é sempre
recalculado) e concede ao Gestor `compras.*` e `estoque.*`. Nada existente é apagado.
Procedimento: backup (`pnpm backup`) → `pnpm db:migrate` → reiniciar API e web.

Mudanças de regra a comunicar: depois de existir compra, reserva ou transferência ligada a uma
solicitação aprovada, ela não pode mais ser reaberta pela tela de medições (ajuste pelas compras);
a prontidão "Materiais" da OS deixou de ser "fase futura". Pendência registrada: estorno de
recebimento **de peças de clientes** (Fase 2) continua não implementado — não confundir com o
estorno de recebimento de materiais.

## Atualização da Fase 4 para a Fase 5

A migration `20261010000000_producao` é aditiva: cria modelos de produção, planejamentos,
itens, revisões, tarefas, dependências e eventos de tarefa (com CHECKs e triggers de
imutabilidade), insere os três modelos padrão (sofá, cabeceira, cadeira/poltrona) e concede ao
Gestor `producao.ver`, `producao.planejar` e `producao.executar`, e às funções Tapeceiro,
Cabeceiras/Qualidade e Ajudante `producao.executar`. Nada existente é apagado.
Procedimento: backup (`pnpm backup`) → `pnpm db:migrate` → reiniciar API e web.

Mudanças de regra a comunicar: cancelar uma OS agora também cancela as tarefas de produção
abertas e libera as reservas de estoque da OS; a prontidão "Programação" da OS passa a refletir
tarefas em planejamento publicado. A API libera, a cada 30 s, as tarefas cujo horário chegou.

## Atualização da Fase 5 para a Fase 6

A migration `20261011000000_tablets_notificacoes` é aditiva: cria `notifications` (avisos por usuário,
únicos por chave) e `production_task_materials` (materiais por tarefa), acrescenta às tarefas os campos
de andamento estruturado (`progress_step`, `progress_next`), `pause_impediment`,
`completion_requirement` e `completion_note`, `completion_requirement` às etapas dos modelos e o tipo
de anexo `PRODUCTION_TASK`. Nada existente é apagado; tarefas e modelos existentes ficam com
"nenhum registro" exigido na conclusão. Procedimento: backup (`pnpm backup`) → `pnpm db:migrate` →
reiniciar API e web.

Mudanças a comunicar: o tablet abre direto no "Meu dia" (o bloco "Minhas tarefas" deixou de existir);
os avisos aparecem no botão "Avisos" do cabeçalho; sem conexão, os botões de ação ficam desativados.

## Atualização da Fase 6 para a Fase 7

A migration `20261012000000_presenca_operacional` é aditiva: cria `operational_attendances`,
`attendance_corrections` (imutável) e `attendance_impacts`, acrescenta à empresa
`arrival_window_start` (07:00) e `late_alert_minutes` (15) e concede `presenca.ver` e
`presenca.gerenciar` ao Gestor e `presenca.registrar` às funções da oficina. Nada é apagado.
Procedimento: backup (`pnpm backup`) → `pnpm db:migrate` → reiniciar API e web.

Rotina nova: a cada minuto, a API verifica ausências presumidas (só em dia útil e depois do limite
configurado). Em Empresa, "Início previsto do expediente" (antes rotulado "“Cheguei” a partir de")
passa a ser o horário de referência do atraso; a janela do "Cheguei" é o novo campo.

## Atualização da Fase 7 para a Fase 8

A migration `20261013000000_ajuda_reprogramacao` é aditiva: cria `employee_skills`,
`help_requests`, `help_request_events` (imutável), `reschedule_proposals` e `planning_actions`
(imutável), acrescenta `estimated_minutes` e `support_for_task_id` às tarefas, concede
`ajuda.solicitar` ao Gestor, aos tapeceiros e a cabeceiras/qualidade e semeia as competências
iniciais por função. Nada é apagado. Procedimento: backup (`pnpm backup`) → `pnpm db:migrate` →
reiniciar API e web.

Rotinas novas: a cada 30 s a API reavalia a fila de ajuda (atribui quando alguém fica livre e avisa
o gestor de pedidos esperando demais). A verificação de ausência presumida passa a gerar uma
proposta de reprogramação (só sugestão) quando a pessoa tinha tarefas no dia.

Variável nova: `ENABLE_TEST_CLOCK` (padrão `false`). **Nunca** definir fora dos testes — a API
recusa iniciar com ela fora de `APP_ENV=test`.

## Atualização da Fase 8 para a Fase 9

A migration `20261014000000_central_atencao` é aditiva: cria `production_issues` (sem exclusão) e
`production_issue_events` (imutável), acrescenta `issue_id` às tarefas e às propostas, o tipo de
anexo `PRODUCTION_ISSUE` e as permissões `ocorrencias.registrar` (oficina e gestor),
`ocorrencias.ver` e `ocorrencias.gerenciar` (gestor). Nada é apagado. Procedimento: backup
(`pnpm backup`) → `pnpm db:migrate` → reiniciar API e web.

Rotina: junto com a fila de ajuda (a cada 30 s), a API avisa prazos de resolução vencendo e
invalida propostas de bloqueio que perderam o sentido. A central de atenção fica em
`/painel/atencao`.

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
