# Homologação GCP — autenticação SSH da auditoria (ssh-agent)

## Sintoma

`bash infra/homolog/gcp/homolog.sh auditar`, no Cloud Shell, pedia a passphrase da chave SSH três
vezes e terminava com erro 255. Já o acesso manual, com
`gcloud compute ssh cenario-homolog --tunnel-through-iap`, funcionava.

## Como o script executava o SSH

- `homolog.sh` → `ssh_vm()` → `gcloud compute ssh cenario-homolog --tunnel-through-iap --quiet --command=…`.
  O gcloud chama o OpenSSH com `-i ~/.ssh/google_compute_engine` e `IdentitiesOnly=yes`.
- Na seção 11 da auditoria, a conexão roda assim:
  `ssh_vm 'sudo bash -s' < vm-inspecao.sh > inspecao.txt 2> inspecao.err`.
  Ou seja: a entrada padrão é o script remoto, a saída de erro vai para um arquivo temporário (apagado ao
  sair) e tudo isso passa por `( … ) 2>&1 | tee` no registro da etapa.
- Nenhuma opção impedia o ssh de fazer perguntas e não havia caminho previsto para o ssh-agent.

## Causa

O script dependia de o ssh pedir e aceitar a passphrase **no meio** da execução, sem qualquer controle
sobre isso:

1. **Pergunta interativa a cada conexão.** Com a chave protegida e fora do agente, cada chamada
   `gcloud compute ssh/scp` pede a passphrase. O ssh desiste após 3 tentativas
   (`NumberOfPasswordPrompts=3`) e sai com código 255. O `preparar-vm` faria isso três vezes
   (ssh + scp + ssh).
2. **Erro real escondido.** A mensagem do ssh ia para `inspecao.err`, que é apagado quando o script
   termina. Só as duas últimas linhas eram resumidas no relatório.
3. **Se a chave não existisse,** o `gcloud … --quiet` a geraria **sem passphrase** e a gravaria nos
   metadados. Isso é uma escrita, dentro de uma auditoria que deveria ser só leitura.

O que **não** é a causa: o encadeamento de redirecionamentos, por si só, não impede digitar a
passphrase. Isso foi reproduzido com OpenSSH real: com a passphrase correta digitada num terminal, a
mesma estrutura conecta. Por que a passphrase digitada no Cloud Shell foi recusada três vezes não pôde
ser observado daqui, porque não há acesso ao Cloud Shell. A correção elimina o pedido de passphrase dentro
do script, e com isso essa diferença deixa de importar.

## Correção

Novo arquivo `infra/homolog/gcp/ssh-agente.sh`, incluído (`source`) por `homolog.sh`,
`auditoria-pre-deploy.sh` e `operador.sh`:

- Toda conexão usa `--ssh-flag=-oBatchMode=yes` (no scp, `--scp-flag=-oBatchMode=yes`): o ssh **nunca
  pergunta nada**. A chave continua sendo aceita pelo agente. O gcloud 570 repassa a opção ao ssh,
  inclusive na espera de propagação da chave. O gcloud nunca usa `StrictHostKeyChecking=ask` (usa `yes`
  ou `no`), então o BatchMode não trava na verificação do host.
- Antes de conectar, `conferir_chave_ssh` verifica sem perguntar nada:
  - chave sem passphrase → segue;
  - chave com passphrase **carregada no ssh-agent** (impressão digital do `.pub` presente em `ssh-add -l`) → segue;
  - sem agente, ou chave fora dele → **para na hora** e mostra os comandos exatos;
  - chave inexistente → para, sem gerar chave e sem chamar o gcloud.
- A auditoria registra `✘ inspeção dentro da VM NÃO executada` e continua as demais seções, que são só
  leitura. O `preparar-vm` para **antes** de copiar ou conectar.
- Nada muda na segurança da chave: a passphrase continua nela, o script não inicia agente, não guarda
  segredo e não cria credenciais. O agente vive só no terminal e a chave expira dele (`ssh-add -t`).
- Nenhuma alteração na infraestrutura do Google Cloud.

## Como executar a auditoria no Cloud Shell

```bash
eval "$(ssh-agent -s)"                          # agente só deste terminal
ssh-add -t 1h ~/.ssh/google_compute_engine      # digite a passphrase aqui, uma vez
bash infra/homolog/gcp/homolog.sh auditar
ssh-agent -k                                    # opcional ao terminar (o -t 1h já expira)
```

Resultado esperado: a seção "11. Dentro da VM" mostra a inspeção e termina com `FIM-INSPECAO`, sem
nenhum pedido de passphrase. Sem o `ssh-add`, a auditoria mostra as instruções acima e não tenta
conectar.

## Testes

- `bash infra/homolog/gcp/testes/test_homolog_sh.sh` (gcloud, ssh-keygen e ssh-add falsos): todos os
  cenários OK, incluindo os novos.
  - 1: com o agente, a conexão leva `--ssh-flag=-oBatchMode=yes`, sem gerar, alterar ou carregar chave.
  - 1b: sem agente, nenhuma conexão é tentada, aparecem as instruções e o código é ≠ 0.
  - 1c: agente sem a chave.
  - 1d: `SSH_AUTH_SOCK` ausente.
  - 1e: chave sem passphrase.
  - 1f: chave inexistente; não gera chave e não chama o gcloud.
  - 10b: `preparar-vm` sem agente para antes do scp.
  - 11: scp com `--scp-flag=-oBatchMode=yes`.
- `bash infra/homolog/gcp/testes/test_ssh_agente.sh` (OpenSSH real, com agente e sshd locais em
  127.0.0.1): todos os cenários OK.
  - Recusa imediata (0 s) sem nenhum "Enter passphrase", mesmo com terminal.
  - Aceita com a chave no agente e com prazo; a chave **continua com passphrase**.
  - Reprodução do comportamento antigo: sem BatchMode, o ssh pede a passphrase no meio do script.
  - Com BatchMode e sem agente: código 255 na hora, sem pedido.
  - Com BatchMode e agente: a mesma estrutura da auditoria (`bash -s` pela entrada, erro desviado, `tee`)
    executa o script remoto.

## Limitações conhecidas

- Se o gcloud precisar **gravar** a chave nos metadados (a chave não está lá ainda), ele faz uma conexão
  de teste antes. Essa conexão consome a entrada padrão, e a auditoria acusaria "inspeção da VM
  incompleta". Hoje isso não ocorre, porque o acesso manual já registrou a chave.
- Não foi possível executar o gcloud real contra a VM a partir deste ambiente: não há credenciais do
  Google Cloud nem acesso de rede ao domínio. A validação final é a auditoria rodando no Cloud Shell.
