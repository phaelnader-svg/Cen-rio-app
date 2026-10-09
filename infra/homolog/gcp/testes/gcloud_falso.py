#!/usr/bin/env python3
"""gcloud FALSO para os testes do homolog.sh: imita a infraestrutura REAL criada manualmente
(VM cenario-homolog na VPC cenario-homolog-vpc, IP 136.108.15.103, conta de serviço, 5 segredos e
bucket privado sem ciclo de vida e sem objectCreator) e guarda as alterações num arquivo de estado.
Registra TODA chamada em $GCLOUD_LOG. Nada externo é tocado.

Variações (variáveis de ambiente): FALSO_ESCOPOS (lista separada por vírgula), FALSO_FW_ABERTO=1,
FALSO_SEGUNDA_VM=1, FALSO_DISCO_ORFAO=1, FALSO_BUCKET_ADMIN=1, FALSO_PORTAO=ABERTO|FECHADO,
FALSO_SSH_FALHA=1.
"""
import json
import os
import sys

P = "cenariogestao"
SA = f"cenario-homolog-vm@{P}.iam.gserviceaccount.com"
U = "https://www.googleapis.com/compute/v1/projects/cenariogestao"
SEGREDOS = ["homolog-postgres-password", "homolog-token-hash-secret", "homolog-admin-password",
            "homolog-proxy-password", "homolog-gate-token"]


def estado_inicial():
    escopos = os.environ.get("FALSO_ESCOPOS", "https://www.googleapis.com/auth/cloud-platform").split(",")
    vm = {
        "name": "cenario-homolog", "status": "RUNNING", "zone": f"{U}/zones/us-east1-b",
        "machineType": f"{U}/zones/us-east1-b/machineTypes/e2-small",
        "disks": [{"boot": True, "autoDelete": True, "source": f"{U}/zones/us-east1-b/disks/cenario-homolog"}],
        "networkInterfaces": [{"network": f"{U}/global/networks/cenario-homolog-vpc",
                               "subnetwork": f"{U}/regions/us-east1/subnetworks/cenario-homolog-subnet",
                               "networkIP": "10.50.0.2",
                               "accessConfigs": [{"natIP": "136.108.15.103", "networkTier": "PREMIUM"}]}],
        "tags": {"items": ["cenario-homolog"]},
        "serviceAccounts": [{"email": SA, "scopes": escopos}],
        "shieldedInstanceConfig": {"enableSecureBoot": True},
        "metadata": {"items": [{"key": "enable-oslogin", "value": "TRUE"}]},
    }
    vms = [vm]
    if os.environ.get("FALSO_SEGUNDA_VM") == "1":
        vms.append(dict(vm, name="outra-vm"))
    discos = [{"name": "cenario-homolog", "sizeGb": "20", "type": f"{U}/zones/us-east1-b/diskTypes/pd-balanced",
               "sourceImage": "projects/debian-cloud/global/images/debian-12-bookworm-v20260910",
               "users": [f"{U}/zones/us-east1-b/instances/cenario-homolog"], "zone": f"{U}/zones/us-east1-b"}]
    if os.environ.get("FALSO_DISCO_ORFAO") == "1":
        discos.append({"name": "esquecido", "sizeGb": "10", "type": "pd-standard", "zone": "us-east1-b"})
    fw = [{"name": "cenario-homolog-iap-ssh", "network": f"{U}/global/networks/cenario-homolog-vpc",
           "direction": "INGRESS", "priority": 1000, "allowed": [{"IPProtocol": "tcp", "ports": ["22"]}],
           "sourceRanges": ["35.235.240.0/20"], "targetTags": ["cenario-homolog"], "disabled": False}]
    if os.environ.get("FALSO_FW_ABERTO") == "1":
        fw.append({"name": "liberou-web", "network": f"{U}/global/networks/cenario-homolog-vpc",
                   "direction": "INGRESS", "priority": 1000,
                   "allowed": [{"IPProtocol": "tcp", "ports": ["80", "443"]}],
                   "sourceRanges": ["0.0.0.0/0"], "disabled": False})
    bucket_iam = {"bindings": [{"role": "roles/storage.legacyBucketOwner", "members": [f"projectOwner:{P}"]}]}
    if os.environ.get("FALSO_BUCKET_ADMIN") == "1":
        bucket_iam["bindings"].append({"role": "roles/storage.objectAdmin", "members": [f"serviceAccount:{SA}"]})
    return {
        "vms": vms, "discos": discos, "fw": fw, "politicas": [],
        "bucket": {"name": "cenariogestao-homolog-backups", "location": "US-EAST1",
                   "default_storage_class": "STANDARD", "uniform_bucket_level_access": True,
                   "public_access_prevention": "enforced",
                   "soft_delete_policy": {"retentionDurationSeconds": "604800"}},
        "bucket_iam": bucket_iam,
        "segredos_iam": {s: {"bindings": [{"role": "roles/secretmanager.secretAccessor",
                                           "members": [f"serviceAccount:{SA}"]}]} for s in SEGREDOS},
        "proj_iam": {"bindings": [{"role": "roles/owner", "members": ["user:teste@exemplo.com"]}]},
    }


def main():
    args = sys.argv[1:]
    with open(os.environ["GCLOUD_LOG"], "a", encoding="utf-8") as f:
        f.write(" ".join(args) + "\n")
    caminho = os.environ["FALSO_ESTADO"]
    if os.path.exists(caminho):
        with open(caminho, encoding="utf-8") as f:
            e = json.load(f)
    else:
        e = estado_inicial()
    pos = [a for a in args if not a.startswith("--")]
    opt = dict(a[2:].split("=", 1) for a in args if a.startswith("--") and "=" in a)
    cmd = " ".join(pos)
    out = None

    def salvar():
        with open(caminho, "w", encoding="utf-8") as f:
            json.dump(e, f)

    def vm():
        return next(v for v in e["vms"] if v["name"] == "cenario-homolog")

    if cmd == "config get-value account":
        print("teste@exemplo.com"); return 0
    if cmd == "config get-value project":
        print(P); return 0
    if cmd == "auth print-access-token":
        print("tok-falso"); return 0
    if cmd == f"projects describe {P}":
        out = {"lifecycleState": "ACTIVE", "projectNumber": "123456"}
    elif cmd == f"projects get-iam-policy {P}":
        out = e["proj_iam"]
    elif cmd == "projects get-iam-policy verificapro-exemplo":
        out = {"bindings": [{"role": "roles/owner", "members": ["user:teste@exemplo.com"]}]}
    elif cmd == "projects list":
        out = [{"projectId": P}, {"projectId": "verificapro-exemplo"}]
    elif cmd.startswith("billing projects describe"):
        out = {"billingEnabled": True, "billingAccountName": "billingAccounts/0000-TESTE"}
    elif cmd == "billing budgets list":
        out = [{"displayName": "Cenário", "amount": {"specifiedAmount": {"units": "30", "currencyCode": "USD"}},
                "budgetFilter": {"projects": ["projects/123456"]},
                "thresholdRules": [{"thresholdPercent": 0.5}, {"thresholdPercent": 0.9}, {"thresholdPercent": 1.0}]}]
    elif cmd == "services list":
        out = [{"config": {"name": n}} for n in ["compute.googleapis.com", "iam.googleapis.com",
                                                 "secretmanager.googleapis.com", "storage.googleapis.com",
                                                 "iap.googleapis.com", "oslogin.googleapis.com"]]
    elif cmd == "compute instances list":
        out = e["vms"]
    elif cmd == "compute instances describe cenario-homolog":
        out = vm()
    elif cmd == "compute instances add-metadata cenario-homolog":
        itens = vm()["metadata"]["items"]
        for kv in opt["metadata"].split(","):
            k, v = kv.split("=", 1)
            itens[:] = [i for i in itens if i["key"] != k] + [{"key": k, "value": v}]
        salvar()
    elif cmd == "compute disks list":
        out = e["discos"]
    elif cmd == "compute disks describe cenario-homolog":
        out = e["discos"][0]
    elif cmd == "compute disks add-resource-policies cenario-homolog":
        e["discos"][0].setdefault("resourcePolicies", []).append(f"{U}/regions/us-east1/resourcePolicies/{opt['resource-policies']}")
        salvar()
    elif cmd == "compute addresses list":
        out = [{"name": "cenario-homolog-ip", "address": "136.108.15.103", "status": "IN_USE",
                "addressType": "EXTERNAL", "region": f"{U}/regions/us-east1"}]
    elif cmd in ("compute snapshots list", "compute images list", "compute machine-images list",
                 "compute forwarding-rules list", "compute routers list"):
        out = []
    elif cmd == "compute resource-policies list":
        out = e["politicas"]
    elif cmd.startswith("compute resource-policies describe"):
        if not any(p["name"] == pos[-1] for p in e["politicas"]):
            print("ERROR: not found", file=sys.stderr); return 1
        out = next(p for p in e["politicas"] if p["name"] == pos[-1])
    elif cmd.startswith("compute resource-policies create snapshot-schedule"):
        e["politicas"].append({"name": pos[-1]}); salvar()
    elif cmd == "compute networks describe cenario-homolog-vpc":
        out = {"name": "cenario-homolog-vpc", "autoCreateSubnetworks": False}
    elif cmd == "compute networks subnets list":
        out = [{"name": "cenario-homolog-subnet", "network": f"{U}/global/networks/cenario-homolog-vpc",
                "region": f"{U}/regions/us-east1", "ipCidrRange": "10.50.0.0/24"}]
    elif cmd == "compute firewall-rules list":
        out = e["fw"]
    elif cmd == f"iam service-accounts describe {SA}":
        out = {"email": SA, "disabled": False}
    elif cmd == "iam service-accounts keys list":
        out = []
    elif cmd == "secrets list":
        out = [{"name": f"projects/123456/secrets/{s}", "replication": {"userManaged": {"replicas": [{"location": "us-east1"}]}}}
               for s in SEGREDOS]
    elif cmd.startswith("secrets versions list"):
        out = [{"name": "1", "state": "ENABLED"}]
    elif cmd.startswith("secrets get-iam-policy"):
        out = e["segredos_iam"].get(pos[-1], {})
    elif cmd.startswith("secrets add-iam-policy-binding"):
        e["segredos_iam"].setdefault(pos[-1], {"bindings": []})["bindings"].append(
            {"role": opt["role"], "members": [opt["member"]]}); salvar()
    elif cmd == "storage buckets list":
        out = [e["bucket"]]
    elif cmd.startswith("storage buckets describe"):
        out = e["bucket"]
    elif cmd.startswith("storage buckets get-iam-policy"):
        out = e["bucket_iam"]
    elif cmd.startswith("storage buckets update") and "lifecycle-file" in opt:
        with open(opt["lifecycle-file"], encoding="utf-8") as f:
            e["bucket"]["lifecycle_config"] = json.load(f)
        salvar()
    elif cmd.startswith("storage buckets add-iam-policy-binding"):
        e["bucket_iam"]["bindings"].append({"role": opt["role"], "members": [opt["member"]]}); salvar()
    elif cmd.startswith("storage du"):
        print("2048  gs://cenariogestao-homolog-backups"); return 0
    elif cmd.startswith("compute ssh"):
        return ssh(opt.get("command", ""))
    elif cmd.startswith("compute scp"):
        return 0
    else:
        return 0  # comandos desconhecidos: apenas registrados (o teste verifica o registro)
    if out is not None:
        print(json.dumps(out))
    return 0


def ssh(comando: str) -> int:
    entrada = "" if sys.stdin.isatty() else sys.stdin.read()
    with open(os.environ["GCLOUD_LOG"] + ".ssh", "a", encoding="utf-8") as f:
        f.write(f"### {comando}\n{entrada}\n")
    if os.environ.get("FALSO_SSH_FALHA") == "1":
        print("ERROR: (gcloud.compute.start-iap-tunnel) falha simulada", file=sys.stderr)
        return 255
    if comando.startswith("test -f"):
        print(f"PORTAO-{os.environ.get('FALSO_PORTAO', 'FECHADO')}")
    elif comando == "sudo bash -s":
        print("✔ Debian 12\n✔ Docker 29.9.0 · Compose 5.6.0\n✔ nenhum contêiner em execução (total existentes: 0)\n"
              "✔ swap ativa: 2048 MB (/swapfile)\n✔ portas TCP escutando fora do loopback: 22\n"
              "✔ portão de publicação fechado\nFIM-INSPECAO")
    elif "vm.sh verificar-preparo" in comando:
        print("✔ portão de publicação fechado\n✔ nenhum contêiner em execução\nPREPARO DA VM: OK (nada foi iniciado)")
    elif "CENARIO_COMMIT=" in comando:
        print("publicação NÃO autorizada (/etc/cenario/publicacao-autorizada ausente): nada foi iniciado\n"
              "contêineres em execução: 0")
    return 0


if __name__ == "__main__":
    sys.exit(main())
