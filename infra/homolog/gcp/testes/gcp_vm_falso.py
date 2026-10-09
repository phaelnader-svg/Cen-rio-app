"""Servidor local que imita, para os testes do vm.sh, o servidor de metadados da VM e a API JSON
do Cloud Storage com a conta da VM tendo SÓ roles/storage.objectCreator:
  - POST /upload/storage/v1/b/<bucket>/o?uploadType=media&ifGenerationMatch=0&name=…
      200 cria · 412 se o nome já existe · 403 no modo "proibido" · 401 sem o token certo;
  - GET do objeto, listagem e DELETE → 403 (sem permissão de leitura/listagem/exclusão).
Uso: gcp_vm_falso.py <pasta-de-objetos> <arquivo-de-modo>  (imprime a URL base)
"""
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, unquote, urlparse

TOKEN = "tok-vm-falso-NAO-DEVE-APARECER"


def servidor(pasta: str, arquivo_modo: str) -> ThreadingHTTPServer:
    def modo() -> str:
        try:
            with open(arquivo_modo, encoding="utf-8") as f:
                return f.read().strip()
        except OSError:
            return "ok"

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def _enviar(self, codigo: int, corpo: bytes = b"{}") -> None:
            self.send_response(codigo)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(corpo)))
            self.end_headers()
            self.wfile.write(corpo)

        def _registrar(self, linha: str) -> None:
            with open(os.path.join(pasta, "_requisicoes.log"), "a", encoding="utf-8") as f:
                f.write(linha + "\n")

        def do_GET(self):
            u = urlparse(self.path)
            self._registrar(f"GET {u.path}")
            if u.path.startswith("/computeMetadata/"):
                if self.headers.get("Metadata-Flavor") != "Google":
                    return self._enviar(403)
                if u.path.endswith("/service-accounts/default/token"):
                    return self._enviar(200, json.dumps({"access_token": TOKEN, "expires_in": 3599,
                                                         "token_type": "Bearer"}).encode())
                if u.path.endswith("/service-accounts/default/scopes"):
                    return self._enviar(200, b"https://www.googleapis.com/auth/cloud-platform\n")
                return self._enviar(404, b"")
            return self._enviar(403 if self._autorizado() else 401)

        def do_DELETE(self):
            self._registrar(f"DELETE {urlparse(self.path).path}")
            return self._enviar(403 if self._autorizado() else 401)

        def do_POST(self):
            u = urlparse(self.path)
            q = parse_qs(u.query)
            dados = self.rfile.read(int(self.headers.get("content-length") or 0))
            nome = unquote((q.get("name") or [""])[0])
            self._registrar(f"POST {u.path} name={nome} ifGenerationMatch={(q.get('ifGenerationMatch') or [''])[0]}")
            if not self._autorizado():
                return self._enviar(401)
            if modo() == "proibido":
                return self._enviar(403, b'{"error":{"code":403}}')
            if (q.get("ifGenerationMatch") or [""])[0] != "0":
                return self._enviar(403, b'{"error":"sobrescrever exige storage.objects.delete"}')
            destino = os.path.join(pasta, nome.replace("/", "__"))
            if os.path.exists(destino):
                return self._enviar(412, b'{"error":{"code":412}}')
            with open(destino, "wb") as f:
                f.write(dados)
            return self._enviar(200, json.dumps({"name": nome, "size": str(len(dados))}).encode())

        def _autorizado(self) -> bool:
            return self.headers.get("Authorization") == f"Bearer {TOKEN}"

    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


if __name__ == "__main__":
    s = servidor(sys.argv[1], sys.argv[2])
    print(f"http://127.0.0.1:{s.server_address[1]}", flush=True)
    try:
        threading.Event().wait()
    except KeyboardInterrupt:
        pass
