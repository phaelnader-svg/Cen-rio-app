# Cadastro do Cenário na Meta (WhatsApp e Instagram dos agentes)

Situação em 2026-11-17: o Raphael **não tem** conta no Meta Business. Tudo o que não depende da
Meta já funciona sem ela:

- Os agentes do escritório (Compras, Financeiro, Orçamentos, WhatsApp, Atendimento) preparam as
  mensagens e, ao aprovar, o WhatsApp do próprio usuário abre com o texto pronto (link `wa.me`).
  Vale para qualquer empresa, sem configurar nada.
- No painel: "Avisar cliente" na OS e "Resumo do dia no WhatsApp" no sininho, também por link.

O que a Meta acrescenta: **enviar sozinho** pelo número da empresa (depois da aprovação), **ler as
conversas** do WhatsApp e do Instagram na caixa de entrada do jogo e publicar posts.

## O que o dono faz (uma vez só, para todas as empresas)

1. **Conta empresarial da Meta.** Em <https://business.facebook.com>, entrar com o Facebook pessoal
   e clicar em "Criar conta". Nome: "Cenário Gestão"; e-mail da empresa.
2. **Verificar a empresa.** No portfólio: Configurações → Central de segurança → "Iniciar
   verificação", com CNPJ, endereço e telefone da empresa. A Meta leva de 2 a 10 dias.
3. **Conta de desenvolvedor e app.** Em <https://developers.facebook.com>, mesmo login: "Meus
   apps" → "Criar app" → caso de uso "Outro" → tipo **Empresa** → escolher o portfólio do passo 1.
   Nome do app: "Cenário Gestão". Adicionar os produtos **WhatsApp**, **Login do Facebook para
   Empresas** e **Instagram**.
4. **Avisar o Claude** quando o app estiver criado. O ID do app não é segredo e pode vir no chat.
   A **chave secreta** do app (Configurações do app → Básico → "Chave secreta do app") **não vai
   no chat**: o Claude entrega um comando para o Cloud Shell que pede a chave sem mostrar na tela e
   a grava no Secret Manager.

## O que o Claude faz depois

- Grava `META_APP_ID`, `META_APP_SECRET` (Secret Manager), `META_REDIRECT_URI`
  (`https://cenariogestao.com.br/api/v1/connections/meta/callback`), `META_WEBHOOK_VERIFY_TOKEN`
  (sorteado no servidor) e cria a configuração do Cadastro Incorporado do WhatsApp
  (`META_WA_CONFIG_ID`), cadastra o webhook e o domínio no app.
- Prepara a **Revisão do App** (textos de uso de cada permissão e o vídeo de demonstração em
  homologação). Enviar a revisão é um clique do dono no painel da Meta.
- **Multi-empresa:** hoje só a empresa nº 1 conecta (`assertPlatformConnections`). Para cada
  tapeçaria conectar o próprio WhatsApp pelo botão da Central de Conexões, falta separar os
  webhooks por empresa (roteamento pelo `phone_number_id` / id da página). Isso é código do Claude
  e entra junto com a ativação, sem passo para as empresas.

## Limites da Meta para lembrar

- Mensagem que a empresa inicia fora da janela de 24 h só sai com **modelo aprovado** pela Meta.
  Por isso o pedido ao fornecedor e a cobrança continuam caindo no link do WhatsApp quando o envio
  direto é recusado (o agente registra o motivo).
- Até a verificação da empresa, a Meta limita os envios a poucos números de teste.
