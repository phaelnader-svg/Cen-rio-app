#!/usr/bin/env python3
"""Cliente das OPERAÇÕES NOMEADAS da homologação (lado do operador, claude-operador).

Não envia scripts nem comandos: só o nome de uma operação do catálogo do runner e parâmetros
validados aqui (e de novo, estritamente, na VM). O JWT com operação + parâmetros é assinado pelo
Google como claude-operador (iamcredentials signJwt), publicado na fila e o resultado lido do
bucket de operações. Também faz, pelas APIs do Google, o que não roda na VM: estado e reinício da
VM, Cloud Build, Artifact Registry e as suítes de teste do repositório (local, allowlist).

Credencial: no ambiente do Claude Code, o proxy injeta o token da conta claude-operador nas
requisições a *.googleapis.com (Network Secret); CLOUDSDK_AUTH_ACCESS_TOKEN contém só um marcador.
No Cloud Shell (bootstrap), usa a conta logada no gcloud.

Uso:
  operar.py catalogo
  operar.py op <operacao> [chave=valor ...] [--timeout S] [--descricao TXT]
  operar.py resultado <jti>
  operar.py verificar                      # status + version (canal de ponta a ponta)
  operar.py teste-seguranca                # replay, adulteração, kid forjado, envelope com script, operação inexistente
  operar.py vm-status | vm-reiniciar | vm-ligar | vm-desligar
  operar.py imagens <sha>                  # existência das imagens api/web no Artifact Registry
  operar.py build-iniciar <sha> | build-status <id> | build-acompanhar <id>
  operar.py testes-locais <suite> [--versao SHA]   # suites: api web shared e2e lint typecheck format
Saída: 0 ok; 1 falhou; 124 tempo esgotado; 125 recusado/interrompido; 126 sem resultado/erro de API; 2 uso.
"""
from __future__ import annotations

import argparse
import base64
import importlib.util
import json
import os
import re
import ssl
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

PROJETO = os.environ.get("CENARIO_PROJECT", "cenariogestao")
ZONA = os.environ.get("CENARIO_ZONE", "us-east1-b")
REGIAO = os.environ.get("CENARIO_REGION", "us-east1")
VM = os.environ.get("CENARIO_VM", "cenario-homolog")
OPERADOR = os.environ.get("CENARIO_OPERADOR", f"claude-operador@{PROJETO}.iam.gserviceaccount.com")
# Sempre esta conta nas builds (nunca a padrão do projeto; não é configurável por variável).
BUILD_SA = f"cenario-build@{PROJETO}.iam.gserviceaccount.com"
TOPICO = os.environ.get("CENARIO_TOPICO", f"projects/{PROJETO}/topics/cenario-homolog-comandos")
BUCKET = os.environ.get("CENARIO_BUCKET_OPERACOES", f"{PROJETO}-homolog-operacoes")
BUCKET_BUILD = os.environ.get("CENARIO_BUCKET_BUILD", f"{PROJETO}-homolog-build")
REPO_AR = os.environ.get("CENARIO_REPO", "cenario-homolog")
AUD = "cenario-homolog-runner"
URL = {
    "iam": os.environ.get("CENARIO_URL_IAMCREDENTIALS", "https://iamcredentials.googleapis.com/v1"),
    "pubsub": os.environ.get("CENARIO_URL_PUBSUB", "https://pubsub.googleapis.com/v1"),
    "storage": os.environ.get("CENARIO_URL_STORAGE", "https://storage.googleapis.com"),
    "compute": os.environ.get("CENARIO_URL_COMPUTE", "https://compute.googleapis.com/compute/v1"),
    "build": os.environ.get("CENARIO_URL_CLOUDBUILD", "https://cloudbuild.googleapis.com/v1"),
    "ar": os.environ.get("CENARIO_URL_ARTIFACTREGISTRY", "https://artifactregistry.googleapis.com/v1"),
}
VALIDADE = 600
AQUI = os.path.dirname(os.path.abspath(__file__))
RAIZ = os.path.abspath(os.path.join(AQUI, "..", "..", "..", ".."))
RE_SHA = re.compile(r"^[0-9a-f]{7,40}$")
SUITES_LOCAIS = {  # comandos FIXOS do repositório; o cliente só escolhe o nome
    "api": ["pnpm", "--filter", "@cenario/api", "test"],
    "web": ["pnpm", "--filter", "@cenario/web", "test"],
    "shared": ["pnpm", "--filter", "@cenario/shared", "test"],
    "e2e": ["pnpm", "test:e2e"],
    "lint": ["pnpm", "lint"],
    "typecheck": ["pnpm", "typecheck"],
    "format": ["pnpm", "format:check"],
}


def _carregar_runner():
    spec = importlib.util.spec_from_file_location("cenario_runner", os.path.join(AQUI, "runner", "cenario_runner.py"))
    mod = importlib.util.module_from_spec(spec)
    sys.modules["cenario_runner"] = mod
    spec.loader.exec_module(mod)
    return mod


RUNNER = _carregar_runner()


def erro(msg: str, codigo: int = 2):
    print(f"✘ {msg}", file=sys.stderr)
    sys.exit(codigo)


_TOKEN: list[str] = []


def token() -> str:
    if not _TOKEN:
        t = os.environ.get("CLOUDSDK_AUTH_ACCESS_TOKEN", "")
        if not t:
            r = subprocess.run(["gcloud", "auth", "print-access-token"], capture_output=True, text=True)
            if r.returncode != 0 or not r.stdout.strip():
                erro("sem credencial do Google Cloud (nem Network Secret no ambiente, nem gcloud logado)", 126)
            t = r.stdout.strip()
        _TOKEN.append(t)
    return _TOKEN[0]


def http(metodo: str, url: str, corpo=None, timeout: float = 60, tipo="application/json"):
    dados = None if corpo is None else (corpo if isinstance(corpo, bytes) else json.dumps(corpo).encode())
    req = urllib.request.Request(url, data=dados, method=metodo, headers={"Authorization": f"Bearer {token()}", "Content-Type": tipo})
    kw = {}
    if url.startswith("https:"):
        ca = os.environ.get("SSL_CERT_FILE") or os.environ.get("REQUESTS_CA_BUNDLE")
        kw["context"] = ssl.create_default_context(cafile=ca) if ca and os.path.exists(ca) else ssl.create_default_context()
    try:
        with urllib.request.urlopen(req, timeout=timeout, **kw) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def api_ok(metodo, url, corpo=None, **kw) -> dict:
    st, resp = http(metodo, url, corpo, **kw)
    if st not in (200, 201):
        erro(f"{metodo} {url.split('?')[0]}: HTTP {st} {resp[:300].decode(errors='replace')}", 126)
    return json.loads(resp or b"{}")


# ============================================================================ fila de operações
def validar_local(operacao: str, parametros: dict, timeout: int | None) -> tuple[dict, int]:
    op = RUNNER.OPERACOES.get(operacao)
    if op is None:
        erro(f"operação desconhecida: {operacao} (veja 'operar.py catalogo')")
    try:
        validos = RUNNER.validar_parametros(op, parametros)
    except RUNNER.Rejeicao as e:
        erro(str(e))
    t = op.timeout_padrao if timeout is None else timeout
    if not op.timeout_min <= t <= op.timeout_max:
        erro(f"--timeout de {operacao}: {op.timeout_min}..{op.timeout_max}")
    return validos, t


def montar(operacao: str, parametros: dict, timeout: int, descricao: str) -> tuple[dict, dict]:
    t = int(time.time())
    claims = {"iss": OPERADOR, "sub": OPERADOR, "aud": AUD, "jti": str(uuid.uuid4()), "iat": t, "exp": t + VALIDADE,
              "vm": VM, "projeto": PROJETO, "operacao": operacao, "parametros": parametros, "timeout_s": timeout,
              "descricao": re.sub(r"[\x00-\x1f]", " ", descricao)[:200]}
    r = api_ok("POST", f"{URL['iam']}/projects/-/serviceAccounts/{urllib.parse.quote(OPERADOR)}:signJwt",
               {"payload": json.dumps(claims)})
    return claims, {"v": 2, "jwt": r["signedJwt"]}


def publicar(envelope: dict) -> str:
    dados = base64.b64encode(json.dumps(envelope, ensure_ascii=False).encode()).decode()
    return api_ok("POST", f"{URL['pubsub']}/{TOPICO}:publish", {"messages": [{"data": dados}]})["messageIds"][0]


def objeto(nome: str) -> bytes | None:
    st, corpo = http("GET", f"{URL['storage']}/storage/v1/b/{BUCKET}/o/{urllib.parse.quote(nome, safe='')}?alt=media")
    if st == 200:
        return corpo
    if st == 404:
        return None
    erro(f"gs://{BUCKET}/{nome}: HTTP {st}", 126)


def rejeicao(mid: str) -> dict | None:
    q = urllib.parse.urlencode({"prefix": "rejeitados/", "matchGlob": f"rejeitados/*-{mid}.json"})
    st, corpo = http("GET", f"{URL['storage']}/storage/v1/b/{BUCKET}/o?{q}")
    if st != 200:
        return None
    itens = json.loads(corpo).get("items", [])
    return json.loads(objeto(itens[0]["name"]) or b"{}") if itens else None


def esperar(jti: str, mid: str, limite_s: float) -> dict:
    fim, espera = time.time() + limite_s, 1.0
    while time.time() < fim:
        r = objeto(f"operacoes/{jti}/resultado.json")
        if r is not None:
            return json.loads(r)
        rej = rejeicao(mid)
        if rej:
            return {"jti": jti, "status": "recusado", "motivo": rej.get("motivo"), "exit_code": None}
        time.sleep(espera)
        espera = min(espera * 1.5, 10)
    return {"jti": jti, "status": "sem_resultado", "motivo": f"nenhum resultado em {int(limite_s)} s", "exit_code": None}


def codigo_saida(res: dict) -> int:
    if res["status"] == "concluido":
        return 0
    if res["status"] == "falhou":
        return 1
    return {"tempo_esgotado": 124, "recusado": 125, "interrompido": 125}.get(res["status"], 126)


def mostrar(res: dict) -> None:
    resumo = {k: res.get(k) for k in ("jti", "operacao", "classe", "parametros", "status", "exit_code", "inicio", "fim",
                                     "duracao_s", "motivo", "truncado")}
    print(json.dumps(resumo, ensure_ascii=False), file=sys.stderr)
    if res["status"] in ("recusado", "sem_resultado"):
        return
    for fluxo, saida in (("stdout", sys.stdout), ("stderr", sys.stderr)):
        corpo = objeto(f"operacoes/{res['jti']}/{fluxo}.txt")
        texto = corpo.decode("utf-8", errors="replace") if corpo is not None else res.get(f"{fluxo}_cauda", "")
        if texto:
            saida.write(texto if texto.endswith("\n") else texto + "\n")


def executar(operacao: str, parametros: dict | None = None, timeout: int | None = None, descricao: str = "",
             esperar_s: float | None = None) -> dict:
    validos, t = validar_local(operacao, parametros or {}, timeout)
    claims, env = montar(operacao, validos, t, descricao)
    mid = publicar(env)
    print(f"• {operacao} {json.dumps(validos, ensure_ascii=False)} → job {claims['jti']} (mensagem {mid})", file=sys.stderr)
    return esperar(claims["jti"], mid, esperar_s if esperar_s is not None else t + 180)


def parse_param(texto: str) -> tuple[str, object]:
    if "=" not in texto:
        erro(f"parâmetro '{texto}': use chave=valor")
    k, v = texto.split("=", 1)
    return k, int(v) if re.fullmatch(r"-?[0-9]+", v) else v


# ============================================================================ Google: VM, build, imagens
def instancia_url() -> str:
    return f"{URL['compute']}/projects/{PROJETO}/zones/{ZONA}/instances/{VM}"


def esperar_operacao_compute(op: dict, limite: float = 600) -> None:
    fim = time.time() + limite
    while time.time() < fim:
        if op.get("status") == "DONE":
            if op.get("error"):
                erro(f"operação do Compute falhou: {op['error']}", 1)
            return
        time.sleep(5)
        op = api_ok("GET", f"{URL['compute']}/projects/{PROJETO}/zones/{ZONA}/operations/{op['name']}")
    erro("operação do Compute não terminou a tempo", 124)


def vm_status() -> dict:
    v = api_ok("GET", instancia_url())
    return {"nome": v.get("name"), "status": v.get("status"), "maquina": v.get("machineType", "").rsplit("/", 1)[-1],
            "ultimo_inicio": v.get("lastStartTimestamp"), "ultima_parada": v.get("lastStopTimestamp")}


def vm_acao(acao: str) -> int:
    assert acao in ("reset", "start", "stop")
    print(json.dumps({"antes": vm_status()}, ensure_ascii=False), file=sys.stderr)
    esperar_operacao_compute(api_ok("POST", f"{instancia_url()}/{acao}"))
    print(json.dumps({"depois": vm_status()}, ensure_ascii=False))
    return 0


def imagens(sha: str) -> int:
    if not RE_SHA.match(sha):
        erro("SHA inválido")
    faltam = 0
    for img in ("api", "web"):
        nome = f"projects/{PROJETO}/locations/{REGIAO}/repositories/{REPO_AR}/packages/{img}/tags/{sha}"
        st, corpo = http("GET", f"{URL['ar']}/{nome}")
        print(json.dumps({"imagem": f"{img}:{sha}", "existe": st == 200, **(json.loads(corpo) if st == 200 else {})},
                         ensure_ascii=False))
        faltam += st != 200
    return 0 if faltam == 0 else 1


def worktree(sha: str) -> str:
    if not RE_SHA.match(sha):
        erro("SHA inválido")
    subprocess.run(["git", "-C", RAIZ, "fetch", "--quiet", "origin"], check=False)
    destino = tempfile.mkdtemp(prefix=f"cenario-{sha[:12]}-")
    os.rmdir(destino)
    r = subprocess.run(["git", "-C", RAIZ, "worktree", "add", "--detach", destino, sha], capture_output=True, text=True)
    if r.returncode != 0:
        erro(f"commit {sha} indisponível: {r.stderr.strip()}")
    return destino


def build_iniciar(sha: str) -> int:
    """Cloud Build do commit EXATO (árvore limpa via git worktree), com a conta cenario-build."""
    wt = worktree(sha)
    try:
        completo = subprocess.run(["git", "-C", wt, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()
        etiqueta = sha  # a etiqueta das imagens é exatamente o SHA pedido (o mesmo usado em prepare/activate)
        with open(os.path.join(wt, "infra/homolog/gcp/cloudbuild.yaml"), encoding="utf-8") as f:
            config = f.read()
        if re.search(r"(?m)^\s*serviceAccount\s*:", config) or not re.search(r"(?m)^\s*logging:\s*CLOUD_LOGGING_ONLY\s*$", config):
            erro("cloudbuild.yaml do commit define serviceAccount ou não usa logging CLOUD_LOGGING_ONLY: build NÃO enviado", 1)
        r = subprocess.run(["bash", "infra/homolog/gcp/conferir-contexto.sh"], cwd=wt)
        if r.returncode != 0:
            erro("contexto de build incompleto (.gcloudignore): build NÃO enviado", 1)
        r = subprocess.run(["gcloud", "builds", "submit", f"--project={PROJETO}", f"--region={REGIAO}", "--async",
                            "--config=infra/homolog/gcp/cloudbuild.yaml", f"--substitutions=_TAG={etiqueta},_REGION={REGIAO}",
                            f"--service-account=projects/{PROJETO}/serviceAccounts/{BUILD_SA}",
                            f"--gcs-source-staging-dir=gs://{BUCKET_BUILD}/source", "--format=value(id)", "."],
                           cwd=wt, capture_output=True, text=True)
        if r.returncode != 0:
            erro(f"builds submit: {r.stderr.strip()[-600:]}", 1)
        print(json.dumps({"build": r.stdout.strip().splitlines()[-1], "commit": completo, "etiqueta": etiqueta}))
        return 0
    finally:
        subprocess.run(["git", "-C", RAIZ, "worktree", "remove", "--force", wt], capture_output=True)


def build_status(bid: str) -> dict:
    if not re.fullmatch(r"[0-9a-f-]{8,64}", bid):
        erro("id de build inválido")
    b = api_ok("GET", f"{URL['build']}/projects/{PROJETO}/locations/{REGIAO}/builds/{bid}")
    return {"id": b.get("id"), "status": b.get("status"), "inicio": b.get("startTime"), "fim": b.get("finishTime"),
            "imagens": b.get("results", {}).get("images", []), "log": b.get("logUrl")}


def build_acompanhar(bid: str, limite: float = 2400) -> int:
    fim = time.time() + limite
    while time.time() < fim:
        s = build_status(bid)
        print(json.dumps(s, ensure_ascii=False), file=sys.stderr)
        if s["status"] in ("SUCCESS", "FAILURE", "INTERNAL_ERROR", "TIMEOUT", "CANCELLED", "EXPIRED"):
            return 0 if s["status"] == "SUCCESS" else 1
        time.sleep(20)
    return 124


def testes_locais(suite: str, versao: str | None) -> int:
    if suite not in SUITES_LOCAIS:
        erro(f"suite inválida (aceitas: {sorted(SUITES_LOCAIS)})")
    cwd, wt = RAIZ, None
    if versao:
        wt = cwd = worktree(versao)
        subprocess.run(["pnpm", "install", "--frozen-lockfile"], cwd=cwd, check=True)
    try:
        return subprocess.run(SUITES_LOCAIS[suite], cwd=cwd).returncode
    finally:
        if wt:
            subprocess.run(["git", "-C", RAIZ, "worktree", "remove", "--force", wt], capture_output=True)


# ============================================================================ verificação e segurança
def cmd_verificar() -> int:
    falhas = 0
    for op in ("status", "version"):
        res = executar(op, descricao="verificação do canal", esperar_s=240)
        mostrar(res)
        falhas += res["status"] != "concluido"
    print("CANAL: OK" if falhas == 0 else "CANAL: FALHOU", file=sys.stderr)
    return 0 if falhas == 0 else 1


def cmd_teste_seguranca() -> int:
    falhas = 0

    def espera_recusa(nome: str, mid: str, trecho: str) -> None:
        nonlocal falhas
        fim = time.time() + 150
        while time.time() < fim:
            rej = rejeicao(mid)
            if rej:
                ok = trecho in (rej.get("motivo") or "")
                print(f"{'✔' if ok else '✘'} {nome}: recusado ({rej.get('motivo')})", file=sys.stderr)
                falhas += not ok
                return
            time.sleep(2)
        print(f"✘ {nome}: nenhuma recusa registrada", file=sys.stderr)
        falhas += 1

    claims, env = montar("gate_status", {}, 30, "teste de replay")
    mid = publicar(env)
    res = esperar(claims["jti"], mid, 180)
    print(f"{'✔' if res['status'] == 'concluido' else '✘'} envelope original executado uma vez ({res['status']})", file=sys.stderr)
    falhas += res["status"] != "concluido"
    espera_recusa("replay do mesmo envelope", publicar(env), "jti já recebido")
    partes = env["jwt"].split(".")
    adulterado = dict(claims, parametros={"x": 1})
    partes[1] = base64.urlsafe_b64encode(json.dumps(adulterado).encode()).decode().rstrip("=")
    espera_recusa("claims adulteradas depois da assinatura", publicar({"v": 2, "jwt": ".".join(partes)}), "assinatura inválida")
    falso = ".".join(base64.urlsafe_b64encode(json.dumps(x).encode()).decode().rstrip("=")
                     for x in ({"alg": "RS256", "kid": "forjado"}, claims)) + ".AAAA"
    espera_recusa("JWT com chave forjada", publicar({"v": 2, "jwt": falso}), "kid desconhecido")
    espera_recusa("envelope com campo de script", publicar({"v": 2, "jwt": env["jwt"], "script": "id"}), "campos inesperados")
    t = int(time.time())
    c2 = dict(claims, jti=str(uuid.uuid4()), operacao="shell", iat=t, exp=t + 300)
    r = api_ok("POST", f"{URL['iam']}/projects/-/serviceAccounts/{urllib.parse.quote(OPERADOR)}:signJwt", {"payload": json.dumps(c2)})
    espera_recusa("operação fora do catálogo (assinada)", publicar({"v": 2, "jwt": r["signedJwt"]}), "operação desconhecida")
    c3 = dict(claims, jti=str(uuid.uuid4()), operacao="container_logs", parametros={"service": "api;id"}, iat=t, exp=t + 300)
    r = api_ok("POST", f"{URL['iam']}/projects/-/serviceAccounts/{urllib.parse.quote(OPERADOR)}:signJwt", {"payload": json.dumps(c3)})
    espera_recusa("parâmetro fora da allowlist (assinado)", publicar({"v": 2, "jwt": r["signedJwt"]}), "parâmetro service")
    print("SEGURANÇA: OK" if falhas == 0 else f"SEGURANÇA: {falhas} falha(s)", file=sys.stderr)
    return 0 if falhas == 0 else 1


def main() -> int:
    p = argparse.ArgumentParser(description="Operações nomeadas da homologação (claude-operador)")
    s = p.add_subparsers(dest="cmd", required=True)
    s.add_parser("catalogo")
    o = s.add_parser("op")
    o.add_argument("operacao")
    o.add_argument("params", nargs="*")
    o.add_argument("--timeout", type=int)
    o.add_argument("--descricao", default="")
    r = s.add_parser("resultado")
    r.add_argument("jti")
    for n in ("verificar", "teste-seguranca", "vm-status", "vm-reiniciar", "vm-ligar", "vm-desligar"):
        s.add_parser(n)
    for n in ("imagens", "build-iniciar"):
        s.add_parser(n).add_argument("sha")
    for n in ("build-status", "build-acompanhar"):
        s.add_parser(n).add_argument("id")
    t = s.add_parser("testes-locais")
    t.add_argument("suite")
    t.add_argument("--versao")
    a = p.parse_args()

    if a.cmd == "catalogo":
        print(json.dumps(RUNNER.catalogo(), ensure_ascii=False, indent=1))
        return 0
    if a.cmd == "op":
        res = executar(a.operacao, dict(parse_param(x) for x in a.params), a.timeout, a.descricao)
        mostrar(res)
        return codigo_saida(res)
    if a.cmd == "resultado":
        if not RUNNER.RE_UUID.match(a.jti):
            erro("jti inválido")
        corpo = objeto(f"operacoes/{a.jti}/resultado.json")
        if corpo is None:
            erro("resultado inexistente", 126)
        res = json.loads(corpo)
        mostrar(res)
        return codigo_saida(res)
    if a.cmd == "verificar":
        return cmd_verificar()
    if a.cmd == "teste-seguranca":
        return cmd_teste_seguranca()
    if a.cmd == "vm-status":
        print(json.dumps(vm_status(), ensure_ascii=False))
        return 0
    if a.cmd in ("vm-reiniciar", "vm-ligar", "vm-desligar"):
        return vm_acao({"vm-reiniciar": "reset", "vm-ligar": "start", "vm-desligar": "stop"}[a.cmd])
    if a.cmd == "imagens":
        return imagens(a.sha)
    if a.cmd == "build-iniciar":
        return build_iniciar(a.sha)
    if a.cmd == "build-status":
        print(json.dumps(build_status(a.id), ensure_ascii=False))
        return 0
    if a.cmd == "build-acompanhar":
        return build_acompanhar(a.id)
    if a.cmd == "testes-locais":
        return testes_locais(a.suite, a.versao)
    return 2


if __name__ == "__main__":
    sys.exit(main())
