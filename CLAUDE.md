# Orientações permanentes — Cenário Gestão e Firma Viva

## Mandato do dono (vale para todas as sessões)

O Claude assume **de ponta a ponta a execução técnica** de tudo que o dono pedir no **Cenário
Gestão** e no **Firma Viva**. O papel do dono é escolher o que quer, aprovar as decisões que dependem
dele e testar o resultado.

- **Desenvolvimento e correções:** investigar, alterar o código, rodar os testes, corrigir as falhas
  e deixar o resultado disponível para teste, usando os repositórios, ambientes e ferramentas já
  configurados.
- **Publicação e infraestrutura:** quando o dono pedir para publicar, executar os passos que o acesso
  da sessão permite (build, homologação, promoção de imagens, deploy, migrations, configuração de
  servidores, domínio e HTTPS), seguindo o procedimento de recuperação do projeto, e conferir a versão
  publicada e os fluxos que o dono vai usar.
- **Falhas:** ler os logs, achar a causa, corrigir o que for recuperável e retomar do ponto certo. Se
  precisar reverter dentro do procedimento autorizado, validar o ambiente depois da reversão. Seguir
  até entregar o resultado ou identificar um bloqueio real.
- **O que depende do dono:** fazer antes tudo o que estiver ao alcance. Se faltar permissão, login
  pessoal, aprovação de produção ou ação que só a conta dele executa, reunir tudo em **um único
  pedido**: qual operação está bloqueada, qual acesso liberar e onde clicar (de preferência pelo
  painel). Quando ele fizer a parte dele, retomar a execução.
- **Entrega:** sempre o link, a versão publicada e o que foi confirmado funcionando (e o que não foi).

## Regras que não mudam

- **Homologação e produção separadas.** Cada uma tem seu ambiente do Claude Code e seu operador:
  "Cenário — Homologação" (conta `claude-operador`) e "Cenário — Produção" (conta
  `claude-operador-prod`). Nunca colocar a credencial de um no ambiente do outro; nunca usar
  `CENARIO_AMBIENTE=prod` numa sessão de homologação.
- **Produção recebe só imagens homologadas**, promovidas por digest; nunca constrói imagens.
- **Antes de migration ou ativação em produção:** `recovery_point_create` + `backup_validate`, e
  `migration_precheck` com exatamente as pendentes esperadas. Retorno: `rollback_to_recovery_point`.
- **Segredos** nunca em chat, commit, log ou argumento de comando: Network Secrets do ambiente,
  Secret Manager, ou digitação sem eco no Cloud Shell do dono.
- **Registro das operações:** toda execução em homologação ou produção fica registrada em
  `docs/operacoes/AAAA-MM-DD-<assunto>.md` (o que, quando, versão antes/depois, ponto de recuperação,
  resultados das verificações, indisponibilidade). Os relatórios de deploy existentes em `docs/` seguem
  o mesmo padrão.

## Mapa do projeto

| Item                                                    | Onde                                                                                                                                      |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Repositório                                             | `phaelnader-svg/cen-rio-app` (monorepo pnpm)                                                                                              |
| Cenário Gestão — linha de produção                      | branch `claude/autorizacao-apps-9fb6b03` (= `9fb6b03` + autorização de aplicativos `0a2546f`)                                             |
| Firma Viva (jogo)                                       | branch `claude/jogo-cenario-estofados`: `apps/firma-viva`, `apps/firma-api`, `packages/firma-db`; docs em `docs/FIRMA-VIVA.md`            |
| Operações nomeadas                                      | `infra/homolog/gcp/autonomia/operar.py` (`verificar`, `op <operação>`, `build-iniciar`, `imagens`…); produção com `CENARIO_AMBIENTE=prod` |
| Runbook atual                                           | `docs/PRODUCAO-DEPLOY-0a2546f-AUTORIZACAO-APPS.md` (branch da linha de produção)                                                          |
| Firma Viva publicado                                    | `https://firmaviva.com.br` (VM `firma-teste`, script `infra/firma-viva/teste/firma-teste.sh`)                                             |
| Produção / homologação do Cenário                       | `https://cenariogestao.com.br` / `https://teste.cenariogestao.com.br` (senha do proxy)                                                    |
| Autonomia (o que ainda depende do dono e como eliminar) | `docs/AUTONOMIA-OPERACIONAL.md`                                                                                                           |
