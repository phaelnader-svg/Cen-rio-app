"""Testes da pré-verificação da cadeia de migrations (`vm.sh preflight <etiqueta>`) com PostgreSQL REAL.

O vm.sh roda de verdade (SQL fixo de sql/preflight-*.sql + preflight_migracoes.py); só o Docker é
falso: "compose exec postgres psql" vira psql no servidor de teste e "docker run … tar migrations"
devolve a pasta de migrations indicada (a do repositório, até 20261230000000_modelos_simplificados).

Requer um PostgreSQL acessível (padrão postgresql://cenario_teste:cenario_teste@localhost:5432, um
usuário que crie bancos; outro em PREFLIGHT_PG_URL). Sem servidor, os testes são PULADOS (avisado).
Executar: python3 -m unittest infra/homolog/gcp/testes/test_preflight.py -v
"""
from __future__ import annotations

import hashlib
import os
import shutil
import subprocess
import tempfile
import unittest
import uuid

AQUI = os.path.dirname(os.path.abspath(__file__))
RAIZ = os.path.abspath(os.path.join(AQUI, "..", "..", "..", ".."))
VMSH = os.path.join(RAIZ, "infra/homolog/gcp/vm.sh")
MIGRACOES = os.path.join(RAIZ, "packages/db/prisma/migrations")
PG = os.environ.get("PREFLIGHT_PG_URL", "postgresql://cenario_teste:cenario_teste@localhost:5432").rstrip("/")
NOMES = sorted(n for n in os.listdir(MIGRACOES) if os.path.isdir(os.path.join(MIGRACOES, n)))
ULTIMA = "20261230000000_modelos_simplificados"

DOCKER_FALSO = """#!/usr/bin/env bash
case "$1" in
  image) exit 0 ;;
  run) exec tar -C "$PF_PRISMA" -cf - migrations ;;
  compose)
    while [[ "$1" != psql ]]; do shift; done; shift
    args=(); db=""
    while (($#)); do case "$1" in -U) shift 2 ;; -d) db="$2"; shift 2 ;; *) args+=("$1"); shift ;; esac; done
    exec psql -q "$PF_PG/$db" "${args[@]}" ;;
esac
echo "docker falso: comando inesperado: $*" >&2; exit 9
"""

TABELA_PRISMA = """CREATE TABLE IF NOT EXISTS _prisma_migrations (
  id varchar(36) PRIMARY KEY, checksum varchar(64) NOT NULL, finished_at timestamptz,
  migration_name varchar(255) NOT NULL, logs text, rolled_back_at timestamptz,
  started_at timestamptz NOT NULL DEFAULT now(), applied_steps_count integer NOT NULL DEFAULT 0)"""


def psql(db: str, *args: str, entrada: str | None = None) -> str:
    r = subprocess.run(["psql", "-qAt", "-v", "ON_ERROR_STOP=1", f"{PG}/{db}", *args], input=entrada,
                       capture_output=True, text=True)
    if r.returncode != 0:
        raise AssertionError(f"psql {args}: {r.stderr}")
    return r.stdout


def servidor_disponivel() -> bool:
    try:
        return subprocess.run(["psql", "-qAt", f"{PG}/postgres", "-c", "select 1"], capture_output=True,
                              timeout=10).returncode == 0
    except (OSError, subprocess.TimeoutExpired):
        return False


def soma(nome: str) -> str:
    with open(os.path.join(MIGRACOES, nome, "migration.sql"), "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


@unittest.skipUnless(shutil.which("psql") and servidor_disponivel(), f"PostgreSQL de teste indisponível em {PG}")
class TestPreflight(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="cenario-preflight-")
        os.makedirs(os.path.join(self.tmp, "bin"))
        with open(os.path.join(self.tmp, "bin/docker"), "w") as f:
            f.write(DOCKER_FALSO)
        os.chmod(os.path.join(self.tmp, "bin/docker"), 0o755)
        with open(os.path.join(self.tmp, "env"), "w") as f:
            f.write("POSTGRES_PASSWORD='nao-usado'\n")
        self.prisma = os.path.join(self.tmp, "prisma")
        os.makedirs(self.prisma)
        shutil.copytree(MIGRACOES, os.path.join(self.prisma, "migrations"))
        self.bancos: list[str] = []

    def tearDown(self):
        for b in self.bancos:
            psql("postgres", "-c", f"DROP DATABASE IF EXISTS {b} WITH (FORCE)")
        shutil.rmtree(self.tmp, ignore_errors=True)

    # -- ambiente
    def banco(self) -> str:
        b = "pf_" + uuid.uuid4().hex[:10]
        psql("postgres", "-c", f"CREATE DATABASE {b}")
        self.bancos.append(b)
        return b

    def aplicar(self, db: str, nomes: list[str]) -> None:
        """Aplica migrations como o Prisma: o SQL e o registro em _prisma_migrations (checksum = SHA-256)."""
        psql(db, "-c", TABELA_PRISMA)
        for n in nomes:
            with open(os.path.join(MIGRACOES, n, "migration.sql"), encoding="utf-8") as f:
                psql(db, "-1", entrada=f.read())
            psql(db, "-c", f"INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name, applied_steps_count) "
                           f"VALUES ('{uuid.uuid4()}', '{soma(n)}', now(), '{n}', 1)")

    def preflight(self, db: str) -> subprocess.CompletedProcess:
        env = {"PATH": f"{self.tmp}/bin:{os.environ['PATH']}", "HOME": self.tmp, "LANG": "C.UTF-8",
               "CENARIO_DIR": RAIZ, "CENARIO_ENV_FILE": os.path.join(self.tmp, "env"),
               "CENARIO_STATE_DIR": os.path.join(self.tmp, "estado"), "CENARIO_REGISTRY": "registro.local/cenario",
               "CENARIO_META_URL": "http://127.0.0.1:9", "PF_PG": PG, "PF_PRISMA": self.prisma}
        # O vm.sh lê sempre o banco cenario_homolog: o docker falso troca pelo banco do teste.
        wrapper = os.path.join(self.tmp, "bin/docker")
        with open(wrapper, "w") as f:
            f.write(DOCKER_FALSO.replace('"$PF_PG/$db"', f'"$PF_PG/{db}"'))
        return subprocess.run(["bash", VMSH, "preflight", "406fde7"], env=env, capture_output=True, text=True, timeout=120)

    def assert_ok(self, r, pendentes: int):
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("PREFLIGHT: OK", r.stdout)
        self.assertIn(f"• pendentes ({pendentes})", r.stdout)

    def assert_bloqueia(self, r, trecho: str):
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertIn("PREFLIGHT: BLOQUEADO", r.stdout)
        self.assertIn(trecho, r.stdout)

    # -- cadeia completa, sem falso positivo em nenhum ponto
    def test_cadeia_completa_ate_modelos_simplificados(self):
        self.assertEqual(NOMES[-1], ULTIMA)
        self.assertEqual(len(NOMES), 25)
        db = self.banco()
        for k, n in enumerate(NOMES):
            r = self.preflight(db)
            self.assert_ok(r, len(NOMES) - k)
            if k:
                self.assertIn(f"banco: {k} aplicadas", r.stdout)
            self.aplicar(db, [n])
        self.assert_ok(self.preflight(db), 0)

    def test_estado_de_homologacao_18_mais_7(self):
        db = self.banco()
        self.aplicar(db, NOMES[:18])
        r = self.preflight(db)
        self.assert_ok(r, 7)
        for n in NOMES[18:]:
            self.assertIn(f"✔ esquema compatível: {n}", r.stdout)
        self.assertIn("✔ 20261220000000_recebimentos_permissao_funcoes role-permissions-sem-chave-funcao-permissao: 0", r.stdout)
        self.assertIn("✔ 20261230000000_modelos_simplificados rotulos-de-enum-ausentes: 0", r.stdout)

    def test_banco_criado_pelo_prisma_real(self):
        prisma = os.path.join(RAIZ, "packages/db/node_modules/.bin/prisma")
        if not os.path.exists(prisma):
            self.skipTest("prisma não instalado (pnpm install)")
        db = self.banco()
        pasta = os.path.join(self.tmp, "schema18")
        os.makedirs(os.path.join(pasta, "migrations"))
        shutil.copy(os.path.join(RAIZ, "packages/db/prisma/schema.prisma"), pasta)
        shutil.copy(os.path.join(MIGRACOES, "migration_lock.toml"), os.path.join(pasta, "migrations"))
        for n in NOMES[:18]:
            shutil.copytree(os.path.join(MIGRACOES, n), os.path.join(pasta, "migrations", n))
        env = {**os.environ, "DATABASE_URL": f"{PG}/{db}", "CHECKPOINT_DISABLE": "1"}
        self.assert_ok(self.preflight(db), len(NOMES))  # banco vazio (sem _prisma_migrations)
        for schema, pendentes in ((os.path.join(pasta, "schema.prisma"), 7),
                                  (os.path.join(RAIZ, "packages/db/prisma/schema.prisma"), 0)):
            subprocess.run([prisma, "migrate", "deploy", "--schema", schema], env=env, check=True, capture_output=True,
                           cwd=os.path.join(RAIZ, "packages/db"))
            self.assert_ok(self.preflight(db), pendentes)

    # -- bloqueios
    def test_migration_incompleta(self):
        db = self.banco()
        self.aplicar(db, NOMES[:18])
        psql(db, "-c", f"INSERT INTO _prisma_migrations (id, checksum, migration_name) VALUES ('{uuid.uuid4()}', '{soma(NOMES[18])}', '{NOMES[18]}')")
        self.assert_bloqueia(self.preflight(db), f"{NOMES[18]}: iniciada e NÃO concluída")

    def test_migration_desconhecida(self):
        db = self.banco()
        self.aplicar(db, NOMES[:18])
        psql(db, "-c", f"INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name) "
                       f"VALUES ('{uuid.uuid4()}', '{'0' * 64}', now(), '20261299000000_de_outra_versao')")
        self.assert_bloqueia(self.preflight(db), "20261299000000_de_outra_versao: aplicada no banco e DESCONHECIDA")

    def test_migration_divergente(self):
        db = self.banco()
        self.aplicar(db, NOMES[:18])
        psql(db, "-c", f"UPDATE _prisma_migrations SET checksum = '{'a' * 64}' WHERE migration_name = '{NOMES[17]}'")
        self.assert_bloqueia(self.preflight(db), f"{NOMES[17]}: conteúdo DIVERGENTE")

    def test_ordem_divergente(self):
        db = self.banco()
        self.aplicar(db, NOMES[:20] + NOMES[21:22])  # 20261227 aplicada sem a 20261220 (pulada)
        self.assert_bloqueia(self.preflight(db), f"{NOMES[20]}: pendente com nome ANTERIOR à última aplicada")

    def test_registro_duplicado(self):
        db = self.banco()
        self.aplicar(db, NOMES[:18])
        psql(db, "-c", f"INSERT INTO _prisma_migrations (id, checksum, finished_at, migration_name) "
                       f"VALUES ('{uuid.uuid4()}', '{soma(NOMES[17])}', now(), '{NOMES[17]}')")
        self.assert_bloqueia(self.preflight(db), f"{NOMES[17]}: registrada 2 vezes como concluída")

    def test_esquema_objeto_ja_existe(self):
        db = self.banco()
        self.aplicar(db, NOMES[:18])
        psql(db, "-c", 'ALTER TABLE "commercial_orders" ADD COLUMN "customer_drop_off" BOOLEAN')
        self.assert_bloqueia(self.preflight(db), '20261227000000_servico_sem_retirada: ALTER TABLE "commercial_orders" '
                                                 'ADD COLUMN "customer_drop_off": coluna já existe')

    def test_esquema_tabela_criada_antes(self):
        db = self.banco()
        self.aplicar(db, NOMES[:18])
        psql(db, "-c", 'CREATE TABLE "material_arrivals" (id uuid)')
        self.assert_bloqueia(self.preflight(db), '20261206000000_recebimentos_compartilhados: CREATE TABLE "material_arrivals": já existe')

    def test_esquema_tabela_referenciada_ausente(self):
        db = self.banco()
        self.aplicar(db, NOMES[:18])
        psql(db, "-c", 'ALTER TABLE "devices" RENAME TO "devices_antigo"')
        self.assert_bloqueia(self.preflight(db), 'tabela "devices" não existe')

    def test_dados_permissao_sem_chave(self):
        db = self.banco()
        self.aplicar(db, NOMES[:18])
        psql(db, "-c", 'ALTER TABLE "role_permissions" DROP CONSTRAINT "role_permissions_pkey"')
        self.assert_bloqueia(self.preflight(db), "role-permissions-sem-chave-funcao-permissao = 1 (esperado 0)")

    def test_dados_rotulo_de_enum_ausente(self):
        db = self.banco()
        self.aplicar(db, NOMES[:18])
        psql(db, "-c", "ALTER TYPE \"piece_type\" RENAME VALUE 'CANTO_ALEMAO' TO 'CANTO_ALEMAO_X'")
        self.assert_bloqueia(self.preflight(db), "rotulos-de-enum-ausentes = 1 (esperado 0)")

    def test_verificacao_de_aplicada_e_ignorada(self):
        # Depois de aplicada, a regra da migration não vale mais: dado alterado depois não bloqueia.
        db = self.banco()
        self.aplicar(db, NOMES)
        psql(db, "-c", "ALTER TYPE \"piece_type\" RENAME VALUE 'CANTO_ALEMAO' TO 'CANTO_ALEMAO_X'")
        self.assert_ok(self.preflight(db), 0)

    def test_revertida_sem_objetos_e_aviso(self):
        db = self.banco()
        self.aplicar(db, NOMES[:18])
        psql(db, "-c", f"INSERT INTO _prisma_migrations (id, checksum, migration_name, rolled_back_at) "
                       f"VALUES ('{uuid.uuid4()}', '{soma(NOMES[18])}', '{NOMES[18]}', now())")
        r = self.preflight(db)
        self.assert_ok(r, 7)
        self.assertIn(f"⚠ {NOMES[18]}: registro revertido", r.stdout)

    def test_revertida_com_objetos_parciais_bloqueia(self):
        db = self.banco()
        self.aplicar(db, NOMES[:18])
        psql(db, "-c", f"INSERT INTO _prisma_migrations (id, checksum, migration_name, rolled_back_at) "
                       f"VALUES ('{uuid.uuid4()}', '{soma(NOMES[18])}', '{NOMES[18]}', now())")
        psql(db, "-c", 'ALTER TABLE "commercial_orders" ADD COLUMN "auto_service_order" BOOLEAN')
        self.assert_bloqueia(self.preflight(db), '"auto_service_order": coluna já existe')

    def test_migrar_usa_a_pre_verificacao(self):
        with open(VMSH, encoding="utf-8") as f:
            vm = f.read()
        corpo = vm.split("\nmigrar() {", 1)[1].split("\n}\n", 1)[0]
        self.assertIn('preflight "$tag" ||', corpo)
        self.assertLess(corpo.index('preflight "$tag"'), corpo.index("pnpm db:migrate"))


if __name__ == "__main__":
    unittest.main()
