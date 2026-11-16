# Autonomia operacional — o que o Claude executa e o que ainda depende do dono

Mandato em `CLAUDE.md`: o Claude executa de ponta a ponta; o dono escolhe, aprova e testa.
Este documento lista cada etapa, quem a executa hoje e a configuração única que elimina a
dependência quando ela não é uma decisão do dono. Atualizado em 16/11/2026.

## Identidades e ambientes (separados)

| Ambiente do Claude Code | Credencial (Network Secret)                          | Alcance                                                                                                                       |
| ----------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Cenário — Homologação   | `claude-operador`                                    | runner da homologação (operações nomeadas), build por gatilho, leitura de imagens da homologação                              |
| Cenário — Produção      | `claude-operador-prod`                               | runner da produção (operações nomeadas), leitura de `cenario-prod`; publicar pedidos de promoção (após a configuração abaixo) |
| Firma Viva — Operação   | `claude-operador-firma` (após a configuração abaixo) | SSH via IAP **só** na VM `firma-teste` (Firma Viva em firmaviva.com.br)                                                       |

Nenhuma credencial aparece em outro ambiente. O operador de produção não tem papel na homologação.

## Etapas

| Etapa                                                                                           | Quem executa hoje                                                         | Depois da configuração única                                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Código, testes, correções, branches                                                             | Claude                                                                    | —                                                                                                                                                                                                                        |
| Build e deploy em homologação (ponto de recuperação, migrations, ativação, verificações)        | Claude (Cenário — Homologação)                                            | —                                                                                                                                                                                                                        |
| **Promoção das imagens para produção**                                                          | Dono, no Cloud Shell (`promover-imagens.sh`)                              | **Claude**: `operar.py promover <sha> <digest-api> <digest-web>` (gatilho `cenario-prod-promocao`, conta `cenario-promocao`, passos fixos) — configuração: `bash infra/prod/gcp/autonomia/bootstrap-promocao.sh aplicar` |
| Deploy em produção (ponto de recuperação, migration, ativação, verificações, reversão)          | Claude (Cenário — Produção), **com a aprovação do dono para cada versão** | — (a aprovação continua sendo decisão do dono)                                                                                                                                                                           |
| **Firma Viva: atualizar, validar, trocar de Cenário, HTTPS do domínio**                         | Dono, no Cloud Shell (`firma-teste.sh`)                                   | **Claude** (Firma Viva — Operação) — configuração: `bash infra/firma-viva/teste/bootstrap-operador-firma.sh aplicar` + Network Secret. O SSH via IAP com o token do proxy é validado no primeiro uso                     |
| Criar infraestrutura nova (VM, IP, firewall, IAM, chaves)                                       | Dono, no Cloud Shell                                                      | continua com o dono: o Claude prepara o script com plano e confirmação                                                                                                                                                   |
| Scripts da VM do Cenário e o runner (`/opt/cenario`)                                            | Dono publica no bucket de versões                                         | continua com o dono por desenho (barreira humana do código que roda como root)                                                                                                                                           |
| DNS (Registro.br / Hostinger)                                                                   | Dono                                                                      | continua com o dono (sem acesso por API)                                                                                                                                                                                 |
| Cadastrar um aplicativo com acesso aos dados de produção (ex.: `firma-viva`) e copiar o segredo | Dono, no painel do Cenário                                                | continua com o dono: é a autorização de acesso aos dados reais e exige o login dele                                                                                                                                      |
| Testes com login pessoal (autorizar com a conta real, senha do proxy da homologação)            | Dono                                                                      | continua com o dono                                                                                                                                                                                                      |

## Pedido único em andamento (Firma Viva ↔ Cenário de produção, modo consulta)

1. Cloud Shell, na raiz do clone (branch `claude/autorizacao-apps-9fb6b03`):
   - promoção desta versão (agora): bloco em `docs/PRODUCAO-DEPLOY-0a2546f-AUTORIZACAO-APPS.md` §4;
   - autonomia da promoção (próximas versões): `bash infra/prod/gcp/autonomia/bootstrap-promocao.sh aplicar`.
2. Cloud Shell, branch `claude/jogo-cenario-estofados`: `bash infra/firma-viva/teste/bootstrap-operador-firma.sh aplicar`
   (gera a chave) → Network Secret no ambiente **Firma Viva — Operação**.
3. Depois do deploy (o Claude avisa): cadastrar `firma-viva` no painel de produção e rodar
   `firma-teste.sh producao` com o segredo; autorizar com a conta real e ver a OS no mapa.

## Registro das operações

Cada execução em homologação, produção ou no Firma Viva gera `docs/operacoes/AAAA-MM-DD-<assunto>.md`
com: pedido, versão antes/depois, ponto de recuperação, operações e resultados, indisponibilidade e
pendências.
