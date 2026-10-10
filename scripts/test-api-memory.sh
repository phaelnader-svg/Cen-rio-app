#!/usr/bin/env bash
# Evolução, Fase 8 — memória e latência da API como PROCESSO REAL, com o mesmo limite de heap
# da VM de homologação e2-small (NODE_OPTIONS=--max-old-space-size=320, contêiner de 512 MB).
# Somente local e com banco de TESTE já povoado (ex.: após closing-perf: 40 OS, 200 tarefas,
# 160 obrigações). Mede RSS do processo (amostra a cada 0,5 s) e p50/p95 por rota sob carga
# concorrente (painel + leituras equivalentes às de 4 tablets).
#
# Uso: DB_URL=postgresql://…/cenario_perf_test scripts/test-api-memory.sh [segundos] [concorrência]
set -euo pipefail
: "${DB_URL:?DB_URL não definido (banco de teste já povoado)}"
[[ "$DB_URL" == *test* ]] || { echo "Recusado: o banco precisa ser de teste." >&2; exit 1; }
SECONDS_RUN="${1:-60}"
CONC="${2:-8}"
PORT="${PORT:-4999}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
LOG="$(mktemp)"

cd "$ROOT/apps/api"
APP_ENV=test NODE_ENV=test DATABASE_URL="$DB_URL" API_PORT="$PORT" API_HOST=127.0.0.1 \
  ALLOWED_ORIGINS="http://localhost:3000" LOG_LEVEL=warn STORAGE_DIR="$(mktemp -d)" \
  TOKEN_HASH_SECRET="memoria-local-memoria-local-memoria-1234" \
  NODE_OPTIONS="--max-old-space-size=320" \
  node --import tsx src/server.ts > "$LOG" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null || true; rm -f "$LOG"' EXIT
for _ in $(seq 1 60); do
  curl -fsS "http://127.0.0.1:$PORT/api/health" > /dev/null 2>&1 && break
  sleep 0.5
done
curl -fsS "http://127.0.0.1:$PORT/api/health" > /dev/null || { cat "$LOG" >&2; echo "✖ API não subiu" >&2; exit 1; }

rss() { awk '/VmRSS/ {print int($2/1024)}' "/proc/$PID/status"; }
IDLE="$(rss)"
PEAK="$IDLE"
( while kill -0 $PID 2>/dev/null; do r="$(rss)"; echo "$r"; sleep 0.5; done ) > "$LOG.rss" &
SAMPLER=$!

node - "$PORT" "$SECONDS_RUN" "$CONC" <<'JS'
const [port, secs, conc] = process.argv.slice(2).map(Number);
const base = `http://127.0.0.1:${port}`;
const origin = 'http://localhost:3000';
// Uma sessão por trabalhador (o limite de requisições é por sessão: 600/min).
async function session() {
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin },
    body: JSON.stringify({ email: 'gestor@teste.local', password: 'SenhaDeTeste123' }),
  });
  if (login.status !== 200) throw new Error(`login ${login.status}`);
  const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  return (p) => fetch(base + p, { headers: { cookie, origin } });
}
const get = await session();
const monday = (() => {
  const d = new Date(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date()) + 'T12:00:00Z');
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
})();
const plans = await (await get('/api/v1/production-plans')).json();
const planId = (Array.isArray(plans) ? plans : plans.items ?? [])[0]?.id;
const workers = await (await get('/api/v1/production/workers')).json();
const routes = [
  `/api/v1/finance/weekly-closings/${monday}`,
  `/api/v1/finance/weekly-closings/${monday}?format=csv`,
  ...(planId ? [`/api/v1/production-plans/${planId}`, `/api/v1/production-plans/${planId}/distribution`] : []),
  ...workers.slice(0, 4).map((w) => `/api/v1/production-queue/${w.userId}`),
  '/api/v1/finance/labor',
];
const key = (r) => r.replace(/[0-9a-f-]{36}/g, ':id');
const lat = {};
const errors = {};
const end = Date.now() + secs * 1000;
const PACE_MS = 110; // < 600 req/min por sessão
await Promise.all(
  Array.from({ length: conc }, async (_, w) => {
    const g = await session();
    let i = w;
    while (Date.now() < end) {
      const r = routes[i++ % routes.length];
      const t0 = performance.now();
      const res = await g(r);
      await res.arrayBuffer();
      const ms = performance.now() - t0;
      if (res.status !== 200) errors[res.status] = (errors[res.status] ?? 0) + 1;
      else (lat[key(r)] ??= []).push(ms);
      if (ms < PACE_MS) await new Promise((ok) => setTimeout(ok, PACE_MS - ms));
    }
  }),
);
const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return Math.round(s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] ?? 0); };
const out = {};
for (const [r, xs] of Object.entries(lat)) out[r] = { n: xs.length, p50: pct(xs, 50), p95: pct(xs, 95) };
console.log(JSON.stringify({ seconds: secs, concurrency: conc, errors, routes: out }));
JS
kill $SAMPLER 2>/dev/null || true
PEAK="$(sort -n "$LOG.rss" | tail -1)"
echo "{\"rssMb\":{\"idle\":$IDLE,\"peak\":$PEAK,\"limitContainer\":512,\"heapLimit\":320}}"  # 2ª linha do resultado
kill $PID; wait $PID 2>/dev/null || true
rm -f "$LOG.rss"
