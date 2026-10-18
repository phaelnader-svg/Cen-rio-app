"""Testes de ponta a ponta do runner de operações nomeadas e do cliente operar.py.

Tudo local: APIs do Google falsas (google_falso.py, com assinatura RS256 real), um HTTPS local falso
no lugar do Caddy e vm.sh/docker/systemctl/journalctl falsos que só registram o que receberam.
Executar: python3 -m unittest infra/homolog/gcp/autonomia/testes/test_runner.py -v
"""
from __future__ import annotations

import base64
import hashlib
import io
import json
import os
import re
import shutil
import signal
import ssl
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import unittest
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

AQUI = os.path.dirname(os.path.abspath(__file__))
BASE = os.path.dirname(AQUI)
sys.path.insert(0, AQUI)
import google_falso  # noqa: E402

RUNNER = os.path.join(BASE, "runner", "cenario_runner.py")
OPERAR = os.path.join(BASE, "operar.py")
OPERADOR = "claude-operador@cenariogestao.iam.gserviceaccount.com"
SEGREDO = "senha-super-secreta-123"
TOKEN_PORTAO = "abcdef0123456789abcdef"


def escrever(caminho: str, texto: str, modo: int = 0o644) -> None:
    os.makedirs(os.path.dirname(caminho), exist_ok=True)
    with open(caminho, "w", encoding="utf-8") as f:
        f.write(texto)
    os.chmod(caminho, modo)


def https_falso(d: str):
    cert, chave = os.path.join(d, "tls.pem"), os.path.join(d, "tls.key")
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", chave, "-out", cert, "-days", "2",
                    "-subj", "/CN=teste.cenariogestao.com.br"], check=True, capture_output=True)

    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):
            pass

        def do_GET(self):
            cookie = f"cenario_homolog={TOKEN_PORTAO}" in (self.headers.get("Cookie") or "")
            if self.path == "/api/realtime":
                st, corpo = 401, b'{"error":"sem sessao"}'
            elif not cookie:
                st, corpo = 401, b"restrito"
            elif self.path == "/api/ready":
                st, corpo = 200, b'{"status":"ready"}'
            else:
                st, corpo = 200, b"ok"
            self.send_response(st)
            self.send_header("Content-Length", str(len(corpo)))
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(corpo)

    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    ctx.load_cert_chain(cert, chave)
    srv.socket = ctx.wrap_socket(srv.socket, server_side=True)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


class Ambiente:
    """Um runner real (subprocesso) com tudo falso ao redor."""

    def __init__(self, vm: str = "cenario-homolog"):
        self.d = tempfile.mkdtemp(prefix="cenario-runner-teste-")
        self.ctrl = os.path.join(self.d, "ctrl")
        os.makedirs(self.ctrl)
        self.srv, self.est = google_falso.criar(self.d)
        self.est.vm = vm
        self.porta = self.srv.server_address[1]
        self.tls = https_falso(self.d)
        self.bin = os.path.join(self.d, "bin")
        c = self.ctrl
        escrever(os.path.join(self.d, "opt/cenario/infra/homolog/gcp/vm.sh"), f"""#!/bin/bash
echo "$(date +%s.%N) INICIO $1 $2 TAG=${{CENARIO_TAG:-}}" >> {c}/vmsh.log
[ -f {c}/dormir-$1 ] && {{ echo $$ > {c}/pid-$1; sleep "$(cat {c}/dormir-$1)"; }}
case "$1" in
  status) echo "contêineres ok"; [ -f {c}/grande ] && head -c 11534336 /dev/zero | tr '\\0' 'x' ;;
  saude) echo "senha do banco: {SEGREDO}"; echo "Authorization: Bearer abcdefghijklmnop"; echo "Saúde: OK" ;;
  *) echo "vm.sh $* ok" ;;
esac
echo "$(date +%s.%N) FIM $1" >> {c}/vmsh.log
[ -f {c}/falhar-$1 ] && exit 3
exit 0
""", 0o755)
        escrever(os.path.join(self.bin, "docker"), f"""#!/bin/bash
printf '%s\\n' "$*" >> {c}/docker.log
case "$*" in
  "image ls "*) cat {c}/imagens.jsonl 2>/dev/null; exit 0 ;;
  "ps -a "*) cat {c}/conteineres 2>/dev/null; exit 0 ;;
  "inspect --format {{{{.Image}}}} "*) cat {c}/imagens-em-uso; exit 0 ;;
  "image rm "*) [ -f {c}/recusar-rm ] && exit 1; ref="$3"
    grep -vF "\\"Repository\\":\\"${{ref%:*}}\\",\\"Tag\\":\\"${{ref##*:}}\\"" {c}/imagens.jsonl > {c}/imagens.tmp; mv {c}/imagens.tmp {c}/imagens.jsonl; exit 0 ;;
  *"caddy validate"*) [ -f {c}/caddy-invalido ] && exit 1; echo "Valid configuration"; exit 0 ;;
  *" restart"*) echo "$(date +%s.%N) INICIO restart" >> {c}/restart.log; sleep "$(cat {c}/dormir-restart 2>/dev/null || echo 0)"; echo "$(date +%s.%N) FIM restart" >> {c}/restart.log ;;
  *" ps "*) printf 'postgres running healthy\\napi running healthy\\nweb running \\ncaddy running \\nbackup running \\n' ;;
  *psql*) printf '20261008000000_fundacao|2026-10-08T00:00:00||1\\n20261018000000_fila_semanal|2026-10-18T00:00:00||1\\n' ;;
  *"--entrypoint ls"*) printf '20261008000000_fundacao\\n20261018000000_fila_semanal\\n20261230000000_modelos_simplificados\\nmigration_lock.toml\\n' ;;
  *) echo "docker ok" ;;
esac
""", 0o755)
        for nome in ("systemctl", "journalctl", "ss"):
            escrever(os.path.join(self.bin, nome), f"#!/bin/bash\nprintf '%s\\n' \"{nome} $*\" >> {c}/{nome}.log\necho {nome} ok\n", 0o755)
        escrever(os.path.join(self.d, "run/env"), f"POSTGRES_PASSWORD='{SEGREDO}'\nHOMOLOG_GATE_TOKEN='{TOKEN_PORTAO}'\n"
                 "CENARIO_API_IMAGE='us-east1-docker.pkg.dev/cenariogestao/cenario-homolog/api:abc1234'\n", 0o600)
        os.makedirs(os.path.join(self.d, "var/lib/cenario"), exist_ok=True)
        u = f"http://127.0.0.1:{self.porta}"
        self.cfg = {
            "projeto": "cenariogestao", "vm": "cenario-homolog", "assinante": OPERADOR,
            "assinatura": "projects/cenariogestao/subscriptions/cenario-homolog-comandos-vm",
            "bucket": "cenariogestao-homolog-operacoes", "bucket_versoes": "cenariogestao-homolog-runner-versoes",
            "estado": os.path.join(self.d, "estado"), "log_auditoria": os.path.join(self.d, "log/auditoria.jsonl"),
            "arquivo_desativado": os.path.join(self.d, "desativado"),
            "dir_cenario": os.path.join(self.d, "opt/cenario"), "vm_sh": os.path.join(self.d, "opt/cenario/infra/homolog/gcp/vm.sh"),
            "compose_arquivo": os.path.join(self.d, "compose.yml"), "env_arquivo": os.path.join(self.d, "run/env"),
            "estado_cenario": os.path.join(self.d, "var/lib/cenario"), "portao": os.path.join(self.d, "etc/portao"),
            "dropin_etiqueta": os.path.join(self.d, "etc/dropin/10-etiqueta.conf"),
            "arquivos_segredos": [os.path.join(self.d, "run/env")], "systemctl": os.path.join(self.bin, "systemctl"),
            "path": f"{self.bin}:/usr/bin:/bin", "https_host": "127.0.0.1", "https_porta": self.tls.server_address[1],
            "metadata_url": f"{u}/meta", "pubsub_url": f"{u}/pubsub", "storage_url": f"{u}/storage",
            "logging_url": f"{u}/logging", "certs_url": u + "/certs/{email}", "espera_termino": 2,
        }
        self.cfg_arq = os.path.join(self.d, "runner.json")
        self.salvar_cfg()
        self.proc = None

    def salvar_cfg(self):
        escrever(self.cfg_arq, json.dumps(self.cfg))

    def iniciar(self):
        self.saida_runner = open(os.path.join(self.d, "runner.out"), "w")
        self.proc = subprocess.Popen([sys.executable, "-I", RUNNER], env={**os.environ, "CENARIO_RUNNER_CONFIG": self.cfg_arq,
                                     "CENARIO_RUNNER_TESTE": "1"}, stdout=self.saida_runner, stderr=subprocess.STDOUT)
        return self

    def parar(self):
        if self.proc and self.proc.poll() is None:
            self.proc.send_signal(signal.SIGTERM)
            try:
                self.proc.wait(10)
            except subprocess.TimeoutExpired:
                self.proc.kill()
        self.srv.shutdown()
        self.srv.server_close()
        self.tls.shutdown()
        self.tls.server_close()
        if getattr(self, "saida_runner", None):
            self.saida_runner.close()
        shutil.rmtree(self.d, ignore_errors=True)

    # -- envelopes montados diretamente (para testar a validação do runner)
    def claims(self, operacao: str, parametros: dict | None = None, **extra) -> dict:
        t = int(time.time())
        c = {"iss": OPERADOR, "sub": OPERADOR, "aud": "cenario-homolog-runner", "jti": str(uuid.uuid4()), "iat": t, "exp": t + 600,
             "vm": "cenario-homolog", "projeto": "cenariogestao", "operacao": operacao, "parametros": parametros or {},
             "timeout_s": 60, "descricao": "teste"}
        c.update(extra)
        return c

    def publicar_env(self, env) -> str:
        bruto = env if isinstance(env, bytes) else json.dumps(env).encode()
        return self.est.publicar(base64.b64encode(bruto).decode())

    def publicar(self, claims: dict) -> str:
        return self.publicar_env({"v": 2, "jwt": self.est.chave.assinar(json.dumps(claims))})

    def objeto(self, nome: str, bucket: str = "cenariogestao-homolog-operacoes"):
        return self.est.objetos.get((bucket, nome))

    def resultado(self, jti: str, limite: float = 30) -> dict:
        fim = time.time() + limite
        while time.time() < fim:
            r = self.objeto(f"operacoes/{jti}/resultado.json")
            if r is not None:
                return json.loads(r)
            time.sleep(0.1)
        raise AssertionError(f"sem resultado para {jti}; runner: {open(os.path.join(self.d, 'runner.out')).read()[-2000:]}")

    def rejeicao(self, mid: str, limite: float = 20) -> dict:
        fim = time.time() + limite
        while time.time() < fim:
            for (b, n), v in list(self.est.objetos.items()):
                if n.startswith("rejeitados/") and n.endswith(f"-{mid}.json"):
                    return json.loads(v)
            time.sleep(0.1)
        raise AssertionError(f"sem rejeição para a mensagem {mid}")

    def log(self, nome: str) -> str:
        try:
            with open(os.path.join(self.ctrl, nome), encoding="utf-8") as f:
                return f.read()
        except FileNotFoundError:
            return ""

    def operar(self, *args: str, timeout: float = 120) -> subprocess.CompletedProcess:
        u = f"http://127.0.0.1:{self.porta}"
        env = {**os.environ, "CLOUDSDK_AUTH_ACCESS_TOKEN": "marcador-do-proxy", "CENARIO_URL_IAMCREDENTIALS": f"{u}/iam",
               "CENARIO_URL_PUBSUB": f"{u}/pubsub", "CENARIO_URL_STORAGE": f"{u}/storage", "CENARIO_URL_CLOUDBUILD": f"{u}/build"}
        return subprocess.run([sys.executable, "-I", OPERAR, *args], env=env, capture_output=True, text=True, timeout=timeout)


class TestRunner(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.a = Ambiente().iniciar()

    @classmethod
    def tearDownClass(cls):
        cls.a.parar()

    def esperar_ociosidade(self):
        time.sleep(0.3)

    # ------------------------------------------------------------------ caminho feliz (cliente real)
    def test_cliente_status_ponta_a_ponta(self):
        r = self.a.operar("op", "status", "--descricao", "teste ponta a ponta")
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("contêineres ok", r.stdout)
        self.assertIn('"status": "concluido"', r.stderr)
        self.assertRegex(self.a.log("vmsh.log"), r"INICIO status")

    def test_cliente_valida_localmente(self):
        r = self.a.operar("op", "container_logs", "service=nginx")
        self.assertEqual(r.returncode, 2)
        self.assertIn("parâmetro service", r.stderr)
        r = self.a.operar("op", "shell", "comando=id")
        self.assertEqual(r.returncode, 2)
        self.assertIn("operação desconhecida", r.stderr)
        r = self.a.operar("op", "status", "--timeout", "99999")
        self.assertEqual(r.returncode, 2)

    def test_cliente_teste_seguranca(self):
        r = self.a.operar("teste-seguranca", timeout=300)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertIn("SEGURANÇA: OK", r.stderr)

    def test_parametros_exatos_no_docker(self):
        c = self.a.claims("container_logs", {"service": "api", "lines": 50, "since_minutes": 30})
        self.a.publicar(c)
        res = self.a.resultado(c["jti"])
        self.assertEqual(res["status"], "concluido", res)
        self.assertIn("logs --no-color --timestamps --tail 50 --since 30m api", self.a.log("docker.log"))
        self.assertEqual(res["classe"], "READ_ONLY")

    # ------------------------------------------------------------------ recusas do runner (nada executa)
    def recusa(self, env_ou_claims, trecho: str, assinar=True):
        antes = (self.a.log("vmsh.log"), self.a.log("docker.log"))
        mid = self.a.publicar(env_ou_claims) if assinar else self.a.publicar_env(env_ou_claims)
        rej = self.a.rejeicao(mid)
        self.assertIn(trecho, rej["motivo"])
        self.esperar_ociosidade()
        self.assertEqual(antes, (self.a.log("vmsh.log"), self.a.log("docker.log")), "algo foi executado numa recusa")

    def test_recusa_operacao_desconhecida(self):
        self.recusa(self.a.claims("shell", {"command": "id"}), "operação desconhecida")

    def test_recusa_parametro_extra(self):
        self.recusa(self.a.claims("status", {"command": "id"}), "parâmetros inesperados")

    def test_recusa_parametros_invalidos(self):
        self.recusa(self.a.claims("migrate", {"version": "abc;rm -rf /"}), "formato inválido")
        self.recusa(self.a.claims("migrate", {"version": "ABC1234"}), "formato inválido")
        self.recusa(self.a.claims("migrate", {}), "obrigatório ausente")
        self.recusa(self.a.claims("container_logs", {"service": "api --privileged"}), "parâmetro service")
        self.recusa(self.a.claims("container_logs", {"service": "api", "lines": 100000}), "parâmetro lines")
        self.recusa(self.a.claims("container_logs", {"service": "api", "lines": True}), "parâmetro lines")
        self.recusa(self.a.claims("backup_validate", {"folder": "../../etc"}), "formato inválido")
        self.recusa(self.a.claims("backup_validate", {"folder": "cenario-x/../../etc"}), "formato inválido")
        self.recusa(self.a.claims("application_logs", {"unit": "sshd"}), "parâmetro unit")
        self.recusa(self.a.claims("run_homologation_tests", {"suite": "qualquer"}), "parâmetro suite")
        c = self.a.claims("status")
        c["parametros"] = ["status"]
        self.recusa(c, "parametros deve ser objeto")

    def test_recusa_timeout_fora_do_intervalo(self):
        self.recusa(self.a.claims("status", timeout_s=1), "timeout_s fora")
        self.recusa(self.a.claims("status", timeout_s=100000), "timeout_s fora")

    def test_recusa_envelope_com_script(self):
        c = self.a.claims("status")
        self.recusa({"v": 2, "jwt": self.a.est.chave.assinar(json.dumps(c)), "script": "id"}, "campos inesperados", assinar=False)
        self.recusa({"v": 1, "jwt": "x", "script": "id"}, "campos inesperados", assinar=False)

    def test_recusa_claims_invalidas(self):
        self.recusa(self.a.claims("status", aud="outra"), "audiência")
        self.recusa(self.a.claims("status", vm="outra-vm"), "outra VM")
        self.recusa(self.a.claims("status", projeto="verificapro-8d3c8"), "outra VM ou projeto")
        self.recusa(self.a.claims("status", iss="intruso@x.iam.gserviceaccount.com"), "emissor")
        self.recusa(self.a.claims("status", jti="nao-uuid"), "jti inválido")
        t = int(time.time())
        self.recusa(self.a.claims("status", iat=t - 2000, exp=t - 1000), "expirado")
        self.recusa(self.a.claims("status", iat=t + 3600, exp=t + 3900), "futuro")
        self.recusa(self.a.claims("status", iat=t, exp=t + 7200), "validade")
        c = self.a.claims("status")
        c["script"] = "id"
        self.recusa(c, "claims inesperadas")

    def test_recusa_assinatura(self):
        c = self.a.claims("status")
        jwt = self.a.est.chave.assinar(json.dumps(c))
        cab, corpo, sig = jwt.split(".")
        outro = base64.urlsafe_b64encode(json.dumps(dict(c, operacao="restart_containers")).encode()).decode().rstrip("=")
        self.recusa({"v": 2, "jwt": f"{cab}.{outro}.{sig}"}, "assinatura inválida", assinar=False)
        nenhum = base64.urlsafe_b64encode(json.dumps({"alg": "none", "kid": "k1"}).encode()).decode().rstrip("=")
        self.recusa({"v": 2, "jwt": f"{nenhum}.{corpo}."}, "algoritmo", assinar=False)
        forjado = base64.urlsafe_b64encode(json.dumps({"alg": "RS256", "kid": "k2"}).encode()).decode().rstrip("=")
        self.recusa({"v": 2, "jwt": f"{forjado}.{corpo}.{sig}"}, "kid desconhecido", assinar=False)
        self.recusa({"v": 2, "jwt": "a.b"}, "malformado", assinar=False)

    def test_recusa_malformados(self):
        self.recusa(b"isto nao e json", "não é JSON", assinar=False)
        self.recusa(b"x" * 20000, "máximo", assinar=False)
        mid = self.a.est.publicar("@@@ nao base64 @@@")
        self.assertIn("base64", self.a.rejeicao(mid)["motivo"])

    def test_replay(self):
        c = self.a.claims("gate_status")
        env = {"v": 2, "jwt": self.a.est.chave.assinar(json.dumps(c))}
        self.a.publicar_env(env)
        self.assertEqual(self.a.resultado(c["jti"])["status"], "concluido")
        mid = self.a.publicar_env(env)
        self.assertIn("jti já recebido", self.a.rejeicao(mid)["motivo"])
        res = json.loads(self.a.objeto(f"operacoes/{c['jti']}/resultado.json"))
        self.assertEqual(res["status"], "concluido")  # o resultado original não foi sobrescrito

    def test_certificados_indisponiveis_falha_fechado(self):
        self.a.est.falhar_certs = True
        # força releitura: kid novo obriga a buscar os certificados de novo
        c = self.a.claims("gate_status")
        jwt = self.a.est.chave.assinar(json.dumps(c))
        cab = base64.urlsafe_b64encode(json.dumps({"alg": "RS256", "kid": "kx"}).encode()).decode().rstrip("=")
        self.a.publicar_env({"v": 2, "jwt": cab + "." + ".".join(jwt.split(".")[1:])})
        time.sleep(3)
        self.assertIsNone(self.a.objeto(f"operacoes/{c['jti']}/resultado.json"))
        self.a.est.falhar_certs = False

    # ------------------------------------------------------------------ comportamento das operações
    def test_mascara_segredos(self):
        c = self.a.claims("smoke_test", timeout_s=60)
        self.a.publicar(c)
        res = self.a.resultado(c["jti"])
        texto = self.a.objeto(f"operacoes/{c['jti']}/stdout.txt").decode()
        self.assertNotIn(SEGREDO, texto)
        self.assertNotIn("abcdefghijklmnop", texto)
        self.assertIn("«POSTGRES_PASSWORD-mascarado»", texto)
        self.assertNotIn(SEGREDO, json.dumps(res))

    def test_health_e_websocket_pelo_https_local(self):
        for op in ("health", "websocket_test", "network_status"):
            c = self.a.claims(op)
            self.a.publicar(c)
            res = self.a.resultado(c["jti"])
            self.assertEqual(res["status"], "concluido", res)
        self.assertNotIn(TOKEN_PORTAO, self.a.objeto(f"operacoes/{c['jti']}/stdout.txt").decode())

    def test_migration_verify_detecta_pendente(self):
        c = self.a.claims("migration_verify", {"version": "abc1234"})
        self.a.publicar(c)
        res = self.a.resultado(c["jti"])
        self.assertEqual(res["status"], "falhou")
        self.assertIn("20261230000000_modelos_simplificados", self.a.objeto(f"operacoes/{c['jti']}/stdout.txt").decode())

    def test_activate_exige_migrate_e_fixa_etiqueta(self):
        c = self.a.claims("activate_version", {"version": "def5678"})
        self.a.publicar(c)
        res = self.a.resultado(c["jti"])
        self.assertEqual(res["status"], "falhou")
        self.assertIn("rode migrate", res["motivo"])
        escrever(os.path.join(self.a.d, "var/lib/cenario/migrada"), "def5678\n")
        c = self.a.claims("activate_version", {"version": "def5678"})
        self.a.publicar(c)
        res = self.a.resultado(c["jti"])
        self.assertEqual(res["status"], "concluido", res)
        with open(self.a.cfg["dropin_etiqueta"], encoding="utf-8") as f:
            self.assertIn("Environment=CENARIO_TAG=def5678", f.read())
        self.assertIn("INICIO ativar def5678 TAG=def5678", self.a.log("vmsh.log"))
        self.assertIn("daemon-reload", self.a.log("systemctl.log"))
        c = self.a.claims("rollback_version", {"version": "0000000"})
        self.a.publicar(c)
        self.assertIn("nunca foi ativada", self.a.resultado(c["jti"])["motivo"])

    def test_portao(self):
        for op, esperado in (("gate_open", "ABERTO"), ("gate_status", "ABERTO"), ("gate_close", "fechado")):
            c = self.a.claims(op)
            self.a.publicar(c)
            self.a.resultado(c["jti"])
            self.assertIn(esperado, self.a.objeto(f"operacoes/{c['jti']}/stdout.txt").decode())

    def test_falha_de_passo_propaga_codigo(self):
        open(os.path.join(self.a.ctrl, "falhar-backup"), "w").close()
        try:
            c = self.a.claims("backup_create")
            self.a.publicar(c)
            res = self.a.resultado(c["jti"])
            self.assertEqual((res["status"], res["exit_code"]), ("falhou", 3))
        finally:
            os.remove(os.path.join(self.a.ctrl, "falhar-backup"))

    def test_timeout_mata_o_grupo_de_processos(self):
        escrever(os.path.join(self.a.ctrl, "dormir-recuperar"), "60")
        try:
            escrever(os.path.join(self.a.d, "var/lib/cenario/ponto-recuperacao"), "PASTA=cenario-x\nETIQUETA=abc1234\n")
            c = self.a.claims("rollback_to_recovery_point", timeout_s=5)
            self.a.publicar(c)
            res = self.a.resultado(c["jti"], 40)
            self.assertEqual(res["status"], "tempo_esgotado")
            with open(os.path.join(self.a.ctrl, "pid-recuperar")) as f:
                pid = int(f.read())
            time.sleep(0.5)
            with self.assertRaises(ProcessLookupError):
                os.kill(pid, 0)
        finally:
            os.remove(os.path.join(self.a.ctrl, "dormir-recuperar"))

    def test_saida_limitada(self):
        open(os.path.join(self.a.ctrl, "grande"), "w").close()
        try:
            c = self.a.claims("status")
            self.a.publicar(c)
            res = self.a.resultado(c["jti"], 60)
            self.assertTrue(res["truncado"]["stdout"])
            self.assertLessEqual(len(self.a.objeto(f"operacoes/{c['jti']}/stdout.txt")), 10 * 1024 * 1024 + 1024)
        finally:
            os.remove(os.path.join(self.a.ctrl, "grande"))

    def test_exclusao_mutua(self):
        escrever(os.path.join(self.a.ctrl, "dormir-restart"), "1.5")
        try:
            c1, c2 = self.a.claims("restart_containers"), self.a.claims("restart_containers")
            self.a.publicar(c1)
            self.a.publicar(c2)
            self.a.resultado(c1["jti"])
            self.a.resultado(c2["jti"])
        finally:
            os.remove(os.path.join(self.a.ctrl, "dormir-restart"))
        tempos = [float(l.split()[0]) for l in self.a.log("restart.log").split("\n") if l][-4:]
        self.assertLessEqual(tempos[1], tempos[2] + 0.01, f"DESTRUCTIVE em paralelo: {tempos}")
        # leituras em paralelo, e nunca junto com MUTATING
        escrever(os.path.join(self.a.ctrl, "dormir-status"), "1.5")
        escrever(os.path.join(self.a.ctrl, "dormir-backup"), "1.5")
        try:
            r1, r2, m = self.a.claims("status"), self.a.claims("status"), self.a.claims("backup_create")
            for c in (r1, r2, m):
                self.a.publicar(c)
            res = [self.a.resultado(c["jti"]) for c in (r1, r2, m)]
        finally:
            os.remove(os.path.join(self.a.ctrl, "dormir-status"))
            os.remove(os.path.join(self.a.ctrl, "dormir-backup"))
        ini = {x["jti"]: x for x in res}
        p = lambda r: (time.mktime(time.strptime(r["inicio"][:19], "%Y-%m-%dT%H:%M:%S")), time.mktime(time.strptime(r["fim"][:19], "%Y-%m-%dT%H:%M:%S")))
        (a0, a1), (b0, b1), (m0, m1) = p(ini[r1["jti"]]), p(ini[r2["jti"]]), p(ini[m["jti"]])
        self.assertTrue(m0 >= max(a1, b1) - 1, "MUTATING junto com leitura")

    def test_desligamento_de_emergencia(self):
        open(self.a.cfg["arquivo_desativado"], "w").close()
        try:
            time.sleep(6)  # o ciclo em andamento termina
            c = self.a.claims("gate_status")
            self.a.publicar(c)
            time.sleep(4)
            self.assertIsNone(self.a.objeto(f"operacoes/{c['jti']}/resultado.json"))
        finally:
            os.remove(self.a.cfg["arquivo_desativado"])
        self.assertEqual(self.a.resultado(c["jti"], 30)["status"], "concluido")

    def test_auditoria_local(self):
        with open(self.a.cfg["log_auditoria"], encoding="utf-8") as f:
            eventos = [json.loads(l) for l in f]
        self.assertTrue(any(e["evento"] == "partida" for e in eventos))
        self.assertTrue(all("ts" in e and "evento" in e for e in eventos))
        self.assertNotIn(SEGREDO, json.dumps(eventos))
        self.assertEqual(oct(os.stat(self.a.cfg["log_auditoria"]).st_mode & 0o777), "0o600")


class TestBuildPeloGatilho(unittest.TestCase):
    """O cliente não cria builds: envia a fonte e publica o pedido ao gatilho (que tem a conta e os passos)."""

    @classmethod
    def setUpClass(cls):
        cls.a = Ambiente()
        cls.sha = subprocess.run(["git", "-C", BASE, "rev-parse", "HEAD"], capture_output=True, text=True).stdout.strip()

    @classmethod
    def tearDownClass(cls):
        cls.a.parar()

    def test_pedido_ao_gatilho(self):
        curto = self.sha[:12]
        r = self.a.operar("build-iniciar", curto, timeout=300)
        self.assertEqual(r.returncode, 0, r.stderr)
        pedido = json.loads(r.stdout)
        self.assertEqual(pedido["conta"], "cenario-build@cenariogestao.iam.gserviceaccount.com")
        nome = f"source/{self.sha}.tgz"
        fonte = self.a.objeto(nome, "cenariogestao-homolog-build")
        self.assertIsNotNone(fonte)
        with tarfile.open(fileobj=io.BytesIO(fonte), mode="r:gz") as t:
            self.assertIn("infra/homolog/Dockerfile", t.getnames())
        msg = [m for m in self.a.est.publicados if m["topico"].endswith("/topics/cenario-homolog-build")][-1]
        self.assertEqual(msg["attributes"], {"tag": curto, "fonte": nome})
        # o mesmo commit de novo: a fonte já existe (412) e o pedido sai normalmente
        self.assertEqual(self.a.operar("build-iniciar", curto, timeout=300).returncode, 0)

    def test_recusa_gatilho_com_outra_conta(self):
        antes = len(self.a.est.publicados)
        self.a.est.gatilho = dict(self.a.est.gatilho, serviceAccount="projects/cenariogestao/serviceAccounts/123-compute@developer.gserviceaccount.com")
        try:
            r = self.a.operar("build-iniciar", self.sha[:12], timeout=120)
        finally:
            self.a.est.gatilho = dict(self.a.est.gatilho, serviceAccount="projects/cenariogestao/serviceAccounts/cenario-build@cenariogestao.iam.gserviceaccount.com")
        self.assertEqual(r.returncode, 1)
        self.assertIn("pedido NÃO enviado", r.stderr)
        self.assertEqual(len(self.a.est.publicados), antes)

    def test_sha_invalido(self):
        self.assertEqual(self.a.operar("build-iniciar", "nao-e-sha").returncode, 2)


class TestUpdateRunner(unittest.TestCase):
    def setUp(self):
        self.a = Ambiente().iniciar()

    def tearDown(self):
        self.a.parar()

    def pacote(self, versao: str, extra: bool = False) -> bytes:
        arquivos = {"VERSAO": versao + "\n", "cenario-runner.service": "[Unit]\n", "cenario_runner.py": "print('x')\n",
                    "instalar.sh": f"#!/bin/bash\necho \"instalado $1 $CENARIO_RUNNER_ADIAR_REINICIO\" > {self.a.ctrl}/instalado\n"}
        if extra:
            arquivos["../../etc/passwd"] = "x"
        buf = io.BytesIO()
        with tarfile.open(fileobj=buf, mode="w:gz") as t:
            for nome, conteudo in arquivos.items():
                dados = conteudo.encode()
                info = tarfile.TarInfo(nome)
                info.size = len(dados)
                t.addfile(info, io.BytesIO(dados))
        return buf.getvalue()

    def publicar_versao(self, versao: str, pacote: bytes, sha: str | None = None):
        b = "cenariogestao-homolog-runner-versoes"
        self.a.est.objetos[(b, f"runner-{versao}.tar.gz")] = pacote
        self.a.est.objetos[(b, f"runner-{versao}.sha256")] = (sha or hashlib.sha256(pacote).hexdigest()).encode()

    def test_instala_versao_publicada(self):
        self.publicar_versao("9.9.9", self.pacote("9.9.9"))
        c = self.a.claims("update_runner", {"version": "9.9.9"})
        self.a.publicar(c)
        res = self.a.resultado(c["jti"])
        self.assertEqual(res["status"], "concluido", res)
        self.assertIn("1", self.a.log("instalado"))

    def test_recusa_sha_divergente(self):
        self.publicar_versao("9.9.8", self.pacote("9.9.8"), sha="0" * 64)
        c = self.a.claims("update_runner", {"version": "9.9.8"})
        self.a.publicar(c)
        self.assertIn("SHA-256", self.a.resultado(c["jti"])["motivo"])
        self.assertEqual(self.a.log("instalado"), "")

    def test_recusa_pacote_com_caminho(self):
        self.publicar_versao("9.9.7", self.pacote("9.9.7", extra=True))
        c = self.a.claims("update_runner", {"version": "9.9.7"})
        self.a.publicar(c)
        self.assertIn("conteúdo inesperado", self.a.resultado(c["jti"])["motivo"])
        self.assertEqual(self.a.log("instalado"), "")

    def test_versao_inexistente(self):
        c = self.a.claims("update_runner", {"version": "1.2.3"})
        self.a.publicar(c)
        self.assertEqual(self.a.resultado(c["jti"])["status"], "falhou")


REPO = "us-east1-docker.pkg.dev/cenariogestao/cenario-homolog"


def imagem_json(servico: str, tag: str, ident: str, criada: str, tamanho: str = "3.7GB") -> str:
    return json.dumps({"Repository": f"{REPO}/{servico}", "Tag": tag, "ID": f"sha256:{ident * 8}"[:71], "Digest": f"sha256:d{ident}",
                       "CreatedAt": criada, "Size": tamanho}, separators=(",", ":"))


class TestLimpezaDeImagens(unittest.TestCase):
    """P1: só imagens da aplicação, sem contêiner e fora das versões protegidas; nunca prune/--force."""

    def setUp(self):
        self.a = Ambiente().iniciar()  # versão ativa (ambiente da pilha): abc1234
        linhas = []
        for tag, ident, criada in (("1111111", "a1", "2026-10-01 10:00:00 +0000 UTC"), ("2222222", "a2", "2026-10-02 10:00:00 +0000 UTC"),
                                   ("4444444", "a4", "2026-10-03 10:00:00 +0000 UTC"), ("3333333", "a3", "2026-10-04 10:00:00 +0000 UTC"),
                                   ("5555555", "a5", "2026-09-01 10:00:00 +0000 UTC"), ("abc1234", "ab", "2026-10-05 10:00:00 +0000 UTC")):
            for serv, sufixo in (("api", "0"), ("web", "1")):
                linhas.append(imagem_json(serv, tag, ident + sufixo, criada))
        linhas.append(imagem_json("api", "6666666", "ab0", "2026-10-05 10:00:00 +0000 UTC"))  # mesmo ID da ativa
        linhas.append(imagem_json("api", "latest", "c90", "2026-10-05 10:00:00 +0000 UTC"))   # etiqueta não-SHA
        linhas.append(imagem_json("api", "<none>", "c91", "2026-10-05 10:00:00 +0000 UTC"))
        for repo, tag, ident in (("postgres", "16", "p1"), ("caddy", "2.10-alpine", "c1"), ("postgres", "16-alpine", "p2")):
            linhas.append(json.dumps({"Repository": repo, "Tag": tag, "ID": f"sha256:{ident * 8}"[:71], "Digest": "", "CreatedAt": "2026-01-01",
                                      "Size": "400MB"}, separators=(",", ":")))
        escrever(os.path.join(self.a.ctrl, "imagens.jsonl"), "\n".join(linhas) + "\n")
        escrever(os.path.join(self.a.ctrl, "conteineres"), "c-api\nc-web\nc-pg\nc-parado\n")
        uso = [f"sha256:{'ab0' * 8}"[:71], f"sha256:{'ab1' * 8}"[:71], f"sha256:{'p2' * 8}"[:71], f"sha256:{'a50' * 8}"[:71]]
        escrever(os.path.join(self.a.ctrl, "imagens-em-uso"), "\n".join(uso) + "\n")  # 5555555/api: contêiner parado
        escrever(os.path.join(self.a.cfg["estado_cenario"], "ponto-recuperacao"), "PASTA=cenario-x\nETIQUETA=4444444\n")

    def tearDown(self):
        self.a.parar()

    def rodar(self, op: str) -> dict:
        c = self.a.claims(op)
        self.a.publicar(c)
        return self.a.resultado(c["jti"])

    def saida(self, res: dict) -> str:
        return (self.a.objeto(f"operacoes/{res['jti']}/stdout.txt") or b"").decode()

    def removidas(self) -> list[str]:
        return [l.split("image rm ", 1)[1] for l in self.a.log("docker.log").splitlines() if l.startswith("image rm ")]

    def test_plano_nao_remove_nada(self):
        res = self.rodar("images_cleanup_plan")
        self.assertEqual(res["status"], "concluido", res)
        out = self.saida(res)
        self.assertIn("• candidatas à remoção: 4", out)
        for tag in ("1111111", "2222222"):
            self.assertIn(f"✘ remover  {REPO}/api:{tag}", out)
        self.assertEqual(self.removidas(), [])

    def test_remove_so_candidatas_e_e_idempotente(self):
        res = self.rodar("images_cleanup")
        self.assertEqual(res["status"], "concluido", res)
        esperado = sorted(f"{REPO}/{s}:{t}" for t in ("1111111", "2222222") for s in ("api", "web"))
        self.assertEqual(sorted(self.removidas()), sorted(esperado))
        out = self.saida(res)
        self.assertIn("PROTEGIDA (versão ativa)", out)
        self.assertIn("PROTEGIDA (versão do ponto de recuperação)", out)          # 4444444
        self.assertIn("PROTEGIDA (mais recente além da ativa (rollback))", out)   # 3333333
        self.assertIn("5555555 (em uso por contêiner)", out)                     # api em contêiner parado: api e web ficam
        self.assertRegex(out, r"✔ manter   \S+/api:6666666 .*PROTEGIDA")             # 6666666 = apelido da ativa
        self.assertIn("3333333 (mais recente além da ativa (rollback))", out)     # não o apelido 6666666
        self.assertIn("fora do repositório da aplicação: nunca removida", out)    # postgres, caddy, latest, <none>
        self.assertRegex(out, r"recuperado -?[0-9.]+ GiB · removidas 4/4")
        # segunda vez: nada a remover
        res2 = self.rodar("images_cleanup")
        self.assertEqual(res2["status"], "concluido", res2)
        self.assertIn("✔ nada a remover (idempotente)", self.saida(res2))
        self.assertEqual(len(self.removidas()), 4)

    def test_nunca_prune_force_volume_ou_conteiner(self):
        self.rodar("images_cleanup")
        log = self.a.log("docker.log")
        for proibido in ("prune", "--force", " -f ", "volume", "container rm", "rm -f", "rmi"):
            self.assertNotIn(proibido, log)
        for l in log.splitlines():
            if l.startswith("image rm "):
                self.assertRegex(l, r"^image rm us-east1-docker\.pkg\.dev/cenariogestao/cenario-homolog/(api|web):[0-9a-f]{7,40}$")

    def test_protege_candidata_migrada_e_ativacao_anterior(self):
        escrever(os.path.join(self.a.cfg["estado_cenario"], "candidata"), "1111111\n")
        escrever(os.path.join(self.a.cfg["estado"], "ativacoes.jsonl"),
                 json.dumps({"versao": "2222222"}) + "\n" + json.dumps({"versao": "abc1234"}) + "\n")
        res = self.rodar("images_cleanup")
        self.assertEqual(res["status"], "concluido", res)
        self.assertEqual(self.removidas(), [])
        out = self.saida(res)
        self.assertIn("1111111 (candidata)", out)
        self.assertIn("2222222 (ativada antes da atual (rollback))", out)

    def test_ativa_desconhecida_nada_removido(self):
        escrever(os.path.join(self.a.d, "run/env"), f"POSTGRES_PASSWORD='{SEGREDO}'\n", 0o600)
        res = self.rodar("images_cleanup")
        self.assertEqual(res["status"], "falhou")
        self.assertIn("versão ativa desconhecida", res["motivo"])
        self.assertEqual(self.removidas(), [])

    def test_recusa_do_docker_falha_sem_forcar(self):
        open(os.path.join(self.a.ctrl, "recusar-rm"), "w").close()
        res = self.rodar("images_cleanup")
        self.assertEqual(res["status"], "falhou")
        self.assertIn("recusada", res["motivo"])
        self.assertNotIn("--force", self.a.log("docker.log"))


def pacote_scripts_git(commit: str) -> bytes:
    raiz = os.path.abspath(os.path.join(BASE, "..", "..", "..", ".."))
    tar = subprocess.run(["git", "-C", raiz, "archive", "--format=tar", commit, "infra/homolog", "scripts/backup.sh",
                          "scripts/restore.sh"], check=True, capture_output=True).stdout
    return subprocess.run(["gzip", "-n"], input=tar, check=True, capture_output=True).stdout


def pacote_scripts_manual(commit: str, membros: dict) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz", format=tarfile.PAX_FORMAT, pax_headers={"comment": commit}) as t:
        for nome, conteudo in membros.items():
            info = tarfile.TarInfo(nome)
            if conteudo is None:
                info.type, info.linkname = tarfile.SYMTYPE, "/etc/passwd"
                t.addfile(info)
                continue
            dados = conteudo.encode()
            info.size, info.mode = len(dados), 0o755 if nome.endswith(".sh") else 0o644
            t.addfile(info, io.BytesIO(dados))
    return buf.getvalue()


class TestScriptsDaVm(unittest.TestCase):
    """P2: só pacotes publicados (bucket de versões, gravação humana), conferidos; cópia anterior; restauração."""

    @classmethod
    def setUpClass(cls):
        raiz = os.path.abspath(os.path.join(BASE, "..", "..", "..", ".."))
        cls.commit = subprocess.run(["git", "-C", raiz, "rev-parse", "HEAD"], check=True, capture_output=True, text=True).stdout.strip()
        cls.v = cls.commit[:12]
        cls.pacote = pacote_scripts_git(cls.commit)

    def setUp(self):
        self.a = Ambiente().iniciar()
        self.base = self.a.cfg["dir_cenario"]
        escrever(os.path.join(self.base, "VERSAO"), "9f2930028b2b\n")
        escrever(os.path.join(self.base, "infra/homolog/local.conf"), "configuração local\n")
        with open(os.path.join(self.base, "infra/homolog/gcp/vm.sh"), "rb") as f:
            self.vm_falso = f.read()

    def tearDown(self):
        self.a.parar()

    def publicar(self, v: str, pacote: bytes, sha: str | None = None):
        b = "cenariogestao-homolog-runner-versoes"
        self.a.est.objetos[(b, f"scripts-{v}.tar.gz")] = pacote
        self.a.est.objetos[(b, f"scripts-{v}.sha256")] = (sha or hashlib.sha256(pacote).hexdigest()).encode()

    def rodar(self, op: str, **p) -> tuple[dict, str]:
        c = self.a.claims(op, p)
        c["timeout_s"] = 120
        self.a.publicar(c)
        res = self.a.resultado(c["jti"], limite=60)
        return res, (self.a.objeto(f"operacoes/{c['jti']}/stdout.txt") or b"").decode()

    def vm_sh_atual(self) -> bytes:
        with open(os.path.join(self.base, "infra/homolog/gcp/vm.sh"), "rb") as f:
            return f.read()

    def test_diff_nao_altera_nada(self):
        self.publicar(self.v, self.pacote)
        res, out = self.rodar("vm_scripts_diff", version=self.v)
        self.assertEqual(res["status"], "concluido", res)
        self.assertIn(f"commit {self.commit}", out)
        self.assertIn("• /opt/cenario atual: 9f2930028b2b", out)
        self.assertIn("== vm.sh: 1 mudança(s)", out)
        self.assertIn("~ alterado  infra/homolog/gcp/vm.sh", out)
        self.assertIn("diff infra/homolog/gcp/vm.sh", out)
        self.assertIn("+ novo      infra/homolog/docker-compose.homolog.yml", out)
        self.assertIn("= infra/homolog/local.conf", out)
        self.assertEqual(self.vm_sh_atual(), self.vm_falso)

    def test_atualiza_preserva_locais_e_restaura(self):
        self.publicar(self.v, self.pacote)
        res, out = self.rodar("vm_scripts_update", version=self.v)
        self.assertEqual(res["status"], "concluido", res)
        self.assertNotEqual(self.vm_sh_atual(), self.vm_falso)
        self.assertTrue(os.access(os.path.join(self.base, "infra/homolog/gcp/vm.sh"), os.X_OK))
        with open(os.path.join(self.base, "VERSAO")) as f:
            self.assertEqual(f.read().strip(), self.v)
        self.assertTrue(os.path.exists(os.path.join(self.base, "infra/homolog/local.conf")))
        copias = [n for n in os.listdir(os.path.dirname(self.base)) if n.startswith("cenario.anterior-")]
        self.assertEqual(len(copias), 1)
        log = self.a.log("docker.log")
        self.assertIn("compose -f", log)
        self.assertIn("config -q", log)
        self.assertRegex(log, r"run --rm --network none -v \S+Caddyfile\.homolog:/etc/caddy/Caddyfile:ro -e HOMOLOG_DOMAIN")
        self.assertNotIn(TOKEN_PORTAO, log)  # segredos só por variável de ambiente, nunca nos argumentos
        # O Caddyfile montado no contêiner de validação fica no diretório de estado, não no /tmp
        # (PrivateTmp do serviço: o daemon do Docker não enxerga o /tmp privado).
        montado = re.search(r"-v (\S+)/infra/homolog/Caddyfile\.homolog:/etc/caddy/Caddyfile:ro", log).group(1)
        self.assertTrue(montado.startswith(self.a.cfg["estado"] + "/validacao-scripts-"), montado)
        self.assertFalse([n for n in os.listdir(self.a.cfg["estado"]) if n.startswith("validacao-scripts-")])  # removido
        self.assertIn("Nada foi reiniciado", out)
        self.assertNotIn("vm.sh", self.a.log("vmsh.log"))  # nenhum comando do vm.sh foi executado
        # restauração
        res, out = self.rodar("vm_scripts_restore")
        self.assertEqual(res["status"], "concluido", res)
        self.assertEqual(self.vm_sh_atual(), self.vm_falso)
        with open(os.path.join(self.base, "VERSAO")) as f:
            self.assertEqual(f.read().strip(), "9f2930028b2b")
        res, _ = self.rodar("vm_scripts_restore")
        self.assertEqual(res["status"], "falhou")  # só uma vez por atualização

    def test_recusa_sha_divergente(self):
        self.publicar(self.v, self.pacote, sha="0" * 64)
        res, _ = self.rodar("vm_scripts_update", version=self.v)
        self.assertIn("SHA-256", res["motivo"])
        self.assertEqual(self.vm_sh_atual(), self.vm_falso)

    def test_recusa_pacote_de_outro_commit(self):
        outro = "1234567890ab"
        self.publicar(outro, self.pacote)  # conteúdo íntegro, mas é o git archive de OUTRO commit
        res, _ = self.rodar("vm_scripts_update", version=outro)
        self.assertIn("não é o git archive do commit pedido", res["motivo"])
        self.assertEqual(self.vm_sh_atual(), self.vm_falso)

    def test_recusa_caminhos_e_links(self):
        base = {o: "x\n" for o in ("infra/homolog/gcp/vm.sh", "infra/homolog/docker-compose.homolog.yml",
                                   "infra/homolog/Caddyfile.homolog", "scripts/backup.sh", "scripts/restore.sh")}
        for i, (extra, trecho) in enumerate(((("etc/cron.d/x", "y"), "caminho não permitido"),
                                             (("infra/homolog/../../etc/passwd", "y"), "caminho não permitido"),
                                             (("/infra/homolog/x.sh", "y"), "caminho não permitido"),
                                             (("scripts/outro.sh", "y"), "caminho não permitido"),
                                             (("infra", "y"), "arquivo no lugar de diretório"),
                                             (("infra/homolog/gcp/link.sh", None), "link ou arquivo especial"))):
            commit = f"{i:x}" * 40
            v = commit[:12]
            self.publicar(v, pacote_scripts_manual(commit, {**base, extra[0]: extra[1]}))
            res, _ = self.rodar("vm_scripts_update", version=v)
            self.assertEqual(res["status"], "falhou", extra)
            self.assertIn(trecho, res["motivo"], extra)
        self.assertEqual(self.vm_sh_atual(), self.vm_falso)

    def test_recusa_sem_obrigatorios(self):
        commit = "c" * 40
        self.publicar(commit[:12], pacote_scripts_manual(commit, {"infra/homolog/gcp/vm.sh": "x\n"}))
        res, _ = self.rodar("vm_scripts_update", version=commit[:12])
        self.assertIn("sem arquivos obrigatórios", res["motivo"])

    def test_caddyfile_invalido_nada_muda(self):
        open(os.path.join(self.a.ctrl, "caddy-invalido"), "w").close()
        self.publicar(self.v, self.pacote)
        res, _ = self.rodar("vm_scripts_update", version=self.v)
        self.assertEqual(res["status"], "falhou")
        self.assertEqual(self.vm_sh_atual(), self.vm_falso)
        self.assertFalse([n for n in os.listdir(os.path.dirname(self.base)) if n.startswith("cenario.anterior-")])

    def test_versao_nao_publicada(self):
        res, _ = self.rodar("vm_scripts_update", version="abcdef123456")
        self.assertEqual(res["status"], "falhou")
        self.assertIn("HTTP 404", res["motivo"])

    def test_apply_stack_config_mantem_a_versao_ativa(self):
        res, out = self.rodar("apply_stack_config")
        self.assertEqual(res["status"], "concluido", res)
        log = self.a.log("vmsh.log")
        self.assertRegex(log, r"INICIO aplicar-config  TAG=abc1234[\s\S]*INICIO ativar abc1234 TAG=abc1234")
        self.assertNotIn("migrar", log)
        self.assertIn("versão ativa mantida: abc1234", out)


class TestPartida(unittest.TestCase):
    def test_vm_errada_nao_inicia(self):
        a = Ambiente(vm="outra-vm").iniciar()
        try:
            self.assertEqual(a.proc.wait(20), 78)
        finally:
            a.parar()

    def test_job_interrompido_nao_e_reexecutado(self):
        a = Ambiente()
        jti = str(uuid.uuid4())
        d = os.path.join(a.cfg["estado"], "jobs", jti)
        os.makedirs(d)
        escrever(os.path.join(d, "envelope.json"), json.dumps({"claims": {"operacao": "restart_containers", "parametros": {}}, "classe": "DESTRUCTIVE"}))
        open(os.path.join(d, "executando"), "w").close()
        a.iniciar()
        try:
            res = a.resultado(jti)
            self.assertEqual(res["status"], "interrompido")
            self.assertEqual(a.log("docker.log"), "")
            # e o jti continua reservado: um envelope novo com o mesmo jti é recusado
            mid = a.publicar(a.claims("restart_containers", jti=jti))
            self.assertIn("jti já recebido", a.rejeicao(mid)["motivo"])
        finally:
            a.parar()


class TestSemExecucaoArbitraria(unittest.TestCase):
    """Análise estática: nenhum caminho de shell/SQL/código vindo do cliente."""

    def fontes(self):
        with open(RUNNER, encoding="utf-8") as f:
            runner = f.read()
        with open(OPERAR, encoding="utf-8") as f:
            cliente = f.read()
        return runner, cliente

    def test_sem_shell(self):
        runner, cliente = self.fontes()
        for fonte in (runner, cliente):
            self.assertNotRegex(fonte, r"shell\s*=\s*True")
            self.assertNotRegex(fonte, r"os\.(system|popen|exec[lv]p?e?)\(")
            self.assertNotRegex(fonte, r"\b(eval|exec)\(")
            self.assertNotRegex(fonte, r"[\"'](ba)?sh[\"']\s*,\s*[\"']-c[\"']")
            self.assertNotIn("pickle", fonte)
        self.assertNotIn('"script"', runner.replace('"script": "id"', ""))

    def test_cliente_nao_cria_builds(self):
        _, cliente = self.fontes()
        self.assertNotIn("builds submit", cliente.replace("gcloud builds submit", "X"))
        self.assertNotIn('"builds", "submit"', cliente)
        self.assertNotIn("--service-account", cliente)
        self.assertNotRegex(cliente, r'/builds"?\s*,\s*\{')  # nenhum POST de criação de build
        self.assertNotIn(":run", cliente)  # nem execução manual de gatilho
        self.assertIn('TOPICO_BUILD = f"projects/{PROJETO}/topics/cenario-homolog-build"', cliente)
        self.assertIn('BUILD_SA = f"cenario-build@{PROJETO}.iam.gserviceaccount.com"', cliente)
        self.assertNotIn("CENARIO_BUILD_SA", cliente)

    def test_config_do_gatilho(self):
        with open(os.path.join(BASE, "cloudbuild-autonomo.json"), encoding="utf-8") as f:
            cfg = json.load(f)
        self.assertNotIn("serviceAccount", cfg)  # a conta é a do gatilho (cenario-build)
        self.assertEqual(cfg["options"]["logging"], "CLOUD_LOGGING_ONLY")
        script = cfg["steps"][0]["args"][1]
        self.assertNotIn("${_", script)  # parâmetros do pedido entram só por variável de ambiente, nunca no texto do script
        self.assertEqual(cfg["steps"][0]["env"], ["TAG=${_TAG}", "FONTE=${_FONTE}", "BUCKET=${_BUCKET}"])
        for passo in cfg["steps"][1:]:
            self.assertEqual(passo["name"], "gcr.io/cloud-builders/docker")
            self.assertNotIn("entrypoint", passo)

    def test_limpeza_sem_prune_nem_forca(self):
        runner, _ = self.fontes()
        self.assertNotIn("prune", runner)
        self.assertNotIn('"--force"', runner)
        self.assertNotIn('"-f"', runner.replace('"compose", "-f"', ""))
        self.assertNotIn('"rmi"', runner)
        self.assertNotIn('"volume"', runner)
        self.assertEqual(len(re.findall(r'\["docker", "image", "rm"', runner)), 1)

    def test_sql_so_constante(self):
        runner, _ = self.fontes()
        self.assertIn("if sql not in (SQL_MIGRACOES, SQL_BANCO, SQL_CONTAGENS):", runner)
        self.assertEqual(len(re.findall(r'"-c", sql', runner)), 1)
        for nome in ("SQL_MIGRACOES", "SQL_BANCO", "SQL_CONTAGENS"):
            m = re.search(nome + r' = \((.*?)\)\n|' + nome + r' = (".*?")\n', runner, re.S)
            self.assertIsNotNone(m)
            self.assertNotIn("{", (m.group(1) or m.group(2)))  # sem formatação/interpolação

    def test_todo_parametro_tem_schema_restrito(self):
        sys.path.insert(0, os.path.join(BASE, "runner"))
        import importlib
        mod = importlib.import_module("cenario_runner")
        for nome, op in mod.OPERACOES.items():
            self.assertIn(op.classe, ("READ_ONLY", "MUTATING", "DESTRUCTIVE"), nome)
            self.assertTrue(hasattr(mod.Runner, "op_" + op.executar), nome)
            self.assertTrue(op.timeout_min <= op.timeout_padrao <= op.timeout_max, nome)
            for pn, p in op.params.items():
                self.assertIn(p.tipo, ("sha", "pasta", "versao_runner", "inteiro", "escolha", "unidade"), f"{nome}.{pn}")
                if p.tipo == "inteiro":
                    self.assertLess(p.maximo, 10**6)
                if p.tipo == "escolha":
                    self.assertTrue(p.opcoes)
        # nenhuma operação aceita texto livre, comando, caminho, SQL ou script
        todos = {pn for op in mod.OPERACOES.values() for pn in op.params}
        self.assertFalse(todos & {"command", "comando", "script", "sql", "path", "caminho", "args", "argv", "query"})


if __name__ == "__main__":
    unittest.main()
