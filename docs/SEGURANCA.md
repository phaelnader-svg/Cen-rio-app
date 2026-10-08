# Segurança — Cenário Gestão (Fase 1)

## Autenticação

| Superfície | Credencial                                             | Detalhes                                                                             |
| ---------- | ------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| Painel     | E-mail + senha                                         | Senha ≥ 10 caracteres com letras e números; hash **argon2id** (19 MiB, 2 iterações). |
| Tablet     | Dispositivo vinculado + funcionário + PIN de 6 dígitos | PIN sem sequências/repetições; hash argon2id. Só funciona em tablet vinculado.       |

- Usuário inexistente e senha errada recebem a mesma mensagem, com custo de tempo equivalente
  (verificação "fictícia" de hash).
- **Força bruta:** bloqueio progressivo persistido no banco — 5 falhas por conta/PIN em 15 min
  bloqueiam (1–2 min, dobrando até 1 h); limite por IP quando o IP real é conhecido;
  vinculação de dispositivos limitada; limite geral de 600 req/min por IP.

## Sessões e dispositivos

- Token opaco de 256 bits em cookie `httpOnly`, `SameSite=Lax`, `Secure` e prefixo `__Host-`
  em HTTPS. No banco fica apenas o **HMAC-SHA256** do token (`TOKEN_HASH_SECRET`).
- Painel: expira após 12 h sem uso e no máximo em 30 dias (configurável).
- Tablet: sessão permanente renovada a cada uso (expira só após 30 dias sem uso) e **vinculada
  ao dispositivo**: o cookie de sessão sozinho não vale sem a credencial do tablet.
- Vinculação: o gestor cadastra o tablet e recebe um código de uso único (15 min, 8 caracteres
  sem ambiguidades, guardado como hash). O tablet recebe uma credencial própria (cookie
  `httpOnly`, 400 dias, renovada).
- **Revogação remota** (efeito imediato, inclusive no WebSocket): encerrar sessão, revogar
  dispositivo, desativar funcionário, trocar PIN/senha.

## Autorização

- Catálogo de permissões em código; funções editáveis; concessões individuais.
- **Toda rota** `/api` declara regra de acesso; sem ela a API não inicia. O servidor verifica
  sessão, tipo de sessão (painel × tablet), permissão de ambiente (`painel.acessar` /
  `producao.acessar`) e permissões específicas — a cada requisição, lendo do banco (mudanças
  valem na hora).
- Sem escalonamento: ninguém concede permissão que não possui.
- Função Gestor protegida (sempre com todas as permissões); o sistema nunca fica sem um gestor
  ativo com acesso ao painel; ninguém desativa a si mesmo.

## Proteções de requisição

- **CSRF / WebSocket entre sites:** métodos que alteram estado e o upgrade do WebSocket exigem
  `Origin` presente em `ALLOWED_ORIGINS`.
- **Validação** de todas as entradas com zod (esquemas compartilhados com a interface).
- Cabeçalhos de segurança (helmet na API; CSP, `X-Frame-Options`, `nosniff`,
  `Permissions-Policy` no Next.js). Respostas da API com `Cache-Control: no-store`.
- Limite de corpo JSON 256 KB; upload limitado por `MAX_UPLOAD_MB`.
- Erros: mensagens genéricas para falhas internas, com `requestId` para rastreio no log.

## Arquivos

- Armazenamento privado fora de diretórios públicos (`STORAGE_DIR`, permissões 700/600), nomes
  gerados (UUID), caminho validado contra _path traversal_.
- Tipo real verificado pelos bytes (JPEG/PNG/WebP), não pelo nome.
- Leitura só pela rota autenticada `/api/files/:id`, com política por finalidade (negação por
  padrão), `nosniff`, CSP `sandbox` e cache privado.

## Logs e auditoria

- Logs estruturados (pino/JSON) com `requestId`; cookies, autorização, senhas, PINs, códigos e
  hashes são **removidos** (redaction). Nenhum segredo é registrado.
- Auditoria imutável no banco para ações críticas (login/logout, cadastros, credenciais,
  funções, dispositivos, sessões, configurações), com diferenças antes/depois sem dados
  sensíveis, IP e autor.

## Segredos e ambientes

- Segredos apenas por variáveis de ambiente; `.env` não é versionado.
- Em homologação/produção a API recusa iniciar sem HTTPS nas origens, `COOKIE_SECURE=true` e
  `NODE_ENV=production`.
- Bancos separados por ambiente; os testes recusam rodar em banco cujo nome não contenha
  `test` ou que seja igual ao `DATABASE_URL`.

## Riscos conhecidos e decisões aceitas

| Item                                 | Situação                                                                                                                                                                                                                                                  |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| IP real atrás de proxy               | O Next.js (dev) não informa o IP do cliente. Sem `TRUST_PROXY`, o limite por IP é ignorado para não bloquear todos os tablets juntos (limites por conta/PIN continuam). Em produção use proxy reverso com `TRUST_PROXY` (veja `infra/Caddyfile.example`). |
| Limite geral de requisições          | Em memória, por instância. Com várias instâncias, usar armazenamento compartilhado (ex.: Redis) — não necessário agora.                                                                                                                                   |
| Resposta idempotente guardada        | A resposta do cadastro de dispositivo (que contém o código de vinculação) fica até 24 h na tabela de idempotência. O código expira em 15 min e é de uso único; quem lê o banco já tem acesso total.                                                       |
| CSP com `'unsafe-inline'` em scripts | Exigido pelo Next.js sem _nonce_. Nenhuma origem externa é permitida. Evolução: CSP com nonce.                                                                                                                                                            |
| PIN de 6 dígitos                     | Adequado somado ao vínculo do dispositivo e ao bloqueio progressivo; não substitui senha no painel.                                                                                                                                                       |
