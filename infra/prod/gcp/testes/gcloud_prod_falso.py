#!/usr/bin/env python3
"""gcloud FALSO para os testes do provisionar.sh: estado em $FALSO_ESTADO (JSON), cada chamada registrada
em $GCLOUD_LOG (argumentos, nunca a entrada padrão). Os valores de segredos recebidos pela entrada padrão
ficam em $FALSO_SEGREDOS (só para o teste conferir que nunca vazaram em argumento ou log).
Variações: FALSO_LIGACAO_CRUZADA=1 (o operador da homologação tem acesso a um segredo de produção)."""
import json
import os
import sys

IP = "34.95.10.20"


def carregar():
    c = os.environ["FALSO_ESTADO"]
    if os.path.exists(c):
        with open(c, encoding="utf-8") as f:
            return json.load(f)
    e = {"existe": ["vm:cenario-homolog", "repo:cenario-homolog", "sa:claude-operador@cenariogestao.iam.gserviceaccount.com",
                    "sa:cenario-homolog-vm@cenariogestao.iam.gserviceaccount.com", "topico:cenario-homolog-comandos"]
                   + [f"segredo:{s}" for s in ("homolog-postgres-password", "homolog-token-hash-secret", "homolog-admin-password",
                                               "homolog-proxy-password", "homolog-gate-token")]
                   + [f"bucket:{b}" for b in ("cenariogestao-homolog-backups", "cenariogestao-homolog-operacoes",
                                              "cenariogestao-homolog-runner-versoes", "cenariogestao-homolog-build")],
         "ligacoes": {}, "politicas_disco": [], "chaves": 0}
    if os.environ.get("FALSO_LIGACAO_CRUZADA") == "1":
        e["ligacoes"]["segredo:prod-admin-password"] = [["roles/secretmanager.secretAccessor",
                                                          "serviceAccount:claude-operador@cenariogestao.iam.gserviceaccount.com"]]
    return e


def salvar(e):
    with open(os.environ["FALSO_ESTADO"], "w", encoding="utf-8") as f:
        json.dump(e, f)


def politica(e, chave):
    lig = e["ligacoes"].get(chave, [])
    papeis = {}
    for r, m in lig:
        papeis.setdefault(r, []).append(m)
    return json.dumps({"bindings": [{"role": r, "members": ms} for r, ms in papeis.items()]})


def main():
    a = [x for x in sys.argv[1:] if not x.startswith("--project")]
    with open(os.environ["GCLOUD_LOG"], "a", encoding="utf-8") as f:
        f.write(" ".join(a) + "\n")
    e = carregar()
    flags = {x.split("=", 1)[0]: (x.split("=", 1)[1] if "=" in x else "") for x in a if x.startswith("--")}
    pos = [x for x in a if not x.startswith("--")]
    j = " ".join(pos)

    def ex(chave):
        return chave in e["existe"]

    def cria(chave):
        if chave in e["existe"]:
            print(f"ALREADY_EXISTS {chave}", file=sys.stderr)
            sys.exit(1)
        e["existe"].append(chave)
        salvar(e)

    if j.startswith("config get-value account"):
        print(os.environ.get("FALSO_CONTA", "dono@exemplo.com")); return
    if j.startswith("projects describe"):
        print(json.dumps({"lifecycleState": "ACTIVE", "projectNumber": "8642957474"})); return
    if j.startswith("services enable"):
        return
    tipos = {"compute networks subnets": "subrede", "compute networks": "rede", "compute firewall-rules": "firewall",
             "compute addresses": "ip", "iam service-accounts": "sa", "secrets": "segredo", "artifacts repositories": "repo",
             "compute instances": "vm", "compute resource-policies": "snap", "iam roles": "papel", "pubsub topics": "topico",
             "pubsub subscriptions": "assinatura", "storage buckets": "bucket"}
    for pref, tipo in tipos.items():
        if not j.startswith(pref + " "):
            continue
        resto = pos[len(pref.split()):]
        verbo = resto[0]
        if tipo == "snap" and verbo == "create":
            resto = resto[1:]
        if tipo == "sa" and verbo == "create":
            nome = resto[1] + "@cenariogestao.iam.gserviceaccount.com"
        elif tipo == "papel" and verbo == "create":
            nome = "projects/cenariogestao/roles/" + resto[1]
        else:
            nome = resto[1] if len(resto) > 1 else ""
        nome = nome.replace("gs://", "")
        chave = f"{tipo}:{nome}"
        if verbo == "describe":
            if not ex(chave):
                sys.exit(1)
            if tipo == "ip":
                print(IP)
            elif tipo == "vm":
                fmt = flags.get("--format", "")
                if "disks[0]" in fmt:
                    print("cenario-prod")
                elif "status" in fmt:
                    print("RUNNING")
                else:
                    print(json.dumps({"metadata": {"items": [{"key": "enable-oslogin", "value": "TRUE"}]},
                                      "serviceAccounts": [{"email": "cenario-prod-vm@cenariogestao.iam.gserviceaccount.com"}]}))
            elif tipo == "bucket":
                print("enforced")
            return
        if verbo == "create":
            cria(chave); return
        if verbo == "add-iam-policy-binding":
            e["ligacoes"].setdefault(chave, []).append([flags["--role"], flags["--member"]]); salvar(e); return
        if verbo == "remove-iam-policy-binding":
            e["ligacoes"][chave] = [x for x in e["ligacoes"].get(chave, []) if x != [flags["--role"], flags["--member"]]]; salvar(e); return
        if verbo == "get-iam-policy":
            if not ex(chave) and tipo != "papel":
                sys.exit(1)
            print(politica(e, chave)); return
        if verbo in ("update", "add-resource-policies"):
            return
        if verbo == "versions" and resto[1] == "add":
            dado = sys.stdin.read()
            with open(os.environ["FALSO_SEGREDOS"], "a", encoding="utf-8") as f:
                f.write(dado + "\n")
            return
        if verbo == "keys":
            e["chaves"] += 1; salvar(e); return
    if j.startswith("projects add-iam-policy-binding"):
        e["ligacoes"].setdefault("projeto", []).append([flags["--role"], flags["--member"]]); salvar(e); return
    if j.startswith("projects get-iam-policy"):
        print(politica(e, "projeto")); return
    if j.startswith("compute disks describe"):
        print(";".join(e["politicas_disco"])); return
    if j.startswith("compute disks add-resource-policies"):
        e["politicas_disco"].append(flags["--resource-policies"]); salvar(e); return
    if j.startswith("compute firewall-rules list"):
        for r in ("cenario-prod-web", "cenario-prod-iap-ssh"):
            if f"firewall:{r}" in e["existe"]:
                print(f"{r}\t0.0.0.0/0")
        return
    if j.startswith("artifacts docker images describe"):
        print(os.environ.get("FALSO_DIGEST", "")); return
    print(f"gcloud falso: chamada não prevista: {j}", file=sys.stderr)
    sys.exit(9)


if __name__ == "__main__":
    main()
