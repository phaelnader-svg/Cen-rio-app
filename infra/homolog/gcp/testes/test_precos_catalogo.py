"""Testes da consulta de preços (falhas de rede, respostas incompletas, cache e limite).

Executar: python3 -m unittest discover -s infra/homolog/gcp/testes -v
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from datetime import datetime, timedelta, timezone

AQUI = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, AQUI)
from catalogo_falso import IP_OFICIAL, Catalogo, total_esperado  # noqa: E402

MODULO = os.path.join(AQUI, "..", "precos_catalogo.py")


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.cache = os.path.join(self.tmp.name, "cache", "precos.json")
        self.cats: list[Catalogo] = []

    def tearDown(self):
        for c in self.cats:
            c.parar()
        self.tmp.cleanup()

    def catalogo(self, modo, atraso=3.0):
        c = Catalogo(modo, atraso)
        self.cats.append(c)
        return c

    def rodar(self, modo_cli, url, limite="20.00", extra=None, token="tok-teste", args=()):
        env = {
            "PATH": os.environ["PATH"],
            "CENARIO_TOKEN": token,
            "CENARIO_CONTA": "teste@exemplo.com",
            "CENARIO_CATALOGO_URL": url,
            "CENARIO_PRECOS_PERMITIR_TESTE": "1",
            "CENARIO_PRECOS_CACHE": self.cache,
            "CENARIO_PRECOS_TIMEOUT": "1",
            "CENARIO_PRECOS_TENTATIVAS": "3",
            "CENARIO_PRECOS_PRAZO": "30",
            **(extra or {}),
        }
        t0 = time.monotonic()
        cmd = [sys.executable, MODULO, modo_cli] + (["--limite", limite] if limite else []) + list(args)
        r = subprocess.run(cmd, env=env,
                           capture_output=True, text=True, timeout=120)
        r.duracao = time.monotonic() - t0
        return r

    def total(self, r):
        linhas = [x for x in r.stdout.splitlines() if x.startswith("TOTAL_USD=")]
        return float(linhas[-1].split("=")[1]) if linhas else None


class ConsultaOficial(Base):
    def test_sucesso_com_paginacao_grava_origem_data_e_validade(self):
        c = self.catalogo("ok")
        r = self.rodar("obter", c.url)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertAlmostEqual(self.total(r), total_esperado(), places=2)
        self.assertIn("consulta oficial agora", r.stdout)
        self.assertEqual(c.requisicoes, 4)  # para na página 4 (de 5), onde estão os últimos itens
        with open(self.cache, encoding="utf-8") as fh:
            conteudo = fh.read()
        reg = json.loads(conteudo)
        self.assertEqual(reg["fonte_url"], c.url)
        self.assertIn("Cloud Billing Catalog API", reg["fonte"])
        validade = datetime.fromisoformat(reg["valido_ate"]) - datetime.fromisoformat(reg["consultado_em"])
        self.assertEqual(validade, timedelta(hours=24))
        self.assertEqual(oct(os.stat(self.cache).st_mode & 0o777), "0o600")
        self.assertNotIn("tok-teste", conteudo)  # token nunca gravado

    def test_paginacao_e_regras_escolhem_as_skus_corretas_e_param_cedo(self):
        c = self.catalogo("ok")
        r = self.rodar("obter", c.url)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(set(c.tamanhos_pedidos), {5000})  # tamanho máximo oficial de página
        with open(self.cache, encoding="utf-8") as fh:
            itens = json.load(fh)["itens"]
        # Snapshots desativados: não são exigidos nem entram no total.
        self.assertEqual({k: v["sku_id"] for k, v in itens.items()},
                         {"core": "CORE", "ram": "RAM", "disco": "DISCO", "ip": IP_OFICIAL})
        for v in itens.values():  # nenhuma isca; cobrança e regiões registradas
            self.assertFalse(v["sku_id"].startswith("ISCA"))
            self.assertEqual(v["cobranca"], "OnDemand")
            self.assertTrue(v["regioes"] == ["global"] or "us-east1" in v["regioes"], v)
        self.assertIn("us-east1", itens["disco"]["regioes"])  # SKU multirregião, como a real
        self.assertGreater(len(itens["disco"]["regioes"]), 1)
        self.assertIn("página 4", r.stderr)
        self.assertIn("Snapshots (desativados; não incluídos)", r.stdout)

    def test_com_snapshots_exige_a_sku_regional_correta(self):
        c = self.catalogo("ok")
        r = self.rodar("obter", c.url, args=["--com-snapshots"])
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertAlmostEqual(self.total(r), total_esperado(com_snapshots=True), places=2)
        with open(self.cache, encoding="utf-8") as fh:
            itens = json.load(fh)["itens"]
        self.assertEqual(itens["snapshot"]["sku_id"], "SNAP")  # nem a multirregional, nem a de arquivo
        self.assertEqual(itens["snapshot"]["regioes"], ["us-east1"])
        # A consulta guardada COM snapshots não serve para a estimativa SEM eles (e vice-versa).
        self.assertEqual(self.rodar("cache", c.url).returncode, 2)

    def test_sem_snapshot_no_catalogo(self):
        c = self.catalogo("sem-snapshot")
        r = self.rodar("obter", c.url)  # snapshots desativados: a falta da SKU não bloqueia
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        os.remove(self.cache)
        r = self.rodar("obter", c.url, args=["--com-snapshots"])  # pedidos: bloqueia, sem presumir
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertIn("SKUs não encontradas no catálogo: snapshot", r.stderr)

    def test_disco_so_de_outras_regioes_nao_e_aceito(self):
        c = self.catalogo("sem-disco-us-east1")
        r = self.rodar("obter", c.url)
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertIn("SKUs não encontradas no catálogo: disco", r.stderr)

    def test_diagnosticar_lista_candidatas_sem_estimar(self):
        c = self.catalogo("ok")
        r = self.rodar("diagnosticar", c.url, limite=None)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("DISCO | Balanced PD Capacity | OnDemand | regiões: us-east1,us-east4", r.stdout)
        self.assertIn("regra: disco", r.stdout)
        self.assertIn("ISCA-PD-REGIONAL | Regional Balanced PD Capacity", r.stdout)
        self.assertIn("ISCA-SNAP-MULTI", r.stdout)
        self.assertIn("fim do catálogo: sim", r.stdout)
        self.assertNotIn("TOTAL_USD", r.stdout)
        self.assertFalse(os.path.exists(self.cache))

    def test_teto_de_paginas_sem_os_itens(self):
        c = self.catalogo("infinito")
        r = self.rodar("obter", c.url, extra={"CENARIO_PRECOS_PRAZO": "120"})
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        self.assertEqual(c.requisicoes, 20)  # teto: 100.000 SKUs / 5.000 por página
        self.assertIn("itens não encontrados em 100000 SKUs", r.stderr)

    def test_sku_do_ip_com_id_diferente_do_oficial_recusada(self):
        c = self.catalogo("ip-id-diferente")
        r = self.rodar("obter", c.url)
        self.assertEqual(r.returncode, 2)
        self.assertIn("difere da oficial conhecida", r.stderr)

    def test_timeout_com_tentativas_limitadas_e_sem_cache_bloqueia(self):
        c = self.catalogo("lento", atraso=3)
        r = self.rodar("obter", c.url)
        self.assertEqual(r.returncode, 2)
        self.assertEqual(c.requisicoes, 3)  # exatamente as 3 tentativas
        self.assertIn("tempo esgotado", r.stderr)
        self.assertIn("Sem estimativa válida", r.stdout)
        self.assertIsNone(self.total(r))
        self.assertLess(r.duracao, 20)

    def test_prazo_total_interrompe_as_tentativas(self):
        c = self.catalogo("lento", atraso=5)
        r = self.rodar("obter", c.url, extra={"CENARIO_PRECOS_TIMEOUT": "4", "CENARIO_PRECOS_PRAZO": "5"})
        self.assertEqual(r.returncode, 2)
        self.assertLess(r.duracao, 12)

    def test_falha_de_rede_sem_servidor(self):
        r = self.rodar("obter", "http://127.0.0.1:9/v1/services/6F81-5844-456A/skus")
        self.assertEqual(r.returncode, 2)
        self.assertIn("falha de rede", r.stderr)

    def test_erro_500_temporario_recupera_nas_tentativas(self):
        c = self.catalogo("erro500-depois-ok")
        r = self.rodar("obter", c.url)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertAlmostEqual(self.total(r), total_esperado(), places=2)

    def test_erro_500_persistente(self):
        c = self.catalogo("erro500")
        r = self.rodar("obter", c.url)
        self.assertEqual(r.returncode, 2)
        self.assertEqual(c.requisicoes, 3)

    def test_403_nao_repete(self):
        c = self.catalogo("proibido")
        r = self.rodar("obter", c.url)
        self.assertEqual(r.returncode, 2)
        self.assertEqual(c.requisicoes, 1)

    def test_json_truncado_e_resposta_incompleta(self):
        for modo, trecho in [("truncado", "resposta incompleta ou inválida"),
                             ("sem-preco", "sem preço completo"),
                             ("unidade-errada", "unidade"),
                             ("pagina-repetida", "paginação repetida")]:
            with self.subTest(modo=modo):
                if os.path.exists(self.cache):
                    os.remove(self.cache)
                c = self.catalogo(modo)
                r = self.rodar("obter", c.url)
                self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
                self.assertIn(trecho, r.stderr)
                self.assertFalse(os.path.exists(self.cache))  # nada parcial é guardado

    def test_acima_do_limite_bloqueia(self):
        c = self.catalogo("alto")
        r = self.rodar("obter", c.url)
        self.assertEqual(r.returncode, 3)
        self.assertIn("ACIMA do limite", r.stdout)
        self.assertGreater(self.total(r), 20)
        self.assertEqual(self.rodar("cache", c.url).returncode, 3)

    def test_endereco_nao_oficial_recusado_sem_modo_teste(self):
        c = self.catalogo("ok")
        r = self.rodar("obter", c.url, extra={"CENARIO_PRECOS_PERMITIR_TESTE": ""})
        self.assertEqual(r.returncode, 2)
        self.assertIn("diferente do oficial", r.stderr)

    def test_sem_token(self):
        c = self.catalogo("ok")
        r = self.rodar("obter", c.url, token="")
        self.assertEqual(r.returncode, 2)
        self.assertEqual(c.requisicoes, 0)


class Reutilizacao(Base):
    def gravar_valido(self):
        self.cat = self.catalogo("ok")
        self.assertEqual(self.rodar("obter", self.cat.url).returncode, 0)
        return self.cat.url

    def editar(self, f):
        with open(self.cache, encoding="utf-8") as fh:
            reg = json.load(fh)
        f(reg)
        with open(self.cache, "w", encoding="utf-8") as fh:
            json.dump(reg, fh)

    def test_rede_falha_reutiliza_consulta_recente_valida(self):
        # Caso real do Cloud Shell: o 'verificar' consultou; depois o catálogo passou a demorar.
        url = self.gravar_valido()
        self.cat.modo, self.cat.atraso = "lento", 3
        r = self.rodar("obter", url)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertIn("tempo esgotado", r.stderr)
        self.assertIn("consulta oficial GUARDADA", r.stdout)
        self.assertIn("Consultado em:", r.stdout)
        self.assertIn("válido até:", r.stdout)
        self.assertAlmostEqual(self.total(r), total_esperado(), places=2)

    def test_cache_de_outra_origem_nao_e_aceito(self):
        self.gravar_valido()
        outro = self.catalogo("lento", atraso=3)
        r = self.rodar("obter", outro.url)
        self.assertEqual(r.returncode, 2)
        self.assertIn("não oficial", r.stdout)

    def test_modo_cache_sem_rede(self):
        url = self.gravar_valido()
        r = self.rodar("cache", url)
        self.assertEqual(r.returncode, 0)
        self.assertIn("GUARDADA", r.stdout)

    def test_cache_vencido_recusado(self):
        url = self.gravar_valido()
        antes = datetime.now(timezone.utc) - timedelta(hours=30)
        self.editar(lambda reg: reg.update(consultado_em=antes.isoformat(),
                                           valido_ate=(antes + timedelta(hours=24)).isoformat()))
        r = self.rodar("cache", url)
        self.assertEqual(r.returncode, 2)
        self.assertIn("vencida", r.stdout)

    def test_cache_adulterado(self):
        casos = [
            ("total alterado é ignorado (recalculado)", lambda reg: reg.update(total=1.0), 0, None),
            ("preço absurdo", lambda reg: reg["itens"]["core"].update(preco_unitario=5.0), 2, "fora do esperado"),
            ("preço negativo", lambda reg: reg["itens"]["ip"].update(preco_unitario=-1), 2, "fora do esperado"),
            ("item faltando", lambda reg: reg["itens"].pop("disco"), 2, "itens incompletos"),
            ("unidade trocada", lambda reg: reg["itens"]["disco"].update(unidade="h"), 2, "unidade"),
            ("validade estendida", lambda reg: reg.update(
                valido_ate=(datetime.fromisoformat(reg["consultado_em"]) + timedelta(days=30)).isoformat()), 2,
             "validade"),
            ("data no futuro", lambda reg: reg.update(
                consultado_em=(datetime.now(timezone.utc) + timedelta(days=1)).isoformat()), 2, "futuro"),
            ("origem não oficial", lambda reg: reg.update(fonte_url="https://exemplo.com/precos"), 2, "não oficial"),
            ("SKU isca no lugar da correta", lambda reg: reg["itens"]["core"].update(
                descricao="E2 Custom Instance Core running in Americas"), 2, "não atende às regras"),
            ("disco de outra região", lambda reg: reg["itens"]["disco"].update(
                regioes=["us-central1", "us-west1"]), 2, "não atende às regras"),
            ("disco regional no lugar do zonal", lambda reg: reg["itens"]["disco"].update(
                descricao="Regional Balanced PD Capacity in South Carolina"), 2, "não atende às regras"),
            ("cobrança Spot", lambda reg: reg["itens"]["ram"].update(cobranca="Preemptible"), 2,
             "não atende às regras"),
            ("versão antiga do cache", lambda reg: reg.update(versao=1), 2, "versão"),
            ("JSON corrompido", None, 2, "inválida"),
        ]
        for nome, f, codigo, trecho in casos:
            with self.subTest(caso=nome):
                url = self.gravar_valido()
                if f is None:
                    with open(self.cache, "w", encoding="utf-8") as fh:
                        fh.write("{ corrompido")
                else:
                    self.editar(f)
                r = self.rodar("cache", url)
                self.assertEqual(r.returncode, codigo, r.stdout + r.stderr)
                if trecho:
                    self.assertIn(trecho, r.stdout)
                else:
                    self.assertAlmostEqual(self.total(r), total_esperado(), places=2)

    def test_sem_cache(self):
        r = self.rodar("cache", "http://127.0.0.1:9/v1/services/6F81-5844-456A/skus")
        self.assertEqual(r.returncode, 2)
        self.assertIn("nenhuma consulta oficial guardada", r.stdout)


if __name__ == "__main__":
    unittest.main()
