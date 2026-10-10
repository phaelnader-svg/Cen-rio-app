#!/usr/bin/env bash
# Conferência da restauração de teste (Evolução — pré-deploy). Biblioteca carregada ("source") pelo
# vm.sh e pelos testes; não executa nada sozinha. Tudo SOMENTE LEITURA, exceto os bancos de
# conferência que o chamador cria e apaga (nunca o banco original).
#
# O chamador define:
#   psql_em <banco> [args do psql…]   psql -U cenario -d <banco> -At -F'|' -v ON_ERROR_STOP=1 (entrada repassada)
#   pg_sh '<comando>'                 shell no contêiner do PostgreSQL (pg_dump | pg_restore)
#   CONF_SQL                          diretório de sql/ (impressao-digital.sql, diagnostico-tabela.sql)
#
# Regra (sem afrouxar nada): a restauração é aprovada só se
#   1. o banco original NÃO mudou durante a conferência (impressão antes == depois);
#   2. todas as linhas de dados, estrutura, sequências, migrations e valores financeiros da
#      restauração são IGUAIS às do original;
#   3. o conjunto de definições textuais (def-*: CHECK, FK, índices, gatilhos, padrões, visões) é o
#      mesmo e cada texto é IGUAL ao de uma restauração SÓ DE ESQUEMA do original feita agora
#      (o PostgreSQL reescreve, num dump/restore, o texto de expressões equivalentes; a referência
#      mostra exatamente o texto que o esquema atual produz ao ser restaurado);
#   4. a referência é fiel: a estrutura dela (colunas, restrições, índices, gatilhos, funções,
#      tipos) é igual à do original.
# Qualquer diferença é listada item a item, sem valores de linhas (só nomes de colunas, contagens,
# somas financeiras e chaves técnicas uuid/inteiras).
set -o pipefail

impressao_de() { # impressao_de <banco>
  psql_em "$1" < "$CONF_SQL/impressao-digital.sql" | grep -vE '^(BEGIN|ROLLBACK|SET)$'
}

# Restauração SÓ DE ESQUEMA do original num banco de referência (recriado vazio).
criar_referencia() { # criar_referencia <original> <referencia>
  psql_em postgres -q -c "DROP DATABASE IF EXISTS $2 WITH (FORCE)" -c "CREATE DATABASE $2 OWNER cenario" >/dev/null
  pg_sh "pg_dump -U cenario --schema-only --format=custom --no-owner --no-privileges $1 \
    | pg_restore -U cenario --no-owner --no-privileges --single-transaction --exit-on-error -d $2"
}

sessoes_no_banco() { # sem texto de consulta: só quem está conectado
  psql_em postgres -c "SELECT usename, coalesce(application_name, '-'), backend_type, coalesce(state, '-'),
      coalesce(client_addr::text, 'local'), coalesce(to_char(xact_start, 'HH24:MI:SS'), '-')
    FROM pg_stat_activity WHERE datname = '$1' AND pid <> pg_backend_pid()" | sed 's/^/      sessão: /'
}

# Localiza, numa tabela divergente, as colunas e as linhas diferentes (sem mostrar valores).
diagnosticar_tabela() { # diagnosticar_tabela <tabela> <banco-a> <banco-b> <dir>
  local t="$1" d="$4/tab"; mkdir -p "$d"
  psql_em "$2" -v tabela="$t" < "$CONF_SQL/diagnostico-tabela.sql" | grep -vE '^(BEGIN|ROLLBACK|SET)$' | LC_ALL=C sort > "$d/a" || return 0
  psql_em "$3" -v tabela="$t" < "$CONF_SQL/diagnostico-tabela.sql" | grep -vE '^(BEGIN|ROLLBACK|SET)$' | LC_ALL=C sort > "$d/b" || return 0
  local cols; cols="$(LC_ALL=C join -t'|' -j1 <(grep '^coluna|' "$d/a" | cut -d'|' -f2- | sort) <(grep '^coluna|' "$d/b" | cut -d'|' -f2- | sort) \
    | awk -F'|' '$2 != $3 {print $1}' | xargs)"
  echo "      colunas com valores diferentes: ${cols:-nenhuma (diferença só na quantidade de linhas)}"
  grep '^linha|' "$d/a" | cut -d'|' -f2,3 | LC_ALL=C sort > "$d/la"; grep '^linha|' "$d/b" | cut -d'|' -f2,3 | LC_ALL=C sort > "$d/lb"
  local so_a so_b mud
  so_a="$(LC_ALL=C join -t'|' -v1 <(cut -d'|' -f1 "$d/la" | LC_ALL=C sort -u) <(cut -d'|' -f1 "$d/lb" | LC_ALL=C sort -u))"
  so_b="$(LC_ALL=C join -t'|' -v1 <(cut -d'|' -f1 "$d/lb" | LC_ALL=C sort -u) <(cut -d'|' -f1 "$d/la" | LC_ALL=C sort -u))"
  mud="$(LC_ALL=C join -t'|' "$d/la" "$d/lb" | awk -F'|' '$2 != $3 {print $1}')"
  local n
  for par in "só no original:$so_a" "só na restauração:$so_b" "alteradas:$mud"; do
    n="$(printf '%s' "${par#*:}" | grep -c . || true)"
    (( n > 0 )) && echo "      linhas ${par%%:*} $n (chaves: $(printf '%s\n' "${par#*:}" | head -5 | xargs)$( (( n > 5 )) && echo ' …'))"
  done
  return 0
}

# Lista as diferenças entre duas impressões (arquivos), item a item.
listar_diferencas() { # listar_diferencas <arq-a> <arq-b> <rotulo-a> <rotulo-b> <banco-a> <banco-b> <dir>
  local a="$1" b="$2" ra="$3" rb="$4" n=0 limite="${CONF_LIMITE:-40}"
  LC_ALL=C join -t$'\t' -a1 -a2 -e '∅' -o 0,1.2,2.2 \
    <(awk -F'|' '{print $1"|"$2"\t"$3"|"$4}' "$a" | LC_ALL=C sort -t$'\t' -k1,1) \
    <(awk -F'|' '{print $1"|"$2"\t"$3"|"$4}' "$b" | LC_ALL=C sort -t$'\t' -k1,1) \
    | awk -F'\t' '$2 != $3' > "$7/difs"
  echo "    $(wc -l < "$7/difs") item(ns) divergente(s) ($ra × $rb):"
  local chave va vb tipo nome
  while IFS=$'\t' read -r chave va vb; do
    n=$((n + 1)); (( n > limite )) && { echo "    … (mais $(( $(wc -l < "$7/difs") - limite )))"; break; }
    tipo="${chave%%|*}"; nome="${chave#*|}"
    if [[ "$va" == '∅' ]]; then echo "    ✘ $tipo $nome: ausente em $ra"; continue; fi
    if [[ "$vb" == '∅' ]]; then echo "    ✘ $tipo $nome: ausente em $rb"; continue; fi
    case "$tipo" in
      tabela)
        echo "    ✘ tabela $nome: linhas $ra=${va%%|*} · $rb=${vb%%|*} · conteúdo diferente"
        [[ -n "$5" && -n "$6" ]] && diagnosticar_tabela "$nome" "$5" "$6" "$7" ;;
      financeiro) echo "    ✘ financeiro $nome: linhas ${va%%|*}→${vb%%|*} · soma $ra=${va#*|} · $rb=${vb#*|} (centavos)" ;;
      sequencia) echo "    ✘ sequência $nome: $ra=${va/|/ chamada=} · $rb=${vb/|/ chamada=}" ;;
      migracoes) echo "    ✘ migrations $nome: $ra=${va%%|*} · $rb=${vb%%|*}"
        if [[ -n "$5" && -n "$6" ]]; then
          diff <(psql_em "$5" -c "SELECT migration_name || ' ' || CASE WHEN finished_at IS NULL THEN 'pendente/falha' ELSE 'ok' END || CASE WHEN rolled_back_at IS NULL THEN '' ELSE ' revertida' END FROM _prisma_migrations ORDER BY 1") \
               <(psql_em "$6" -c "SELECT migration_name || ' ' || CASE WHEN finished_at IS NULL THEN 'pendente/falha' ELSE 'ok' END || CASE WHEN rolled_back_at IS NULL THEN '' ELSE ' revertida' END FROM _prisma_migrations ORDER BY 1") \
            | grep '^[<>]' | sed "s/^</      $ra:/; s/^>/      $rb:/" || true
        fi ;;
      *) echo "    ✘ $tipo $nome"; echo "      $ra: ${va#*|}"; echo "      $rb: ${vb#*|}" ;;
    esac
  done < "$7/difs"
}

# conferir_restauracao <arq-impressao-original-antes> <original> <restaurado> <referencia> <dir>
# Saída: 0 = idêntica (aprovada) · 1 = restauração diverge · 2 = original mudou · 3 = referência inválida
conferir_restauracao() {
  local antes="$1" orig="$2" rest="$3" ref="$4" d="$5"
  impressao_de "$rest" > "$d/restaurado" || { echo "    ✘ impressão do banco restaurado falhou"; return 1; }
  impressao_de "$ref" > "$d/referencia" || { echo "    ✘ impressão da referência falhou"; return 3; }
  impressao_de "$orig" > "$d/depois" || { echo "    ✘ impressão do original falhou"; return 2; }
  echo "  itens: $(wc -l < "$antes") · tabelas: $(grep -c '^tabela|' "$antes") · colunas financeiras: $(grep -c '^financeiro|' "$antes") · migrations: $(grep '^migracoes|aplicadas' "$antes" | cut -d'|' -f3) · restrições: $(grep -c '^restricao|' "$antes") · índices: $(grep -c '^indice|' "$antes") · gatilhos: $(grep -c '^gatilho|' "$antes") · sequências: $(grep -c '^sequencia|' "$antes")"
  if ! cmp -s "$antes" "$d/depois"; then
    echo "  ✘ o banco ORIGINAL mudou durante a conferência (há gravação acontecendo): nada a concluir."
    listar_diferencas "$antes" "$d/depois" antes depois "" "" "$d"
    echo "    conexões ao banco $orig agora:"; sessoes_no_banco "$orig"
    return 2
  fi
  # 4. Referência fiel: mesma estrutura (sem texto) que o original.
  local estrut='^(coluna|restricao|indice|gatilho|funcao|tipo)\|'
  if ! cmp -s <(grep -E "$estrut" "$antes") <(grep -E "$estrut" "$d/referencia"); then
    echo "  ✘ a referência (esquema do original restaurado agora) não reproduz a estrutura do original:"
    listar_diferencas <(grep -E "$estrut" "$antes") <(grep -E "$estrut" "$d/referencia") original referencia "" "" "$d"
    return 3
  fi
  local falhas=0
  # 2. Dados, estrutura, sequências, migrations e financeiro: iguais ao original.
  grep -v '^def-' "$antes" > "$d/o-sem-def"; grep -v '^def-' "$d/restaurado" > "$d/r-sem-def"
  if ! cmp -s "$d/o-sem-def" "$d/r-sem-def"; then
    falhas=1; listar_diferencas "$d/o-sem-def" "$d/r-sem-def" original restaurado "$orig" "$rest" "$d"
  fi
  # 3. Definições: mesmos objetos que o original; mesmo texto que a referência.
  if ! cmp -s <(grep '^def-' "$antes" | cut -d'|' -f1,2) <(grep '^def-' "$d/restaurado" | cut -d'|' -f1,2); then
    falhas=1; echo "  ✘ conjunto de definições diferente do original:"
    diff <(grep '^def-' "$antes" | cut -d'|' -f1,2) <(grep '^def-' "$d/restaurado" | cut -d'|' -f1,2) \
      | grep '^[<>]' | sed 's/^</    só no original:/; s/^>/    só na restauração:/' | head -"${CONF_LIMITE:-40}"
  fi
  if ! cmp -s <(grep '^def-' "$d/referencia") <(grep '^def-' "$d/restaurado"); then
    falhas=1; listar_diferencas <(grep '^def-' "$d/referencia") <(grep '^def-' "$d/restaurado") referencia restaurado "" "" "$d"
  fi
  (( falhas == 0 )) || return 1
  local reescritas; reescritas="$(diff <(grep '^def-' "$antes") <(grep '^def-' "$d/restaurado") | grep -c '^<' || true)"
  echo "  ✔ dados, estrutura, sequências, migrations e valores financeiros IGUAIS ao original; definições iguais à referência"
  if (( reescritas > 0 )); then
    echo "  • $reescritas definição(ões) com texto reescrito pelo PostgreSQL no dump/restore (equivalentes; iguais à referência):"
    LC_ALL=C join -t$'\t' <(grep '^def-' "$antes" | awk -F'|' '{print $1"|"$2"\t"$4}' | LC_ALL=C sort -t$'\t' -k1,1) \
                  <(grep '^def-' "$d/restaurado" | awk -F'|' '{print $1"|"$2"\t"$4}' | LC_ALL=C sort -t$'\t' -k1,1) \
      | awk -F'\t' '$2 != $3 {print "      " $1}' | head -"${CONF_LIMITE:-40}"
  fi
  return 0
}
