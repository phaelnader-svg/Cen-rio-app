# Plano de reversão por fase

Remediação pós-auditoria, Rodada 3 (F1-14). Este documento reúne, numa tabela só, como cada
fase entregue é revertida. Ele não substitui os relatórios de cada fase. Junta o que estava
espalhado neles e completa o que faltava: Compras 1–3, Cobrança, R1, R2, Presença/Apoio,
Fase 8, Fase 10 e Rodadas 1–3.

## 1. Regra geral (vale para todas as fases)

1. **Antes de publicar**, o fluxo seguro da homologação cria o ponto de recuperação
   (`recovery_point_create`), valida o backup (`backup_validate`) e restaura esse backup num banco
   de teste (`backup_restore_test`). Só então aplica as migrations (`migration_precheck` → `migrate` →
   `migration_verify`).
2. **Reverter só a aplicação** (imagens): volta-se à versão anterior das imagens. Isso vale sempre
   que nenhuma migration nova entrou. Também vale quando a migration nova é aditiva e o código
   anterior a ignora; é o caso de todas as migrations da lista abaixo.
3. **Reverter o banco** pode seguir um destes caminhos:
   - **(a) Reversão condicionada** (`packages/db/rollback/<migration>.down.sql`): o script aborta
     sem alterar nada se já existem dados que a reversão perderia. O registro em
     `_prisma_migrations` é apagado no mesmo script.
   - **(b) Restauração do ponto de recuperação/backup** anterior à migration. É o caminho para as
     migrations sem `.down.sql` e para quando (a) é recusada.
4. Nenhuma reversão é automática. Cada uma pede a aplicação parada, um backup recente e decisão
   humana.

## 2. Por migration

| Fase / entrega                      | Migration                                     | Reversão do banco                            | Condição de recusa / observação                                                 | Prova                                                 |
| ----------------------------------- | --------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Fases 1–12 (base)                   | 20261008000000 … 20261017000000               | (b)                                          | Base do sistema; não há reversão parcial                                        | —                                                     |
| Evolução F2 — fila semanal          | 20261018000000_fila_semanal                   | (a)                                          | Recusa com registro da fila semanal                                             | `test-evolution-migrations.sh` etapas 4 e 6           |
| Evolução F3 — distribuição          | 20261025000000_distribuicao_automatica        | (a)                                          | Recusa com registro da distribuição automática                                  | idem                                                  |
| Evolução F5 — mão de obra           | 20261101000000_mao_de_obra_revisao            | (a)                                          | Recusa com revisão/divisão de obrigação                                         | idem                                                  |
| Evolução F6 — custos logísticos     | 20261108000000_custos_logistica               | (a)                                          | Recusa com registro da Fase 6                                                   | idem                                                  |
| Evolução F7 — fechamento            | 20261115000000_fechamento_semanal             | (a)                                          | Recusa com registro da Fase 7                                                   | idem                                                  |
| Correção global — roteiro           | 20261122000000_roteiro_logistica              | (a)                                          | Incondicional: só a ordem das paradas (sem perda de compromisso)                | idem (etapa 4)                                        |
| Simplificação F2 — Novo serviço     | 20261129000000_novo_servico                   | (a)                                          | Recusa com registro do Novo serviço                                             | idem                                                  |
| Simplificação F3 — recebimentos     | 20261206000000_recebimentos_compartilhados    | (a)                                          | Recusa com registro dos recebimentos compartilhados                             | idem                                                  |
| Simplificação F4 — pré-planejamento | 20261213000000_pre_planejamento               | (a)                                          | Recusa com OS planejada pelo pré-planejamento                                   | idem                                                  |
| Estabilização F3 — permissão        | 20261220000000_recebimentos_permissao_funcoes | (a) incondicional                            | Só dados de permissão (documentado no próprio `.down.sql`)                      | `migrations.test.ts` (instalação existente)           |
| Estabilização F2 — cliente entrega  | 20261227000000_servico_sem_retirada           | (a)                                          | Recusa com pedido de entrega pelo cliente                                       | `migrations.test.ts`                                  |
| Estabilização F2 — titular previsto | 20261228000000_titular_mao_de_obra_prevista   | (a)                                          | Recusa com titular/mão de obra prevista                                         | `migrations.test.ts`                                  |
| Simplificação F5 — modelos          | 20261230000000_modelos_simplificados          | (a)                                          | Recusa com tarefa gerada pelos modelos novos ou configuração em outros modelos  | `migrations.test.ts`, script                          |
| Compras Etapa 2                     | 20270105000000_necessidade_substituicao       | **(b)**                                      | Coluna `status`/predecessora em necessidades; sem `.down.sql`                   | F1-05 (fora do escopo da Rodada 3)                    |
| Compras Etapa 3                     | 20270112000000_compra_antes_da_chegada        | **(b)**                                      | `DROP NOT NULL` + valor de enum novo: reverter exigiria apagar previsões pré-OS | idem                                                  |
| Cobrança do cliente                 | 20270119000000_cobranca_cliente               | **(b)**                                      | Tabela de pagamentos informados + colunas de cobrança                           | idem                                                  |
| R1 — Meus Ganhos                    | 20270126000000_meus_ganhos_permissao          | **(b)** (ou remoção manual das 2 permissões) | Só concede `financeiro.producao_propria` a 2 funções                            | `migrations.test.ts` (Rodada 3, instalação existente) |
| R2 — negociação/confirmação         | 20270202000000_negociacao_confirmacao_semanal | **(b)**                                      | Duas tabelas novas (pedidos e confirmações)                                     | F1-05                                                 |
| Presença/Apoio simplificados        | 20270209000000_presenca_apoio_simplificados   | **(b)**                                      | Feriados, folgas e marcações novas                                              | F1-05                                                 |
| Rodada 2 — avisos resolvidos        | 20270216000000_notificacoes_resolvidas        | (a)                                          | Recusa com aviso já resolvido                                                   | script etapa 5 (reverte e reaplica)                   |
| **Rodada 3**                        | **nenhuma migration**                         | só (2): imagens anteriores                   | —                                                                               | cadeia de 32 migrations inalterada                    |

As seis linhas **(b)** são as reversões históricas que F1-05 aponta. Por instrução do
proprietário, elas ficaram fora da Rodada 3. A reversão delas é o ponto de recuperação e o
backup restaurado do fluxo seguro.

## 3. Por fase de produto (o que voltar e o que se perde)

- **Compras 1–3 / Cobrança / R1 / R2 / Presença-Apoio:** reverter as imagens mantém os dados novos
  (aditivos, ignorados pelo código anterior). Reverter o banco é (b), e com isso se perdem os
  registros criados depois do ponto de recuperação.
- **Fase 8 (qualidade/entrega) e Fase 10 (gestão):** não trouxeram migration própria além das
  listadas. A reversão é só das imagens; a Central e o Início são derivados (nada é gravado por
  eles).
- **Rodadas 1–3 da remediação:** só a Rodada 2 trouxe migration (20270216, reversão (a)). A Rodada
  3 é só código: reverter as imagens desfaz a fila de Recebimentos, o alerta de rascunho, os
  novos itens da Central e do Início, o estado "valor ainda não disponível", o corte de eventos
  por tipo de sessão e as resoluções novas de avisos. Os avisos já marcados como resolvidos
  continuam resolvidos (coluna da Rodada 2), e o código anterior os trata do mesmo jeito.

## 4. Como provar localmente

```
PG_BASE=postgresql://usuario:senha@127.0.0.1:5432 scripts/test-evolution-migrations.sh
```

O que o script faz:

- Banco legado → Evolução (até 20261230): dados idênticos e reversão até o esquema legado
  (`pg_dump -s` idêntico).
- Cadeia completa (32 migrations): dados legados idênticos, salvo as permissões documentadas.
- Leitura pelo código atual.
- Reversão e reaplicação da 20270216.
- Recusa atômica de cada reversão da Evolução com dados novos.
- Backup e restauração.
