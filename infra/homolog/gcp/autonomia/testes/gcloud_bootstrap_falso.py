#!/usr/bin/env python3
"""gcloud FALSO para os testes do bootstrap.sh/revogar.sh: guarda o estado num JSON e registra
toda chamada em $GCLOUD_LOG. Variações: FALSO_CONTA, FALSO_ESCOPOS, FALSO_VM_SA, FALSO_OUTRO_COM_OP=1,
FALSO_BUILD_PADRAO (conta padrão do Cloud Build; padrão: a do Compute), FALSO_BUILD_PADRAO_ERRO=1,
FALSO_LEGADA=1 (conta legada com cloudbuild.builds.builder), FALSO_ACTAS_EXTRA=1 (operador com actAs na
conta do Compute), FALSO_PAPEL_PERIGOSO=1 (monitoring.viewer com actAs), FALSO_BUILD_ACTAS=1,
FALSO_OP_BUILDS_EDITOR=1 (operador já com cloudbuild.builds.editor), FALSO_GATILHO_DIVERGENTE=1 (gatilho
com o nome esperado mas a conta do Compute), FALSO_GATILHO_ALHEIO=1 (outro gatilho no tópico de build)."""
import json
import os
import sys

P = "cenariogestao"
COMPUTE = "123456-compute@developer.gserviceaccount.com"
LEGADA = "123456@cloudbuild.gserviceaccount.com"
OP = "serviceAccount:claude-operador@cenariogestao.iam.gserviceaccount.com"
PERMS = {  # amostra fiel do essencial de cada papel predefinido
    "roles/compute.viewer": ["compute.instances.get", "compute.instances.list", "compute.zoneOperations.get", "resourcemanager.projects.get"],
    "roles/logging.viewer": ["logging.logEntries.list", "logging.logs.list"],
    "roles/monitoring.viewer": ["monitoring.timeSeries.list"],
    "roles/serviceusage.serviceUsageConsumer": ["serviceusage.services.use", "serviceusage.services.get"],
    "roles/logging.logWriter": ["logging.logEntries.create"],
    "roles/cloudbuild.builds.builder": ["cloudbuild.builds.create", "storage.objects.get", "storage.objects.create", "artifactregistry.repositories.uploadArtifacts"],
    "roles/editor": ["compute.instances.setMetadata", "iam.serviceAccounts.actAs", "storage.objects.get"],
    "roles/cloudbuild.builds.editor": ["cloudbuild.builds.create", "cloudbuild.builds.get", "cloudbuild.builds.list", "cloudbuild.builds.update"],
}


def carregar():
    c = os.environ["FALSO_ESTADO"]
    if os.path.exists(c):
        with open(c, encoding="utf-8") as f:
            return json.load(f)
    return {"apis": ["compute.googleapis.com", "artifactregistry.googleapis.com"], "sas": ["cenario-homolog-vm@cenariogestao.iam.gserviceaccount.com", COMPUTE],
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
        if alvo == P:  # contas do Google que existem em todo projeto real
            membros.append({"membro": f"serviceAccount:{COMPUTE}", "papel": "roles/editor"})
            if os.environ.get("FALSO_OP_BUILDS_EDITOR") == "1":
                membros.append({"membro": OP, "papel": "roles/cloudbuild.builds.editor"})
            if os.environ.get("FALSO_LEGADA") == "1":
                membros.append({"membro": f"serviceAccount:{LEGADA}", "papel": "roles/cloudbuild.builds.builder"})
        out = {"bindings": [{"role": l["papel"], "members": [l["membro"]]} for l in membros]}
    elif cmd.startswith("builds get-default-service-account"):
        if os.environ.get("FALSO_BUILD_PADRAO_ERRO") == "1":
            return 1
        print(os.environ.get("FALSO_BUILD_PADRAO", f"projects/{P}/serviceAccounts/{COMPUTE}"))
    elif cmd.startswith("builds list"):
        out = [{"id": "b0a1c2d3-0000-4000-8000-000000000001", "createTime": "2026-10-09T12:00:00Z", "status": "SUCCESS",
                "serviceAccount": f"projects/{P}/serviceAccounts/{COMPUTE}", "source": {"storageSource": {"bucket": f"{P}_cloudbuild"}}}]
    elif cmd.startswith("builds triggers list"):
        out = list(e.get("gatilhos", {}).values()) if "--region=us-east1" in a else []
        if "--region=us-east1" in a and os.environ.get("FALSO_GATILHO_DIVERGENTE") == "1":
            out = [dict(g, serviceAccount=f"projects/{P}/serviceAccounts/{COMPUTE}") for g in out] or [
                {"name": "cenario-homolog-build-autonomo", "serviceAccount": f"projects/{P}/serviceAccounts/{COMPUTE}",
                 "pubsubConfig": {"topic": f"projects/{P}/topics/cenario-homolog-build"}, "build": {"steps": []}}]
        if "--region=us-east1" in a and os.environ.get("FALSO_GATILHO_ALHEIO") == "1":
            out.append({"name": "gatilho-antigo", "pubsubConfig": {"topic": f"projects/{P}/topics/cenario-homolog-build"}, "build": {"steps": []}})
    elif cmd.startswith("builds triggers describe"):
        gat = e.get("gatilhos", {}).get(pos[-1])
        if os.environ.get("FALSO_GATILHO_DIVERGENTE") == "1":
            gat = {"name": pos[-1], "serviceAccount": f"projects/{P}/serviceAccounts/{COMPUTE}", "pubsubConfig": {"topic": "x"}, "build": {"steps": []}}
        if gat is None:
            return 1
        out = gat
    elif cmd.startswith("builds triggers create pubsub"):
        with open(opt["inline-config"], encoding="utf-8") as f:
            build = json.load(f)
        subst = dict(x.split("=", 1) for x in opt["substitutions"].split(","))
        e.setdefault("gatilhos", {})[opt["name"]] = {"name": opt["name"], "serviceAccount": opt["service-account"],
                                                     "pubsubConfig": {"topic": opt["topic"]}, "substitutions": subst, "build": build}
        salvar(e)
    elif cmd.startswith("builds triggers delete"):
        rc = 0 if e.get("gatilhos", {}).pop(pos[-1], None) else 1
        salvar(e)
    elif cmd.startswith("iam service-accounts list"):
        print("\n".join(e["sas"]))
    elif cmd.startswith("iam roles describe roles/"):
        perms = list(PERMS.get(pos[-1], []))
        if pos[-1] == "roles/monitoring.viewer" and os.environ.get("FALSO_PAPEL_PERIGOSO") == "1":
            perms.append("iam.serviceAccounts.actAs")
        if not perms:
            return 1
        out = {"name": pos[-1], "includedPermissions": perms}
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
        b = [{"role": l["papel"], "members": [l["membro"]]} for l in e["ligacoes"] if l["recurso"] == f"sa:{pos[-1]}"]
        if pos[-1] == COMPUTE and os.environ.get("FALSO_ACTAS_EXTRA") == "1":
            b.append({"role": "roles/iam.serviceAccountUser", "members": [OP]})
        if pos[-1] == COMPUTE and os.environ.get("FALSO_BUILD_ACTAS") == "1":
            b.append({"role": "roles/iam.serviceAccountTokenCreator", "members": ["serviceAccount:cenario-build@cenariogestao.iam.gserviceaccount.com"]})
        out = {"bindings": b}
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
        elif opt.get("format") == "json":
            out = {"name": pos[-1], "includedPermissions": r}
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
