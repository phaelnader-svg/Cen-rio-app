# Reformulação — consolidado das Fases 0 a 4

Documento de decisão para a homologação integrada. **Nada aqui foi executado** em homologação,
produção ou branch padrão: é plano. A implantação integrada depende de autorização específica.

Estado atual dos ambientes (inalterado nesta etapa): homologação ativa `3e0d2d0` (Fase 1, com a
migration `20270309000000`), candidata `de31aa7`, candidatas de retorno
`claude/retorno-5ff1597-fase0` e `claude/retorno-a7f4f93-fase1`, branch padrão e produção sem
mudança.

## 1. Branches e commits

| Fase | Branch                       | Base      | Commit final             | Migration                            |
| ---- | ---------------------------- | --------- | ------------------------ | ------------------------------------ |
| 2    | `claude/reformulacao-fase-2` | `3e0d2d0` | `dcae84f` (aprovada)     | `20270316000000_reformulacao_fase_2` |
| 3    | `claude/reformulacao-fase-3` | `dcae84f` | `781e3b8` (com reversão) | `20270323000000_reformulacao_fase_3` |
| 4    | `claude/reformulacao-fase-4` | `781e3b8` | ponta do branch (¹)      | nenhuma                              |

(¹) O commit que contém este documento; informado no encerramento. A ponta de
`claude/reformulacao-fase-4` contém as Fases 2, 3 e 4 sobre `3e0d2d0`.

## 2. Resultados de testes (rodada final, ambiente isolado)

Ver a seção 8 — preenchida com os números da rodada final da ponta da Fase 4.

## 3. Pendências e riscos consolidados

### 3.1 Ressalvas abertas (sem evidência nova — não tratar como resolvidas)

1. **Fotos antigas (F2):** continuam com GPS/EXIF no arquivo até a migração em lotes, que exige
   backup e autorização. O acesso comum já não expõe.
2. **CPU do tratamento de imagem na VM (F2):** não medido na VM. [NÃO TESTADO]
3. **Versão de retorno integrada:** não construída (seção 5).
4. **Validação funcional em homologação:** nada das Fases 2–4 foi validado lá.
5. **Tablet físico e Safari:** não testados nas Fases 0–4.

### 3.2 Decisões de negócio ainda registradas

1. (F1) Dois estoques coexistem (formal e da oficina); sem unificação.
2. (F1) Dupla contagem formal + lista simples só gera aviso (`mixedSources`) e conciliação manual.
3. (F1) Travas de materiais na produção **ligadas** por padrão (comportamento antigo); para
   "produção não bloqueada por material", o gestor desliga em Empresa → Funcionalidades.
4. (F1) Entrega direta entrega **todas** as peças pendentes da OS de uma vez.

### 3.3 Riscos técnicos e operacionais

| #   | Fase | Risco                                                                                                     | Mitigação                                                  |
| --- | ---- | --------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 1   | 0    | DTO futuro com outro nome de campo de cliente escaparia do filtro global                                  | Varredura automática nos testes                            |
| 2   | 1    | Conciliação de materiais depende de decisão humana (custo a maior enquanto pendente; nunca a menor)       | Valor em risco exibido no resultado                        |
| 3   | 1    | Lançamento manual `AJUSTE_MANUAL` fora da conciliação                                                     | Orientação operacional                                     |
| 4   | 2    | Retorno a código anterior volta a gravar fotos sem tratamento                                             | Retorno só em incidente; seção 6                           |
| 5   | 3    | Peças aprovadas **sem embalagem** e não entregues aparecem como "aguardando embalagem" no código anterior | Entregar ou religar a embalagem antes do retorno (seção 6) |
| 6   | 3    | Autoaprovação do gestor é exceção de controle                                                             | Justificativa ≥ 10 caracteres + auditoria destacada        |
| 7   | 3    | Entrega direta **desfeita**: o código anterior não conhece o estado "desfeita"                            | `.down.sql` recusa; retorno exige conferência (seção 6)    |
| 8   | 3    | Reversão bloqueada por pagamento/fechamento conferido só pode ser corrigida por suporte                   | Bloqueio intencional (regra aprovada)                      |
| 9   | 4    | Alertas com até 5 min de atraso; volume sem limite numa oficina com muitas OS atrasadas                   | Limites em `today.ts`; painel "Hoje" é em tempo real       |
| 10  | 4    | "Pronta desde" sem evento de etapa antigo conta 0 dia (alerta a menos, nunca a mais)                      | Aceito                                                     |
| 11  | 4    | Retorno a código anterior com avisos de tipos novos abertos                                               | Resolver os avisos antes (seção 6)                         |
| 12  | E2E  | Instabilidades pontuais (`team-issues`, `measurements`) observadas uma vez cada, não reproduzidas         | Registradas; investigadas como não ligadas às fases        |

## 4. Plano de implantação na homologação integrada (não executar sem autorização)

Pré-requisitos: autorização específica; janela combinada; nenhum uso de credenciais de produção;
mesmo executor e procedimento das VMs já usados na Fase 1.

1. **Conferências antes:** espaço em disco da VM; versão ativa `3e0d2d0`; `_prisma_migrations`
   com `20270309000000` aplicada e **sem** `20270316…`/`20270323…`.
2. **Backup** completo do banco de homologação (`scripts/backup.sh`) e do armazenamento de fotos;
   registrar o ponto de recuperação. Testar a leitura do backup (`scripts/test-backup-restore.sh`
   no procedimento da VM).
3. **Construir as imagens** a partir do SHA final de `claude/reformulacao-fase-4` (aplicação) e,
   em paralelo, a **versão de retorno** (seção 5) — só construir, sem publicar.
4. **Migrations** pelo procedimento normal (`prisma migrate deploy`): aplicam
   `20270316000000_reformulacao_fase_2` e `20270323000000_reformulacao_fase_3`, nessa ordem
   (ambas aditivas; cadeia testada).
5. **Conferências depois:** `prisma migrate diff` sem diferença; contagens de OS, peças, entregas,
   contas iguais às de antes; `deliveries.reverted_at` todo nulo; `quality_inspections.packaging_required`
   todo verdadeiro nas inspeções antigas; `module_settings` sem alteração.
6. **Publicar** a aplicação nova. Os interruptores ficam como estão (embalagem obrigatória ligada,
   travas de materiais ligadas, logística como estiver).
7. **Validação funcional com dados fictícios** (homologação manual integrada, conduzida pelo
   gestor): OS unificada e fotos (novas sem GPS), modelos de serviço, tablets, mapa, qualidade
   "Tudo conforme" e autoaprovação justificada, embalagem desligada e religada, programação
   semanal, entrega direta e **desfazer** (dentro e fora das condições), painel "Hoje", alertas,
   produtividade para quem planeja (sem valores).
8. **Medições pendentes:** CPU do tratamento de imagem na VM; tempo da produtividade com o
   histórico real da homologação.
9. Só depois: decidir sobre a migração das fotos antigas e sobre os interruptores.

## 5. Versão de retorno integrada

Código `3e0d2d0` + as pastas `20270316000000_reformulacao_fase_2` e
`20270323000000_reformulacao_fase_3` byte a byte idênticas (o executor recusa banco com migration
desconhecida pela imagem). Compatibilidade **medida** no ambiente isolado: a suíte de `3e0d2d0`
sobre o schema com as duas migrations → 971 passaram, 1 falha estática esperada (o verificador
antigo lê a lista de pastas), 13 pulados. A Fase 4 não tem migration, então essa compatibilidade
vale também para a ponta da Fase 4. **Não construída** (sem build em nuvem nesta etapa).

Retorno parcial possível (menor impacto): código da Fase 3 (`781e3b8`) sobre o mesmo banco, se o
problema for só da Fase 4 (sem migration envolvida).

## 6. Estratégia de retorno segura

Princípio das fases anteriores: **o banco não volta; volta a aplicação.** Os dados novos ficam
preservados e inertes.

**Antes de voltar para qualquer código anterior**, conferir e tratar:

| Situação                                     | Consulta                                                                                                                                    | Ação antes do retorno                                                                                          |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Avisos da Fase 4 abertos                     | `SELECT count(*) FROM notifications WHERE resolved_at IS NULL AND kind IN ('PRAZO_EM_RISCO','PECA_PRONTA_SEM_ENTREGA','MATERIAL_FALTANTE')` | `UPDATE … SET resolved_at = now()` (só esses tipos)                                                            |
| Peças aprovadas sem embalagem, não entregues | `quality_inspections` com `NOT packaging_required AND status='APROVADA'` cujas peças não estão entregues                                    | Entregar, ou religar a embalagem e embalá-las                                                                  |
| Entregas diretas desfeitas                   | `SELECT count(*) FROM deliveries WHERE reverted_at IS NOT NULL`                                                                             | Ficam no histórico; o código anterior as mostra como entrega concluída antiga — avisar a equipe; nada a apagar |
| Autoaprovações justificadas                  | `quality_inspections.self_approval_reason IS NOT NULL`                                                                                      | Nenhuma: código anterior ignora a coluna                                                                       |
| Fotos tratadas (F2)                          | —                                                                                                                                           | Nenhuma: arquivos e miniaturas continuam; o código anterior volta a gravar fotos novas sem tratamento          |
| Materiais padrão / modelos (F2)              | —                                                                                                                                           | Nenhuma: dados inertes                                                                                         |

Ordem:

1. Incidente só da Fase 4 → publicar `781e3b8` (sem mudança de banco), após resolver os avisos.
2. Incidente das Fases 2–3 → publicar a **versão de retorno integrada** (seção 5), após a tabela
   acima. Religar `embalagem` e `logistica` no painel se tiverem sido desligados.
3. `.down.sql` das Fases 3 e 2 **só** com banco sem dados dessas fases (ex.: falha logo após a
   migration); com dados, recusam sozinhos e sem mutação (testado na cadeia).
4. Último recurso: o ponto de recuperação do passo 2 do plano, com perda do que foi gravado
   depois — só com autorização.

**Fotos:** o retorno não toca o armazenamento. A migração das fotos antigas continua **não
executada**; quando for, terá backup próprio e é irreversível no arquivo (por isso fica para
depois da homologação).

## 7. Restrições cumpridas nesta etapa

Sem deploy; sem merge; sem PR; sem migration em ambiente compartilhado; homologação ativa,
candidata, candidatas de retorno, branch padrão e produção inalterados; nenhuma conta de
produção usada; nenhuma alteração de IAM; nenhum segredo no repositório, logs ou relatórios;
homologação manual integrada **não iniciada**.

## 8. Resultado final

(preenchido abaixo após a rodada final)
