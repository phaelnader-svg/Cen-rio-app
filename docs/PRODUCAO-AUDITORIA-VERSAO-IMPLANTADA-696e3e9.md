# Produção — auditoria da versão implantada (`696e3e9`) × reformulação, 14/11/2026

Somente leitura: nenhum deploy, nenhuma alteração no banco nem na produção.

## Conclusão

**Implantamos a versão correta, e ela contém a reformulação completa (Fases 0 a 4).**

- O código das Fases 0 a 4 está todo em `696e3e9`.
- O que ficou de fora da linha da Fase 4 são 20 commits posteriores: documentação, scripts de VM
  (já aplicados pelo pacote `9ff142e274b1`) e 1 teste. Nenhum muda a aplicação.

A sensação de "sistema igual" tem quatro causas:

1. **As rotas e telas antigas foram mantidas de propósito.** O commit `d3fd4c6` "mantém a linha de
   base de rotas de 9fb1786 intacta": as telas antigas continuam abrindo pela URL e só saíram do menu.
2. **O banco está vazio.** A maior parte da reformulação acontece dentro da OS (6 abas, materiais,
   fotos, entrega direta, qualidade e embalagem), do tablet e do painel "Hoje". Sem clientes, OS ou
   equipe, essas telas mostram estados vazios.
3. **As mudanças de navegação são pontuais.** Saem 4 itens, entram 3 e 1 muda de nome (tabela
   abaixo). A logo nova (sofá, `4c10b63`, de 25/10) é posterior a `7b4177b` (22/10) e também é
   novidade desta versão.
4. **Um navegador com aba aberta da versão anterior** pode manter o JavaScript antigo até recarregar
   a página. Não há service worker no painel; o do tablet é rede-primeiro para páginas e nunca guarda
   a API.

## 1. O que está em execução

| Item | Evidência | Resultado |
|---|---|---|
| Etiqueta da pilha, candidata e migrada | `version` (17:28:06Z) | `696e3e9ddc5f1c803a4b9244a075ed498ad81be3` |
| Imagem `api` em execução | `prepare_version` e `images_cleanup_plan` | `sha256:264884b3…cb4f`: a mesma da homologação de `696e3e9` (`docs/HOMOLOGACAO-CORRECOES-DEPLOY-RELATORIO.md`) |
| Imagem `web` em execução | idem | `sha256:cb76d474…ae72`: idem |
| Banco | `migration_status` | 37/37 migrations da imagem `696e3e9`, incluindo as 4 da reformulação (F0, F1, F2, F3) |
| Tabelas novas da reformulação | `database_counts` | `module_settings`, `inventory_items`, `fabric_rolls`, `service_order_materials`, `service_model_materials` existem (vazias) |
| Funcionalidades configuráveis (F0) | `module_settings` = 0 linhas | sem linha = padrão **ligado**: logística, ajuda, embalagem e materiais estão ligados |
| Permissões | `seed.ts` | o papel Gestor recebe o catálogo completo (`ALL_PERMISSIONS`) a cada seed |

**Limitação:** esta sessão não alcança `cenariogestao.com.br` (a política de rede da sessão recusa
o domínio). A conferência pública do frontend fica no §5, para o Cloud Shell.

## 2. `7b4177b` → `696e3e9`

`7b4177b` é ancestral de `696e3e9`, com **80 commits** de diferença: 463 arquivos, +29.787 e −883
linhas.

| Bloco | Commits principais |
|---|---|
| Encerramento da Rodada 4 | `44b23df`, `c7d56d0` |
| Página comercial `/conheca` (desligada na produção) | `d25ce24`…`e1e4a89`, `16d17f4` |
| **Logo oficial nova (sofá) em todo o sistema** | `4c10b63` |
| **Reformulação, Fase 0** | `cca903d`, `6b38bf7` |
| **Fase 1** | `2b394a1`, `1e97cc6`, `799b47d`, `f03c42b`, `f0c2866` |
| **Fase 2** | `8bf69b6`, `de327ec`, `3fbdb3f`, `bb3a575` |
| **Fase 3** | `0eab71e`, `0ef2756`, `91bcd40` |
| **Fase 4** | `5f86201`, `2bba804`, `d3fd4c6` |
| Correções da homologação | `f007753` (B1–B6, U1), `696e3e9` (lint) |

## 3. Fases da reformulação × versão implantada

Verificação com o histórico completo do repositório (a primeira tentativa usou um clone raso).

| Ramo | Contido em `696e3e9`? | Fora de `696e3e9` |
|---|---|---|
| `claude/reformulacao-fase-1` (`3e0d2d0`) | ✔ ancestral | 0 commits |
| `claude/reformulacao-fase-2` (`dcae84f`) | ✔ ancestral | 0 |
| `claude/reformulacao-fase-3` (`781e3b8`) | ✔ ancestral | 0 |
| `claude/reformulacao-fase-4` (`eca805e`) | `696e3e9` é ancestral dele | 20 commits: documentação, scripts de VM (`91f1552`, já em produção pelo pacote `9ff142e274b1`) e 1 teste (`29dc333`). **Nenhuma mudança em `apps/` ou `packages/`** além do teste |
| `claude/retorno-5ff1597-fase0` | não | 2 commits de homologação: `SITE_COMERCIAL=1` e versão de retorno. Não pertencem à produção |

## 4. Funcionalidade esperada × situação

"No build" significa que o código está em `696e3e9` e que a imagem em execução é a desse commit.
"Visível sem dados" diz se a mudança aparece num banco vazio.

| Funcionalidade | Commit | Em `696e3e9` | Situação em produção |
|---|---|---|---|
| Logo nova (sofá) em todo o sistema | `4c10b63` | ✔ | no build; visível imediatamente |
| Página comercial `/conheca` | `d25ce24`…`16d17f4` | ✔ | **desligada de propósito** (decisão do deploy); responde 404 |
| F0: funcionalidades configuráveis (Empresa → Funcionalidades) | `cca903d` | ✔ | no build; as 4 ligadas por padrão (`module_settings` vazio) |
| F0: ajuda desligável; privacidade dos tablets | `cca903d` | ✔ | no build; ajuda ligada |
| F1: materiais da OS (comprado/na oficina, custo opcional, conciliação) | `2b394a1`, `1e97cc6`, `799b47d`, `f0c2866` | ✔ | no build; aparece **dentro de uma OS**: banco vazio = não visível |
| F1: estoque simples da oficina | `2b394a1` | ✔ | no build; menu **"Estoque da oficina"** (`/painel/estoque-oficina`), nova |
| F1: entrega direta pela OS | `2b394a1` | ✔ | no build; aparece numa OS pronta |
| F2: fotos seguras (orientação, sem EXIF/GPS, miniatura, visualizador) | `8bf69b6` | ✔ | no build; aparece ao anexar foto |
| F2: OS unificada (6 abas, situação e próximo passo no cabeçalho) | `de327ec` | ✔ | no build; aparece ao abrir uma OS: banco vazio = não visível |
| F2: modelos de serviço unificados e materiais padrão | `3fbdb3f` | ✔ | no build; menu renomeado **"Modelos de serviço"** (antes "Modelos de produção") |
| F2: tablet simplificado e mapa interno da oficina | `bb3a575` | ✔ | no build; menu **"Mapa da oficina"** (`/painel/producao/mapa`), nova; tablet exige dispositivo vinculado |
| F3: qualidade simplificada, embalagem opcional, estados e menu | `0eab71e` | ✔ | no build; visível com OS em qualidade |
| F3: programação unificada | `0eab71e` | ✔ | no build; menu **"Programação semanal"** (`/painel/producao/programacao`), nova; saem do menu "Planejamento de sexta", "Produção — A planejar", "Planejamento de produção" e "Competências da equipe" (as URLs antigas continuam abrindo) |
| F3 (D5): desfazer a entrega direta | `0ef2756` | ✔ | no build; visível numa entrega direta |
| F4: painel "Hoje" no Início, alertas internos, ações sugeridas, produtividade | `5f86201`, `2bba804` | ✔ | no build; aparece no Início com estados vazios ("Nada pedindo ação.") |
| Correções da homologação B1–B6, U1 | `f007753` | ✔ | no build |

## 5. Conferência pública do frontend (Cloud Shell; não altera nada)

As três páginas novas só existem no build de `696e3e9`. Sem sessão, ele responde **200** com o
título da página; o build de `7b4177b` responderia **404**. A rota de controle tem de dar 404.

```bash
for r in /painel/producao/mapa /painel/estoque-oficina /painel/producao/programacao /painel/rota-que-nao-existe; do
  printf '%-34s ' "$r"; curl -s -o /tmp/p.html -w '%{http_code} ' "https://cenariogestao.com.br$r"; grep -o '<title>[^<]*</title>' /tmp/p.html | head -1; echo
done
```

Esperado: `200 <title>Mapa da oficina · Cenário Gestão</title>`, `200 <title>Estoque da oficina · Cenário Gestão</title>`,
`200 <title>Programação semanal · Cenário Gestão</title>` e `404` na
rota inexistente.

## 6. Cache, service worker, rotas, flags e permissões

- **Service worker:** só no tablet (`/sw.js`, escopo `/tablet`). Páginas vêm da rede primeiro, `/api`
  nunca é guardado, e os arquivos versionados do Next mudam de nome a cada build. O painel não tem
  service worker.
- **Cache do navegador:** uma aba aberta antes das 17:23Z de 14/11 pode manter o JavaScript antigo
  até recarregar. Use Ctrl+Shift+R (ou Cmd+Shift+R) ou uma janela anônima.
- **Rotas antigas mantidas:** as URLs de planejamento antigas continuam abrindo. Quem usa favoritos
  ou o histórico do navegador cai nas telas antigas.
- **Flags:** as 4 funcionalidades configuráveis estão ligadas. O site comercial está desligado
  (`SITE_COMERCIAL`).
- **Permissões:** o Gestor tem o catálogo completo; nada fica escondido por permissão.

## 7. Correção de registro

`docs/PRODUCAO-AUDITORIA-LEITURA-696e3e9.md` dizia que `7b4177b` não era ancestral de `696e3e9`.
Isso vinha do clone raso desta sessão e foi corrigido lá.
