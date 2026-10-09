"""Servidor local que imita o catálogo do Cloud Billing, para os testes (nunca usado em produção).

Comportamento escolhido por MODO: ok, alto, lento, erro500, erro500-depois-ok, truncado, sem-snapshot,
sem-preco, unidade-errada, pagina-repetida, proibido. Conta as requisições recebidas.
"""
from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse


def sku(sku_id, desc, regioes, unidade, units, nanos):
    return {
        "skuId": sku_id,
        "description": desc,
        "category": {"usageType": "OnDemand"},
        "serviceRegions": regioes,
        "pricingInfo": [{"pricingExpression": {"usageUnit": unidade, "tieredRates": [
            {"startUsageAmount": 0, "unitPrice": {"currencyCode": "USD", "units": str(units), "nanos": nanos}}]}}],
    }


# Preços de teste (fictícios, só para os testes): totalizam um valor conhecido.
PRECOS_TESTE = {  # FICTÍCIOS: só para os testes, nunca usados pelo script real
    "core": 0.021811, "ram": 0.002923, "disco": 0.1, "ip": 0.005, "snapshot": 0.05,
}


def skus(alto=False):
    f = 1.5 if alto else 1
    p = {k: v * f for k, v in PRECOS_TESTE.items()}
    n = lambda v: int(round((v % 1) * 1e9))  # noqa: E731
    return [
        sku("RUIDO-1", "N1 Predefined Instance Core running in Americas", ["us-east1"], "h", 0, 31611000),
        sku("CORE", "E2 Instance Core running in Americas", ["us-east1", "us-central1"], "h", 0, n(p["core"])),
        sku("RAM", "E2 Instance Ram running in Americas", ["us-east1", "us-central1"], "GiBy.h", 0, n(p["ram"])),
        sku("DISCO", "Balanced PD Capacity in South Carolina", ["us-east1"], "GiBy.mo", 0, n(p["disco"])),
        sku("IP", "External IP Charge on a Standard VM", ["global"], "h", 0, n(p["ip"])),
        sku("SNAP", "Storage PD Snapshot in South Carolina", ["us-east1"], "GiBy.mo", 0, n(p["snapshot"])),
    ]


class Catalogo:
    def __init__(self, modo: str, atraso: float = 3.0, arquivo_modo: str | None = None):
        self._modo = modo
        self.arquivo_modo = arquivo_modo
        self.atraso = atraso
        self.requisicoes = 0
        cat = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):  # silencioso
                pass

            def do_GET(self):
                cat.requisicoes += 1
                q = parse_qs(urlparse(self.path).query)
                pagina = (q.get("pageToken") or [""])[0]
                m = cat.modo
                if m == "lento":
                    time.sleep(cat.atraso)
                if m == "proibido":
                    return self._enviar(403, b'{"error":"forbidden"}')
                if m == "erro500" or (m == "erro500-depois-ok" and cat.requisicoes <= 2):
                    return self._enviar(500, b'{"error":"interno"}')
                todos = skus(alto=(m == "alto"))
                if m == "sem-snapshot":
                    todos = [s for s in todos if s["skuId"] != "SNAP"]
                if m == "sem-preco":
                    del todos[1]["pricingInfo"]
                if m == "unidade-errada":
                    todos[3]["pricingInfo"][0]["pricingExpression"]["usageUnit"] = "GiBy.h"
                # Duas páginas: a primeira sem o snapshot, com nextPageToken.
                if pagina == "":
                    corpo = {"skus": todos[:-1], "nextPageToken": "p2"}
                elif m == "pagina-repetida":
                    corpo = {"skus": [], "nextPageToken": "p2"}
                else:
                    corpo = {"skus": todos[-1:] if m != "sem-snapshot" else [], "nextPageToken": ""}
                dados = json.dumps(corpo).encode()
                if m == "truncado":
                    dados = dados[: len(dados) // 2]
                self._enviar(200, dados)

            def _enviar(self, codigo, dados):
                try:
                    self.send_response(codigo)
                    self.send_header("content-type", "application/json")
                    self.end_headers()
                    self.wfile.write(dados)
                except (BrokenPipeError, ConnectionResetError):
                    pass

        self.srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = f"http://127.0.0.1:{self.srv.server_address[1]}/v1/services/6F81-5844-456A/skus"
        threading.Thread(target=self.srv.serve_forever, daemon=True).start()

    @property
    def modo(self) -> str:
        if self.arquivo_modo:
            try:
                with open(self.arquivo_modo, encoding="utf-8") as f:
                    return f.read().strip() or self._modo
            except OSError:
                pass
        return self._modo

    @modo.setter
    def modo(self, valor: str) -> None:
        self._modo = valor

    def parar(self):
        self.srv.shutdown()
        self.srv.server_close()


def total_esperado(alto=False):
    f = 1.5 if alto else 1
    p = {k: v * f for k, v in PRECOS_TESTE.items()}
    return round(p["core"] * 0.5 * 730 + p["ram"] * 2 * 730 + p["disco"] * 20 + p["ip"] * 730
                 + p["snapshot"] * 10, 2)


if __name__ == "__main__":  # uso pelo teste de integração em shell
    import sys
    # catalogo_falso.py <modo> [atraso] [arquivo-de-modo]: o arquivo, se existir, troca o modo em tempo real.
    c = Catalogo(sys.argv[1], float(sys.argv[2]) if len(sys.argv) > 2 else 3.0,
                 sys.argv[3] if len(sys.argv) > 3 else None)
    print(c.url, flush=True)
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        pass
