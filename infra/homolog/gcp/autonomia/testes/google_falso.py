"""Servidor HTTP FALSO das APIs do Google usadas pelo runner e pelo cliente (só para testes).

Metadados, Pub/Sub (publish/pull/acknowledge/modifyAckDeadline), IAM Credentials signJwt (assina
de verdade, RS256, com uma chave RSA local), certificados x509 da conta, Cloud Storage (upload com
ifGenerationMatch=0, leitura, listagem com prefix/matchGlob) e Logging. Estado em memória.
"""
from __future__ import annotations

import base64
import fnmatch
import json
import os
import subprocess
import tempfile
import threading
import time
import urllib.parse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


def b64url(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode().rstrip("=")


class Chave:
    def __init__(self, d: str, kid: str = "k1"):
        self.kid = kid
        self.priv = os.path.join(d, f"{kid}.key")
        self.cert = os.path.join(d, f"{kid}.pem")
        subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", self.priv, "-out", self.cert,
                        "-days", "2", "-subj", "/CN=claude-operador"], check=True, capture_output=True)

    def assinar(self, payload: str) -> str:
        cab = b64url(json.dumps({"alg": "RS256", "kid": self.kid, "typ": "JWT"}).encode())
        corpo = b64url(payload.encode())
        with tempfile.NamedTemporaryFile() as m:
            m.write(f"{cab}.{corpo}".encode())
            m.flush()
            sig = subprocess.run(["openssl", "dgst", "-sha256", "-sign", self.priv, m.name], check=True, capture_output=True).stdout
        return f"{cab}.{corpo}.{b64url(sig)}"


class Estado:
    def __init__(self, d: str):
        self.lock = threading.Lock()
        self.chave = Chave(d)
        self.mensagens: dict[str, dict] = {}     # id → {data, publishTime, ack, lease}
        self.seq = 0
        self.objetos: dict[tuple[str, str], bytes] = {}
        self.projeto, self.vm = "cenariogestao", "cenario-homolog"
        self.assinante = "claude-operador@cenariogestao.iam.gserviceaccount.com"
        self.publicacoes = 0
        self.logs: list[dict] = []
        self.falhar_certs = False
        self.gatilho = {"name": "cenario-homolog-build-autonomo",
                        "serviceAccount": "projects/cenariogestao/serviceAccounts/cenario-build@cenariogestao.iam.gserviceaccount.com",
                        "pubsubConfig": {"topic": "projects/cenariogestao/topics/cenario-homolog-build"}}
        self.publicados: list[dict] = []

    def publicar(self, data_b64: str) -> str:
        with self.lock:
            self.seq += 1
            mid = str(1000 + self.seq)
            self.mensagens[mid] = {"data": data_b64, "publishTime": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
                                   "ack": False, "lease": 0.0}
            self.publicacoes += 1
            return mid


def criar(d: str):
    est = Estado(d)

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def responder(self, st: int, corpo, tipo="application/json"):
            dados = corpo if isinstance(corpo, bytes) else json.dumps(corpo).encode()
            self.send_response(st)
            self.send_header("Content-Type", tipo)
            self.send_header("Content-Length", str(len(dados)))
            self.end_headers()
            self.wfile.write(dados)

        def corpo(self) -> bytes:
            n = int(self.headers.get("Content-Length") or 0)
            return self.rfile.read(n) if n else b""

        def do_GET(self):
            u = urllib.parse.urlparse(self.path)
            q = urllib.parse.parse_qs(u.query)
            p = u.path
            if p.startswith("/meta/"):
                if self.headers.get("Metadata-Flavor") != "Google":
                    return self.responder(403, {})
                r = p[len("/meta/"):]
                if r == "project/project-id":
                    return self.responder(200, est.projeto.encode(), "text/plain")
                if r == "instance/name":
                    return self.responder(200, est.vm.encode(), "text/plain")
                if r == "instance/service-accounts/default/token":
                    return self.responder(200, {"access_token": "token-da-vm", "expires_in": 3600})
                return self.responder(404, {})
            if p.startswith("/certs/"):
                if est.falhar_certs:
                    return self.responder(503, {})
                if urllib.parse.unquote(p[len("/certs/"):]) != est.assinante:
                    return self.responder(404, {})
                with open(est.chave.cert, encoding="utf-8") as f:
                    return self.responder(200, {est.chave.kid: f.read()})
            if p.startswith("/build/") and "/triggers/" in p:
                return self.responder(200, est.gatilho) if p.endswith("/" + est.gatilho["name"]) else self.responder(404, {})
            if p.startswith("/storage/storage/v1/b/"):
                resto = p[len("/storage/storage/v1/b/"):]
                bucket, _, objeto = resto.partition("/o")
                if objeto.startswith("/"):
                    nome = urllib.parse.unquote(objeto[1:])
                    v = est.objetos.get((bucket, nome))
                    return self.responder(200, v, "application/octet-stream") if v is not None else self.responder(404, {})
                prefixo = q.get("prefix", [""])[0]
                glob = q.get("matchGlob", ["*"])[0]
                itens = [{"name": n} for (b, n) in sorted(est.objetos) if b == bucket and n.startswith(prefixo) and fnmatch.fnmatch(n, glob)]
                return self.responder(200, {"items": itens} if itens else {})
            if p.startswith("/storage/") and not p.startswith(("/storage/storage/", "/storage/upload/")):  # XML API
                bucket, _, nome = p[len("/storage/"):].partition("/")
                v = est.objetos.get((bucket, urllib.parse.unquote(nome)))
                return self.responder(200, v, "application/octet-stream") if v is not None else self.responder(404, {})
            self.responder(404, {"erro": p})

        def do_POST(self):
            u = urllib.parse.urlparse(self.path)
            q = urllib.parse.parse_qs(u.query)
            p, dados = u.path, self.corpo()
            if p.startswith("/iam/") and p.endswith(":signJwt"):
                email = urllib.parse.unquote(p.split("/serviceAccounts/")[1].rsplit(":", 1)[0])
                if email != est.assinante:
                    return self.responder(403, {"error": "sem permissão"})
                payload = json.loads(dados)["payload"]
                return self.responder(200, {"keyId": est.chave.kid, "signedJwt": est.chave.assinar(payload)})
            if p.startswith("/pubsub/") and p.endswith(":publish"):
                msgs = json.loads(dados)["messages"]
                est.publicados += [{"topico": p[len("/pubsub/"):-len(":publish")], **m} for m in msgs]
                if p.endswith("/topics/cenario-homolog-build:publish"):  # pedidos de build não vão para o runner
                    return self.responder(200, {"messageIds": [f"b{len(est.publicados)}" for _ in msgs]})
                return self.responder(200, {"messageIds": [est.publicar(m["data"]) for m in msgs]})
            if p.startswith("/pubsub/") and p.endswith(":pull"):
                maximo = json.loads(dados).get("maxMessages", 1)
                fim = time.time() + 1.0
                while time.time() < fim:
                    with est.lock:
                        livres = [(mid, m) for mid, m in sorted(est.mensagens.items()) if not m["ack"] and m["lease"] < time.time()][:maximo]
                        for mid, m in livres:
                            m["lease"] = time.time() + 60
                    if livres:
                        return self.responder(200, {"receivedMessages": [
                            {"ackId": f"ack-{mid}", "message": {"messageId": mid, "data": m["data"], "publishTime": m["publishTime"]}}
                            for mid, m in livres]})
                    time.sleep(0.05)
                return self.responder(200, {})
            if p.startswith("/pubsub/") and p.endswith(":acknowledge"):
                with est.lock:
                    for a in json.loads(dados)["ackIds"]:
                        est.mensagens[a[4:]]["ack"] = True
                return self.responder(200, {})
            if p.startswith("/pubsub/") and p.endswith(":modifyAckDeadline"):
                with est.lock:
                    for a in json.loads(dados)["ackIds"]:
                        est.mensagens[a[4:]]["lease"] = 0.0
                return self.responder(200, {})
            if p.startswith("/storage/upload/storage/v1/b/"):
                bucket = p[len("/storage/upload/storage/v1/b/"):].split("/")[0]
                nome = q["name"][0]
                with est.lock:
                    if q.get("ifGenerationMatch") == ["0"] and (bucket, nome) in est.objetos:
                        return self.responder(412, {})
                    est.objetos[(bucket, nome)] = dados
                return self.responder(200, {"name": nome})
            if p.startswith("/logging/"):
                est.logs.append(json.loads(dados))
                return self.responder(200, {})
            self.responder(404, {"erro": p})

    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, est
