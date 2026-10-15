#!/usr/bin/env python3
"""Executor de OPERAÇÕES NOMEADAS da homologação (VM cenario-homolog), alimentado por Pub/Sub.

Não existe execução de script, shell, SQL ou executável enviado pelo cliente. O cliente pede uma
operação da tabela OPERACOES (abaixo) com parâmetros validados por schema estrito; cada operação é
uma sequência fixa de comandos (listas de argumentos, sem shell) que, sempre que possível, chama os
scripts auditados do projeto (vm.sh). Parâmetros só entram em posições previstas, depois de
validados por expressão regular, intervalo ou allowlist. Nenhum caminho vem do cliente.

Antes de qualquer execução, o envelope inteiro é validado e tudo falha fechado:
  * autenticação: JWT RS256 assinado pelo Google para claude-operador (iamcredentials signJwt),
    conferido com os certificados públicos dessa conta; emissor, audiência, VM, projeto, validade
    (≤ 15 min), operação e parâmetros precisam estar no JWT assinado;
  * só nesta VM e projeto (servidor de metadados);
  * anti-replay: jti (UUID v4) reservado atomicamente no disco antes da execução; nunca roda duas
    vezes, nem depois de reiniciar; jobs interrompidos por queda viram "interrompido" (sem repetir);
  * classes READ_ONLY (até 2 em paralelo), MUTATING e DESTRUCTIVE (sempre sozinhas, FIFO);
  * timeout por operação (mínimo/máximo), limites de envelope e de saída, máscara de segredos,
    resultado imutável no bucket (só criação), log local e Cloud Logging;
  * desligamento de emergência: /etc/cenario/runner-desativado → nada é lido da fila.

Novas operações: acrescentar à tabela, revisar, testar e publicar uma nova versão do runner
(o bucket de versões só aceita gravação humana; update_runner instala só de lá, com SHA-256).
Os scripts administrativos da VM (/opt/cenario) seguem a mesma regra: vm_scripts_update só instala um
pacote scripts-<commit>.tar.gz publicado por humano nesse bucket, conferido por SHA-256 e pelo commit.
Somente biblioteca padrão do Python 3.11+ e os binários do sistema (openssl, docker, journalctl…).
"""
from __future__ import annotations

import base64
import collections
import dataclasses
import datetime as dt
import difflib
import hashlib
import io
import json
import os
import re
import shutil
import signal
import socket
import ssl
import subprocess
import sys
import tarfile
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Callable

VERSAO = "2.1.0"
CONFIG_PADRAO = "/etc/cenario/runner.json"
LIMITE_MENSAGEM = 16 * 1024
LIMITE_SAIDA = 10 * 1024 * 1024
LIMITE_CAUDA = 4096
VALIDADE_MAX = 900
TOLERANCIA_RELOGIO = 120
SAIDA_CONFIG = 78

READ_ONLY, MUTATING, DESTRUCTIVE = "READ_ONLY", "MUTATING", "DESTRUCTIVE"
CLAIMS = {"iss", "sub", "aud", "jti", "iat", "exp", "vm", "projeto", "operacao", "parametros", "timeout_s", "descricao"}
RE_UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
RE_KID = re.compile(r"^[A-Za-z0-9_-]{1,128}$")
RE_SHA = re.compile(r"^[0-9a-f]{7,40}$")
RE_PASTA = re.compile(r"^cenario-[A-Za-z0-9._-]{1,100}$")
RE_VERSAO_RUNNER = re.compile(r"^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$")
# Pacote de scripts da VM: só estes caminhos (git archive de infra/homolog + scripts de backup).
RE_MEMBRO_SCRIPTS = re.compile(r"^(infra|infra/homolog(/[A-Za-z0-9_.-]+)*|scripts(/(backup|restore)\.sh)?)/?$")
DIRETORIOS_SCRIPTS = ("infra", "infra/homolog", "scripts")  # só podem ser diretórios
SCRIPTS_OBRIGATORIOS = ("infra/homolog/gcp/vm.sh", "infra/homolog/docker-compose.homolog.yml",
                        "infra/homolog/Caddyfile.homolog", "scripts/backup.sh", "scripts/restore.sh")
LIMITE_PACOTE_SCRIPTS = 30 * 1024 * 1024
IMAGEM_CADDY = "caddy:2.10-alpine"
VARS_CADDY = ("HOMOLOG_DOMAIN", "HOMOLOG_BASIC_USER", "HOMOLOG_BASIC_HASH", "HOMOLOG_GATE_TOKEN")
SERVICOS = ("postgres", "api", "web", "caddy", "backup")
UNIDADES = ("cenario-homolog", "cenario-backup-upload", "cenario-runner", "docker")
SUITES = ("saude", "acesso", "websocket", "completo")
BANCO = "cenario_homolog"

PADROES_SEGREDO = [
    (re.compile(r"-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----", re.S), "«chave-privada-mascarada»"),
    (re.compile(r"(?i)(authorization:\s*(?:bearer|basic)\s+)[^\s\"']+"), r"\1«mascarado»"),
    (re.compile(r"(?i)(cookie:\s*[^\n]*cenario_homolog=)[^;\s]+"), r"\1«mascarado»"),
    (re.compile(r"\bya29\.[0-9A-Za-z_\-.]+"), "«token-google-mascarado»"),
    (re.compile(r"(?i)\b(postgres(?:ql)?://[^:/\s]+:)[^@\s]+@"), r"\1«mascarado»@"),
    (re.compile(r"(?i)\b([A-Z0-9_]*(?:PASSWORD|SENHA|SECRET|TOKEN|HASH|PRIVATE_KEY)[A-Z0-9_]*\s*[=:]\s*)['\"]?[^\s'\"]{4,}"), r"\1«mascarado»"),
]


def agora() -> float:
    return time.time()


def iso(ts: float) -> str:
    return dt.datetime.fromtimestamp(ts, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def b64url_decode(s: str) -> bytes:
    if not re.fullmatch(r"[A-Za-z0-9_-]*", s):
        raise ValueError("base64url inválido")
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


class Rejeicao(Exception):
    """Recusa definitiva: confirmada na fila e registrada, nunca executada."""


class Adiar(Exception):
    """Falha transitória na validação (certificados indisponíveis): volta à fila, nada executado."""


class FalhaPasso(Exception):
    """Um passo da operação terminou com erro (a operação para ali)."""


# ============================================================================ configuração
class Config:
    def __init__(self, caminho: str):
        with open(caminho, encoding="utf-8") as f:
            c = json.load(f)
        self.projeto: str = c["projeto"]
        self.vm: str = c["vm"]
        self.assinante: str = c["assinante"]
        self.assinatura: str = c["assinatura"]
        self.bucket: str = c["bucket"]
        self.bucket_versoes: str = c["bucket_versoes"]
        self.dominio: str = c.get("dominio", "teste.cenariogestao.com.br")
        self.aud: str = c.get("aud", "cenario-homolog-runner")
        self.estado: str = c.get("estado", "/var/lib/cenario-runner")
        self.log_auditoria: str = c.get("log_auditoria", "/var/log/cenario-runner/auditoria.jsonl")
        self.desativado: str = c.get("arquivo_desativado", "/etc/cenario/runner-desativado")
        self.paralelo_leitura: int = int(c.get("paralelo_leitura", 2))
        # Caminhos fixos da homologação (substituíveis SÓ pelo arquivo de configuração, de root).
        self.dir_cenario: str = c.get("dir_cenario", "/opt/cenario")
        self.vm_sh: str = c.get("vm_sh", "/opt/cenario/infra/homolog/gcp/vm.sh")
        self.compose_arquivo: str = c.get("compose_arquivo", "/opt/cenario/infra/homolog/docker-compose.homolog.yml")
        self.env_arquivo: str = c.get("env_arquivo", "/run/cenario/env")
        self.estado_cenario: str = c.get("estado_cenario", "/var/lib/cenario")
        self.portao: str = c.get("portao", "/etc/cenario/publicacao-autorizada")
        self.dropin_etiqueta: str = c.get("dropin_etiqueta", "/etc/systemd/system/cenario-homolog.service.d/10-etiqueta.conf")
        self.dir_runner: str = c.get("dir_runner", "/opt/cenario-runner")
        self.arquivos_segredos: list[str] = c.get("arquivos_segredos", ["/run/cenario/env"])
        self.systemctl: str = c.get("systemctl", "/usr/bin/systemctl")
        self.path: str = c.get("path", "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin")
        self.https_local: tuple[str, int] = (c.get("https_host", "127.0.0.1"), int(c.get("https_porta", 443)))
        self.https_verificar: bool = bool(c.get("https_verificar", False))
        self.metadata_url: str = c.get("metadata_url", "http://metadata.google.internal/computeMetadata/v1")
        self.pubsub_url: str = c.get("pubsub_url", "https://pubsub.googleapis.com/v1")
        self.storage_url: str = c.get("storage_url", "https://storage.googleapis.com")
        self.logging_url: str = c.get("logging_url", "https://logging.googleapis.com/v2")
        self.certs_url: str = c.get("certs_url", "https://www.googleapis.com/service_accounts/v1/metadata/x509/{email}")
        self.espera_termino: float = float(c.get("espera_termino", 10))
        self.dias_retencao: int = int(c.get("dias_retencao", 30))


# ============================================================================ HTTP / Google
def http(metodo: str, url: str, corpo: bytes | None = None, cab: dict | None = None, timeout: float = 30):
    req = urllib.request.Request(url, data=corpo, method=metodo, headers=cab or {})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


class Google:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self._token, self._expira = "", 0.0
        self._lock = threading.Lock()

    def meta(self, caminho: str) -> str:
        st, corpo = http("GET", f"{self.cfg.metadata_url}/{caminho}", cab={"Metadata-Flavor": "Google"}, timeout=10)
        if st != 200:
            raise RuntimeError(f"metadados {caminho}: HTTP {st}")
        return corpo.decode()

    def token(self) -> str:
        with self._lock:
            if agora() < self._expira - 60:
                return self._token
            dados = json.loads(self.meta("instance/service-accounts/default/token"))
            self._token, self._expira = dados["access_token"], agora() + int(dados.get("expires_in", 300))
            return self._token

    def api(self, metodo, url, corpo=None, tipo="application/json", timeout: float = 30):
        dados = corpo if isinstance(corpo, (bytes, type(None))) else json.dumps(corpo).encode()
        return http(metodo, url, dados, {"Authorization": f"Bearer {self.token()}", "Content-Type": tipo}, timeout)

    def puxar(self, maximo: int) -> list[dict]:
        st, corpo = self.api("POST", f"{self.cfg.pubsub_url}/{self.cfg.assinatura}:pull", {"maxMessages": maximo}, timeout=60)
        if st != 200:
            raise RuntimeError(f"pull: HTTP {st} {corpo[:200]!r}")
        return json.loads(corpo or b"{}").get("receivedMessages", [])

    def confirmar(self, ack_id: str) -> None:
        st, _ = self.api("POST", f"{self.cfg.pubsub_url}/{self.cfg.assinatura}:acknowledge", {"ackIds": [ack_id]})
        if st != 200:
            raise RuntimeError(f"acknowledge: HTTP {st}")

    def devolver(self, ack_id: str) -> None:
        self.api("POST", f"{self.cfg.pubsub_url}/{self.cfg.assinatura}:modifyAckDeadline", {"ackIds": [ack_id], "ackDeadlineSeconds": 0})

    def enviar(self, nome: str, dados: bytes, tipo: str = "text/plain; charset=utf-8") -> None:
        q = urllib.parse.urlencode({"uploadType": "media", "name": nome, "ifGenerationMatch": "0"})
        st, corpo = self.api("POST", f"{self.cfg.storage_url}/upload/storage/v1/b/{self.cfg.bucket}/o?{q}", dados, tipo, timeout=120)
        if st not in (200, 412):
            raise RuntimeError(f"upload {nome}: HTTP {st} {corpo[:200]!r}")

    def baixar_versao(self, nome: str) -> bytes:
        st, corpo = self.api("GET", f"{self.cfg.storage_url}/storage/v1/b/{self.cfg.bucket_versoes}/o/{urllib.parse.quote(nome, safe='')}?alt=media", timeout=120)
        if st != 200:
            raise FalhaPasso(f"gs://{self.cfg.bucket_versoes}/{nome}: HTTP {st}")
        return corpo

    def registrar(self, payload: dict, severidade: str) -> None:
        try:
            self.api("POST", f"{self.cfg.logging_url}/entries:write", {
                "logName": f"projects/{self.cfg.projeto}/logs/cenario-runner",
                "resource": {"type": "global", "labels": {"project_id": self.cfg.projeto}},
                "entries": [{"severity": severidade, "jsonPayload": payload}]}, timeout=10)
        except Exception:  # noqa: BLE001 — complementar; o log local e o bucket são os registros oficiais
            pass


# ============================================================================ assinatura
class Verificador:
    def __init__(self, cfg: Config):
        self.cfg = cfg
        self._certs: dict[str, str] = {}
        self._quando = 0.0
        self._lock = threading.Lock()

    def certificados(self, forcar: bool = False) -> dict[str, str]:
        with self._lock:
            if self._certs and not forcar and agora() - self._quando < 3600:
                return self._certs
            url = self.cfg.certs_url.format(email=urllib.parse.quote(self.cfg.assinante))
            try:
                st, corpo = http("GET", url, timeout=15)
            except Exception as e:  # noqa: BLE001
                raise Adiar(f"certificados indisponíveis: {e}") from e
            if st != 200:
                raise Adiar(f"certificados indisponíveis: HTTP {st}")
            dados = json.loads(corpo)
            if not isinstance(dados, dict) or not dados:
                raise Adiar("certificados vazios")
            self._certs, self._quando = dados, agora()
            return self._certs

    def conferir(self, jwt: str) -> dict:
        partes = jwt.split(".")
        if len(partes) != 3:
            raise Rejeicao("JWT malformado")
        try:
            cab = json.loads(b64url_decode(partes[0]))
            claims = json.loads(b64url_decode(partes[1]))
            assinatura = b64url_decode(partes[2])
        except (ValueError, json.JSONDecodeError) as e:
            raise Rejeicao(f"JWT ilegível: {e}") from e
        if not isinstance(cab, dict) or cab.get("alg") != "RS256":
            raise Rejeicao("algoritmo não aceito (só RS256)")
        kid = cab.get("kid")
        if not isinstance(kid, str) or not RE_KID.match(kid):
            raise Rejeicao("kid ausente ou inválido")
        cert = self.certificados().get(kid) or self.certificados(forcar=True).get(kid)
        if cert is None:
            raise Rejeicao("kid desconhecido para a conta autorizada")
        if not conferir_rs256(cert, f"{partes[0]}.{partes[1]}".encode(), assinatura):
            raise Rejeicao("assinatura inválida")
        if not isinstance(claims, dict):
            raise Rejeicao("claims inválidas")
        return claims


def conferir_rs256(cert_pem: str, dados: bytes, assinatura: bytes) -> bool:
    with tempfile.TemporaryDirectory(prefix="cenario-jwt-") as d:
        c, p, s, m = (os.path.join(d, x) for x in ("c.pem", "p.pem", "s.bin", "m.bin"))
        with open(c, "w", encoding="utf-8") as f:
            f.write(cert_pem)
        for caminho, conteudo in ((s, assinatura), (m, dados)):
            with open(caminho, "wb") as f:
                f.write(conteudo)
        if subprocess.run(["openssl", "x509", "-in", c, "-checkend", "0", "-noout"], capture_output=True).returncode != 0:
            return False
        if subprocess.run(["openssl", "x509", "-in", c, "-pubkey", "-noout", "-out", p], capture_output=True).returncode != 0:
            return False
        r = subprocess.run(["openssl", "dgst", "-sha256", "-verify", p, "-signature", s, m], capture_output=True)
        return r.returncode == 0 and b"Verified OK" in r.stdout


# ============================================================================ schema de parâmetros
@dataclasses.dataclass(frozen=True)
class Param:
    tipo: str                     # "sha" | "pasta" | "versao_runner" | "inteiro" | "escolha"
    obrigatorio: bool = False
    padrao: object = None
    minimo: int = 0
    maximo: int = 0
    opcoes: tuple = ()

    def validar(self, nome: str, valor):
        if self.tipo == "inteiro":
            if not isinstance(valor, int) or isinstance(valor, bool) or not self.minimo <= valor <= self.maximo:
                raise Rejeicao(f"parâmetro {nome}: inteiro entre {self.minimo} e {self.maximo}")
            return valor
        if not isinstance(valor, str):
            raise Rejeicao(f"parâmetro {nome}: texto esperado")
        regra = {"sha": RE_SHA, "pasta": RE_PASTA, "versao_runner": RE_VERSAO_RUNNER}.get(self.tipo)
        if regra is not None:
            if not regra.match(valor):
                raise Rejeicao(f"parâmetro {nome}: formato inválido")
            return valor
        if self.tipo == "escolha":
            if valor not in self.opcoes:
                raise Rejeicao(f"parâmetro {nome}: valores aceitos {list(self.opcoes)}")
            return valor
        raise Rejeicao(f"parâmetro {nome}: tipo desconhecido")


@dataclasses.dataclass(frozen=True)
class Operacao:
    classe: str
    timeout_padrao: int
    timeout_max: int
    params: dict
    executar: str                 # nome do método Runner.op_<executar>
    resumo: str
    timeout_min: int = 5


VERSAO_P = Param("sha", obrigatorio=True)
OPERACOES: dict[str, Operacao] = {
    # -- diagnóstico
    "status": Operacao(READ_ONLY, 120, 600, {}, "status", "vm.sh status (contêineres, memória, disco)"),
    "health": Operacao(READ_ONLY, 60, 300, {}, "health", "saúde rápida: contêineres + /api/ready pelo proxy local"),
    "version": Operacao(READ_ONLY, 60, 300, {}, "version", "versões: runner, /opt/cenario, etiqueta ativa, imagens em execução"),
    "resources": Operacao(READ_ONLY, 60, 300, {}, "resources", "memória, swap, disco, carga, uso do Docker"),
    "containers_status": Operacao(READ_ONLY, 60, 300, {}, "containers_status", "estado e saúde de cada contêiner"),
    "container_logs": Operacao(READ_ONLY, 60, 300, {"service": Param("escolha", True, opcoes=SERVICOS),
                                                     "lines": Param("inteiro", padrao=200, minimo=1, maximo=5000),
                                                     "since_minutes": Param("inteiro", padrao=1440, minimo=1, maximo=10080)},
                               "container_logs", "logs de UM contêiner da allowlist (linhas e janela limitadas)"),
    "application_logs": Operacao(READ_ONLY, 60, 300, {"unit": Param("escolha", True, opcoes=UNIDADES),
                                                       "lines": Param("inteiro", padrao=200, minimo=1, maximo=5000),
                                                       "since_minutes": Param("inteiro", padrao=1440, minimo=1, maximo=10080)},
                                 "application_logs", "journal de UMA unidade systemd da allowlist"),
    "migration_status": Operacao(READ_ONLY, 120, 600, {"version": Param("sha")}, "migration_status",
                                 "_prisma_migrations; com version, compara com as migrations da imagem"),
    "database_status": Operacao(READ_ONLY, 60, 300, {}, "database_status", "tamanho, conexões, bloqueios e consultas longas"),
    "disk_status": Operacao(READ_ONLY, 120, 600, {}, "disk_status", "disco, volumes Docker e pasta de backups"),
    "network_status": Operacao(READ_ONLY, 60, 300, {}, "network_status", "portas em escuta e respostas HTTPS locais"),
    "smoke_test": Operacao(READ_ONLY, 180, 600, {}, "smoke_test", "vm.sh saude (verificação completa)"),
    "websocket_test": Operacao(READ_ONLY, 60, 120, {}, "websocket_test", "handshake WebSocket em /api/realtime pelo proxy"),
    "gate_status": Operacao(READ_ONLY, 30, 60, {}, "gate_status", "portão de publicação aberto/fechado"),
    # -- backup
    "backup_create": Operacao(MUTATING, 1800, 3600, {}, "backup_create", "vm.sh backup (backup imediato + envio ao bucket)"),
    "backup_validate": Operacao(READ_ONLY, 600, 1800, {"folder": Param("pasta", True)}, "backup_validate", "SHA256SUMS de uma pasta de backup"),
    "backup_list": Operacao(READ_ONLY, 60, 300, {}, "backup_list", "pastas de backup na VM"),
    "backup_restore_test": Operacao(MUTATING, 1800, 3600, {"folder": Param("pasta")}, "backup_restore_test",
                                    "vm.sh restaurar-teste [pasta] (bancos SEPARADOS; original só lido)"),
    "recovery_point_create": Operacao(MUTATING, 3600, 7200, {}, "recovery_point_create", "vm.sh ponto-recuperacao (exige manutenção)"),
    # -- banco
    "database_fingerprint": Operacao(READ_ONLY, 300, 1200, {}, "database_fingerprint", "vm.sh impressao-digital"),
    "database_counts": Operacao(READ_ONLY, 120, 600, {}, "database_counts", "linhas por tabela (estatísticas do PostgreSQL)"),
    "migration_precheck": Operacao(READ_ONLY, 300, 1200, {"version": Param("sha")}, "migration_precheck",
                                   "vm.sh preflight <versão> (cadeia banco × imagem: incompleta, desconhecida, divergente, "
                                   "fora de ordem, esquema e dados); sem versão: a candidata"),
    "migrate": Operacao(DESTRUCTIVE, 1800, 3600, {"version": VERSAO_P}, "migrate", "vm.sh migrar <versão> (exige ponto de recuperação)"),
    "migration_verify": Operacao(READ_ONLY, 120, 600, {"version": VERSAO_P}, "migration_verify",
                                 "banco × migrations da imagem: nenhuma pendente, com falha ou desconhecida"),
    "rollback_to_recovery_point": Operacao(DESTRUCTIVE, 3600, 7200, {}, "rollback_to_recovery_point",
                                           "vm.sh recuperar --sim (volta banco e versão ao ponto de recuperação)"),
    # -- aplicação
    "prepare_version": Operacao(MUTATING, 900, 1800, {"version": VERSAO_P}, "prepare_version", "vm.sh preparar-versao <versão>"),
    "activate_version": Operacao(DESTRUCTIVE, 900, 1800, {"version": VERSAO_P}, "activate_version",
                                 "fixa a etiqueta local e vm.sh ativar <versão> (exige migrate da mesma versão)"),
    "rollback_version": Operacao(DESTRUCTIVE, 900, 1800, {"version": VERSAO_P}, "rollback_version",
                                 "volta só a aplicação a uma versão já ativada, se o banco for compatível"),
    "maintenance_on": Operacao(MUTATING, 300, 900, {}, "maintenance_on", "vm.sh manutencao (para API e web)"),
    "maintenance_off": Operacao(MUTATING, 900, 1800, {}, "maintenance_off", "volta API e web na versão ativa (vm.sh ativar)"),
    "restart_api": Operacao(MUTATING, 300, 900, {}, "restart_api", "reinicia o contêiner da API"),
    "restart_web": Operacao(MUTATING, 300, 900, {}, "restart_web", "reinicia o contêiner web"),
    "restart_application": Operacao(MUTATING, 300, 900, {}, "restart_application", "reinicia API e web"),
    "restart_containers": Operacao(DESTRUCTIVE, 600, 1200, {}, "restart_containers", "reinicia todos os contêineres da pilha"),
    "gate_open": Operacao(MUTATING, 30, 60, {}, "gate_open", "abre o portão de publicação"),
    "gate_close": Operacao(MUTATING, 30, 60, {}, "gate_close", "fecha o portão de publicação"),
    "update_runner": Operacao(DESTRUCTIVE, 300, 600, {"version": Param("versao_runner", True)}, "update_runner",
                              "instala uma versão PUBLICADA (bucket de versões, gravação humana) com SHA-256"),
    # -- espaço em disco: só imagens da aplicação, nunca as protegidas (ativa, rollback, em uso)
    "images_cleanup_plan": Operacao(READ_ONLY, 60, 300, {}, "images_cleanup_plan",
                                    "lista as imagens da aplicação e o que seria removido (nada é removido)"),
    "images_cleanup": Operacao(MUTATING, 300, 900, {}, "images_cleanup",
                               "remove SÓ imagens da aplicação sem contêiner e fora das versões protegidas (sem --force)"),
    # -- scripts administrativos da VM (/opt/cenario): só pacotes PUBLICADOS por humano
    "vm_scripts_diff": Operacao(READ_ONLY, 120, 600, {"version": VERSAO_P}, "vm_scripts_diff",
                                "diferença exata entre /opt/cenario e o pacote publicado scripts-<versão> (nada muda)"),
    "vm_scripts_update": Operacao(DESTRUCTIVE, 300, 900, {"version": VERSAO_P}, "vm_scripts_update",
                                  "instala o pacote publicado scripts-<versão> em /opt/cenario (cópia anterior guardada; "
                                  "nada reiniciado)"),
    "vm_scripts_restore": Operacao(DESTRUCTIVE, 120, 600, {}, "vm_scripts_restore",
                                   "volta /opt/cenario à cópia guardada pelo último vm_scripts_update (nada reiniciado)"),
    "apply_stack_config": Operacao(MUTATING, 900, 1800, {}, "apply_stack_config",
                                   "aplica a configuração de /opt/cenario na versão ATIVA: vm.sh aplicar-config (proxy) + "
                                   "vm.sh ativar <ativa> (recria só o que mudou; mesmas imagens; exige o portão)"),
    # -- testes de homologação (na VM)
    "run_homologation_tests": Operacao(READ_ONLY, 600, 1800, {"suite": Param("escolha", True, opcoes=SUITES)},
                                       "run_homologation_tests", "suítes da VM: saude | acesso | websocket | completo"),
}

SQL_MIGRACOES = ("select migration_name, coalesce(to_char(finished_at,'YYYY-MM-DD\"T\"HH24:MI:SS'),'NAO_CONCLUIDA'), "
                 "coalesce(to_char(rolled_back_at,'YYYY-MM-DD\"T\"HH24:MI:SS'),''), applied_steps_count "
                 "from _prisma_migrations order by migration_name")
SQL_BANCO = ("select 'versao', version() union all "
             "select 'tamanho', pg_size_pretty(pg_database_size(current_database())) union all "
             "select 'conexoes', count(*)::text from pg_stat_activity union all "
             "select 'aguardando_bloqueio', count(*)::text from pg_stat_activity where wait_event_type = 'Lock' union all "
             "select 'consulta_mais_longa_s', coalesce(max(extract(epoch from now() - query_start))::int, 0)::text "
             "from pg_stat_activity where state = 'active' and pid <> pg_backend_pid()")
SQL_CONTAGENS = "select relname, n_live_tup from pg_stat_user_tables order by relname"


def validar_parametros(op: Operacao, recebidos) -> dict:
    if not isinstance(recebidos, dict):
        raise Rejeicao("parametros deve ser objeto")
    extras = set(recebidos) - set(op.params)
    if extras:
        raise Rejeicao(f"parâmetros inesperados: {sorted(extras)}")
    saida = {}
    for nome, p in op.params.items():
        if nome in recebidos:
            saida[nome] = p.validar(nome, recebidos[nome])
        elif p.obrigatorio:
            raise Rejeicao(f"parâmetro obrigatório ausente: {nome}")
        elif p.padrao is not None:
            saida[nome] = p.padrao
    return saida


def validar_envelope(cfg: Config, verif: Verificador, dados: bytes, publicado_em: float | None) -> dict:
    if len(dados) > LIMITE_MENSAGEM:
        raise Rejeicao(f"envelope de {len(dados)} bytes (máximo {LIMITE_MENSAGEM})")
    try:
        env = json.loads(dados.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as e:
        raise Rejeicao(f"envelope não é JSON UTF-8: {e}") from e
    if not isinstance(env, dict) or set(env) != {"v", "jwt"}:
        raise Rejeicao("envelope com campos inesperados (exigidos exatamente: v, jwt)")
    if env["v"] != 2 or not isinstance(env["jwt"], str) or len(env["jwt"]) > 8192:
        raise Rejeicao("envelope com versão ou JWT inválidos")
    c = verif.conferir(env["jwt"])
    extras, faltam = set(c) - CLAIMS, CLAIMS - set(c)
    if extras or faltam:
        raise Rejeicao(f"claims inesperadas {sorted(extras)} / ausentes {sorted(faltam)}")
    if c["iss"] != cfg.assinante or c["sub"] != cfg.assinante:
        raise Rejeicao("emissor não autorizado")
    if c["aud"] != cfg.aud:
        raise Rejeicao("audiência inválida")
    if c["vm"] != cfg.vm or c["projeto"] != cfg.projeto:
        raise Rejeicao("job destinado a outra VM ou projeto")
    if not isinstance(c["jti"], str) or not RE_UUID.match(c["jti"]):
        raise Rejeicao("jti inválido (UUID v4 minúsculo)")
    for k in ("iat", "exp", "timeout_s"):
        if not isinstance(c[k], int) or isinstance(c[k], bool):
            raise Rejeicao(f"{k} não inteiro")
    t = agora()
    if c["iat"] > t + TOLERANCIA_RELOGIO:
        raise Rejeicao("emitido no futuro")
    if c["exp"] <= t:
        raise Rejeicao("envelope expirado")
    if c["exp"] <= c["iat"] or c["exp"] - c["iat"] > VALIDADE_MAX:
        raise Rejeicao("validade fora do permitido")
    if publicado_em is not None and publicado_em < c["iat"] - TOLERANCIA_RELOGIO:
        raise Rejeicao("publicado antes da emissão")
    if not isinstance(c["descricao"], str) or len(c["descricao"]) > 200 or re.search(r"[\x00-\x1f]", c["descricao"]):
        raise Rejeicao("descrição inválida")
    op = OPERACOES.get(c["operacao"]) if isinstance(c["operacao"], str) else None
    if op is None:
        raise Rejeicao("operação desconhecida")
    if not op.timeout_min <= c["timeout_s"] <= op.timeout_max:
        raise Rejeicao(f"timeout_s fora de {op.timeout_min}..{op.timeout_max} para {c['operacao']}")
    c["parametros"] = validar_parametros(op, c["parametros"])
    return c


# ============================================================================ máscara
class Mascara:
    def __init__(self, arquivos: list[str]):
        self.valores: list[tuple[str, str]] = []
        for a in arquivos:
            try:
                with open(a, encoding="utf-8", errors="replace") as f:
                    for linha in f:
                        m = re.match(r"^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$", linha.rstrip("\n"))
                        if m:
                            v = m.group(2).strip().strip("'\"")
                            if len(v) >= 8:
                                self.valores.append((v, m.group(1)))
            except OSError:
                continue
        self.valores.sort(key=lambda x: -len(x[0]))

    def aplicar(self, texto: str) -> str:
        for v, nome in self.valores:
            texto = texto.replace(v, f"«{nome}-mascarado»")
        for padrao, troca in PADROES_SEGREDO:
            texto = padrao.sub(troca, texto)
        return texto


def ler_env(caminho: str) -> dict[str, str]:
    out = {}
    try:
        with open(caminho, encoding="utf-8") as f:
            for linha in f:
                m = re.match(r"^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$", linha.rstrip("\n"))
                if m:
                    out[m.group(1)] = m.group(2).strip().strip("'\"")
    except OSError:
        pass
    return out


# ============================================================================ execução de um job
class Saida:
    """stdout/stderr de um job, com limite de tamanho (o excesso é contado e descartado)."""

    def __init__(self, d: str):
        self.arquivos = {k: open(os.path.join(d, f"{k}.bruto"), "wb") for k in ("stdout", "stderr")}
        self.cont = {k: {"gravados": 0, "total": 0} for k in self.arquivos}
        self.lock = threading.Lock()

    def escrever(self, fluxo: str, dados: bytes) -> None:
        with self.lock:
            c = self.cont[fluxo]
            livre = LIMITE_SAIDA - c["gravados"]
            if livre > 0:
                self.arquivos[fluxo].write(dados[:livre])
                c["gravados"] += min(len(dados), livre)
            c["total"] += len(dados)

    def linha(self, texto: str) -> None:
        self.escrever("stdout", (texto + "\n").encode())

    def fechar(self) -> None:
        for f in self.arquivos.values():
            f.close()


class Job:
    def __init__(self, runner: "Runner", jti: str, claims: dict, d: str):
        self.r, self.cfg, self.jti, self.claims, self.d = runner, runner.cfg, jti, claims, d
        self.p = claims["parametros"]
        self.saida = Saida(d)
        self.prazo = agora() + claims["timeout_s"]
        self.processo: subprocess.Popen | None = None
        self.passos: list[dict] = []

    # Um comando = lista de argumentos (sem shell), com o tempo que resta ao job.
    def cmd(self, argv: list[str], env: dict | None = None, permitir: tuple[int, ...] = (0,), capturar: bool = False) -> tuple[int, bytes]:
        for a in argv:
            if not isinstance(a, str) or "\x00" in a:
                raise FalhaPasso("argumento inválido")
        resto = self.prazo - agora()
        if resto <= 0:
            raise TimeoutError()
        amb = {"PATH": self.cfg.path, "HOME": "/root", "LANG": "C.UTF-8",
               "CENARIO_JOB_ID": self.jti, **(env or {})}
        self.saida.linha(f"$ {' '.join(argv)}")
        ini = agora()
        p = subprocess.Popen(argv, cwd="/", env=amb, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                             stderr=subprocess.PIPE, start_new_session=True)
        self.processo = p
        capt = bytearray()

        def bomba(fluxo, nome):
            while True:
                bloco = fluxo.read(65536)
                if not bloco:
                    break
                if capturar and nome == "stdout" and len(capt) < LIMITE_SAIDA:
                    capt.extend(bloco)
                self.saida.escrever(nome, bloco)

        bombas = [threading.Thread(target=bomba, args=(p.stdout, "stdout"), daemon=True),
                  threading.Thread(target=bomba, args=(p.stderr, "stderr"), daemon=True)]
        for b in bombas:
            b.start()
        try:
            codigo = p.wait(timeout=resto)
        except subprocess.TimeoutExpired:
            self.r.matar(p)
            for b in bombas:
                b.join(10)
            self.passos.append({"argv": argv, "exit_code": None, "duracao_s": round(agora() - ini, 3)})
            raise TimeoutError()
        for b in bombas:
            b.join(30)
        self.processo = None
        self.passos.append({"argv": argv, "exit_code": codigo, "duracao_s": round(agora() - ini, 3)})
        if codigo not in permitir:
            raise FalhaPasso(f"{os.path.basename(argv[0])} {argv[1] if len(argv) > 1 else ''}: código {codigo}")
        return codigo, bytes(capt)

    def vmsh(self, *args: str, env: dict | None = None, permitir=(0,)):
        return self.cmd(["/bin/bash", self.cfg.vm_sh, *args], env=env, permitir=permitir)

    def compose(self, *args: str, capturar=False, permitir=(0,)):
        return self.cmd(["docker", "compose", "-f", self.cfg.compose_arquivo, "--env-file", self.cfg.env_arquivo, *args],
                        capturar=capturar, permitir=permitir)

    def psql(self, sql: str, capturar=True):
        # SQL SEMPRE constante deste arquivo (SQL_*); nada do cliente entra aqui.
        if sql not in (SQL_MIGRACOES, SQL_BANCO, SQL_CONTAGENS):  # verificação explícita (não some com python -O)
            raise FalhaPasso("consulta SQL fora das constantes do runner")
        return self.compose("exec", "-T", "postgres", "psql", "-U", "cenario", "-d", BANCO, "-At", "-F", "|",
                            "-v", "ON_ERROR_STOP=1", "-c", sql, capturar=capturar)


# ============================================================================ runner
class Runner:
    def __init__(self, cfg: Config, google: Google | None = None, verif: Verificador | None = None):
        self.cfg = cfg
        self.g = google or Google(cfg)
        self.verif = verif or Verificador(cfg)
        self.fila: collections.deque = collections.deque()
        self.cond = threading.Condition()
        self.exclusivo_rodando = False
        self.leituras_rodando = 0
        self.parar = threading.Event()
        self.jobs_dir = os.path.join(cfg.estado, "jobs")
        self.rej_dir = os.path.join(cfg.estado, "rejeitados")
        self.historico = os.path.join(cfg.estado, "ativacoes.jsonl")

    # -- registro
    def auditar(self, evento: str, **campos) -> None:
        reg = {"ts": iso(agora()), "evento": evento, "vm": self.cfg.vm, "runner": VERSAO, **campos}
        linha = json.dumps(reg, ensure_ascii=False)
        os.makedirs(os.path.dirname(self.cfg.log_auditoria), mode=0o700, exist_ok=True)
        fd = os.open(self.cfg.log_auditoria, os.O_WRONLY | os.O_APPEND | os.O_CREAT, 0o600)
        with os.fdopen(fd, "a", encoding="utf-8") as f:
            f.write(linha + "\n")
        print(linha, flush=True)
        self.g.registrar(reg, "WARNING" if evento in ("rejeitado", "tempo_esgotado", "interrompido", "falhou") else "INFO")

    @staticmethod
    def gravar(caminho: str, conteudo, modo: int = 0o600) -> None:
        fd = os.open(caminho, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, modo)
        if isinstance(conteudo, bytes):
            with os.fdopen(fd, "wb") as f:
                f.write(conteudo)
        else:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(conteudo)

    def preparar(self) -> None:
        for d in (self.cfg.estado, self.jobs_dir, self.rej_dir):
            os.makedirs(d, mode=0o700, exist_ok=True)
            os.chmod(d, 0o700)
        projeto, vm = self.g.meta("project/project-id").strip(), self.g.meta("instance/name").strip()
        if projeto != self.cfg.projeto or vm != self.cfg.vm:
            self.auditar("recusado_na_partida", motivo=f"máquina {projeto}/{vm} ≠ configuração {self.cfg.projeto}/{self.cfg.vm}")
            sys.exit(SAIDA_CONFIG)
        self.recuperar()

    def recuperar(self) -> None:
        for jti in sorted(os.listdir(self.jobs_dir)):
            d = os.path.join(self.jobs_dir, jti)
            if not os.path.isdir(d):
                continue
            if not os.path.exists(os.path.join(d, "resultado.json")):
                if os.path.exists(os.path.join(d, "envelope.json")):
                    self.finalizar(jti, "interrompido", None, agora(), agora(), None, [], "o serviço parou antes do fim; NÃO reexecutado")
            elif not os.path.exists(os.path.join(d, "enviado")):
                self.enviar_resultado(jti)
        self.limpar_antigos()

    def limpar_antigos(self) -> None:
        limite = agora() - self.cfg.dias_retencao * 86400
        for nome in os.listdir(self.jobs_dir):
            p = os.path.join(self.jobs_dir, nome)
            try:
                if os.path.getmtime(p) < limite and os.path.exists(os.path.join(p, "enviado")):
                    for f in os.listdir(p):  # o diretório (marcador do jti) fica: impede replay
                        os.remove(os.path.join(p, f))
            except OSError:
                continue
        for nome in os.listdir(self.rej_dir):
            p = os.path.join(self.rej_dir, nome)
            try:
                if os.path.getmtime(p) < limite:
                    os.remove(p)
            except OSError:
                continue

    # -- recepção
    def receber(self, msg: dict) -> str:
        m = msg.get("message", {})
        mid = str(m.get("messageId", "?"))[:64]
        try:
            dados = base64.b64decode(m.get("data", ""), validate=True)
        except (ValueError, TypeError):
            return self.rejeitar(mid, "dados não estão em base64")
        publicado = None
        try:
            publicado = dt.datetime.fromisoformat(m["publishTime"].replace("Z", "+00:00")).timestamp()
        except (KeyError, ValueError, AttributeError):
            pass
        try:
            claims = validar_envelope(self.cfg, self.verif, dados, publicado)
        except Adiar as e:
            self.auditar("adiado", mensagem=mid, motivo=str(e))
            return "adiado"
        except Rejeicao as e:
            return self.rejeitar(mid, str(e))
        jti = claims["jti"]
        d = os.path.join(self.jobs_dir, jti)
        try:
            os.mkdir(d, 0o700)  # reserva atômica do jti
        except FileExistsError:
            return self.rejeitar(mid, "jti já recebido (replay ou entrega duplicada)", jti=jti)
        classe = OPERACOES[claims["operacao"]].classe
        self.gravar(os.path.join(d, "envelope.json"), json.dumps(
            {"claims": claims, "classe": classe, "mensagem": mid, "recebido": iso(agora()),
             "publicado": iso(publicado) if publicado else None}, ensure_ascii=False, indent=1))
        self.auditar("aceito", jti=jti, mensagem=mid, operacao=claims["operacao"], classe=classe,
                     parametros=claims["parametros"], timeout_s=claims["timeout_s"], descricao=claims["descricao"])
        with self.cond:
            self.fila.append((jti, claims, classe))
            self.cond.notify_all()
        return "aceito"

    def rejeitar(self, mid: str, motivo: str, jti: str | None = None) -> str:
        reg = {"mensagem": mid, "motivo": motivo, "jti": jti, "quando": iso(agora()), "vm": self.cfg.vm}
        nome = f"{dt.datetime.now(dt.timezone.utc):%Y%m%dT%H%M%S%f}-{re.sub(r'[^A-Za-z0-9]', '_', mid)}"
        self.gravar(os.path.join(self.rej_dir, nome + ".json"), json.dumps(reg, ensure_ascii=False))
        self.auditar("rejeitado", mensagem=mid, motivo=motivo, jti=jti)
        try:
            self.g.enviar(f"rejeitados/{nome}.json", json.dumps(reg, ensure_ascii=False).encode(), "application/json")
        except Exception as e:  # noqa: BLE001
            self.auditar("aviso", motivo=f"rejeição não enviada ao bucket: {e}")
        return "rejeitado"

    # -- agendamento: READ_ONLY em paralelo limitado; MUTATING/DESTRUCTIVE sempre sozinhos; FIFO
    def agendador(self) -> None:
        while not self.parar.is_set():
            with self.cond:
                escolhido = None
                while not self.parar.is_set() and escolhido is None:
                    if self.fila:
                        jti, claims, classe = self.fila[0]
                        if classe == READ_ONLY:
                            livre = not self.exclusivo_rodando and self.leituras_rodando < self.cfg.paralelo_leitura
                        else:
                            livre = not self.exclusivo_rodando and self.leituras_rodando == 0
                        if livre:
                            self.fila.popleft()
                            if classe == READ_ONLY:
                                self.leituras_rodando += 1
                            else:
                                self.exclusivo_rodando = True
                            escolhido = (jti, claims, classe)
                            break
                    self.cond.wait(1)
                if escolhido is None:
                    return
            threading.Thread(target=self.executar, args=escolhido, daemon=True).start()

    def executar(self, jti: str, claims: dict, classe: str) -> None:
        d = os.path.join(self.jobs_dir, jti)
        ini = agora()
        open(os.path.join(d, "executando"), "w").close()
        self.auditar("iniciado", jti=jti, operacao=claims["operacao"], classe=classe)
        job = Job(self, jti, claims, d)
        status, codigo, motivo = "falhou", 1, ""
        try:
            getattr(self, "op_" + OPERACOES[claims["operacao"]].executar)(job)
            status, codigo = "concluido", 0
        except TimeoutError:
            status, codigo, motivo = "tempo_esgotado", None, f"excedeu {claims['timeout_s']} s"
        except FalhaPasso as e:
            motivo = str(e)
            codigo = next((p["exit_code"] for p in reversed(job.passos) if p["exit_code"] not in (0, None)), 1)
        except Exception as e:  # noqa: BLE001
            motivo = f"erro do executor: {type(e).__name__}: {e}"
        finally:
            job.saida.fechar()
            self.finalizar(jti, status, codigo, ini, agora(), job.saida.cont, job.passos, motivo)
            with self.cond:
                if classe == READ_ONLY:
                    self.leituras_rodando -= 1
                else:
                    self.exclusivo_rodando = False
                self.cond.notify_all()

    def matar(self, p: subprocess.Popen) -> None:
        try:
            os.killpg(p.pid, signal.SIGTERM)
            p.wait(self.cfg.espera_termino)
        except subprocess.TimeoutExpired:
            os.killpg(p.pid, signal.SIGKILL)
            p.wait()
        except ProcessLookupError:
            p.wait()

    def finalizar(self, jti, status, codigo, ini, fim, conts, passos, motivo) -> None:
        d = os.path.join(self.jobs_dir, jti)
        mascara = Mascara(self.cfg.arquivos_segredos)  # relida a cada job: o env da pilha pode surgir depois
        caudas = {}
        for fluxo in ("stdout", "stderr"):
            bruto, texto = os.path.join(d, f"{fluxo}.bruto"), ""
            if os.path.exists(bruto):
                with open(bruto, "rb") as f:
                    texto = f.read().decode("utf-8", errors="replace")
                os.remove(bruto)
            texto = mascara.aplicar(texto)
            self.gravar(os.path.join(d, f"{fluxo}.txt"), texto)
            caudas[fluxo] = texto[-LIMITE_CAUDA:]
        try:
            with open(os.path.join(d, "envelope.json"), encoding="utf-8") as f:
                env = json.load(f)
        except (OSError, ValueError):
            env = {}
        c = env.get("claims", {})
        conts = conts or {}
        res = {"jti": jti, "status": status, "exit_code": codigo, "inicio": iso(ini), "fim": iso(fim),
               "duracao_s": round(fim - ini, 3), "operacao": c.get("operacao"), "classe": env.get("classe"),
               "parametros": c.get("parametros"), "descricao": c.get("descricao"), "timeout_s": c.get("timeout_s"),
               "vm": self.cfg.vm, "runner": VERSAO, "motivo": mascara.aplicar(motivo),
               "passos": [{**p, "argv": [mascara.aplicar(a) for a in p["argv"]]} for p in passos],
               "bytes": {k: v.get("total", 0) for k, v in conts.items()},
               "truncado": {k: v.get("total", 0) > v.get("gravados", 0) for k, v in conts.items()},
               "stdout_cauda": caudas["stdout"], "stderr_cauda": caudas["stderr"]}
        self.gravar(os.path.join(d, "resultado.json"), json.dumps(res, ensure_ascii=False, indent=1))
        try:
            os.remove(os.path.join(d, "executando"))
        except OSError:
            pass
        self.auditar(status, jti=jti, operacao=res["operacao"], exit_code=codigo, duracao_s=res["duracao_s"], bytes=res["bytes"])
        self.enviar_resultado(jti)

    def enviar_resultado(self, jti: str) -> None:
        d = os.path.join(self.jobs_dir, jti)
        try:
            for nome, tipo in (("envelope.json", "application/json"), ("stdout.txt", "text/plain; charset=utf-8"),
                               ("stderr.txt", "text/plain; charset=utf-8"), ("resultado.json", "application/json")):
                p = os.path.join(d, nome)
                if os.path.exists(p):
                    with open(p, "rb") as f:
                        self.g.enviar(f"operacoes/{jti}/{nome}", f.read(), tipo)
            open(os.path.join(d, "enviado"), "w").close()
        except Exception as e:  # noqa: BLE001 — fica pendente; reenviado depois
            self.auditar("aviso", jti=jti, motivo=f"resultado não enviado ao bucket: {e}")

    # ======================================================================== operações
    # Cada op_* recebe o Job; parâmetros já validados em job.p. Só listas de argumentos fixas.
    def op_status(self, j: Job):
        j.vmsh("status")

    def op_containers_status(self, j: Job):
        j.compose("ps", "--all", "--format", "table {{.Service}}\t{{.State}}\t{{.Status}}\t{{.Image}}")

    def op_health(self, j: Job):
        _, saida = j.compose("ps", "--all", "--format", "{{.Service}} {{.State}} {{.Health}}", capturar=True)
        falhas = 0
        for s in SERVICOS:
            linha = next((l for l in saida.decode(errors="replace").splitlines() if l.split(" ")[0] == s), "")
            ok = " running" in linha and "unhealthy" not in linha
            falhas += not ok
            j.saida.linha(f"{'✔' if ok else '✘'} contêiner {s}: {linha.partition(' ')[2] or 'ausente'}")
        st, corpo = self.https_local(j, "/api/ready", com_cookie=True)
        ok = st == 200 and b"ready" in corpo
        falhas += not ok
        j.saida.linha(f"{'✔' if ok else '✘'} /api/ready pelo proxy: HTTP {st}")
        if falhas:
            raise FalhaPasso(f"saúde: {falhas} problema(s)")

    def op_version(self, j: Job):
        j.saida.linha(f"runner: {VERSAO}")
        try:
            with open(os.path.join(self.cfg.dir_cenario, "VERSAO"), encoding="utf-8") as f:
                j.saida.linha(f"/opt/cenario (scripts da VM): {f.read().strip()}")
        except OSError:
            j.saida.linha("/opt/cenario (scripts da VM): desconhecida")
        j.saida.linha(f"etiqueta local (drop-in): {self.etiqueta_dropin() or 'nenhuma'}")
        j.saida.linha(f"etiqueta do ambiente da pilha: {self.etiqueta_env() or 'nenhuma'}")
        for nome in ("candidata", "migrada"):
            try:
                with open(os.path.join(self.cfg.estado_cenario, nome), encoding="utf-8") as f:
                    j.saida.linha(f"{nome}: {f.read().strip()}")
            except OSError:
                j.saida.linha(f"{nome}: nenhuma")
        j.compose("ps", "--all", "--format", "{{.Service}}\t{{.Image}}", permitir=(0, 1))
        j.cmd(["docker", "ps", "--format", "{{.Names}}\t{{.Image}}\t{{.ID}}"], permitir=(0, 1))

    def op_resources(self, j: Job):
        j.cmd(["free", "-m"])
        j.cmd(["swapon", "--show"], permitir=(0, 1))
        j.cmd(["df", "-h", "/"])
        j.cmd(["uptime"])
        j.cmd(["docker", "stats", "--no-stream", "--format", "table {{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}"], permitir=(0, 1))

    def op_container_logs(self, j: Job):
        j.compose("logs", "--no-color", "--timestamps", "--tail", str(j.p["lines"]), "--since", f"{j.p['since_minutes']}m",
                  j.p["service"])

    def op_application_logs(self, j: Job):
        j.cmd(["journalctl", "--no-pager", "-o", "short-iso", "-u", f"{j.p['unit']}.service", "-n", str(j.p["lines"]),
               "--since", f"-{j.p['since_minutes']}min"], permitir=(0, 1))

    def op_migration_status(self, j: Job):
        _, saida = j.psql(SQL_MIGRACOES)
        if "version" in j.p:
            self.comparar_migracoes(j, saida, j.p["version"], exigir=False)

    def op_migration_verify(self, j: Job):
        _, saida = j.psql(SQL_MIGRACOES)
        self.comparar_migracoes(j, saida, j.p["version"], exigir=True)

    def comparar_migracoes(self, j: Job, saida: bytes, versao: str, exigir: bool) -> list[str]:
        aplicadas, falhas = set(), []
        for l in saida.decode(errors="replace").splitlines():
            partes = l.split("|")
            if len(partes) >= 3:
                if partes[1] == "NAO_CONCLUIDA" and not partes[2]:
                    falhas.append(partes[0])
                elif not partes[2]:
                    aplicadas.add(partes[0])
        _, lista = j.cmd(["docker", "run", "--rm", "--entrypoint", "ls", self.imagem("api", versao), "packages/db/prisma/migrations"],
                         capturar=True)
        na_imagem = {x for x in lista.decode(errors="replace").split() if re.match(r"^[0-9]{14}_", x)}
        pendentes, desconhecidas = sorted(na_imagem - aplicadas), sorted(aplicadas - na_imagem)
        j.saida.linha(f"• aplicadas: {len(aplicadas)} · na imagem {versao}: {len(na_imagem)}")
        j.saida.linha(f"• pendentes: {pendentes or 'nenhuma'}")
        j.saida.linha(f"• no banco e ausentes da imagem: {desconhecidas or 'nenhuma'}")
        j.saida.linha(f"• iniciadas e não concluídas: {falhas or 'nenhuma'}")
        if exigir and (pendentes or desconhecidas or falhas):
            raise FalhaPasso("banco e imagem divergem (veja acima)")
        return desconhecidas

    def op_database_status(self, j: Job):
        j.psql(SQL_BANCO, capturar=False)

    def op_database_counts(self, j: Job):
        j.psql(SQL_CONTAGENS, capturar=False)

    def op_disk_status(self, j: Job):
        j.cmd(["df", "-h"])
        j.cmd(["docker", "system", "df"], permitir=(0, 1))
        j.compose("exec", "-T", "backup", "du", "-sh", "/data/backups", permitir=(0, 1))

    def op_network_status(self, j: Job):
        j.cmd(["ss", "-tlnH"])
        for caminho, cookie in (("/painel", False), ("/api/ready", True), ("/entrar", True)):
            st, _ = self.https_local(j, caminho, com_cookie=cookie)
            j.saida.linha(f"• https://{self.cfg.dominio}{caminho} ({'com' if cookie else 'sem'} cookie de acesso): HTTP {st}")

    def op_smoke_test(self, j: Job):
        j.vmsh("saude")

    def op_websocket_test(self, j: Job):
        st = self.websocket_handshake(j)
        # Sem sessão de usuário, a API recusa ANTES do upgrade (401): prova que proxy e API
        # encaminham o handshake; 101 também é aceito. 502/404/timeout indicam falha real.
        ok = st in (101, 401)
        j.saida.linha(f"{'✔' if ok else '✘'} WebSocket /api/realtime pelo proxy: HTTP {st} (esperado 401 sem sessão, ou 101)")
        if not ok:
            raise FalhaPasso(f"handshake WebSocket: HTTP {st}")

    def op_gate_status(self, j: Job):
        j.saida.linha(f"portão de publicação: {'ABERTO' if os.path.exists(self.cfg.portao) else 'fechado'} ({self.cfg.portao})")

    def op_gate_open(self, j: Job):
        os.makedirs(os.path.dirname(self.cfg.portao), mode=0o755, exist_ok=True)
        open(self.cfg.portao, "a").close()
        self.op_gate_status(j)

    def op_gate_close(self, j: Job):
        try:
            os.remove(self.cfg.portao)
        except FileNotFoundError:
            pass
        self.op_gate_status(j)

    def op_backup_create(self, j: Job):
        j.vmsh("backup")

    def op_backup_validate(self, j: Job):
        pasta = j.p["folder"]
        j.compose("exec", "-T", "-w", f"/data/backups/{pasta}", "backup", "sha256sum", "--check", "--quiet", "SHA256SUMS")
        j.saida.linha(f"✔ {pasta}: SHA256SUMS conferido")

    def op_backup_list(self, j: Job):
        j.compose("exec", "-T", "backup", "ls", "-lt", "--time-style=+%Y-%m-%dT%H:%M:%S", "/data/backups")

    def op_backup_restore_test(self, j: Job):
        j.vmsh("restaurar-teste", *([j.p["folder"]] if "folder" in j.p else []))

    def op_recovery_point_create(self, j: Job):
        j.vmsh("ponto-recuperacao")

    def op_database_fingerprint(self, j: Job):
        j.vmsh("impressao-digital")

    def op_migration_precheck(self, j: Job):
        j.vmsh("preflight", *([j.p["version"]] if "version" in j.p else []))

    def op_migrate(self, j: Job):
        j.vmsh("migrar", j.p["version"])

    def op_prepare_version(self, j: Job):
        j.vmsh("preparar-versao", j.p["version"])

    def op_activate_version(self, j: Job):
        v = j.p["version"]
        migrada = self.ler_estado("migrada")
        if migrada != v:
            raise FalhaPasso(f"a versão migrada é '{migrada or 'nenhuma'}', não {v}: rode migrate {v} antes")
        self.ativar(j, v)

    def op_rollback_version(self, j: Job):
        v = j.p["version"]
        if v not in self.versoes_ativadas():
            raise FalhaPasso(f"{v} nunca foi ativada por este runner: use activate_version ou rollback_to_recovery_point")
        _, saida = j.psql(SQL_MIGRACOES)
        desconhecidas = self.comparar_migracoes(j, saida, v, exigir=False)
        if desconhecidas:
            raise FalhaPasso("o banco tem migrations que a versão alvo não conhece: use rollback_to_recovery_point")
        self.ativar(j, v)

    def op_rollback_to_recovery_point(self, j: Job):
        ponto = ler_env(os.path.join(self.cfg.estado_cenario, "ponto-recuperacao"))
        etiqueta = ponto.get("ETIQUETA", "")
        if not RE_SHA.match(etiqueta):
            raise FalhaPasso("ponto de recuperação ausente ou sem versão válida")
        self.fixar_etiqueta(j, etiqueta)
        j.vmsh("recuperar", "--sim", env={"CENARIO_TAG": etiqueta})
        self.registrar_ativacao(etiqueta, "rollback_to_recovery_point", j.jti)

    def op_maintenance_on(self, j: Job):
        j.vmsh("manutencao")

    def op_maintenance_off(self, j: Job):
        v = self.etiqueta_dropin() or self.etiqueta_env()
        if not v or not RE_SHA.match(v):
            raise FalhaPasso("versão ativa desconhecida")
        self.ativar(j, v, registrar=False)

    def op_restart_api(self, j: Job):
        j.compose("restart", "api")

    def op_restart_web(self, j: Job):
        j.compose("restart", "web")

    def op_restart_application(self, j: Job):
        j.compose("restart", "api", "web")

    def op_restart_containers(self, j: Job):
        j.compose("restart")

    def op_run_homologation_tests(self, j: Job):
        s = j.p["suite"]
        falhas = []
        etapas = {"saude": [("saude", lambda: j.vmsh("saude"))],
                  "acesso": [("acesso", lambda: j.vmsh("diagnosticar-acesso", "24"))],
                  "websocket": [("websocket", lambda: self.op_websocket_test(j))]}
        etapas["completo"] = etapas["saude"] + etapas["acesso"] + etapas["websocket"]
        for nome, f in etapas[s]:
            try:
                f()
                j.saida.linha(f"✔ suíte {nome}")
            except FalhaPasso as e:
                falhas.append(nome)
                j.saida.linha(f"✘ suíte {nome}: {e}")
        if falhas:
            raise FalhaPasso(f"suítes com falha: {falhas}")

    def op_update_runner(self, j: Job):
        v = j.p["version"]
        pacote = self.g.baixar_versao(f"runner-{v}.tar.gz")
        esperado = self.g.baixar_versao(f"runner-{v}.sha256").decode(errors="replace").split()[0]
        obtido = hashlib.sha256(pacote).hexdigest()
        if not re.fullmatch(r"[0-9a-f]{64}", esperado) or obtido != esperado:
            raise FalhaPasso(f"SHA-256 do pacote não confere (esperado {esperado[:16]}…, obtido {obtido[:16]}…)")
        j.saida.linha(f"✔ pacote runner-{v} íntegro ({obtido})")
        with tempfile.TemporaryDirectory(prefix="cenario-runner-") as tmp:
            arq = os.path.join(tmp, "p.tar.gz")
            with open(arq, "wb") as f:
                f.write(pacote)
            destino = os.path.join(tmp, "x")
            os.mkdir(destino, 0o700)
            esperados = {"cenario_runner.py", "cenario-runner.service", "instalar.sh", "VERSAO"}
            with tarfile.open(arq, "r:gz") as t:
                membros = t.getmembers()
                if sorted(m.name for m in membros) != sorted(esperados) or any(not m.isfile() for m in membros):
                    raise FalhaPasso("pacote com conteúdo inesperado")
                for m in membros:  # só 4 arquivos regulares de nome fixo: nada de caminhos, links ou dispositivos
                    with t.extractfile(m) as origem:
                        self.gravar(os.path.join(destino, m.name), origem.read(), 0o700)
            with open(os.path.join(destino, "VERSAO"), encoding="utf-8") as f:
                if f.read().strip() != v:
                    raise FalhaPasso("VERSAO do pacote difere da pedida")
            j.cmd(["/bin/bash", os.path.join(destino, "instalar.sh"), destino], env={"CENARIO_RUNNER_ADIAR_REINICIO": "1"})

    # ======================================================================== P1: imagens Docker
    def inventario_imagens(self, j: Job) -> tuple[list[dict], dict[str, str]]:
        """Imagens da APLICAÇÃO (repositório api/web do ambiente) com a decisão de cada uma.
        Protegidas: versão ativa, candidata, migrada, a do ponto de recuperação, a ativada antes da
        atual (rollback) e a mais recente além da ativa; qualquer imagem usada por contêiner (mesmo
        parado); e o mesmo ID de qualquer imagem protegida. Fora do repositório da aplicação: nunca."""
        ativa = self.etiqueta_dropin() or self.etiqueta_env()
        if not RE_SHA.match(ativa or ""):
            raise FalhaPasso("versão ativa desconhecida: nada é removido")
        bases = {self.imagem(s, "x").rsplit(":", 1)[0] for s in ("api", "web")}
        _, bruto = j.cmd(["docker", "image", "ls", "--no-trunc", "--format", "{{json .}}"], capturar=True)
        imagens = []
        for l in bruto.decode(errors="replace").splitlines():
            if l.strip():
                try:
                    imagens.append(json.loads(l))
                except ValueError as e:
                    raise FalhaPasso(f"saída inesperada do docker image ls: {e}") from e
        _, ids = j.cmd(["docker", "ps", "-a", "--no-trunc", "--format", "{{.ID}}"], capturar=True)
        ids = ids.decode(errors="replace").split()
        em_uso: set[str] = set()
        if ids:
            _, s = j.cmd(["docker", "inspect", "--format", "{{.Image}}", *ids], capturar=True)
            em_uso = set(s.decode(errors="replace").split())
            if len(em_uso) == 0:
                raise FalhaPasso("não identifiquei as imagens dos contêineres: nada é removido")
        ponto = ler_env(os.path.join(self.cfg.estado_cenario, "ponto-recuperacao")).get("ETIQUETA", "")
        motivos: dict[str, str] = {}

        def proteger(v: str, motivo: str) -> None:
            if RE_SHA.match(v or ""):
                motivos.setdefault(v, motivo)

        proteger(ativa, "versão ativa")
        proteger(self.etiqueta_env(), "versão do ambiente da pilha")
        proteger(self.ler_estado("candidata"), "candidata")
        proteger(self.ler_estado("migrada"), "migrada")
        proteger(ponto, "versão do ponto de recuperação")
        anteriores = [v for v in self.historico_ativacoes() if not (v.startswith(ativa) or ativa.startswith(v))]
        if anteriores:
            proteger(anteriores[-1], "ativada antes da atual (rollback)")
        app = [i for i in imagens if i.get("Repository") in bases and RE_SHA.match(i.get("Tag", ""))]
        # Versão inteira (api + web) em uso se QUALQUER imagem dela é usada por um contêiner, mesmo parado.
        for i in app:
            if i["ID"] in em_uso:
                proteger(i["Tag"], "em uso por contêiner")
        # A mais recente além da ativa é uma VERSÃO diferente: etiquetas que apontam para as mesmas
        # imagens da ativa (mesmo ID) são apelidos dela, não a versão anterior.
        ids_ativa = {i["ID"] for i in app if i["Tag"].startswith(ativa) or ativa.startswith(i["Tag"])}
        outras = sorted({i["Tag"] for i in app if not (i["Tag"].startswith(ativa) or ativa.startswith(i["Tag"]))
                         and not ({x["ID"] for x in app if x["Tag"] == i["Tag"]} & ids_ativa)},
                        key=lambda t: max(i.get("CreatedAt", "") for i in app if i["Tag"] == t), reverse=True)
        if outras:
            proteger(outras[0], "mais recente além da ativa (rollback)")

        def motivo_de(tag: str) -> str:
            return next((m for v, m in motivos.items() if tag.startswith(v) or v.startswith(tag)), "")

        ids_protegidos = {i["ID"] for i in imagens
                          if not (i.get("Repository") in bases and RE_SHA.match(i.get("Tag", ""))) or motivo_de(i["Tag"])}
        for i in imagens:
            ref = f"{i.get('Repository')}:{i.get('Tag')}"
            if i.get("Repository") not in bases or not RE_SHA.match(i.get("Tag", "")):
                i["decisao"], i["ref"] = "fora do repositório da aplicação: nunca removida", ref
            elif motivo_de(i["Tag"]):
                i["decisao"], i["ref"] = f"PROTEGIDA ({motivo_de(i['Tag'])})", ref
            elif i["ID"] in em_uso:
                i["decisao"], i["ref"] = "PROTEGIDA (usada por contêiner)", ref
            elif i["ID"] in ids_protegidos:
                i["decisao"], i["ref"] = "PROTEGIDA (mesmo ID de imagem protegida)", ref
            else:
                i["decisao"], i["ref"] = "REMOVER", ref
        return imagens, motivos

    def mostrar_inventario(self, j: Job, imagens: list[dict], motivos: dict[str, str]) -> list[dict]:
        j.saida.linha("versões protegidas: " + ", ".join(f"{v} ({m})" for v, m in motivos.items()))
        for i in sorted(imagens, key=lambda x: (x["decisao"] != "REMOVER", x["ref"])):
            j.saida.linha(f"  {'✘ remover ' if i['decisao'] == 'REMOVER' else '✔ manter  '} {i['ref']}  {i['ID'][:19]}  "
                          f"{i.get('Size', '?')}  {i.get('CreatedAt', '')[:19]}  — {i['decisao']}")
        candidatas = [i for i in imagens if i["decisao"] == "REMOVER"]
        j.saida.linha(f"• candidatas à remoção: {len(candidatas)}")
        return candidatas

    def op_images_cleanup_plan(self, j: Job):
        self.mostrar_inventario(j, *self.inventario_imagens(j))
        j.cmd(["docker", "system", "df"], permitir=(0, 1))
        j.saida.linha(f"• disco livre em /: {shutil.disk_usage('/').free / 2**30:.2f} GiB (nada foi removido)")

    def op_images_cleanup(self, j: Job):
        antes = shutil.disk_usage("/").free
        candidatas = self.mostrar_inventario(j, *self.inventario_imagens(j))
        j.cmd(["docker", "system", "df"], permitir=(0, 1))
        falhas = 0
        for i in candidatas:
            # Sem --force: o Docker recusa remover imagem ainda usada por qualquer contêiner.
            codigo, _ = j.cmd(["docker", "image", "rm", i["ref"]], permitir=(0, 1))
            if codigo == 0:
                j.saida.linha(f"✔ removida {i['ref']} (ID {i['ID']}, digest {i.get('Digest') or '-'})")
            else:
                falhas += 1
                j.saida.linha(f"✘ não removida {i['ref']} (o Docker recusou)")
        depois = shutil.disk_usage("/").free
        j.cmd(["docker", "system", "df"], permitir=(0, 1))
        j.saida.linha(f"• disco livre em /: antes {antes / 2**30:.2f} GiB · depois {depois / 2**30:.2f} GiB · "
                      f"recuperado {(depois - antes) / 2**30:.2f} GiB · removidas {len(candidatas) - falhas}/{len(candidatas)}")
        if not candidatas:
            j.saida.linha("✔ nada a remover (idempotente)")
        if falhas:
            raise FalhaPasso(f"{falhas} remoção(ões) recusada(s) pelo Docker")

    # ======================================================================== P2: scripts da VM
    def pacote_scripts(self, v: str) -> tuple[str, dict[str, tuple[bytes, int]]]:
        """Baixa e confere o pacote scripts-<v>.tar.gz PUBLICADO (bucket de versões, gravação humana):
        SHA-256, commit do git archive (começa por <v>), só caminhos de infra/homolog e scripts de backup,
        só arquivos regulares e diretórios, tamanho limitado e arquivos obrigatórios presentes."""
        pacote = self.g.baixar_versao(f"scripts-{v}.tar.gz")
        esperado = self.g.baixar_versao(f"scripts-{v}.sha256").decode(errors="replace").split()[0]
        obtido = hashlib.sha256(pacote).hexdigest()
        if not re.fullmatch(r"[0-9a-f]{64}", esperado) or obtido != esperado:
            raise FalhaPasso(f"SHA-256 do pacote não confere (esperado {esperado[:16]}…, obtido {obtido[:16]}…)")
        arquivos: dict[str, tuple[bytes, int]] = {}
        total = 0
        try:
            with tarfile.open(fileobj=io.BytesIO(pacote), mode="r:gz") as t:
                membros = t.getmembers()
                commit = t.pax_headers.get("comment", "")
                if not re.fullmatch(r"[0-9a-f]{40}", commit) or not commit.startswith(v):
                    raise FalhaPasso("o pacote não é o git archive do commit pedido")
                for m in membros:
                    nome = m.name.rstrip("/")
                    if not RE_MEMBRO_SCRIPTS.match(m.name) or any(p in (".", "..") for p in nome.split("/")):
                        raise FalhaPasso(f"pacote com caminho não permitido: {m.name!r}")
                    if m.isdir():
                        continue
                    if nome in DIRETORIOS_SCRIPTS:
                        raise FalhaPasso(f"pacote com arquivo no lugar de diretório: {m.name!r}")
                    if not m.isfile():
                        raise FalhaPasso(f"pacote com link ou arquivo especial: {m.name!r}")
                    total += m.size
                    if total > LIMITE_PACOTE_SCRIPTS:
                        raise FalhaPasso("pacote grande demais")
                    with t.extractfile(m) as f:
                        arquivos[nome] = (f.read(), 0o755 if m.mode & 0o111 else 0o644)
        except (tarfile.TarError, OSError, EOFError) as e:
            raise FalhaPasso(f"pacote ilegível: {e}") from e
        faltam = [o for o in SCRIPTS_OBRIGATORIOS if o not in arquivos]
        if faltam:
            raise FalhaPasso(f"pacote sem arquivos obrigatórios: {faltam}")
        return commit, arquivos

    @staticmethod
    def categoria(nome: str) -> str:
        if nome == "infra/homolog/gcp/vm.sh":
            return "vm.sh"
        if nome.startswith("infra/homolog/docker-compose"):
            return "Compose"
        if nome.startswith("infra/homolog/Caddyfile"):
            return "Caddy"
        if nome.startswith("infra/homolog/gcp/autonomia/"):
            return "autonomia (não executado a partir de /opt/cenario)"
        if "/testes/" in nome or nome.endswith((".md", ".test.ts")):
            return "testes/documentação"
        return "scripts auxiliares"

    def op_vm_scripts_diff(self, j: Job):
        v = j.p["version"]
        commit, arquivos = self.pacote_scripts(v)
        base = self.cfg.dir_cenario
        try:
            with open(os.path.join(base, "VERSAO"), encoding="utf-8") as f:
                atual = f.read().strip()
        except OSError:
            atual = "desconhecida"
        j.saida.linha(f"✔ pacote scripts-{v} íntegro (commit {commit}, {len(arquivos)} arquivos)")
        j.saida.linha(f"• /opt/cenario atual: {atual} → pacote: {v}")
        mudancas: dict[str, list[str]] = collections.defaultdict(list)
        diffs: list[tuple[str, bytes, bytes]] = []
        for nome in sorted(arquivos):
            dados, modo = arquivos[nome]
            local = os.path.join(base, nome)
            try:
                with open(local, "rb") as f:
                    atual_b = f.read()
                modo_atual = os.stat(local).st_mode & 0o777
            except OSError:
                mudancas[self.categoria(nome)].append(f"+ novo      {nome} ({len(dados)} bytes, sha256 {hashlib.sha256(dados).hexdigest()[:16]}…)")
                continue
            if atual_b != dados:
                mudancas[self.categoria(nome)].append(f"~ alterado  {nome}")
                diffs.append((nome, atual_b, dados))
            elif (modo_atual & 0o111 != 0) != (modo & 0o111 != 0):
                mudancas[self.categoria(nome)].append(f"~ permissão {nome}: {oct(modo_atual)} → {oct(modo)}")
        so_vm = []
        for raiz, _, nomes in os.walk(base):
            for n in nomes:
                rel = os.path.relpath(os.path.join(raiz, n), base)
                if rel != "VERSAO" and rel not in arquivos:
                    so_vm.append(rel)
        for cat in ("vm.sh", "Compose", "Caddy", "scripts auxiliares", "autonomia (não executado a partir de /opt/cenario)",
                    "testes/documentação"):
            linhas = mudancas.get(cat, [])
            j.saida.linha(f"== {cat}: {len(linhas)} mudança(s)")
            for l in linhas:
                j.saida.linha("   " + l)
        j.saida.linha(f"== só na VM (mantidos, nunca apagados): {len(so_vm)}")
        for n in sorted(so_vm):
            j.saida.linha(f"   = {n}")
        for nome, a, b in diffs:
            j.saida.linha(f"---------------------------------------------------------------- diff {nome}")
            for l in difflib.unified_diff(a.decode("utf-8", errors="replace").splitlines(),
                                          b.decode("utf-8", errors="replace").splitlines(),
                                          f"/opt/cenario/{nome}", f"scripts-{v}/{nome}", lineterm="", n=3):
                j.saida.linha(l)
        if not diffs and not any(mudancas.values()):
            j.saida.linha("✔ /opt/cenario já é idêntico ao pacote")

    def op_vm_scripts_update(self, j: Job):
        v = j.p["version"]
        commit, arquivos = self.pacote_scripts(v)
        base = self.cfg.dir_cenario
        j.saida.linha(f"✔ pacote scripts-{v} íntegro (commit {commit}, {len(arquivos)} arquivos)")
        env = ler_env(self.cfg.env_arquivo)
        with tempfile.TemporaryDirectory(prefix="cenario-scripts-") as tmp:
            for nome, (dados, modo) in arquivos.items():
                destino = os.path.join(tmp, nome)
                os.makedirs(os.path.dirname(destino), mode=0o755, exist_ok=True)
                self.gravar(destino, dados, modo)
            os.chmod(tmp, 0o755)
            # Antes de trocar qualquer arquivo: o vm.sh novo é bash válido, o Compose novo é válido com o
            # ambiente atual e o Caddyfile novo é aceito pelo Caddy da pilha (sem rede, nada iniciado).
            j.cmd(["bash", "-n", os.path.join(tmp, "infra/homolog/gcp/vm.sh")])
            j.cmd(["docker", "compose", "-f", os.path.join(tmp, "infra/homolog/docker-compose.homolog.yml"),
                   "--env-file", self.cfg.env_arquivo, "config", "-q"])
            j.cmd(["docker", "run", "--rm", "--network", "none", "-v",
                   f"{os.path.join(tmp, 'infra/homolog/Caddyfile.homolog')}:/etc/caddy/Caddyfile:ro",
                   *[x for n in VARS_CADDY for x in ("-e", n)], IMAGEM_CADDY,
                   "caddy", "validate", "--config", "/etc/caddy/Caddyfile", "--adapter", "caddyfile"],
                  env={n: env.get(n, "") for n in VARS_CADDY})
        copia = f"{base}.anterior-{dt.datetime.now(dt.timezone.utc):%Y%m%dT%H%M%S}Z-{j.jti[:8]}"
        shutil.copytree(base, copia, symlinks=True)
        j.saida.linha(f"✔ cópia anterior guardada: {copia}")
        trocados = 0
        for nome, (dados, modo) in sorted(arquivos.items()):
            destino = os.path.join(base, nome)
            try:
                with open(destino, "rb") as f:
                    if f.read() == dados and (os.stat(destino).st_mode & 0o777) == modo:
                        continue
            except OSError:
                pass
            os.makedirs(os.path.dirname(destino), mode=0o755, exist_ok=True)
            self.gravar(destino + ".cenario-novo", dados, modo)
            os.chmod(destino + ".cenario-novo", modo)
            os.replace(destino + ".cenario-novo", destino)
            trocados += 1
            j.saida.linha(f"  ✔ {nome}")
        self.gravar(os.path.join(base, "VERSAO"), v + "\n", 0o644)
        self.gravar(os.path.join(self.cfg.estado, "scripts-anterior"), copia + "\n")
        j.saida.linha(f"✔ /opt/cenario na versão {v}: {trocados} arquivo(s) atualizado(s); arquivos locais fora do "
                      f"pacote mantidos. Nada foi reiniciado: aplique com apply_stack_config.")

    def op_vm_scripts_restore(self, j: Job):
        base = self.cfg.dir_cenario
        try:
            with open(os.path.join(self.cfg.estado, "scripts-anterior"), encoding="utf-8") as f:
                copia = f.read().strip()
        except OSError as e:
            raise FalhaPasso("nenhuma cópia registrada por vm_scripts_update") from e
        if not copia.startswith(base + ".anterior-") or "/" in copia[len(base):] or not os.path.isdir(copia):
            raise FalhaPasso("cópia registrada inválida ou ausente")
        substituido = f"{base}.substituido-{dt.datetime.now(dt.timezone.utc):%Y%m%dT%H%M%S}Z-{j.jti[:8]}"
        os.rename(base, substituido)
        os.rename(copia, base)
        os.remove(os.path.join(self.cfg.estado, "scripts-anterior"))
        j.saida.linha(f"✔ /opt/cenario restaurado de {copia}; a versão substituída ficou em {substituido}. "
                      f"Nada foi reiniciado: aplique com apply_stack_config.")

    def op_apply_stack_config(self, j: Job):
        v = self.etiqueta_dropin() or self.etiqueta_env()
        if not RE_SHA.match(v or ""):
            raise FalhaPasso("versão ativa desconhecida")
        j.saida.linha(f"• versão ativa mantida: {v} (mesmas imagens; nenhuma migration)")
        j.vmsh("aplicar-config", env={"CENARIO_TAG": v})
        self.ativar(j, v, registrar=False)

    # ======================================================================== auxiliares
    def imagem(self, servico: str, versao: str) -> str:
        env = ler_env(self.cfg.env_arquivo)
        atual = env.get("CENARIO_API_IMAGE" if servico == "api" else "CENARIO_WEB_IMAGE", "")
        base = atual.rsplit(":", 1)[0] if ":" in atual else f"us-east1-docker.pkg.dev/{self.cfg.projeto}/cenario-homolog/{servico}"
        if not re.fullmatch(r"[a-z0-9.-]+-docker\.pkg\.dev/[a-z0-9-]+/[a-z0-9-]+/(api|web)", base):
            raise FalhaPasso("repositório de imagens inesperado no ambiente")
        return f"{base}:{versao}"

    def ler_estado(self, nome: str) -> str:
        try:
            with open(os.path.join(self.cfg.estado_cenario, nome), encoding="utf-8") as f:
                return f.read().strip()
        except OSError:
            return ""

    def etiqueta_dropin(self) -> str:
        try:
            with open(self.cfg.dropin_etiqueta, encoding="utf-8") as f:
                m = re.search(r"CENARIO_TAG=([0-9a-f]{7,40})", f.read())
                return m.group(1) if m else ""
        except OSError:
            return ""

    def etiqueta_env(self) -> str:
        m = re.search(r":([0-9a-f]{7,40})$", ler_env(self.cfg.env_arquivo).get("CENARIO_API_IMAGE", ""))
        return m.group(1) if m else ""

    def fixar_etiqueta(self, j: Job, v: str) -> None:
        """A versão que sobe num reinício da VM fica numa configuração LOCAL do serviço (o vm.sh dá
        precedência a CENARIO_TAG sobre o metadado), sem exigir permissão de alterar metadados."""
        os.makedirs(os.path.dirname(self.cfg.dropin_etiqueta), mode=0o755, exist_ok=True)
        tmp = self.cfg.dropin_etiqueta + ".novo"
        self.gravar(tmp, f"# Gerado pelo cenario-runner (job {j.jti}). Versão que sobe na partida.\n[Service]\nEnvironment=CENARIO_TAG={v}\n", 0o644)
        os.replace(tmp, self.cfg.dropin_etiqueta)
        j.cmd([self.cfg.systemctl, "daemon-reload"])
        j.saida.linha(f"✔ etiqueta local fixada em {v}")

    def ativar(self, j: Job, v: str, registrar: bool = True) -> None:
        self.fixar_etiqueta(j, v)
        j.vmsh("ativar", v, env={"CENARIO_TAG": v})
        if registrar:
            self.registrar_ativacao(v, j.claims["operacao"], j.jti)

    def registrar_ativacao(self, v: str, operacao: str, jti: str) -> None:
        with open(self.historico, "a", encoding="utf-8") as f:
            f.write(json.dumps({"versao": v, "operacao": operacao, "jti": jti, "quando": iso(agora())}) + "\n")

    def versoes_ativadas(self) -> set[str]:
        return set(self.historico_ativacoes())

    def historico_ativacoes(self) -> list[str]:
        """Versões ativadas por este runner, na ordem (a última é a ativação mais recente)."""
        try:
            with open(self.historico, encoding="utf-8") as f:
                return [json.loads(l)["versao"] for l in f if l.strip()]
        except (OSError, ValueError, KeyError):
            return []

    def _conectar(self) -> ssl.SSLSocket:
        ctx = ssl.create_default_context()
        if not self.cfg.https_verificar:  # conexão a 127.0.0.1: o certificado é do domínio, conferido pelo vm.sh saude
            ctx.check_hostname, ctx.verify_mode = False, ssl.CERT_NONE
        bruto = socket.create_connection(self.cfg.https_local, timeout=15)
        return ctx.wrap_socket(bruto, server_hostname=self.cfg.dominio)

    def https_local(self, j: Job, caminho: str, com_cookie: bool) -> tuple[int, bytes]:
        cab = [f"GET {caminho} HTTP/1.1", f"Host: {self.cfg.dominio}", "Connection: close", "User-Agent: cenario-runner"]
        if com_cookie:
            token = ler_env(self.cfg.env_arquivo).get("HOMOLOG_GATE_TOKEN", "")
            if token:
                cab.append(f"Cookie: cenario_homolog={token}")
        try:
            with self._conectar() as s:
                s.sendall(("\r\n".join(cab) + "\r\n\r\n").encode())
                dados = b""
                while len(dados) < 65536:
                    bloco = s.recv(4096)
                    if not bloco:
                        break
                    dados += bloco
        except OSError as e:
            j.saida.linha(f"✘ conexão https local falhou: {e}")
            return 0, b""
        m = re.match(rb"HTTP/1\.[01] (\d{3})", dados)
        return (int(m.group(1)) if m else 0), dados.partition(b"\r\n\r\n")[2]

    def websocket_handshake(self, j: Job) -> int:
        chave = base64.b64encode(os.urandom(16)).decode()
        cab = [f"GET /api/realtime HTTP/1.1", f"Host: {self.cfg.dominio}", "Upgrade: websocket", "Connection: Upgrade",
               f"Sec-WebSocket-Key: {chave}", "Sec-WebSocket-Version: 13", f"Origin: https://{self.cfg.dominio}"]
        token = ler_env(self.cfg.env_arquivo).get("HOMOLOG_GATE_TOKEN", "")
        if token:
            cab.append(f"Cookie: cenario_homolog={token}")
        try:
            with self._conectar() as s:
                s.sendall(("\r\n".join(cab) + "\r\n\r\n").encode())
                dados = s.recv(4096)
        except OSError as e:
            j.saida.linha(f"✘ conexão falhou: {e}")
            return 0
        m = re.match(rb"HTTP/1\.[01] (\d{3})", dados)
        return int(m.group(1)) if m else 0

    # ======================================================================== laço
    def ciclo(self) -> int:
        if os.path.exists(self.cfg.desativado):
            time.sleep(5)
            return 0
        msgs = self.g.puxar(5)
        for msg in msgs:
            ack = msg.get("ackId", "")
            if self.receber(msg) == "adiado":
                self.g.devolver(ack)
            else:
                self.g.confirmar(ack)
        return len(msgs)

    def pendentes_reenvio(self) -> None:
        for jti in os.listdir(self.jobs_dir):
            d = os.path.join(self.jobs_dir, jti)
            if os.path.exists(os.path.join(d, "resultado.json")) and not os.path.exists(os.path.join(d, "enviado")):
                self.enviar_resultado(jti)

    def rodar(self) -> None:
        self.preparar()
        threading.Thread(target=self.agendador, daemon=True).start()
        self.auditar("partida", assinatura=self.cfg.assinatura, assinante=self.cfg.assinante, operacoes=sorted(OPERACOES))
        espera, ultimo = 1.0, agora()
        while not self.parar.is_set():
            try:
                self.ciclo()
                espera = 1.0
            except Exception as e:  # noqa: BLE001 — falha fechada: nada executa; tenta de novo com recuo
                self.auditar("erro_fila", motivo=str(e)[:300])
                time.sleep(espera)
                espera = min(espera * 2, 60)
            if agora() - ultimo > 300:
                self.pendentes_reenvio()
                self.limpar_antigos()
                ultimo = agora()


def catalogo() -> dict:
    """Operações e schemas (para documentação e para o cliente)."""
    return {nome: {"classe": op.classe, "resumo": op.resumo, "timeout": [op.timeout_min, op.timeout_padrao, op.timeout_max],
                   "parametros": {k: {"tipo": p.tipo, "obrigatorio": p.obrigatorio, "padrao": p.padrao,
                                      **({"intervalo": [p.minimo, p.maximo]} if p.tipo == "inteiro" else {}),
                                      **({"opcoes": list(p.opcoes)} if p.opcoes else {})} for k, p in op.params.items()}}
            for nome, op in sorted(OPERACOES.items())}


def main(argv: list[str]) -> int:
    if len(argv) > 1 and argv[1] == "--versao":
        print(VERSAO)
        return 0
    if len(argv) > 1 and argv[1] == "--catalogo":
        print(json.dumps(catalogo(), ensure_ascii=False, indent=1))
        return 0
    cfg = Config(os.environ.get("CENARIO_RUNNER_CONFIG", CONFIG_PADRAO))
    if os.geteuid() != 0 and os.environ.get("CENARIO_RUNNER_TESTE") != "1":
        print("o executor precisa rodar como root (systemd)", file=sys.stderr)
        return SAIDA_CONFIG
    r = Runner(cfg)
    signal.signal(signal.SIGTERM, lambda *_: r.parar.set())
    r.rodar()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
