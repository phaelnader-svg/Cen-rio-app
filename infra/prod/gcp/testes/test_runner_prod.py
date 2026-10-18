"""Runner com o perfil de PRODUÇÃO: identidade separada da homologação e caminhos/nomes de produção.

Reaproveita o ambiente falso dos testes do runner homologado (APIs do Google falsas com assinatura RS256
real, vm.sh/docker/systemctl falsos) e muda só a configuração para a de produção.
Executar: python3 -m unittest infra/prod/gcp/testes/test_runner_prod.py -v
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import unittest

AQUI = os.path.dirname(os.path.abspath(__file__))
RAIZ = os.path.abspath(os.path.join(AQUI, "..", "..", "..", ".."))
sys.path.insert(0, os.path.join(RAIZ, "infra/homolog/gcp/autonomia/testes"))
import test_runner as base  # noqa: E402

OPERADOR_PROD = "claude-operador-prod@cenariogestao.iam.gserviceaccount.com"
OPERADOR_HOMOLOG = base.OPERADOR


def ambiente_prod(**ajustes) -> base.Ambiente:
    a = base.Ambiente(vm="cenario-prod")
    a.est.assinante = OPERADOR_PROD
    vm_sh = os.path.join(a.d, "opt/cenario/infra/prod/gcp/vm.sh")
    os.makedirs(os.path.dirname(vm_sh), exist_ok=True)
    shutil.copy2(os.path.join(a.d, "opt/cenario/infra/homolog/gcp/vm.sh"), vm_sh)
    shutil.rmtree(os.path.join(a.d, "opt/cenario/infra/homolog"))
    base.escrever(os.path.join(a.d, "run/env"), f"POSTGRES_PASSWORD='{base.SEGREDO}'\nPROD_DOMAIN='cenariogestao.com.br'\n"
                  "PROD_DOMAIN_WWW='www.cenariogestao.com.br'\n"
                  "CENARIO_API_IMAGE='southamerica-east1-docker.pkg.dev/cenariogestao/cenario-prod/api:9fb1786'\n", 0o600)
    a.cfg.update({
        "ambiente": "prod", "vm": "cenario-prod", "assinante": OPERADOR_PROD, "aud": "cenario-prod-runner",
        "dominio": "cenariogestao.com.br",
        "assinatura": "projects/cenariogestao/subscriptions/cenario-prod-comandos-vm",
        "bucket": "cenariogestao-prod-operacoes", "bucket_versoes": "cenariogestao-prod-runner-versoes",
        "vm_sh": vm_sh,
    })
    a.cfg.update(ajustes)
    a.salvar_cfg()
    return a


def claims_prod(a: base.Ambiente, operacao: str, parametros: dict | None = None, **extra) -> dict:
    c = a.claims(operacao, parametros)
    c.update({"iss": OPERADOR_PROD, "sub": OPERADOR_PROD, "aud": "cenario-prod-runner", "vm": "cenario-prod"})
    c.update(extra)
    return c


def resultado_prod(a: base.Ambiente, jti: str) -> dict:
    import time
    fim = time.time() + 30
    while time.time() < fim:
        r = a.objeto(f"operacoes/{jti}/resultado.json", bucket="cenariogestao-prod-operacoes")
        if r is not None:
            return json.loads(r)
        time.sleep(0.1)
    raise AssertionError(f"sem resultado para {jti}: {open(os.path.join(a.d, 'runner.out')).read()[-2000:]}")


class TestPerfilProd(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.a = ambiente_prod().iniciar()

    @classmethod
    def tearDownClass(cls):
        cls.a.parar()

    def test_opera_com_identidade_de_producao(self):
        c = claims_prod(self.a, "status")
        self.a.publicar(c)
        res = resultado_prod(self.a, c["jti"])
        self.assertEqual(res["status"], "concluido", res)
        self.assertIn("INICIO status", self.a.log("vmsh.log"))

    def test_recusa_operador_e_audiencia_da_homologacao(self):
        # JWT do operador da HOMOLOGAÇÃO (outra conta): o certificado não é o da conta de produção.
        c = claims_prod(self.a, "status", iss=OPERADOR_HOMOLOG, sub=OPERADOR_HOMOLOG)
        self.assertIn("emissor", self.a.rejeicao(self.a.publicar(c))["motivo"])
        c = claims_prod(self.a, "status", aud="cenario-homolog-runner")
        self.assertIn("audiência", self.a.rejeicao(self.a.publicar(c))["motivo"])
        c = claims_prod(self.a, "status", vm="cenario-homolog")
        self.assertIn("outra VM", self.a.rejeicao(self.a.publicar(c))["motivo"])

    def test_unidades_e_banco_de_producao(self):
        c = claims_prod(self.a, "application_logs", {"unit": "cenario-homolog"})
        self.assertIn("valores aceitos", self.a.rejeicao(self.a.publicar(c))["motivo"])
        c = claims_prod(self.a, "application_logs", {"unit": "cenario-prod"})
        self.a.publicar(c)
        self.assertEqual(resultado_prod(self.a, c["jti"])["status"], "concluido")
        self.assertIn("-u cenario-prod.service", self.a.log("journalctl.log"))
        c = claims_prod(self.a, "migration_status")
        self.a.publicar(c)
        resultado_prod(self.a, c["jti"])
        self.assertRegex(self.a.log("docker.log"), r"psql -U cenario -d cenario_prod ")
        self.assertNotIn("cenario_homolog", self.a.log("docker.log"))

    def test_suite_acesso_sem_camada_de_senha(self):
        c = claims_prod(self.a, "run_homologation_tests", {"suite": "acesso"})
        self.a.publicar(c)
        resultado_prod(self.a, c["jti"])
        self.assertIn("INICIO acesso", self.a.log("vmsh.log"))
        self.assertNotIn("diagnosticar-acesso", self.a.log("vmsh.log"))


class TestPrimeiraPublicacao(unittest.TestCase):
    """stack_bootstrap/seed_bootstrap: só no perfil de produção; stack_bootstrap exige o portão aberto."""

    def test_stack_bootstrap_exige_portao_e_fixa_a_etiqueta(self):
        a = ambiente_prod().iniciar()
        try:
            v = "9fb1786beddae28c34b20a0922b42989ecb0fbf2"
            c = claims_prod(a, "stack_bootstrap", {"version": v})
            a.publicar(c)
            res = resultado_prod(a, c["jti"])
            self.assertEqual(res["status"], "falhou", res)
            self.assertIn("portão", res["motivo"])
            base.escrever(a.cfg["portao"], "")
            c = claims_prod(a, "stack_bootstrap", {"version": v})
            a.publicar(c)
            self.assertEqual(resultado_prod(a, c["jti"])["status"], "concluido")
            log = a.log("vmsh.log")
            self.assertRegex(log, rf"INICIO gerar-env\s+TAG={v}")
            self.assertRegex(log, rf"INICIO iniciar-banco\s+TAG={v}")
            with open(a.cfg["dropin_etiqueta"]) as f:
                self.assertIn(f"CENARIO_TAG={v}", f.read())
            c = claims_prod(a, "seed_bootstrap")
            a.publicar(c)
            self.assertEqual(resultado_prod(a, c["jti"])["status"], "concluido")
            self.assertIn("INICIO semear", a.log("vmsh.log"))
        finally:
            a.parar()

    def test_homologacao_nao_tem_primeira_publicacao(self):
        a = base.Ambiente().iniciar()
        try:
            for op, p in (("stack_bootstrap", {"version": "9fb1786"}), ("seed_bootstrap", {})):
                c = a.claims(op, p)
                a.publicar(c)
                res = a.resultado(c["jti"])
                self.assertEqual(res["status"], "falhou", res)
                self.assertIn("perfil de produção", res["motivo"])
        finally:
            a.parar()


class TestPartidaCoerente(unittest.TestCase):
    def esperar_recusa(self, a: base.Ambiente):
        a.iniciar()
        try:
            self.assertEqual(a.proc.wait(20), 78)
        finally:
            a.parar()

    def test_perfil_prod_com_audiencia_de_homologacao_nao_inicia(self):
        self.esperar_recusa(ambiente_prod(aud="cenario-homolog-runner"))

    def test_perfil_prod_com_assinante_de_homologacao_nao_inicia(self):
        self.esperar_recusa(ambiente_prod(assinante=OPERADOR_HOMOLOG))

    def test_perfil_prod_com_bucket_de_homologacao_nao_inicia(self):
        self.esperar_recusa(ambiente_prod(bucket="cenariogestao-homolog-operacoes"))

    def test_perfil_homolog_com_identidade_de_producao_nao_inicia(self):
        a = base.Ambiente(vm="cenario-prod")
        a.cfg.update({"vm": "cenario-prod"})
        a.salvar_cfg()
        self.esperar_recusa(a)


class TestPacoteDeScriptsProd(unittest.TestCase):
    """O pacote de scripts da produção só contém infra/prod e os scripts de backup."""

    def setUp(self):
        self.a = ambiente_prod().iniciar()
        self.commit = subprocess.run(["git", "-C", RAIZ, "rev-parse", "HEAD"], check=True, capture_output=True,
                                     text=True).stdout.strip()
        self.v = self.commit[:12]

    def tearDown(self):
        self.a.parar()

    def publicar(self, pacote: bytes):
        b = "cenariogestao-prod-runner-versoes"
        self.a.est.objetos[(b, f"scripts-{self.v}.tar.gz")] = pacote
        self.a.est.objetos[(b, f"scripts-{self.v}.sha256")] = hashlib.sha256(pacote).hexdigest().encode()

    def rodar(self, op: str, **p) -> tuple[dict, str]:
        c = claims_prod(self.a, op, p, timeout_s=120)
        self.a.publicar(c)
        res = resultado_prod(self.a, c["jti"])
        return res, (self.a.objeto(f"operacoes/{c['jti']}/stdout.txt", bucket="cenariogestao-prod-operacoes") or b"").decode()

    def test_pacote_git_de_infra_prod_e_aceito(self):
        tar = subprocess.run(["git", "-C", RAIZ, "archive", "--format=tar", self.commit, "infra/prod", "scripts/backup.sh",
                              "scripts/restore.sh"], check=True, capture_output=True).stdout
        self.publicar(subprocess.run(["gzip", "-n"], input=tar, check=True, capture_output=True).stdout)
        res, out = self.rodar("vm_scripts_diff", version=self.v)
        self.assertEqual(res["status"], "concluido", res)
        self.assertIn("~ alterado  infra/prod/gcp/vm.sh", out)
        self.assertIn("+ novo      infra/prod/docker-compose.prod.yml", out)
        pacote = [l for l in out.splitlines() if l.lstrip().startswith(("+ novo", "~ alterado"))]
        self.assertTrue(pacote)
        self.assertFalse([l for l in pacote if "infra/homolog" in l])

    def test_pacote_com_infra_homolog_e_recusado(self):
        membros = {"infra/homolog/gcp/vm.sh": "#!/bin/bash\n", "infra/prod/gcp/vm.sh": "#!/bin/bash\n",
                   "infra/prod/docker-compose.prod.yml": "services: {}\n", "infra/prod/Caddyfile.prod": ":80\n",
                   "scripts/backup.sh": "#!/bin/bash\n", "scripts/restore.sh": "#!/bin/bash\n"}
        self.publicar(base.pacote_scripts_manual(self.commit, membros))
        res, _ = self.rodar("vm_scripts_diff", version=self.v)
        self.assertEqual(res["status"], "falhou", res)
        self.assertIn("caminho não permitido", res["motivo"])


class TestFerramentasCompartilhadas(unittest.TestCase):
    """As ferramentas independentes de ambiente (impressão digital, conferência da restauração e
    pré-verificação das migrations) são CÓPIAS idênticas das homologadas: nunca divergem em silêncio."""

    def test_copias_identicas(self):
        # impressao-digital.sql é a ÚNICA divergência deliberada (banco novo sem _prisma_migrations; mesma
        # saída com a tabela presente — conferido com PostgreSQL real no ensaio do primeiro deploy).
        pares = ["conferencia-restauracao.sh", "preflight_migracoes.py", "sql/preflight-catalogo.sql", "sql/preflight-estado.sql", "sql/preflight-migracoes.sql",
                 "sql/diagnostico-tabela.sql"]
        for p in pares:
            with open(os.path.join(RAIZ, "infra/homolog/gcp", p), "rb") as f1, open(os.path.join(RAIZ, "infra/prod/gcp", p), "rb") as f2:
                self.assertEqual(f1.read(), f2.read(), p)

    def test_impressao_digital_so_difere_nas_migracoes(self):
        with open(os.path.join(RAIZ, "infra/homolog/gcp/sql/impressao-digital.sql"), encoding="utf-8") as f:
            h = f.read()
        with open(os.path.join(RAIZ, "infra/prod/gcp/sql/impressao-digital.sql"), encoding="utf-8") as f:
            p = f.read()
        corte = "SELECT 'migracoes', 'aplicadas'"
        self.assertEqual(h.split(corte)[0], p.split("-- PRODUÇÃO (única diferença")[0])
        self.assertEqual(h.split("SELECT 'financeiro'")[1], p.split("SELECT 'financeiro'")[1])


if __name__ == "__main__":
    unittest.main()
