#!/usr/bin/env python3
"""Pré-verificação da CADEIA de migrations (somente leitura; chamada por `vm.sh preflight <etiqueta>`).

Compara, sem tocar no banco (recebe tudo em arquivos já extraídos pelo vm.sh):
  * as migrations da IMAGEM da versão (pasta migrations/, com o migration.sql de cada uma);
  * o estado da tabela _prisma_migrations (sql/preflight-estado.sql);
  * o catálogo do esquema public (sql/preflight-catalogo.sql);
  * as verificações de DADOS por migration (sql/preflight-migracoes.sql).

Bloqueia (código 1) quando encontrar:
  * migration iniciada e não concluída, ou registrada mais de uma vez como concluída;
  * migration aplicada no banco que a imagem não conhece (desconhecida);
  * migration aplicada com conteúdo diferente do da imagem (checksum do Prisma = SHA-256 do arquivo);
  * migration pendente com nome anterior a uma já aplicada (ordem divergente);
  * esquema incompatível: objeto que uma pendente cria e já existe, ou que ela altera/remove/referencia
    e não existe (considerando o que as pendentes anteriores criam, na ordem);
  * dado que faria uma migration pendente falhar (verificações de dados com valor ≠ esperado).
Nunca executa SQL: só lê arquivos e o texto das migrations. Código 2 = uso/entrada inválida.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import re
import sys

RE_NOME = re.compile(r"^[0-9]{14}_[a-z0-9_]+$")
ID = r'"?([A-Za-z_][A-Za-z0-9_]*)"?'


def ler_linhas(caminho: str) -> list[list[str]]:
    if not caminho or not os.path.exists(caminho):
        return []
    with open(caminho, encoding="utf-8", errors="replace") as f:
        return [l.rstrip("\n").split("|") for l in f if l.strip() and l.strip() not in ("BEGIN", "ROLLBACK", "SET")]


# ------------------------------------------------------------------------------------------- SQL
def sem_comentarios_e_corpos(sql: str) -> str:
    """Remove comentários '--' e corpos $$…$$ (funções): o que interessa são os comandos DDL."""
    sql = re.sub(r"\$([A-Za-z_]*)\$.*?\$\1\$", "''", sql, flags=re.S)
    linhas = []
    for l in sql.splitlines():
        fora, aspas = [], False
        i = 0
        while i < len(l):
            c = l[i]
            if c == "'":
                aspas = not aspas
            elif not aspas and l.startswith("--", i):
                break
            fora.append(c)
            i += 1
        linhas.append("".join(fora))
    return "\n".join(linhas)


def comandos(sql: str) -> list[str]:
    return [" ".join(c.split()) for c in sem_comentarios_e_corpos(sql).split(";") if c.strip()]


def partes_de_alter(acoes: str) -> list[str]:
    """Separa as ações de um ALTER TABLE pelas vírgulas de nível 0 (fora de parênteses e aspas)."""
    out, nivel, atual, aspas = [], 0, [], False
    for c in acoes:
        if c == "'":
            aspas = not aspas
        if not aspas:
            if c == "(":
                nivel += 1
            elif c == ")":
                nivel -= 1
            elif c == "," and nivel == 0:
                out.append("".join(atual).strip())
                atual = []
                continue
        atual.append(c)
    if "".join(atual).strip():
        out.append("".join(atual).strip())
    return out


class Catalogo:
    def __init__(self, linhas: list[list[str]]):
        self.relacoes: set[str] = set()
        self.tabelas: set[str] = set()
        self.colunas: set[str] = set()
        self.restricoes: set[str] = set()
        self.tipos: set[str] = set()
        self.rotulos: set[str] = set()
        self.gatilhos: set[str] = set()
        self.funcoes: set[str] = set()
        for l in linhas:
            if len(l) < 2:
                continue
            tipo, nome, extra = l[0], l[1], (l[2] if len(l) > 2 else "")
            if tipo == "relacao":
                self.relacoes.add(nome)
                if extra in ("r", "p", "v", "m", "f"):
                    self.tabelas.add(nome)
            elif tipo == "coluna":
                self.colunas.add(nome)
            elif tipo == "restricao":
                self.restricoes.add(nome)
            elif tipo == "tipo":
                self.tipos.add(nome)
            elif tipo == "rotulo":
                self.rotulos.add(nome)
            elif tipo == "gatilho":
                self.gatilhos.add(nome)
            elif tipo == "funcao":
                self.funcoes.add(nome)


def conferir_esquema(nome: str, sql: str, cat: Catalogo) -> tuple[list[str], int]:
    """Simula o efeito do DDL da migration sobre o catálogo. Devolve (problemas, comandos reconhecidos)."""
    prob: list[str] = []
    reconhecidos = 0

    def exige_tabela(t: str, onde: str):
        if t not in cat.tabelas:
            prob.append(f"{onde}: tabela \"{t}\" não existe")

    for c in comandos(sql):
        u = c.upper()
        m = re.match(r"CREATE TABLE (IF NOT EXISTS )?" + ID + r" \((.*)\)$", c, re.I | re.S)
        if m:
            reconhecidos += 1
            t = m.group(2)
            if t in cat.relacoes and not m.group(1):
                prob.append(f"CREATE TABLE \"{t}\": já existe")
            cat.tabelas.add(t)
            cat.relacoes.add(t)
            for col in partes_de_alter(m.group(3)):
                mc = re.match(r'CONSTRAINT ' + ID + r" (PRIMARY KEY|UNIQUE|CHECK|FOREIGN KEY)", col, re.I)
                if mc:
                    cat.restricoes.add(f"{t}.{mc.group(1)}")
                    if mc.group(2).upper() in ("PRIMARY KEY", "UNIQUE"):
                        cat.relacoes.add(mc.group(1))
                    continue
                mcol = re.match(ID + r" ", col)
                if mcol and mcol.group(1).upper() not in ("PRIMARY", "UNIQUE", "CHECK", "FOREIGN", "CONSTRAINT"):
                    cat.colunas.add(f"{t}.{mcol.group(1)}")
                    if re.search(r"\bSERIAL\b", col, re.I):
                        cat.relacoes.add(f"{t}_{mcol.group(1)}_seq")
                for ref in re.findall(r"REFERENCES " + ID, col, re.I):
                    exige_tabela(ref, f"CREATE TABLE \"{t}\"")
            continue
        m = re.match(r"CREATE TYPE " + ID + r" AS ENUM \((.*)\)$", c, re.I | re.S)
        if m:
            reconhecidos += 1
            t = m.group(1)
            if t in cat.tipos:
                prob.append(f"CREATE TYPE \"{t}\": já existe")
            cat.tipos.add(t)
            for r in re.findall(r"'([^']*)'", m.group(2)):
                cat.rotulos.add(f"{t}.{r}")
            continue
        m = re.match(r"ALTER TYPE " + ID + r" ADD VALUE (IF NOT EXISTS )?'([^']*)'", c, re.I)
        if m:
            reconhecidos += 1
            t, r = m.group(1), m.group(3)
            if t not in cat.tipos:
                prob.append(f"ALTER TYPE \"{t}\": tipo não existe")
            elif f"{t}.{r}" in cat.rotulos and not m.group(2):
                prob.append(f"ALTER TYPE \"{t}\" ADD VALUE '{r}': rótulo já existe")
            cat.rotulos.add(f"{t}.{r}")
            continue
        m = re.match(r"CREATE (UNIQUE )?INDEX (IF NOT EXISTS )?" + ID + r" ON (ONLY )?" + ID, c, re.I)
        if m:
            reconhecidos += 1
            i, t = m.group(3), m.group(5)
            if i in cat.relacoes and not m.group(2):
                prob.append(f"CREATE INDEX \"{i}\": já existe")
            exige_tabela(t, f"CREATE INDEX \"{i}\"")
            cat.relacoes.add(i)
            continue
        m = re.match(r"DROP INDEX (IF EXISTS )?" + ID, c, re.I)
        if m:
            reconhecidos += 1
            i = m.group(2)
            if i not in cat.relacoes and not m.group(1):
                prob.append(f"DROP INDEX \"{i}\": não existe")
            cat.relacoes.discard(i)
            continue
        m = re.match(r"ALTER TABLE (ONLY )?(IF EXISTS )?" + ID + r" (.*)$", c, re.I | re.S)
        if m:
            reconhecidos += 1
            t = m.group(3)
            exige_tabela(t, f"ALTER TABLE \"{t}\"")
            for a in partes_de_alter(m.group(4)):
                ma = re.match(r"ADD COLUMN (IF NOT EXISTS )?" + ID, a, re.I)
                if ma:
                    col = f"{t}.{ma.group(2)}"
                    if col in cat.colunas and not ma.group(1):
                        prob.append(f"ALTER TABLE \"{t}\" ADD COLUMN \"{ma.group(2)}\": coluna já existe")
                    cat.colunas.add(col)
                ma = re.match(r"ADD CONSTRAINT " + ID + r" (PRIMARY KEY|UNIQUE|CHECK|FOREIGN KEY|EXCLUDE)?", a, re.I)
                if ma:
                    k = f"{t}.{ma.group(1)}"
                    if k in cat.restricoes:
                        prob.append(f"ALTER TABLE \"{t}\" ADD CONSTRAINT \"{ma.group(1)}\": restrição já existe")
                    cat.restricoes.add(k)
                    if (ma.group(2) or "").upper() in ("PRIMARY KEY", "UNIQUE"):
                        cat.relacoes.add(ma.group(1))
                ma = re.match(r"DROP CONSTRAINT (IF EXISTS )?" + ID, a, re.I)
                if ma:
                    k = f"{t}.{ma.group(2)}"
                    if k not in cat.restricoes and not ma.group(1):
                        prob.append(f"ALTER TABLE \"{t}\" DROP CONSTRAINT \"{ma.group(2)}\": restrição não existe")
                    cat.restricoes.discard(k)
                ma = re.match(r"DROP COLUMN (IF EXISTS )?" + ID, a, re.I)
                if ma:
                    col = f"{t}.{ma.group(2)}"
                    if col not in cat.colunas and not ma.group(1):
                        prob.append(f"ALTER TABLE \"{t}\" DROP COLUMN \"{ma.group(2)}\": coluna não existe")
                    cat.colunas.discard(col)
                ma = re.match(r"ALTER COLUMN " + ID, a, re.I)
                if ma and f"{t}.{ma.group(1)}" not in cat.colunas:
                    prob.append(f"ALTER TABLE \"{t}\" ALTER COLUMN \"{ma.group(1)}\": coluna não existe")
                ma = re.match(r"RENAME (COLUMN )?" + ID + r" TO " + ID, a, re.I)
                if ma:
                    de, para = f"{t}.{ma.group(2)}", f"{t}.{ma.group(3)}"
                    if de not in cat.colunas:
                        prob.append(f"ALTER TABLE \"{t}\" RENAME \"{ma.group(2)}\": coluna não existe")
                    if para in cat.colunas:
                        prob.append(f"ALTER TABLE \"{t}\" RENAME … TO \"{ma.group(3)}\": coluna já existe")
                    cat.colunas.discard(de)
                    cat.colunas.add(para)
                for ref in re.findall(r"REFERENCES " + ID, a, re.I):
                    exige_tabela(ref, f"ALTER TABLE \"{t}\"")
            continue
        m = re.match(r"CREATE (OR REPLACE )?(CONSTRAINT )?TRIGGER " + ID + r" .*? ON " + ID, c, re.I | re.S)
        if m:
            reconhecidos += 1
            g, t = m.group(3), m.group(4)
            exige_tabela(t, f"CREATE TRIGGER \"{g}\"")
            if f"{t}.{g}" in cat.gatilhos and not m.group(1):
                prob.append(f"CREATE TRIGGER \"{g}\": já existe em \"{t}\"")
            cat.gatilhos.add(f"{t}.{g}")
            continue
        m = re.match(r"CREATE (OR REPLACE )?FUNCTION " + ID, c, re.I)
        if m:
            reconhecidos += 1
            if m.group(2) in cat.funcoes and not m.group(1):
                prob.append(f"CREATE FUNCTION \"{m.group(2)}\": já existe")
            cat.funcoes.add(m.group(2))
            continue
        m = re.match(r"(INSERT INTO|UPDATE|DELETE FROM) " + ID, c, re.I)
        if m:
            reconhecidos += 1
            exige_tabela(m.group(2), m.group(1).upper())
            continue
        if u.startswith(("CREATE EXTENSION", "COMMENT ON", "SELECT ", "SET ")):
            reconhecidos += 1
    return [f"{nome}: {p}" for p in prob], reconhecidos


# ----------------------------------------------------------------------------------------- cadeia
def principal(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--versao", required=True)
    ap.add_argument("--migracoes", required=True, help="pasta migrations/ extraída da imagem")
    ap.add_argument("--estado", required=True, help="saída de sql/preflight-estado.sql ('' = tabela ausente)")
    ap.add_argument("--catalogo", required=True)
    ap.add_argument("--verificacoes", required=True)
    a = ap.parse_args(argv)

    if not os.path.isdir(a.migracoes):
        print(f"✘ pasta de migrations ausente: {a.migracoes}")
        return 2
    imagem: dict[str, str] = {}
    sqls: dict[str, str] = {}
    for n in sorted(os.listdir(a.migracoes)):
        p = os.path.join(a.migracoes, n, "migration.sql")
        if not os.path.isdir(os.path.join(a.migracoes, n)):
            continue
        if not RE_NOME.match(n) or not os.path.isfile(p):
            print(f"✘ item inesperado nas migrations da imagem: {n}")
            return 2
        with open(p, "rb") as f:
            bruto = f.read()
        imagem[n] = hashlib.sha256(bruto).hexdigest()
        sqls[n] = bruto.decode("utf-8", errors="replace")
    nomes = sorted(imagem)
    bloqueios: list[str] = []
    avisos: list[str] = []

    registros = [l for l in ler_linhas(a.estado) if len(l) >= 5]
    concluidas: dict[str, list[str]] = {}
    for n, ck, fim, rev, _ in registros:
        if fim == "1" and rev == "0":
            concluidas.setdefault(n, []).append(ck)
    for n, ck, fim, rev, _ in registros:
        if fim == "0" and rev == "0":
            bloqueios.append(f"{n}: iniciada e NÃO concluída (o Prisma recusa continuar: resolva antes de migrar)")
        elif rev == "1" and n not in concluidas:
            avisos.append(f"{n}: registro revertido (rolled back) — será aplicada de novo")
    for n, cks in sorted(concluidas.items()):
        if len(cks) > 1:
            bloqueios.append(f"{n}: registrada {len(cks)} vezes como concluída")
        if n not in imagem:
            bloqueios.append(f"{n}: aplicada no banco e DESCONHECIDA da imagem {a.versao}")
        elif cks[-1] != imagem[n]:
            bloqueios.append(f"{n}: conteúdo DIVERGENTE (checksum no banco {cks[-1][:12]}… ≠ imagem {imagem[n][:12]}…)")
    aplicadas = sorted(n for n in concluidas if n in imagem)
    pendentes = [n for n in nomes if n not in concluidas]
    ultima = max(concluidas) if concluidas else ""
    for n in pendentes:
        if n < ultima:
            bloqueios.append(f"{n}: pendente com nome ANTERIOR à última aplicada ({ultima}) — ordem divergente")

    # Esquema: simula as pendentes na ordem sobre o catálogo atual.
    cat = Catalogo(ler_linhas(a.catalogo))
    esquema_ok = []
    for n in pendentes:
        prob, rec = conferir_esquema(n, sqls[n], cat)
        bloqueios.extend(prob)
        if not prob:
            esquema_ok.append(f"{n} ({rec} comandos)")

    # Dados: só as verificações das pendentes (e as gerais '*').
    dados = []
    for l in ler_linhas(a.verificacoes):
        if len(l) < 4:
            continue
        mig, nome, valor, esperado = l[0], l[1], l[2], l[3]
        if mig != "*" and mig not in pendentes:
            continue
        if mig == "*" and not pendentes:
            continue
        if esperado == "-":
            dados.append(f"ℹ {mig} {nome}: {valor}")
        elif valor != esperado:
            bloqueios.append(f"{mig}: dado incompatível — {nome} = {valor} (esperado {esperado})")
        else:
            dados.append(f"✔ {mig} {nome}: {valor}")

    print(f"• imagem {a.versao}: {len(nomes)} migrations · banco: {len(aplicadas)} aplicadas ({len(registros)} registros)")
    print(f"• pendentes ({len(pendentes)}): {', '.join(pendentes) if pendentes else 'nenhuma'}")
    for n in esquema_ok:
        print(f"✔ esquema compatível: {n}")
    for d in dados:
        print(d)
    for w in avisos:
        print(f"⚠ {w}")
    for b in bloqueios:
        print(f"✘ {b}")
    if bloqueios:
        print(f"PREFLIGHT: BLOQUEADO ({len(bloqueios)} problema(s)). Nada foi alterado; NÃO migre antes de resolver.")
        return 1
    print("PREFLIGHT: OK (nenhuma migration incompleta, desconhecida, divergente ou fora de ordem; "
          "esquema e dados compatíveis com as pendentes)")
    return 0


if __name__ == "__main__":
    sys.exit(principal(sys.argv[1:]))
