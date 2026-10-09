# Fase 12 — Auditoria final, remediação, segurança e homologação: relatório de entrega

> Nenhum deploy foi feito, nenhum serviço foi contratado, nenhum dado real foi usado e nenhuma
> migration antiga foi alterada. Todos os resultados abaixo vêm de execuções reais neste
> ambiente (09/10/2026); o que não pôde ser executado está marcado como **não testado**.

## 1. Branch e SHAs

- Branch: `claude/cenario-gestao-fase-1-zf3bj2`.
- Ponto de partida: `9be3a7e` (Fase 11: relatório), sobre `e838d26` e `a897a4c`. Worktree limpo.
- Commits da Fase 12:

| SHA       | Conteúdo                                                                             |
| --------- | ------------------------------------------------------------------------------------ |
| `fb1d47f` | Versiona o módulo de armazenamento da API (corrige o CI quebrado)                    |
| `cd84216` | Auditorias automatizadas de segurança, integridade e sincronização; dependências     |
| `acd2a59` | Pendências antigas A–E e migration `20261017000000_auditoria_final`                  |
| `eec425d` | Fluxo completo de ponta a ponta (32 passos) e medição de desempenho                  |
| `4bcb53e` | Auditoria visual, quatro tablets simultâneos, reconexão imediata, correções de telas |
| (este)    | Homologação (`infra/homolog`, guia, dados sintéticos), documentação e este relatório |

## 2. Linha de base inicial

Medida antes de qualquer alteração, sem confiar nos relatórios anteriores:

| Verificação          | Resultado em `9be3a7e`                                                                                                                                                                                                   |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `pnpm check` (local) | Passou: API 264 testes, shared 53, web 6                                                                                                                                                                                 |
| `pnpm build`         | Passou                                                                                                                                                                                                                   |
| `pnpm test:backup`   | Passou                                                                                                                                                                                                                   |
| `pnpm test:e2e`      | 19/19                                                                                                                                                                                                                    |
| `pnpm audit`         | **15 alertas** (incluindo altos em ferramentas de build/teste)                                                                                                                                                           |
| **CI no GitHub**     | **Vermelho em todas as execuções #1–#27.** Causa encontrada: `.gitignore` com `storage/` excluía o código-fonte `apps/api/src/core/storage/`; um clone limpo não compilava (o relatório da Fase 11 não registrava isso). |

## 3. Inventário completo

| Área                  | Itens                                                                                                                                                                                                                                                                                           |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| API (Fastify 5)       | 30 módulos, ~300 rotas, todas com regra de acesso declarada (`config.access`)                                                                                                                                                                                                                   |
| Banco (PostgreSQL 16) | 12 migrations (11 anteriores + 1 desta fase), triggers de imutabilidade/não exclusão, CHECKs                                                                                                                                                                                                    |
| Web (Next.js 15)      | 46 telas do painel (rotas com registros reais), app do tablet (Meu dia, tarefas, medições, materiais, inspeções, logística, Meus valores)                                                                                                                                                       |
| Testes                | API 30 arquivos / 295 testes; shared 53; web 6; E2E 13 specs / 21 testes; backup; desempenho                                                                                                                                                                                                    |
| Operação              | `scripts/backup.sh`, `restore.sh`, `test-backup-restore.sh`, `homolog-dados-sinteticos.mjs`                                                                                                                                                                                                     |
| Infra                 | `infra/Caddyfile.example`, `infra/homolog/` (Dockerfile, compose, Caddy, modelo de variáveis)                                                                                                                                                                                                   |
| Módulos auditados     | autenticação e dispositivos, clientes, pedidos, retiradas, recebimentos, OS, medições, compras, estoque, planejamento, produção, presença, ajuda, reprogramação, central de atenção, qualidade, embalagem, logística, devoluções, financeiro, indicadores/relatórios, auditoria e sincronização |

## 4. Pendências identificadas

| #   | Pendência                                                                                                                                    | Origem                     | Gravidade |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- | --------- |
| 1   | CI quebrado desde o início (código-fonte ignorado pelo Git)                                                                                  | Auditoria inicial          | Alta      |
| 2   | 15 alertas de dependências                                                                                                                   | `pnpm audit`               | Média     |
| 3   | A. Reservas de OS parcialmente devolvida não eram liberadas                                                                                  | Fase 10                    | Alta      |
| 4   | B. Valor de produção de peça devolvida sem execução continuava previsto                                                                      | Fase 11                    | Alta      |
| 5   | C. Painel sem fluxo de devolução de peças avulsas (sem OS), destino e histórico                                                              | Fase 10                    | Média     |
| 6   | D. Pedido sem situação comercial de devolução/conclusão                                                                                      | Fase 10/11                 | Média     |
| 7   | E. Compra parcialmente recebida sem como encerrar o saldo                                                                                    | Fase 4                     | Média     |
| 8   | Publicar planejamento com 40 OS → **erro 500** (transação > 5 s)                                                                             | Teste de desempenho        | Alta      |
| 9   | Tablet ficava "sem conexão" até 30 s depois de a rede voltar                                                                                 | E2E quatro tablets         | Média     |
| 10  | Rolagem horizontal em telas estreitas (início, pedido, modelos, reprogramação, tablet)                                                       | Auditoria visual           | Baixa     |
| 11  | Tela "Nova OS" sem título; abas "Qualidade"/"Entrega" da OS desativadas ("fase futura") e texto desatualizado da retirada                    | Auditoria visual           | Baixa     |
| 12  | 103 colunas de chave estrangeira sem índice                                                                                                  | Auditoria de integridade   | Baixa     |
| 13  | Painel financeiro lento com volume (3,7 s com 120 OS)                                                                                        | Teste de desempenho        | Média     |
| 14  | Dockerfile de homologação: `pg_dump` 15 (Debian) incompatível com servidor 16; pnpm baixado ao iniciar; primeiro backup antes das migrations | Verificação da homologação | Média     |
| 15  | E2E dependentes do horário: tarefas "hoje às 00:01" falhavam se a suíte rodasse entre 00:00 e 00:05 (Brasília) — o CI roda a qualquer hora   | Execução de evidências     | Média     |

## 5. Correções realizadas

1. **CI** — `.gitignore` passa a ignorar só `/storage/` e `apps/api/storage/`; os dois arquivos do
   módulo de armazenamento foram versionados. CI acrescido de `pnpm audit --audit-level critical`,
   migrations do zero + `migrate status` + `migrate diff --exit-code` (schema × banco) e `pnpm build`.
2. **Dependências** — vitest 4.1.11, postcss 8.5.29; overrides de `esbuild`, `deepmerge-ts`.
   15 → 1 alerta (`braces`, sem versão corrigida, só no lint — §7).
3. **A. Reservas** — devolução parcial confirmada libera só reservas `ATIVA` das peças devolvidas,
   sob bloqueio e releitura; consumido e outras peças intactos; reservas sem peça definida vão
   para revisão do gestor (não há rateio por suposição); evento, auditoria e prontidão.
4. **B. Valores de produção** — sem execução nem pagamento: cancelado com justificativa
   ("Sem execução…"); com execução, valor elegível ou pagamento: nada muda e o gestor recebe aviso
   "Revisar". Elegibilidade atingida não volta atrás. Nada é descontado automaticamente.
5. **C. Devolução avulsa** — tela Devoluções com "Peças de OS" e "Peças avulsas (sem OS)", peça,
   quantidade disponível, motivo, destino, responsável, data, confirmação e detalhe com histórico
   e pendências de revisão.
6. **D. Situação do serviço** — devolução parcial, devolução total, serviço concluído, serviço
   cancelado (lista e detalhe do pedido, receita no financeiro); valor negociado inalterado.
7. **E. Encerrar saldo de compra** — `compras.aprovar`, justificativa, recebido e custos
   preservados, necessidade não atendida volta a aparecer, prontidão recalculada, sem estoque
   negativo; estorno posterior não reabre.
8. **Transações** — limite de 60 s (`transactionOptions`); a publicação com 40 OS passou a concluir
   (6,8 s).
9. **Tempo real** — ao voltar a rede, o cliente troca o socket antigo e retoma na hora.
10. **Telas** — `min-width: 0` em `fieldset` e filhos de grid, botão de aprovação truncado no
    celular, título em Nova OS, aba real "Qualidade e entrega" na OS (peças, etapa, inspeção),
    texto da retirada atualizado.
11. **Índices** — 19 índices nas chaves estrangeiras mais consultadas. Restam 85 colunas de FK
    sem índice próprio (as 84 originais de tabelas pequenas ou pouco filtradas + a nova
    `balance_closed_by_id`, raramente consultada); a lista é registrada pelo teste de integridade.
12. **Homologação** — backup na imagem `postgres:16`, pnpm embutido na imagem (`COREPACK_HOME`),
    backup só depois da API saudável.
13. **E2E independentes do horário** — tarefas de teste programadas para 00:00 (já liberadas em
    qualquer horário do dia); a suíte completa voltou a passar logo após a meia-noite.

## 6. Migrations

- Nova: `20261017000000_auditoria_final` (aditiva): `piece_returns.destination`;
  `purchase_order_items.closed_quantity` (padrão 0); `purchase_orders.balance_closed_at`,
  `balance_closed_by_id` (FK), `balance_close_reason`; CHECKs
  `purchase_order_items_closed_quantity`, `purchase_orders_balance_closed`,
  `piece_returns_destination`; 19 índices.
- Nenhuma migration antiga alterada. Verificado: aplicação do zero, `migrate status` e
  `migrate diff` sem divergência (local e no CI); o teste `migrations.test.ts` confere a lista.

## 7. Auditoria de segurança

Teste `security-audit.test.ts` (11 cenários, todos passando), executado contra a API real:

| Verificação                                                                                                 | Resultado                |
| ----------------------------------------------------------------------------------------------------------- | ------------------------ |
| Todas as rotas sem sessão → 401 (exceto as 5 públicas: health, ready, tablet/status, login, pair)           | OK                       |
| Todas as rotas com `Origin` estranho (CSRF) → 403                                                           | OK                       |
| Tablet do Ricardo, celular do André e painel só com `pedidos.ver`: 403 onde a regra nega, em todas as rotas | OK — nenhum vazamento    |
| André × Izaías: um não vê nem avança a retirada do outro                                                    | OK                       |
| Comprovante financeiro no tablet → 403; caminhos `..`/codificados → 400/404                                 | OK                       |
| Textos de injeção (SQL, HTML, CSV) gravados e devolvidos como texto                                         | OK                       |
| Corpo acima do limite → 413; cabeçalhos de segurança                                                        | OK                       |
| Sessão revogada derruba o WebSocket                                                                         | OK                       |
| Tablets nunca recebem valores financeiros (rotas e eventos)                                                 | OK (Fase 11 + varredura) |
| Limite de requisições (600/min por sessão) e bloqueio progressivo de login/PIN                              | OK (testes existentes)   |
| Configuração de produção: API recusa iniciar sem HTTPS/`COOKIE_SECURE`/`NODE_ENV`                           | OK (`env.test.ts`)       |
| Segredos: nenhum no repositório; `.env.homolog` ignorado no Git e no contexto Docker                        | OK                       |
| Dependências: 1 alerta **alto** restante (`braces`), só em ferramenta de lint, sem versão corrigida         | Aceito (risco residual)  |

Nenhuma falha crítica ou alta de segurança em aberto.

## 8. Auditoria de integridade

`integrity-audit.test.ts` (7 cenários):

- Falha forçada (trigger temporário) no meio de: recebimento financeiro, decisão de inspeção e
  saída de estoque para a OS → **nada parcial** gravado; repetir com a mesma chave de
  idempotência conclui normalmente.
- Duas conclusões simultâneas da mesma tarefa → um único evento `CONCLUIDA`.
- Duas reservas simultâneas do último saldo → `[201, 409]`; estoque nunca negativo.
- Toda tabela com chave primária; triggers de imutabilidade presentes; migrations aplicadas.
- O fluxo completo (§9) confere ausência de eventos duplicados e de estoque negativo ao final.

## 9. Testes E2E

**Fluxo completo pela API** (`full-flow.test.ts`, painel + 4 tablets + André): 1–3 cliente,
pedido e retirada; 4 logística executa; 5 recebimento; 6 OS; 7–8 medição e aprovação; 9 compras;
10 chegada do material (tablet); 11 estoque e reservas; 12 programação; 13 chegada da equipe;
14 preparação; 15 execução paralela; 16–17 pedido de ajuda atribuído; 18 falta de material;
19 central de atenção; 20 delegação; 21 resolução e verificação; 22 retomada; 23 etapas
concluídas; 24 inspeções; 25 reprovação; 26 correção; 27 aprovação; 28 embalagem; 29 agenda;
30 entrega peça a peça; 31 financeiro (cobrança, recebimento, frete, produção liberada e paga);
32 resultado da OS (materiais 12×R$ 45,00 + 2×R$ 18,90, mão de obra R$ 1.250,00, logística
R$ 150,00, imposto estimado R$ 210,00; painel com 1 pedido concluído). Cancelamentos, devoluções,
ausências e reprogramações: cobertos pelos testes das Fases 7–12 (`remediation.test.ts` para
devoluções parciais/totais).

**Navegador (Playwright)** — 13 specs, **21/21 passando** (execuções completas finais: 5,9 min
e 6,5 min com capturas; uma execução intermediária às 00:01 de Brasília falhou em 3 testes pela
dependência de horário — pendência 15, corrigida),
incluindo:

- `team-workshop`: painel + quatro tablets abertos ao mesmo tempo — chegada, início simultâneo,
  queda de conexão do Márcio enquanto o gestor muda a prioridade, conclusões, inspeção nascendo em
  tempo real no tablet do Thiago, reconexão com o estado atualizado e sem duplicidade.
- `zz-visual-audit`: auditoria visual (§14).

## 10. Testes de desempenho

Local, sem serviços externos (`pnpm --filter @cenario/api perf`), 4 vCPU Xeon 2,1 GHz, 16 GB,
Node 22.22, PostgreSQL 16 local. Volume sintético gerado pela API: 120 OS, 240 peças, 480 tarefas,
1.203 eventos. Latência in-process (`app.inject`, sem rede), 20 execuções sequenciais + 5
simultâneas. Bruto em `docs/evidencias/fase-12/desempenho.json`.

| Consulta                         | p50          | p95      | 5 simultâneas (máx.) |
| -------------------------------- | ------------ | -------- | -------------------- |
| OS: lista (100)                  | 17 ms        | 20 ms    | 53 ms                |
| OS: detalhe                      | 17 ms        | 27 ms    | 38 ms                |
| Planejamento semanal (publicado) | 478 ms       | 608 ms   | 1.054 ms             |
| Quadro de produção               | 153 ms       | 392 ms   | 516 ms               |
| Central de atenção               | 29 ms        | 38 ms    | 54 ms                |
| Compras: necessidades            | 8 ms         | 10 ms    | 15 ms                |
| Estoque                          | 6 ms         | 8 ms     | 10 ms                |
| Prontidão de materiais           | 275 ms       | 299 ms   | 723 ms               |
| Pedidos: lista                   | 22 ms        | 26 ms    | 45 ms                |
| Financeiro: contas a receber     | 123 ms       | 134 ms   | 568 ms               |
| **Financeiro: painel do mês**    | **3.709 ms** | 3.822 ms | 3.536 ms (2)         |
| Financeiro: resultado de uma OS  | 39 ms        | 44 ms    | 80 ms                |

- Publicação de planejamento com 40 OS: **6,8 s** (antes da correção: erro 500).
- Tempo real: 40 clientes conectados, sinal até todos receberem p50 42 ms / p95 46 ms.
- Upload de foto (PNG 233 KB): p50 22 ms, máx. 189 ms.
- Processamento de eventos: ~200 eventos/s (3.223 em 15,9 s).
- Memória do processo de teste: 1.159 MB RSS (inclui o gerador de volume).

Não foram feitos testes de carga com usuários reais, rede real nem contra serviços externos.

## 11. Sincronização

`sync-audit.test.ts` (5 cenários) + E2E:

- Painel + 4 tablets simultâneos: todos recebem as mudanças; nenhuma tarefa concluída duas vezes.
- Queda e reconexão: eventos perdidos reenviados pela sequência (`resume`); eventos atrasados e
  repetidos não duplicam efeito (idempotência + versão).
- Reinício da API com clientes conectados: reconexão e recuperação do estado; eventos pendentes
  processados depois do reinício (consumidores guardam a posição no banco).
- Permissão retirada e dispositivo revogado: efeito imediato (403 e WebSocket encerrado).
- Defeito encontrado e corrigido: reconexão tardia no navegador ao voltar a rede (§5.9).

## 12. Backup e restauração

- `pnpm test:backup` (ampliado nesta fase), **passou**: backup com banco + arquivo real
  (anexo + `stored_files`), backup adulterado é **recusado** pelo checksum, restauração num banco
  isolado, SHA-256 do arquivo restaurado igual, `prisma migrate status` em dia, contagens idênticas
  de todas as tabelas principais, incluindo `stored_files`, `attachments`, `event_consumers`,
  `user_permissions`, `piece_returns`, `_prisma_migrations` e a sequência máxima de eventos
  (= eventos pendentes preservados), e imutabilidade preservada.
- Na pilha de homologação local (§17): backup pelo contêiner `postgres:16` e restauração num banco
  separado com contagens e hash dos arquivos idênticos.
- Procedimento de recuperação documentado em `OPERACAO.md` ("Procedimento de recuperação").

## 13. CI

- Execuções #1–#27: **todas vermelhas** (código-fonte ignorado — §2).
- #28 (`fb1d47f`), #29 (`cd84216`) e #30 (`acd2a59`): **verdes** no GitHub Actions, com formatação,
  lint, typecheck, auditoria de dependências, migrations (do zero, status, diff), build, testes,
  backup/restauração e E2E.
- #31 (`4bcb53e`, já com os E2E dos quatro tablets e a auditoria visual): **verde**.
- Execução do commit deste relatório: conferida no GitHub depois do push e informada na entrega;
  não é presumida a partir dos resultados locais.

## 14. Auditoria visual

`zz-visual-audit.spec.ts` visita **todas as 46 telas do painel** (com registros reais) em desktop
(1440), tablet (820) e celular (390), e as telas principais do tablet em tablet e celular:
**144 combinações**. Resultado final: **0 erros de JavaScript, 0 erros de console, 0 rolagens
horizontais, 0 telas sem título**. Na primeira execução: 7 combinações com rolagem horizontal e 3 sem título; na
segunda, 1 rolagem (reprogramação no celular) (corrigidas — §5.10). Também removidos: abas desativadas "fase futura" da OS e textos
desatualizados. Capturas em `docs/evidencias/fase-12/{desktop,tablet,celular}/` e o resultado em
`auditoria-visual.json`.

Limites: automatizado em Chromium. **Não testado** em Safari/iPhone real nem nos tablets físicos;
acessibilidade verificada só em títulos, rótulos e navegação por teclado dos testes (sem leitor de
tela).

## 15. Riscos residuais

| Risco                                                                                        | Impacto | Tratamento                                                                          |
| -------------------------------------------------------------------------------------------- | ------- | ----------------------------------------------------------------------------------- |
| Painel financeiro 3,7 s com 120 OS (resultado calculado OS a OS)                             | Médio   | Aceitável na escala da oficina; otimizar antes de crescer (cache/consulta agregada) |
| Publicar planejamento grande: 6,8 s com 40 OS                                                | Baixo   | Funciona (limite 60 s); semana típica tem menos OS                                  |
| `braces` (alerta alto) no lint                                                               | Baixo   | Não executa em produção; reavaliar nas atualizações                                 |
| Revisões manuais do gestor (reservas sem peça, valores com execução)                         | Baixo   | Intencional: nada é inferido; aparece no detalhe e nos avisos                       |
| Safari/iPhone e tablets físicos não testados                                                 | Médio   | Roteiro da homologação (HOMOLOGACAO.md §5–6)                                        |
| HTTPS com domínio real (Let's Encrypt) não testado; só certificado local do Caddy            | Médio   | Primeira verificação ao subir a homologação                                         |
| Sem teste de carga com rede e usuários reais                                                 | Baixo   | Equipe pequena; medir na homologação                                                |
| Imagem Docker grande (~3,6 GB na variante verificada; inclui ferramentas de desenvolvimento) | Baixo   | Aceitável em homologação; enxugar antes da produção                                 |
| Limite de requisições em memória (uma instância)                                             | Baixo   | Documentado em SEGURANCA.md                                                         |

## 16. Matriz Go/No-Go

| Área                                             | Situação               | Base                                                                |
| ------------------------------------------------ | ---------------------- | ------------------------------------------------------------------- |
| Autenticação, sessões e dispositivos             | APROVADA               | Testes de auth/devices, revogação imediata, varredura               |
| Permissões e isolamento (inclusive André/Izaías) | APROVADA               | Varredura de ~300 rotas × 4 perfis                                  |
| Clientes, pedidos, retiradas, recebimentos       | APROVADA               | Testes + fluxo completo + E2E                                       |
| OS e medições                                    | APROVADA               | Testes + E2E                                                        |
| Compras e estoque                                | APROVADA               | Testes, concorrência no último saldo, saldo encerrado               |
| Planejamento e produção                          | APROVADA COM RESSALVAS | Publicação de 40 OS em 6,8 s; leitura do plano ~0,5 s               |
| Presença, ajuda, reprogramação                   | APROVADA               | Testes + E2E                                                        |
| Central de atenção e ocorrências                 | APROVADA               | Testes + E2E                                                        |
| Qualidade, embalagem, entregas, logística        | APROVADA               | Entrega só com inspeção aprovada (testes + fluxo completo)          |
| Devoluções                                       | APROVADA COM RESSALVAS | Correto; casos ambíguos dependem de revisão do gestor (por desenho) |
| Financeiro e indicadores                         | APROVADA COM RESSALVAS | Sem duplicidade; painel lento com volume (3,7 s)                    |
| Sincronização e tempo real                       | APROVADA               | Testes + E2E com 4 tablets; defeito de reconexão corrigido          |
| Integridade do banco                             | APROVADA               | Falhas forçadas sem registro parcial; triggers; CHECKs              |
| Backup e restauração                             | APROVADA               | Teste automático + pilha de homologação local                       |
| CI                                               | APROVADA               | #28–#30 verdes no GitHub (ver §13/§19 para as seguintes)            |
| Telas e responsividade (Chromium)                | APROVADA COM RESSALVAS | 144 combinações sem defeito; Safari/iPhone **não testado**          |
| Tablets físicos e iPhone                         | NÃO TESTADA            | Depende da homologação                                              |
| Ambiente de homologação em nuvem                 | NÃO TESTADA            | Pilha verificada localmente; nada publicado                         |
| Desempenho com usuários e rede reais             | NÃO TESTADA            | Só medição local                                                    |

**Bloqueios:** nenhum. Nenhuma das condições impeditivas foi encontrada em aberto (falha crítica
de segurança, corrupção de dados, duplicidade financeira, perda de tarefas, liberação indevida de
produção, entrega sem inspeção válida, falha grave de permissão, inconsistência de estoque ou
falha de restauração).

**Decisão recomendada:** **GO para homologação** com dados fictícios e a equipe real.
**NO-GO para operação real** até a homologação cobrir os itens "NÃO TESTADA" e você autorizar.

## 17. Preparação de homologação

Entregue (nada publicado): `infra/homolog/` — `Dockerfile` (API e web, usuário sem privilégios,
migrations na partida, healthcheck), `docker-compose.homolog.yml` (PostgreSQL sem porta pública,
API, web, Caddy com HTTPS automático e `noindex`, backup diário `postgres:16` com 14 dias),
`Caddyfile.homolog`, `env.homolog.example` (sem segredos); `.dockerignore`;
`scripts/homolog-dados-sinteticos.mjs`; guia `docs/HOMOLOGACAO.md` (subida, contas de teste,
dados sintéticos, iPhone/Safari, os 4 tablets, roteiro, logs, backups, controle de acesso,
encerramento). Nenhum serviço pago é necessário.

**Verificação local da pilha (executada):**

| Item                                                                                                            | Resultado |
| --------------------------------------------------------------------------------------------------------------- | --------- |
| Imagens API e web construídas; compose válido                                                                   | OK\*      |
| PostgreSQL saudável; API aplicou as 12 migrations na partida e ficou saudável (`staging`)                       | OK        |
| Seed (gestor de teste, equipe, checklists)                                                                      | OK        |
| Caddy em `https://localhost` (certificado local): HTTP→HTTPS 308, HSTS, CSP, `X-Frame-Options`, `noindex`       | OK        |
| Login sem `Origin` / com origem estranha → 403; login → cookie `__Host-` `Secure` `HttpOnly`                    | OK        |
| Rota protegida anônima → 401; autenticada → 200                                                                 | OK        |
| Navegador (celular 390 px): login, tempo real `wss://…/api/realtime` online, lista de OS, sem erros nem rolagem | OK        |
| Script de dados sintéticos (3 clientes com pedido, recebimento e OS) pela HTTPS                                 | OK        |
| Upload de foto; backup pelo contêiner; restauração num banco separado; contagens e hash dos arquivos idênticos  | OK        |

\* Neste ambiente a política de rede bloqueia `deb.debian.org`; a verificação usou uma cópia
temporária do Dockerfile com a imagem base completa `node:22-bookworm` (que já traz o OpenSSL)
no lugar de `slim` + `apt-get install openssl`. Essa única linha do Dockerfile real **não foi
executada aqui**. Os demais passos são idênticos.

## 18. Recomendações de implantação

1. Subir a homologação (HOMOLOGACAO.md) numa VM com domínio de teste; confirmar o certificado.
2. Executar o roteiro com o gestor, os 4 tablets físicos e os celulares de André e Izaías
   (Safari), por pelo menos uma semana de programação completa.
3. Testar uma restauração na própria VM (banco separado) e a revogação de um tablet.
4. Antes da produção: banco, segredos e armazenamento **novos**; backup diário com cópia externa
   criptografada; monitorar `GET /api/ready`; acesso ao banco só pela rede interna.
5. Otimizar o painel financeiro se o volume mensal crescer; enxugar a imagem Docker.
6. Manter o CI verde como condição para qualquer atualização.

## 19. Evidências

- Testes locais finais: `pnpm check` (formatação, lint, typecheck, API 295, shared 53, web 6) —
  passou; `pnpm test:backup` — passou; `pnpm test:e2e` — 21/21.
- Desempenho: `docs/evidencias/fase-12/desempenho.json`.
- Auditoria visual: `docs/evidencias/fase-12/auditoria-visual.json` (as 144 combinações) e capturas
  de 14 telas representativas por tamanho de tela (as demais são geradas com `E2E_EVIDENCE=1`);
  quatro tablets: `docs/evidencias/fase-12/quatro-tablets-*.png`.
- CI: GitHub Actions do repositório, execuções #28–#31 verdes; as execuções dos últimos commits são
  conferidas e informadas na mensagem de entrega.
- Testes novos: `apps/api/test/{security-audit,integrity-audit,sync-audit,remediation,full-flow}.test.ts`,
  `tests/e2e/specs/{team-workshop,zz-visual-audit}.spec.ts`, `apps/api/perf/performance.perf.ts`.

## 20. Próximos passos (aguardando autorização)

1. Autorizar a subida do ambiente de homologação (VM e domínio de teste) — nada foi publicado.
2. Homologação com a equipe (roteiro em HOMOLOGACAO.md §7) e registro de divergências.
3. Correções da homologação, se houver; nova rodada de CI e E2E.
4. Plano de implantação em produção, somente após aprovação explícita.
