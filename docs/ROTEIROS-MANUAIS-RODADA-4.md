# Roteiros manuais — Rodada 4 (Safari/WebKit, tablets físicos e rede real)

Remediação pós-auditoria, Rodada 4. Este documento cobre o que **não tem prova automatizada
possível neste ambiente**. Os itens correspondentes continuam **NÃO COMPROVADOS** até alguém
executar o roteiro e registrar o resultado na tabela do fim.

- **Safari/WebKit (F4-21):** o ambiente de testes só tem Chromium (`/opt/pw-browsers`). Baixar
  outro navegador está fora da política. Por isso o WebKit não roda automaticamente.
- **Tablets e celulares físicos (F4-21):** o E2E emula toque e viewport no Chromium. Isso não
  substitui o aparelho real.
- **Rede real:** a parte automatizável está automatizada, mas em navegador emulado. Ela fica
  separada do teste físico:
  - queda e volta da conexão (`context.setOffline`), em `tablets.spec.ts`, `team-week.spec.ts`
    e `team-workshop.spec.ts`;
  - resposta perdida e repetição idempotente, em `novo-servico-rede.spec.ts` e
    `recebimentos-rede.spec.ts`;
  - reconexão do tempo real e sincronização, em `tablet-sync.spec.ts`.

  Wi-Fi da oficina, troca de rede e 4G só se provam com aparelho.

Use **sempre** a homologação (nunca produção) e dados fictícios marcados "Teste R4".

## 0. Preparação (gestor)

1. Abra a homologação pelo endereço do runbook (`docs/HOMOLOGACAO-GCP-ACESSO-SAFARI.md`).
2. Confirme no rodapé/`/api/health` a versão em homologação (SHA do relatório da Rodada 4).
3. Tenha à mão: um tablet Android ou iPad, um iPhone com Safari e um MacBook com Safari.
4. Em **Funcionários**, defina PINs de teste para um tapeceiro e para o André (logística).

## 1. Safari no MacBook (painel do gestor)

Em cada passo, confira **sem rolagem horizontal** e com textos legíveis em 1280 e 1440 px.

| #   | Fluxo        | Passos                                                                                       | Esperado                                                                  |
| --- | ------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1.1 | Login        | Entrar com e-mail e senha; fechar e reabrir a aba                                            | Painel abre; "Tempo real ativo" verde; sessão mantida                     |
| 1.2 | Novo serviço | Início → Novo serviço; cliente novo; 1 peça com titular e mão de obra; retirada terceirizada | Confirmação com PC-xxxxx; o pedido abre; um clique duplo não duplica      |
| 1.3 | Central      | Central de atenção; abrir 1 item por categoria pelo link "Abrir"                             | O link leva ao registro exato, destacado; nada de R$ para quem não pode   |
| 1.4 | Compras      | Compras → selecionar necessidade → Criar pedido → Salvar → Confirmar                         | CP-xxxxx confirmado; "A comprar" atualizado sem recarregar                |
| 1.5 | Planejamento | Produção → A planejar → Planejar → Revisar e publicar                                        | A OS sai de "A planejar"; a prévia lista as pessoas certas                |
| 1.6 | Fechamento   | Financeiro → Fechamento semanal → Registrar pagamento (revisar → confirmar)                  | Sem confirmação do profissional: recusado; após a confirmação: PF-xxxxx   |
| 1.7 | Entrega      | Entregas → Prontas → Agendar (data, horário, responsável)                                    | Entrega agendada aparece na Agenda e no celular do responsável na hora    |
| 1.8 | Datas        | Campos de data/hora em Novo serviço, Planejamento e Entregas                                 | Seletor nativo do Safari funciona; valor salvo é o escolhido (sem −1 dia) |

## 2. Tablet físico (oficina)

| #   | Fluxo        | Passos                                                                    | Esperado                                                                            |
| --- | ------------ | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 2.1 | Vinculação   | Dispositivos → Cadastrar → digitar o código no tablet → PIN               | Entra direto na tela do funcionário; teclado do PIN responde ao toque               |
| 2.2 | Chegada      | "Cheguei"; Aguardando chegada → Confirmar chegada                         | Presença registrada; OS-xxxxx criada; outro tablet vê a peça sumir em segundos      |
| 2.3 | Materiais    | Materiais → recebimento → quantidades → "Conferi referência…" → Confirmar | RM-xxxxx; nenhum preço na tela                                                      |
| 2.4 | Minha semana | Iniciar → Concluir → tocar de novo para confirmar                         | Próxima tarefa aparece; botões grandes; nada de valores                             |
| 2.5 | Qualidade    | Inspeções → Iniciar → checklist → Aprovar                                 | Embalagem nasce para quem está disponível                                           |
| 2.6 | Meus Ganhos  | Meus Ganhos → PIN → conferir → "Conferi os itens e valores" → Confirmar   | Só os próprios valores; após 5 min pede o PIN de novo; nenhum valor de outra pessoa |
| 2.7 | Orientação   | Girar o tablet (retrato/paisagem) em cada tela acima                      | Layout se ajusta sem cortar botões                                                  |

## 3. Celular físico (logística — iPhone com Safari)

| #   | Fluxo    | Passos                                                                                | Esperado                                         |
| --- | -------- | ------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 3.1 | Roteiro  | Vincular; Hoje/Amanhã                                                                 | Paradas na ordem, com horário de chegada; sem R$ |
| 3.2 | Retirada | "Saí para a retirada" → "Peças retiradas"                                             | Status muda; o painel atualiza sozinho           |
| 3.3 | Entrega  | "Saí para entrega" → "Cheguei" → "Confirmar peças" → "Registrar" → "Concluir entrega" | Concluída; a peça fica "Entregue" no painel      |
| 3.4 | Ganhos   | Meus Ganhos com PIN                                                                   | Só as próprias viagens (LG-xxxxx)                |

## 4. Rede real (aparelhos físicos)

| #   | Situação                   | Como provocar                                              | Esperado                                                                                    |
| --- | -------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 4.1 | Queda durante uma ação     | No meio de "Confirmar chegada", desligar o Wi-Fi do tablet | Aviso de sem conexão; ao voltar, a ação não duplica (mesma OS)                              |
| 4.2 | Resposta perdida           | Concluir tarefa e cortar a rede logo após tocar            | Ao voltar: "já registrado" ou estado concluído; uma única conclusão no histórico            |
| 4.3 | Troca de rede              | Celular do André: Wi-Fi → 4G no meio do roteiro            | Indicador volta a "Tempo real ativo"; eventos perdidos chegam (sincronização), sem duplicar |
| 4.4 | Tablet dormindo            | Bloquear a tela por 10 min e reabrir                       | Reconecta sozinho; nada de dados antigos na tela                                            |
| 4.5 | Duas pessoas na mesma ação | Dois tablets confirmam a mesma chegada ao mesmo tempo      | Um confirma; o outro mostra "já confirmado por outra pessoa" e recarrega                    |

## 5. Registro do resultado

| Roteiro | Aparelho / navegador | Versão (SHA) | Data | Quem executou | Resultado (OK/Falhou) | Observações |
| ------- | -------------------- | ------------ | ---- | ------------- | --------------------- | ----------- |
| 1       | MacBook / Safari     |              |      |               |                       |             |
| 2       | Tablet               |              |      |               |                       |             |
| 3       | iPhone / Safari      |              |      |               |                       |             |
| 4       | Tablet + iPhone      |              |      |               |                       |             |

Qualquer "Falhou" volta como bug com: passo, aparelho, versão, esperado × obtido e captura.
