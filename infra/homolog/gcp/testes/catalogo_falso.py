"""Servidor local que imita o catálogo do Cloud Billing (v1 services.skus.list), só para testes.

Imita o comportamento real relevante: paginação por pageSize/pageToken, milhares de SKUs de
"enchimento" antes dos itens procurados e SKUs-isca parecidas (Custom, Spot, regional,
Hyperdisk, multirregional, outra região) aparecendo ANTES das corretas.

MODO: ok, alto, lento, erro500, erro500-depois-ok, truncado, sem-snapshot, sem-preco,
unidade-errada, pagina-repetida, proibido, infinito, ip-id-diferente. Conta as requisições.
"""
from __future__ import annotations

import json
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse


def sku(sku_id, desc, regioes, unidade, preco, uso="OnDemand"):
    return {
        "skuId": sku_id,
        "description": desc,
        "category": {"usageType": uso, "resourceFamily": "Compute"},
        "serviceRegions": regioes,
        "pricingInfo": [{"pricingExpression": {"usageUnit": unidade, "tieredRates": [
            {"startUsageAmount": 0, "unitPrice": {"currencyCode": "USD", "units": str(int(preco)),
                                                  "nanos": int(round((preco % 1) * 1e9))}}]}}],
    }


# Preços FICTÍCIOS, só para os testes (nunca usados pelo script real).
PRECOS_TESTE = {"core": 0.021811, "ram": 0.002923, "disco": 0.1, "ip": 0.005, "snapshot": 0.05}
IP_OFICIAL = "C054-7F72-A02E"


def iscas():
    """Parecidas com as corretas, mas que NÃO podem ser escolhidas."""
    return [
        sku("ISCA-CUSTOM", "E2 Custom Instance Core running in Americas", ["us-east1"], "h", 0.0229),
        sku("ISCA-SPOT", "Spot Preemptible E2 Instance Core running in Americas", ["us-east1"], "h", 0.007,
            uso="Preemptible"),
        sku("ISCA-COMMIT", "Commitment v1: E2 Cpu in Americas for 1 Year", ["us-east1"], "h", 0.0137,
            uso="Commit1Yr"),
        sku("ISCA-RAM-CUSTOM", "E2 Custom Instance Ram running in Americas", ["us-east1"], "GiBy.h", 0.0031),
        sku("ISCA-PD-REGIONAL", "Regional Balanced PD Capacity in South Carolina", ["us-east1"], "GiBy.mo", 0.2),
        sku("ISCA-PD-OUTRA", "Balanced PD Capacity in Iowa", ["us-central1"], "GiBy.mo", 0.1),
        sku("ISCA-HYPERDISK", "Hyperdisk Balanced Capacity in South Carolina", ["us-east1"], "GiBy.mo", 0.08),
        sku("ISCA-SNAP-MULTI", "Storage PD Snapshot in US", ["us-east1", "us-central1", "us-west1"], "GiBy.mo",
            0.065),
        sku("ISCA-SNAP-ARQ", "Storage PD Snapshot Archive in South Carolina", ["us-east1"], "GiBy.mo", 0.019),
        sku("ISCA-IP-SPOT", "External IP Charge on a Spot Preemptible VM", ["global"], "h", 0.0025),
    ]


def corretas(fator=1.0, ip_id=IP_OFICIAL):
    p = {k: v * fator for k, v in PRECOS_TESTE.items()}
    return [
        sku("CORE", "E2 Instance Core running in Americas", ["us-east1", "us-central1", "southamerica-east1"],
            "h", p["core"]),
        sku("RAM", "E2 Instance Ram running in Americas", ["us-east1", "us-central1"], "GiBy.h", p["ram"]),
        sku("DISCO", "Balanced PD Capacity in South Carolina", ["us-east1"], "GiBy.mo", p["disco"]),
        sku(ip_id, "External IP Charge on a Standard VM", ["global"], "h", p["ip"]),
        sku("SNAP", "Storage PD Snapshot in South Carolina", ["us-east1"], "GiBy.mo", p["snapshot"]),
    ]


def enchimento(n, inicio=0):
    return [sku(f"ENCH-{i:06d}", f"N2 Predefined Instance Core running in Region {i}", [f"r{i % 40}"], "h", 0.03)
            for i in range(inicio, inicio + n)]


class Catalogo:
    def __init__(self, modo: str, atraso: float = 3.0, arquivo_modo: str | None = None,
                 enchimento_antes: int = 12000):
        self._modo = modo
        self.arquivo_modo = arquivo_modo
        self.atraso = atraso
        self.enchimento_antes = enchimento_antes
        self.requisicoes = 0
        self.paginas_servidas: list[int] = []
        self.tamanhos_pedidos: list[int] = []
        cat = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):  # silencioso
                pass

            def do_GET(self):
                cat.requisicoes += 1
                q = parse_qs(urlparse(self.path).query)
                inicio = int((q.get("pageToken") or ["0"])[0] or 0)
                tamanho = min(int((q.get("pageSize") or ["50"])[0]), 5000)
                cat.tamanhos_pedidos.append(int((q.get("pageSize") or ["0"])[0]))
                m = cat.modo
                if m == "lento":
                    time.sleep(cat.atraso)
                if m == "proibido":
                    return self._enviar(403, b'{"error":"forbidden"}')
                if m == "erro500" or (m == "erro500-depois-ok" and cat.requisicoes <= 2):
                    return self._enviar(500, b'{"error":"interno"}')
                if m == "infinito":  # catálogo sem fim e sem os itens: deve parar no teto do script
                    corpo = {"skus": enchimento(tamanho, inicio), "nextPageToken": str(inicio + tamanho)}
                    return self._enviar(200, json.dumps(corpo).encode())
                todos = cat.catalogo()
                pagina = todos[inicio:inicio + tamanho]
                prox = str(inicio + tamanho) if inicio + tamanho < len(todos) else ""
                if m == "pagina-repetida":
                    prox = "0"
                cat.paginas_servidas.append(inicio // max(tamanho, 1) + 1)
                dados = json.dumps({"skus": pagina, "nextPageToken": prox}).encode()
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

    def catalogo(self) -> list:
        """Enchimento → iscas → corretas (espalhadas) → mais enchimento."""
        m = self.modo
        certas = corretas(fator=1.5 if m == "alto" else 1.0,
                          ip_id="0000-AAAA-BBBB" if m == "ip-id-diferente" else IP_OFICIAL)
        if m == "sem-snapshot":
            certas = [s for s in certas if s["skuId"] != "SNAP"]
        if m == "sem-preco":
            del certas[0]["pricingInfo"]
        if m == "unidade-errada":
            certas[2]["pricingInfo"][0]["pricingExpression"]["usageUnit"] = "GiBy.h"
        n = self.enchimento_antes
        # Itens corretos espalhados: core/ram no meio, disco/ip/snapshot mais adiante.
        return (enchimento(n) + iscas() + certas[:2] + enchimento(n // 2, n) + certas[2:]
                + enchimento(3000, n + n // 2))

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
