# Cobrança, planos e e-mails

Melhorias 1, 2, 3, 4, 5 e 7 da lista de 2026-11-17. Decisões do dono (2026-11-17): pagamento pelo
**Asaas**, **teste grátis de 7 dias**, e-mail pelo **Resend**, plano com o jogo a **R$ 599/mês**,
**15% de desconto no anual**, **bloqueio 5 dias depois do vencimento**.

## Planos

| Plano                       | Mensal    | Anual (15% off) | Jogo Firma Viva |
| --------------------------- | --------- | --------------- | --------------- |
| Cenário Gestão              | R$ 399,00 | R$ 4.069,80     | não             |
| Cenário Gestão + Firma Viva | R$ 599,00 | R$ 6.109,80     | sim             |

Fonte: `packages/shared/src/billing.ts`. O ambiente interativo (`ambiente_interativo`) deixou de
ser um interruptor em Empresa → Funcionalidades: vem do plano (`apps/api/src/core/modules.ts`).
A Cenário Estofados (empresa nº 1) fica em **cortesia** no plano com o jogo.

## Situação da assinatura

Calculada pelas datas da empresa (`company_settings`): `billing_courtesy`, `trial_ends_at`,
`paid_until`. Não existe tarefa que "vira" o estado.

- **Teste grátis**: 7 dias a partir do Criar conta, plano básico.
- **Em dia**: pago até uma data futura.
- **Atrasada**: venceu há menos de 5 dias (o sistema funciona, com aviso no topo).
- **Vencida**: passou a tolerância (ou o teste acabou sem pagamento). Todas as rotas respondem
  `402 SUBSCRIPTION_REQUIRED`, menos `/auth/me`, sair e a tela **Assinatura**. Tablets e o jogo
  também param. Os dados ficam guardados; volta na hora em que o pagamento é confirmado.

Com `BILLING_ENABLED=false` (padrão) nada bloqueia: a tela mostra o plano e os avisos de teste não
aparecem.

## Pagamento (Asaas)

1. O gestor escolhe plano e ciclo em **Assinatura** (`/painel/assinatura`). Na primeira vez, informa
   CPF ou CNPJ (o Asaas exige).
2. A API cria o cliente e a assinatura no Asaas (`billingType: UNDEFINED`: a pessoa escolhe Pix,
   boleto ou cartão na página do Asaas) e abre a página de pagamento.
3. O Asaas chama `POST /api/webhooks/assinatura/asaas` (cabeçalho `asaas-access-token`). Pagamento
   confirmado: a cobrança fica paga, `paid_until` anda um ciclo e o plano da cobrança passa a valer
   (é aqui que o jogo liga). Repetir a notificação não paga duas vezes. Vencida: e-mail de aviso.
4. Mudar de plano cancela a assinatura anterior no Asaas e gera uma nova, com vencimento hoje.

O dono da plataforma, em **Empresas**, vê plano, situação, última cobrança, pedidos lançados,
último acesso e se o e-mail foi confirmado; pelo botão **Plano** troca o plano, dá cortesia,
estende o teste ou registra um pagamento recebido por fora.

## E-mails (Resend)

Fila no banco (`outbound_emails`), gravada na mesma transação que gera o e-mail e enviada em
segundo plano, com novas tentativas (1, 5, 15, 60 min…). Sem `RESEND_API_KEY` os e-mails ficam na
fila. Tipos: `confirmar-email`, `redefinir-senha`, `assinatura-paga`, `assinatura-vencida`.

- **Confirmar e-mail**: link de 3 dias enviado no Criar conta; aviso no painel com "Mandar de novo"
  (no máximo 3 por hora). A conta funciona antes de confirmar.
- **Esqueci minha senha** (`/entrar/esqueci`): link de 1 hora, uso único; a resposta é a mesma
  exista ou não a conta. Trocar a senha encerra todas as sessões e confirma o e-mail.

## Anti-robô

Campo-isca invisível no Criar conta e, quando configurado, **Cloudflare Turnstile** invisível no
Criar conta e no "Esqueci minha senha". Com o Turnstile ligado, o teto global de contas por hora
sobe de 40 para 400 (antes, um robô com 40 contas travava o cadastro de todo mundo por 1 hora).

## Configuração (uma vez, por ambiente)

| Variável                                     | O que é                                                         |
| -------------------------------------------- | --------------------------------------------------------------- |
| `BILLING_ENABLED`                            | `true` liga o bloqueio por falta de pagamento                   |
| `ASAAS_API_KEY`, `ASAAS_BASE_URL`            | chave da conta Asaas da Cenário (sandbox em homologação)        |
| `ASAAS_WEBHOOK_TOKEN`                        | token do webhook `…/api/webhooks/assinatura/asaas` (32+ letras) |
| `RESEND_API_KEY`, `EMAIL_FROM`               | chave do Resend e remetente (domínio verificado no Resend)      |
| `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` | chaves do widget Turnstile (modo invisível) para o domínio      |
| `PUBLIC_WEB_URL`                             | endereço do painel nos links dos e-mails (compose já preenche)  |

O que só a conta do dono faz: criar a chave de API e o webhook no Asaas, verificar o domínio
`cenariogestao.com.br` no Resend (registros DNS SPF/DKIM) e criar o widget do Turnstile. Os
segredos vão para o Secret Manager / `.env` da VM, nunca para chat ou commit.

Migration `20270722000000_cobranca_planos_emails` (reversão em `packages/db/rollback/`): só
acrescenta. Empresa 1 → cortesia no plano com o jogo; demais empresas existentes → 7 dias de teste
a partir da migração; usuários existentes → e-mail confirmado.

Testes: `apps/api/test/cobranca-planos-emails.test.ts`.
