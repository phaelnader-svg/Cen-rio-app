#!/usr/bin/env python3
"""gcloud FALSO para os testes do bootstrap.sh/revogar.sh: guarda o estado num JSON e registra
toda chamada em $GCLOUD_LOG. Variações: FALSO_CONTA, FALSO_ESCOPOS, FALSO_VM_SA, FALSO_OUTRO_COM_OP=1."""
import json
import os
import sys

P = "cenariogestao"


def carregar():
    c = os.environ["FALSO_ESTADO"]
    if os.path.exists(c):
        with open(c, encoding="utf-8") as f:
            return json.load(f)
    return {"apis": ["compute.googleapis.com", "artifactregistry.googleapis.com"], "sas": ["cenario-homolog-vm@cenariogestao.iam.gserviceaccount.com"],
            "papeis": {}, "topicos": [], "assinaturas": [], "buckets": ["cenariogestao-homolog-backups"], "ligacoes": [], "chaves": {},
            "objetos": {}, "desativadas": []}


def salvar(e):
    with open(os.environ["FALSO_ESTADO"], "w", encoding="utf-8") as f:
        json.dump(e, f)


def main():
    a = sys.argv[1:]
    with open(os.environ["GCLOUD_LOG"], "a", encoding="utf-8") as f:
        f.write(" ".join(a) + "\n")
    e = carregar()
    pos = [x for x in a if not x.startswith("--")]
    opt = {}
    for x in a:
        if x.startswith("--") and "=" in x:
            k, v = x[2:].split("=", 1)
            opt[k] = v
    cmd = " ".join(pos)
    out = None
    rc = 0

    def lig(recurso):  # idempotente, como no gcloud real
        nova = {"recurso": recurso, "membro": opt["member"], "papel": opt["role"]}
        if nova not in e["ligacoes"]:
            e["ligacoes"].append(nova)
        salvar(e)

    def deslig(recurso):
        antes = len(e["ligacoes"])
        e["ligacoes"] = [l for l in e["ligacoes"] if not (l["recurso"] == recurso and l["membro"] == opt["member"] and l["papel"] == opt["role"])]
        salvar(e)
        return 0 if len(e["ligacoes"]) < antes else 1

    if cmd == "config get-value account":
        print(os.environ.get("FALSO_CONTA", "dono@gmail.com"))
    elif cmd.startswith("auth print-access-token"):
        print("token-do-dono")
    elif cmd == f"projects describe {P}":
        out = {"projectId": P, "projectNumber": "123456", "lifecycleState": "ACTIVE"}
    elif cmd == "projects list":
        print(f"{P}\nverificapro-8d3c8")
    elif cmd.startswith("projects get-iam-policy"):
        alvo = pos[-1]
        membros = [l for l in e["ligacoes"] if l["recurso"] == f"projeto:{alvo}"]
        if alvo == "verificapro-8d3c8" and os.environ.get("FALSO_OUTRO_COM_OP") == "1":
            membros.append({"membro": "serviceAccount:claude-operador@cenariogestao.iam.gserviceaccount.com", "papel": "roles/viewer"})
        out = {"bindings": [{"role": l["papel"], "members": [l["membro"]]} for l in membros]}
    elif cmd.startswith("projects add-iam-policy-binding"):
        lig(f"projeto:{pos[-1]}")
    elif cmd.startswith("projects remove-iam-policy-binding"):
        rc = deslig(f"projeto:{pos[-1]}")
    elif cmd.startswith("compute instances describe"):
        out = {"name": "cenario-homolog", "status": "RUNNING", "serviceAccounts": [{
            "email": os.environ.get("FALSO_VM_SA", "cenario-homolog-vm@cenariogestao.iam.gserviceaccount.com"),
            "scopes": os.environ.get("FALSO_ESCOPOS", "https://www.googleapis.com/auth/cloud-platform").split(",")}]}
    elif cmd.startswith("compute instances add-iam-policy-binding"):
        lig(f"vm:{pos[-1]}")
    elif cmd.startswith("compute instances remove-iam-policy-binding"):
        rc = deslig(f"vm:{pos[-1]}")
    elif cmd.startswith("compute scp") or cmd.startswith("compute ssh"):
        entrada = sys.stdin.read() if not sys.stdin.isatty() else ""
        with open(os.environ["GCLOUD_LOG"] + ".ssh", "a", encoding="utf-8") as f:
            f.write(f"### {opt.get('command', cmd)}\n{entrada}\n")
    elif cmd.startswith("services list"):
        print("\n".join(e["apis"]))
    elif cmd.startswith("services enable"):
        e["apis"] += pos[2:]
        salvar(e)
    elif cmd.startswith("iam service-accounts describe"):
        rc = 0 if pos[-1] in e["sas"] else 1
        if rc == 0:
            print(f"{pos[-1]}\t{pos[-1] in e['desativadas']}")
    elif cmd.startswith("iam service-accounts create"):
        e["sas"].append(f"{pos[-1]}@{P}.iam.gserviceaccount.com")
        salvar(e)
    elif cmd.startswith("iam service-accounts delete"):
        rc = 0 if pos[-1] in e["sas"] else 1
        e["sas"] = [s for s in e["sas"] if s != pos[-1]]
        e["ligacoes"] = [l for l in e["ligacoes"] if l["recurso"] != f"sa:{pos[-1]}"]  # a política some com a conta
        salvar(e)
    elif cmd.startswith("iam service-accounts disable"):
        e["desativadas"].append(pos[-1]); salvar(e)
    elif cmd.startswith("iam service-accounts enable"):
        e["desativadas"] = [s for s in e["desativadas"] if s != pos[-1]]; salvar(e)
    elif cmd.startswith("iam service-accounts add-iam-policy-binding"):
        lig(f"sa:{pos[-1]}")
    elif cmd.startswith("iam service-accounts remove-iam-policy-binding"):
        rc = deslig(f"sa:{pos[-1]}")
    elif cmd.startswith("iam service-accounts get-iam-policy"):
        out = {"bindings": [{"role": l["papel"], "members": [l["membro"]]} for l in e["ligacoes"] if l["recurso"] == f"sa:{pos[-1]}"]}
    elif cmd.startswith("iam service-accounts keys list"):
        print("\n".join(e["chaves"].get(opt["iam-account"], [])))
    elif cmd.startswith("iam service-accounts keys create"):
        sa = opt["iam-account"]
        kid = f"chave{len(e['chaves'].get(sa, [])) + 1}"
        e["chaves"].setdefault(sa, []).append(kid)
        salvar(e)
        with open(pos[-1], "w", encoding="utf-8") as f:
            json.dump({"type": "service_account", "private_key_id": kid, "private_key": "-----BEGIN PRIVATE KEY-----\nSEGREDO-FALSO\n-----END PRIVATE KEY-----\n"}, f)
    elif cmd.startswith("iam service-accounts keys delete"):
        e["chaves"][opt["iam-account"]].remove(pos[-1]); salvar(e)
    elif cmd.startswith("iam roles describe"):
        r = e["papeis"].get(pos[-1])
        if r is None:
            rc = 1
        elif opt.get("format", "").startswith("value(includedPermissions)"):
            print(";".join(r))
    elif cmd.startswith("iam roles create") or cmd.startswith("iam roles update"):
        e["papeis"][pos[-1]] = opt["permissions"].split(","); salvar(e)
    elif cmd.startswith("iam roles delete"):
        rc = 0 if e["papeis"].pop(pos[-1], None) is not None else 1; salvar(e)
    elif cmd.startswith("pubsub topics describe"):
        rc = 0 if pos[-1] in e["topicos"] else 1
    elif cmd.startswith("pubsub topics create"):
        e["topicos"].append(pos[-1]); salvar(e)
    elif cmd.startswith("pubsub topics delete"):
        rc = 0 if pos[-1] in e["topicos"] else 1
        e["topicos"] = [t for t in e["topicos"] if t != pos[-1]]
        e["ligacoes"] = [l for l in e["ligacoes"] if l["recurso"] != f"topico:{pos[-1]}"]; salvar(e)
    elif cmd.startswith("pubsub subscriptions describe"):
        rc = 0 if pos[-1] in e["assinaturas"] else 1
    elif cmd.startswith("pubsub subscriptions create"):
        e["assinaturas"].append(pos[-1]); salvar(e)
    elif cmd.startswith("pubsub subscriptions delete"):
        rc = 0 if pos[-1] in e["assinaturas"] else 1
        e["assinaturas"] = [t for t in e["assinaturas"] if t != pos[-1]]
        e["ligacoes"] = [l for l in e["ligacoes"] if l["recurso"] != f"assinatura:{pos[-1]}"]; salvar(e)
    elif cmd.startswith("pubsub topics add-iam-policy-binding"):
        lig(f"topico:{pos[-1]}")
    elif cmd.startswith("pubsub subscriptions add-iam-policy-binding"):
        lig(f"assinatura:{pos[-1]}")
    elif cmd.startswith("pubsub subscriptions remove-iam-policy-binding"):
        rc = deslig(f"assinatura:{pos[-1]}")
    elif cmd.startswith("pubsub") and "get-iam-policy" in cmd:
        tipo = "topico" if "topics" in cmd else "assinatura"
        out = {"bindings": [{"role": l["papel"], "members": [l["membro"]]} for l in e["ligacoes"] if l["recurso"] == f"{tipo}:{pos[-1]}"]}
    elif cmd.startswith("storage buckets describe"):
        rc = 0 if pos[-1].removeprefix("gs://") in e["buckets"] else 1
    elif cmd.startswith("storage buckets create"):
        e["buckets"].append(pos[-1].removeprefix("gs://")); salvar(e)
    elif cmd.startswith("storage buckets update"):
        pass
    elif cmd.startswith("storage buckets add-iam-policy-binding"):
        lig(f"bucket:{pos[-1].removeprefix('gs://')}")
    elif cmd.startswith("storage buckets remove-iam-policy-binding"):
        rc = deslig(f"bucket:{pos[-1].removeprefix('gs://')}")
    elif cmd.startswith("storage cat"):
        v = e["objetos"].get(pos[-1])
        if v is None:
            rc = 1
        else:
            print(v)
    elif cmd.startswith("storage cp"):
        destino = pos[-1]
        for origem in pos[2:-1]:
            nome = destino + os.path.basename(origem)
            if "--if-generation-match=0" in a and nome in e["objetos"]:
                print(f"precondição falhou: {nome}", file=sys.stderr)
                return 1
            with open(origem, "rb") as f:
                dados = f.read()
            e["objetos"][nome] = dados.decode().strip() if origem.endswith(".sha256") else f"<{len(dados)} bytes>"
        salvar(e)
    elif cmd.startswith("artifacts repositories describe"):
        rc = 0
    elif cmd.startswith("artifacts repositories add-iam-policy-binding"):
        lig(f"repo:{pos[-1]}")
    elif cmd.startswith("artifacts repositories remove-iam-policy-binding"):
        rc = deslig(f"repo:{pos[-1]}")
    if out is not None:
        print(json.dumps(out))
    return rc


if __name__ == "__main__":
    sys.exit(main())
