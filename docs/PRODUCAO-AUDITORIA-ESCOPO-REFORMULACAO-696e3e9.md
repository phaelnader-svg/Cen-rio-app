# Auditoria de escopo — reformulação (Fases 0 a 4) × versão `696e3e9` em produção

14/11/2026. Somente leitura: nenhuma alteração e nenhum deploy.

## Conclusão

**A reformulação foi implementada como camadas novas sobre o sistema antigo, não como
simplificação por remoção.** Os próprios relatórios registram essa escolha de projeto em cada fase:

- **Fase 0:** "padrão = tudo ligado"; "Nada é apagado" (`REFORMULACAO-FASE-0-RELATORIO.md` §1, §3).
- **Fase 1:** "O fluxo formal **continua existindo e funcionando** abaixo da lista simples"; entrega
  pela logística "Igual. **Mais:** aba Entrega"; estoque formal "Inalterado"; interruptores com padrão
  ligado, e "Em uma instalação existente **nada muda sozinho**" (`REFORMULACAO-FASE-1-RELATORIO.md`
  §6, §7, §8, §10).
- **Fase 2:** "Nada removido: cada conteúdo antigo está numa das 6 abas"; recebimento "mesmas telas,
  regras e permissões" (`REFORMULACAO-FASE-2-RELATORIO.md` §1).
- **Fase 3:** itens saíram do menu, com "páginas, rotas e permissões preservadas"
  (`REFORMULACAO-FASE-3-RELATORIO.md` §1.5).
- **Fase 4:** "mantém a linha de base de rotas de 9fb1786 intacta" (commit `d3fd4c6`); a trava
  estrutural congela as rotas (`REFORMULACAO-CONSOLIDADO-F0-F4.md` §2).
- **Consolidado:** "Dois estoques coexistem"; "Travas de materiais na produção ligadas por padrão"
  (§3.2).

Resultado medido: **o menu passou de 35 para 34 itens** (`apps/web/components/admin/nav.ts`,
`7b4177b` × `696e3e9`). Com todos os interruptores desligados, chegaria a 31: só "Retiradas",
"Roteiro do dia" e "Pedidos de ajuda" dependem deles. Em produção, os interruptores estão todos no
padrão ligado (`module_settings` = 0 linhas).

**Limitação:** o texto original do seu pedido da reformulação **não está em nenhum documento do
repositório**, em nenhum branch. Os relatórios registram só o "escopo autorizado" de cada fase. A
coluna "requisito" abaixo usa esse registro. Onde o seu pedido (remover ou simplificar) não aparece
nele, isso está indicado.

## Tabela ANTES → REQUISITO REGISTRADO → DEPOIS REAL → PENDÊNCIA

| # | Antes (`7b4177b`) | Requisito registrado (documento) | Depois real (`696e3e9` em produção) | Pendência para a simplificação |
|---|---|---|---|---|
| 1 | Pedidos de ajuda: tablet, fila automática, Central, avisos, menu | F0: "Desativação operacional dos pedidos de ajuda… reversível"; interruptor com **padrão ligado** (FASE-0 §1, §3; `cca903d`) | **Continua tudo presente**: o interruptor está ligado | Desligar em Empresa → Funcionalidades (configuração, sem código), ou removê-lo do produto (código) |
| 2 | Logística: Retiradas, Roteiro do dia, Expedição e entregas, tablet do motorista, custo de viagem | F1: logística **configurável, padrão ligado**; entrega pela OS **somada** à logística (FASE-1 §5, §8, §10; `2b394a1`) | **Continua tudo presente**; a entrega pela OS é uma alternativa a mais | Desligar a logística esconde só Retiradas e Roteiro. "Expedição e entregas" e "Devoluções" continuam (código) |
| 3 | Compras formais: requisito → aprovação → compra → recebimento; Compras, Fornecedores, Materiais aprovados, Prontidão de materiais | F1: lista simples na OS; "o fluxo formal **continua existindo e funcionando**"; travas de material **ligadas** (FASE-1 §6; Consolidado §3.2) | **Os dois fluxos coexistem**; produção ainda trava por material formal | Remover ou esconder o fluxo formal, ou torná-lo um interruptor desligado por padrão (código); desligar "Travas de materiais" (configuração) |
| 4 | Recebimento de materiais (painel e tablet) | F2 #8: "reunido em 'Aguardando chegada'… **mesmas telas, regras e permissões**" (FASE-2 §1; `bb3a575`) | Item de menu "Recebimento de materiais" **mantido**; no tablet, só reagrupado | Removê-lo, ou tirá-lo do menu junto com as compras formais (código) |
| 5 | Estoque formal (`/painel/estoque`) | F1: estoque formal "**Inalterado**" + "Estoque da oficina" novo (FASE-1 §7); "Dois estoques coexistem" (Consolidado §3.2.1) | **Dois estoques** no menu | Unificar num estoque só (código e decisão) |
| 6 | Medições (painel, tablet, rotina de sexta) | **Nenhum requisito de medições nas Fases 0 a 4** (0 menções nos relatórios das Fases 0, 1, 2 e 4; na Fase 3, só o link de "Planejamento de sexta" foi movido para Medições) | **Inalterado** | Nunca entrou no escopo: requisito novo, a ser especificado |
| 7 | Planejamento: 2 telas (A planejar + Planejamento de produção) e Planejamento de sexta | F3 #3/#5: uma tela, "Programação semanal"; itens fora do menu, com páginas e rotas **preservadas** (FASE-3 §1; `0eab71e`, `d3fd4c6`) | **Entregue no menu**; as telas antigas abrem pela URL | Apagar as rotas antigas, se for o desejado (exige soltar a trava de rotas) |
| 8 | Competências da equipe no menu | F3 #5: saiu do menu; link na Programação semanal | Entregue (fora do menu; página preservada) | — |
| 9 | OS com ~10 abas | F2 #1: 6 abas, "Nada removido" (FASE-2 §1; `de327ec`) | Entregue (visível ao abrir uma OS) | — |
| 10 | Qualidade com conferência item a item; gestor sem poder aprovar a própria execução | F3 #1: "Tudo conforme — aprovar"; autoaprovação justificada (FASE-3 §1; `0eab71e`) | Entregue | — |
| 11 | Embalagem obrigatória | F3 #2: embalagem **opcional por interruptor**, padrão ligado (FASE-3 §1) | **Continua obrigatória** (interruptor ligado) | Desligar em Empresa → Funcionalidades (configuração) |
| 12 | Modelos de produção | F2 #4/#5: "Modelos de serviço" com materiais padrão e sugestão na OS (FASE-2 §1; `3fbdb3f`) | Entregue (renomeado e ampliado) | — |
| 13 | Fotos com GPS/EXIF | F2 #6/#7: tratamento seguro e visualizador (`8bf69b6`) | Entregue | — |
| 14 | — | F4: painel "Hoje", alertas internos, ações sugeridas, produtividade (FASE-4 §1; `2bba804`) | Entregue, como **camada nova** | — |
| 15 | Menu com 35 itens | F3: "Área Produção de 11 para 8" | **34 itens** no total | Redução real do menu depende dos itens 1 a 7 |

## O que mudou de fato para o usuário (sem contar o que já existia)

**Novo:**

- OS em 6 abas, com estado e próximo passo no cabeçalho;
- lista simples de materiais na OS;
- entrega direta pela OS (e desfazer);
- Estoque da oficina;
- Mapa da oficina;
- Modelos de serviço com materiais padrão;
- Programação semanal (fusão de 2 telas);
- qualidade "Tudo conforme" e autoaprovação justificada;
- embalagem e logística desligáveis;
- Empresa → Funcionalidades;
- painel "Hoje", alertas e produtividade;
- fotos sem GPS, com miniaturas;
- logo nova.

**Removido:** 4 itens de menu, com as páginas mantidas. **Nenhuma funcionalidade foi removida.**

## Correções que faltam para a simplificação por remoção

**Sem código** (configuração pelo gestor em Empresa → Funcionalidades; muda a produção):

- desligar Pedidos de ajuda;
- desligar Logística (o banco está vazio, então não há entrega em andamento que recuse);
- desligar Travas de materiais;
- desligar Embalagem obrigatória.

**Com código** (nova fase; precisa de especificação aprovada por escrito antes):

1. Registrar num documento o requisito original: o que **sai do produto** × o que só fica
   escondido.
2. Tirar do menu e dos fluxos, ou tornar desligado por padrão em instalação nova:
   - Compras, Fornecedores, Materiais aprovados, Prontidão de materiais e Recebimento de materiais;
   - Expedição e entregas e Devoluções;
   - Reprogramação e Quadro, se for o caso;
   - Medições (escopo novo).
3. Um estoque só (decidir entre o formal e o da oficina).
4. Apagar as rotas antigas de planejamento e soltar a "linha de base de rotas de 9fb1786" na trava
   estrutural (`apps/api/test/rodada4-travas-estruturais.test.ts`).
5. Tablet: conferir o que ainda aparece de ajuda, recebimento e medições.
