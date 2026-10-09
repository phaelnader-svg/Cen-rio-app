#!/usr/bin/env python3
"""Estimativa de custo da Etapa 1 com preços OFICIAIS de lista do catálogo do Cloud Billing.

Uso (chamado por etapa1-infra.sh; o token vem de CENARIO_TOKEN, nunca de argumentos):
  precos_catalogo.py obter --limite 20.00   # consulta oficial (com tentativas); se falhar, reutiliza
                                            # uma consulta oficial recente ainda válida
  precos_catalogo.py cache --limite 20.00   # só a consulta guardada (sem rede)

Códigos de saída: 0 = estimativa válida dentro do limite; 3 = estimativa válida ACIMA do limite;
2 = sem estimativa válida (rede, resposta incompleta, cache ausente/vencido/inválido).
Nunca usa preços fixos no código: sem consulta oficial válida, não há estimativa.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import socket
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timedelta, timezone

SERVICO = "6F81-5844-456A"  # Compute Engine no catálogo do Cloud Billing
URL_OFICIAL = f"https://cloudbilling.googleapis.com/v1/services/{SERVICO}/skus"
FONTE = "Cloud Billing Catalog API v1 (preços de lista, USD, sem tributos)"
REGIAO = "us-east1"
HORAS_MES = 730
VERSAO_CACHE = 2  # v2: identificação estrita das SKUs (invalida consultas guardadas antigas)

# Itens da Etapa 1: quantidades definidas AQUI (nunca lidas do cache) e unidade esperada da SKU.
ITENS = {
    "core": {"nome": "VM e2-small — vCPU (0,5 vCPU-equivalente)", "qtd": 0.5 * HORAS_MES, "unidade": "h"},
    "ram": {"nome": "VM e2-small — memória (2 GiB)", "qtd": 2 * HORAS_MES, "unidade": "GiBy.h"},
    "disco": {"nome": "Disco pd-balanced 20 GB", "qtd": 20, "unidade": "GiBy.mo"},
    "ip": {"nome": "IPv4 estático em uso", "qtd": HORAS_MES, "unidade": "h"},
    "snapshot": {"nome": "Snapshots (~10 GB armazenados)", "qtd": 10, "unidade": "GiBy.mo"},
}
PRECO_MAX = 1.0  # sanidade: nenhum preço unitário destes itens passa de US$ 1

# Paginação. A API v1 (services.skus.list) NÃO tem filtro por descrição, região ou SKU — só por
# serviço (no caminho), moeda e data; a v2beta também só filtra por serviço, e a busca de preço
# por ID nela exige chave de API (recurso novo, fora do autorizado). Por isso: página do tamanho
# MÁXIMO oficial (5.000), parada assim que os 5 itens são achados e um teto explícito de SKUs
# examinadas (o catálogo do Compute Engine tem dezenas de milhares de SKUs).
TAMANHO_PAGINA = 5000
MAX_SKUS_EXAMINADAS = 100_000
MAX_PAGINAS = MAX_SKUS_EXAMINADAS // TAMANHO_PAGINA  # 20

# Regras de identificação (estritas). Todas exigem cobrança "OnDemand" (exclui Spot/Preemptible e
# compromissos), moeda USD e a unidade de ITENS. Iscas conhecidas que NÃO podem ser aceitas:
# "E2 Custom Instance …", "Spot Preemptible E2 …", "Regional Balanced PD Capacity …",
# "Hyperdisk …", snapshots multirregionais/arquivo/instantâneos e IP de VM Spot.
REGRAS = {
    "core": {"prefixo": "E2 Instance Core running in Americas", "regiao": "contém"},
    "ram": {"prefixo": "E2 Instance Ram running in Americas", "regiao": "contém"},
    "disco": {"prefixo": "Balanced PD Capacity", "regiao": "somente"},
    "snapshot": {"prefixo": "Storage PD Snapshot", "regiao": "somente"},
    "ip": {"prefixo": "External IP Charge on a Standard VM", "regiao": "contém-ou-global"},
}
# SKU confirmada no anúncio oficial de preços de IPv4 externo (fev/2024). Se o catálogo trouxer
# outro ID para a mesma descrição, a consulta é recusada (mudança a revisar, nunca presumida).
SKU_CONHECIDA = {"ip": "C054-7F72-A02E"}


def agora() -> datetime:
    return datetime.now(timezone.utc)


def identificar(sku: dict) -> str | None:
    """Qual item da Etapa 1 esta SKU representa (ou None), pelas REGRAS estritas."""
    d = sku.get("description", "")
    regioes = sku.get("serviceRegions") or []
    if (sku.get("category") or {}).get("usageType") != "OnDemand":
        return None
    for chave, r in REGRAS.items():
        if not d.startswith(r["prefixo"]):
            continue
        if r["regiao"] == "somente" and regioes != [REGIAO]:
            return None  # p.ex. disco/snapshot de outra região ou multirregional
        if r["regiao"] == "contém" and REGIAO not in regioes:
            return None
        if r["regiao"] == "contém-ou-global" and REGIAO not in regioes and "global" not in regioes:
            return None
        if any(x in d for x in ("Archive", "Instant", "Multi-region", "Multiregional")):
            return None
        conhecida = SKU_CONHECIDA.get(chave)
        if conhecida and sku.get("skuId") != conhecida:
            raise ValueError(f"{chave}: SKU {sku.get('skuId')} difere da oficial conhecida {conhecida}")
        return chave
    return None


def preco_unitario(sku: dict) -> tuple[float, str]:
    """Preço do último degrau (o pago, após cotas) e a unidade; ValueError se incompleto."""
    try:
        expr = sku["pricingInfo"][0]["pricingExpression"]
        degraus = expr["tieredRates"]
        unit = degraus[-1]["unitPrice"]
        moeda = unit.get("currencyCode", "USD")
        valor = int(unit.get("units", 0) or 0) + int(unit.get("nanos", 0) or 0) / 1e9
        unidade = expr["usageUnit"]
    except (KeyError, IndexError, TypeError, ValueError) as e:
        raise ValueError(f"SKU {sku.get('skuId', '?')} sem preço completo ({e.__class__.__name__})") from e
    if moeda != "USD":
        raise ValueError(f"SKU {sku.get('skuId')} em moeda inesperada: {moeda}")
    return valor, unidade


def validar_item(chave: str, preco: float, unidade: str) -> None:
    esperado = ITENS[chave]["unidade"]
    if unidade != esperado:
        raise ValueError(f"{chave}: unidade {unidade!r}, esperada {esperado!r}")
    if not (isinstance(preco, (int, float)) and math.isfinite(preco) and 0 < preco < PRECO_MAX):
        raise ValueError(f"{chave}: preço unitário fora do esperado ({preco!r})")


def buscar_pagina(url: str, token: str, timeout: float, tentativas: int, prazo: float) -> dict:
    """Uma página com timeout definido e tentativas limitadas (espera 2 s, 4 s…)."""
    ultimo = None
    for n in range(1, tentativas + 1):
        restante = prazo - time.monotonic()
        if restante <= 0:
            raise TimeoutError("prazo total da consulta esgotado")
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
        try:
            with urllib.request.urlopen(req, timeout=min(timeout, restante)) as r:
                corpo = r.read()
            dados = json.loads(corpo)
            if not isinstance(dados, dict) or not isinstance(dados.get("skus", []), list):
                raise ValueError("resposta sem a lista 'skus'")
            return dados
        except urllib.error.HTTPError as e:
            ultimo = f"HTTP {e.code}"
            if e.code in (400, 401, 403, 404):  # não adianta repetir
                raise RuntimeError(f"consulta recusada: {ultimo}") from e
        except (TimeoutError, socket.timeout):
            ultimo = f"tempo esgotado ({timeout:.0f} s)"
        except (urllib.error.URLError, ConnectionError, OSError) as e:
            ultimo = f"falha de rede ({getattr(e, 'reason', e)})"
        except (json.JSONDecodeError, ValueError) as e:
            ultimo = f"resposta incompleta ou inválida ({e})"
        print(f"  tentativa {n}/{tentativas} falhou: {ultimo}", file=sys.stderr)
        if n < tentativas:
            time.sleep(min(2 ** n, max(0.0, prazo - time.monotonic())))
    raise RuntimeError(f"catálogo indisponível após {tentativas} tentativas: {ultimo}")


def consultar(url: str, token: str, timeout: float, tentativas: int, prazo_total: float) -> dict:
    """Percorre o catálogo em páginas pequenas e para assim que achar os 5 itens."""
    prazo = time.monotonic() + prazo_total
    achados: dict[str, dict] = {}
    pagina, vistos, n_paginas, examinadas = "", set(), 0, 0
    while True:
        n_paginas += 1
        if n_paginas > MAX_PAGINAS:
            faltam = sorted(set(ITENS) - set(achados))
            raise RuntimeError(f"itens não encontrados em {examinadas} SKUs ({MAX_PAGINAS} páginas de "
                               f"{TAMANHO_PAGINA}, teto do script): {', '.join(faltam)}")
        sep = "&" if "?" in url else "?"
        dados = buscar_pagina(f"{url}{sep}currencyCode=USD&pageSize={TAMANHO_PAGINA}&pageToken={pagina}",
                              token, timeout, tentativas, prazo)
        for sku in dados.get("skus", []):
            examinadas += 1
            chave = identificar(sku)
            if chave and chave not in achados:
                preco, unidade = preco_unitario(sku)
                validar_item(chave, preco, unidade)
                achados[chave] = {"sku_id": sku.get("skuId", "?"), "descricao": sku.get("description", ""),
                                  "regioes": sku.get("serviceRegions") or [], "cobranca": "OnDemand",
                                  "unidade": unidade, "preco_unitario": preco,
                                  "posicao": examinadas, "pagina": n_paginas}
        print(f"  página {n_paginas}: {examinadas} SKUs examinadas, {len(achados)}/{len(ITENS)} itens", file=sys.stderr)
        if len(achados) == len(ITENS):
            break
        pagina = dados.get("nextPageToken", "")
        if not pagina:
            faltam = sorted(set(ITENS) - set(achados))
            raise RuntimeError(f"resposta incompleta: SKUs não encontradas no catálogo: {', '.join(faltam)}")
        if pagina in vistos:
            raise RuntimeError("paginação repetida (resposta inválida)")
        vistos.add(pagina)
    return achados


def montar_registro(achados: dict, url: str, conta: str, validade_h: float, limite: float) -> dict:
    t = agora()
    return {
        "versao": VERSAO_CACHE,
        "fonte": FONTE,
        "fonte_url": url,
        "servico": SERVICO,
        "regiao": REGIAO,
        "moeda": "USD",
        "conta": conta,
        "consultado_em": t.isoformat(timespec="seconds"),
        "valido_ate": (t + timedelta(hours=validade_h)).isoformat(timespec="seconds"),
        "limite_usd": limite,
        "itens": {k: achados[k] for k in ITENS},
    }


def calcular(registro: dict) -> tuple[list[tuple[str, float, str]], float]:
    """Recalcula SEMPRE a partir dos preços unitários e das quantidades do código."""
    linhas = []
    for chave, item in ITENS.items():
        a = registro["itens"][chave]
        validar_item(chave, a["preco_unitario"], a["unidade"])
        # Reaplica as regras de identificação ao que foi guardado (descrição, região, SKU conhecida).
        sku = {"skuId": a.get("sku_id"), "description": a.get("descricao", ""),
               "serviceRegions": a.get("regioes"), "category": {"usageType": a.get("cobranca")}}
        if identificar(sku) != chave:
            raise ValueError(f"{chave}: SKU guardada não atende às regras ({a.get('descricao')!r}, {a.get('regioes')})")
        linhas.append((item["nome"], a["preco_unitario"] * item["qtd"],
                       f"{a['descricao']} · {a['sku_id']} · {a['preco_unitario']:.6f}/{a['unidade']}"))
    return linhas, round(sum(v for _, v, _ in linhas), 2)


def ler_cache(caminho: str, url_aceita: str, validade_max_h: float) -> dict:
    """Consulta guardada, só se íntegra, da fonte oficial e dentro da validade."""
    if not os.path.exists(caminho):
        raise RuntimeError("nenhuma consulta oficial guardada")
    try:
        with open(caminho, encoding="utf-8") as f:
            r = json.load(f)
        consultado = datetime.fromisoformat(r["consultado_em"])
        valido = datetime.fromisoformat(r["valido_ate"])
        if r.get("versao") != VERSAO_CACHE or r.get("servico") != SERVICO or r.get("regiao") != REGIAO:
            raise ValueError("versão, serviço ou região diferentes")
        if r.get("fonte_url") != url_aceita:
            raise ValueError(f"origem não oficial: {r.get('fonte_url')}")
        if set(r.get("itens", {})) != set(ITENS):
            raise ValueError("itens incompletos")
    except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError) as e:
        raise RuntimeError(f"consulta guardada inválida: {e}") from e
    t = agora()
    if consultado > t + timedelta(minutes=5):
        raise RuntimeError("consulta guardada com data no futuro")
    if valido - consultado > timedelta(hours=validade_max_h) + timedelta(seconds=1):
        raise RuntimeError("validade da consulta guardada maior que a permitida")
    if t > valido:
        raise RuntimeError(f"consulta guardada vencida em {valido.isoformat(timespec='minutes')}")
    return r


def gravar_cache(caminho: str, registro: dict) -> None:
    os.makedirs(os.path.dirname(caminho), mode=0o700, exist_ok=True)
    tmp = f"{caminho}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(registro, f, ensure_ascii=False, indent=2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, caminho)


def relatar(registro: dict, origem: str, limite: float) -> int:
    linhas, total = calcular(registro)
    print(f"  Origem: {origem}")
    print(f"  Fonte: {registro['fonte']}")
    print(f"  Consultado em: {registro['consultado_em']} · válido até: {registro['valido_ate']}")
    for nome, v, desc in linhas:
        print(f"  {nome:45s} US$ {v:6.2f}   [{desc}]")
    print(f"  {'Bucket, segredos, IAP, logs (cotas gratuitas)':45s} US$   0.00")
    print(f"  {'TOTAL Etapa 1 (sem tributos)':45s} US$ {total:6.2f}  (limite autorizado: US$ {limite:.2f})")
    print(f"TOTAL_USD={total:.2f}")
    if total > limite:
        print(f"✘ Estimativa ACIMA do limite autorizado (US$ {limite:.2f}): criação bloqueada.")
        return 3
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("modo", choices=["obter", "cache"])
    ap.add_argument("--limite", type=float, required=True)
    a = ap.parse_args()
    if not (a.limite > 0):
        print("limite inválido", file=sys.stderr)
        return 2
    url = os.environ.get("CENARIO_CATALOGO_URL", URL_OFICIAL)
    teste = os.environ.get("CENARIO_PRECOS_PERMITIR_TESTE") == "1"
    if url != URL_OFICIAL and not teste:
        print("✘ endereço do catálogo diferente do oficial: recusado", file=sys.stderr)
        return 2
    timeout = float(os.environ.get("CENARIO_PRECOS_TIMEOUT", "60"))  # páginas de 5.000 SKUs
    tentativas = max(1, min(int(os.environ.get("CENARIO_PRECOS_TENTATIVAS", "3")), 5))
    prazo_total = float(os.environ.get("CENARIO_PRECOS_PRAZO", "300"))
    validade_h = min(float(os.environ.get("CENARIO_PRECOS_VALIDADE_H", "24")), 72.0)
    caminho = os.environ.get("CENARIO_PRECOS_CACHE") or os.path.expanduser(
        "~/.cache/cenario-homolog/precos-etapa1.json")

    if a.modo == "obter":
        token = os.environ.get("CENARIO_TOKEN", "")
        try:
            if not token:
                raise RuntimeError("sem token de acesso (gcloud auth)")
            achados = consultar(url, token, timeout, tentativas, prazo_total)
            registro = montar_registro(achados, url, os.environ.get("CENARIO_CONTA", ""), validade_h, a.limite)
            calcular(registro)  # valida antes de guardar
            gravar_cache(caminho, registro)
            return relatar(registro, f"consulta oficial agora (guardada em {caminho})", a.limite)
        except (RuntimeError, ValueError, TimeoutError) as e:
            print(f"⚠ consulta oficial falhou: {e}", file=sys.stderr)
            print("  tentando a consulta oficial guardada (se recente e válida)…", file=sys.stderr)
    try:
        registro = ler_cache(caminho, url, validade_h)
        return relatar(registro, f"consulta oficial GUARDADA ({caminho}), conta {registro.get('conta') or '?'}",
                       a.limite)
    except (RuntimeError, ValueError, KeyError, TypeError) as e:
        print(f"✘ Sem estimativa válida: {e}. Criação bloqueada (nenhum preço é presumido).")
        return 2


if __name__ == "__main__":
    sys.exit(main())
