#!/usr/bin/env python3
"""Compara dois retratos de integridade histórica (antes × depois). SOMENTE LÊ os dois arquivos.

Regras (remoção real: o histórico NÃO pode encolher nem mudar de valor):
  ✘ VIOLAÇÃO  tabela que sumiu ou perdeu linhas; soma monetária diferente; órfão novo (FK);
              situação com MENOS linhas do que antes (registro reclassificado sem autorização).
  • AVISO     tabela que ganhou linhas; situação nova; medida nova (uso normal depois do retrato).
Tabelas autorizadas a mudar (ex.: rotina S9 aprovada) podem ser listadas em --permitir t1,t2.
Saída 0 = nenhuma violação; 1 = há violações.
Uso: python3 -I scripts/remocao/retrato-comparar.py antes.txt depois.txt [--permitir tabela,…]
"""
import sys
from collections import defaultdict


def ler(caminho):
    medidas = {}
    with open(caminho, encoding="utf-8") as f:
        for linha in f:
            partes = linha.rstrip("\n").split("|")
            if len(partes) < 3:
                continue
            chave, valor = tuple(partes[:-1]), partes[-1]
            medidas[chave] = int(valor) if valor.lstrip("-").isdigit() else valor
    return medidas


def main(argv):
    if len(argv) < 3:
        print(__doc__)
        return 2
    antes, depois = ler(argv[1]), ler(argv[2])
    permitir = set()
    if "--permitir" in argv:
        permitir = set(argv[argv.index("--permitir") + 1].split(","))
    violacoes, avisos = [], []
    for chave, v0 in sorted(antes.items()):
        tipo, tabela = chave[0], chave[1] if len(chave) > 1 else ""
        v1 = depois.get(chave)
        livre = tabela in permitir
        if tipo == "contagem":
            if v1 is None:
                violacoes.append(f"tabela removida: {tabela} ({v0} linhas)")
            elif v1 < v0 and not livre:
                violacoes.append(f"linhas perdidas: {tabela} {v0} → {v1}")
            elif v1 > v0:
                avisos.append(f"linhas novas: {tabela} {v0} → {v1}")
        elif tipo == "soma":
            if v1 != v0 and not livre:
                (violacoes if v1 is None or v1 < v0 or tabela in HISTORICO_FIXO else avisos).append(
                    f"soma {tabela}.{chave[2]}: {v0} → {v1}")
        elif tipo == "situacao":
            if (v1 or 0) < v0 and not livre:
                violacoes.append(f"situação {tabela}.{chave[2]}={chave[3]}: {v0} → {v1 or 0}")
        elif tipo == "orfaos":
            pass  # verificado abaixo (vale para o retrato novo inteiro)
        elif v1 != v0:
            avisos.append(f"{'|'.join(chave)}: {v0} → {v1}")
    for chave, v1 in sorted(depois.items()):
        if chave[0] == "orfaos" and v1 > antes.get(chave, 0):
            violacoes.append(f"órfãos novos: {chave[1]} ({chave[2]}): {antes.get(chave, 0)} → {v1}")
        elif chave not in antes and chave[0] != "orfaos":
            avisos.append(f"medida nova: {'|'.join(chave)} = {v1}")
    for v in violacoes:
        print("✘", v)
    for a in avisos:
        print("•", a)
    total = sum(1 for k in antes if k[0] == "contagem")
    print(f"RESULTADO: {'HISTÓRICO PRESERVADO' if not violacoes else 'VIOLAÇÕES'} "
          f"({len(violacoes)} violação(ões), {len(avisos)} aviso(s), {total} tabelas no retrato inicial)")
    return 1 if violacoes else 0


# Tabelas cujo total monetário não pode mudar nem para cima (registros fechados/imutáveis).
HISTORICO_FIXO = {
    "logistics_costs", "logistics_cost_allocations", "logistics_cost_adjustments", "purchase_order_items",
    "material_receipt_lines", "stock_movements", "weekly_closings", "closing_payment_parts",
}

if __name__ == "__main__":
    sys.exit(main(sys.argv))
