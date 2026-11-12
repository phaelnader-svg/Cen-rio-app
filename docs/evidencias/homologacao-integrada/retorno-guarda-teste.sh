#!/usr/bin/env bash
# Teste do retorno com a guarda (imagens locais F2 = 63674f1 e R2 = 341badb), bancos LOCAIS
# descartáveis restaurados da semente representativa (/var/tmp/rb-seed.dump).
set -u
P=postgresql://cenario:local_teste@127.0.0.1:5432
NOPROXY=(-e HTTPS_PROXY= -e HTTP_PROXY= -e https_proxy= -e http_proxy=)
ALERTS="select count(*) from notifications where resolved_at is null and kind in ('PRAZO_EM_RISCO','PECA_PRONTA_SEM_ENTREGA','MATERIAL_FALTANTE')"
fresh() { psql -q $P/postgres -c "DROP DATABASE IF EXISTS $1" -c "CREATE DATABASE $1" 2>/dev/null; pg_restore -d $P/$1 --no-owner /var/tmp/rb-seed.dump; }
migrate_r2() { # exatamente o comando de vm.sh migrar
  docker run --rm --network host "${NOPROXY[@]}" -e MIGRATE_ON_START=0 -e DATABASE_URL=$P/$1 \
    --entrypoint sh local/api:R2 -c 'pnpm db:migrate && pnpm db:status' 2>&1
}
start_r2() { # partida da API como no Compose (MIGRATE_ON_START=0)
  docker rm -f rt-api >/dev/null 2>&1
  docker run -d --name rt-api --network host "${NOPROXY[@]}" -v /var/tmp/rb-storage:/data/storage \
    -e APP_ENV=staging -e NODE_ENV=production -e MIGRATE_ON_START=0 -e DATABASE_URL=$P/$1 \
    -e API_HOST=127.0.0.1 -e API_PORT=4600 -e ALLOWED_ORIGINS=https://homolog.local -e COOKIE_SECURE=true \
    -e TOKEN_HASH_SECRET="$(openssl rand -hex 24)" -e STORAGE_DIR=/data/storage -e CHECKPOINT_DISABLE=1 \
    --memory=512m local/api:R2 >/dev/null
}

echo "████ CASO 1 — peças aprovadas sem embalagem e não entregues: retorno BLOQUEADO"
fresh rt_block
/var/tmp/rb-snapshot.sh $P/rt_block > /tmp/rt1-a.txt
n0=$(psql $P/rt_block -Atc "select count(*) from notifications"); a0=$(psql $P/rt_block -Atc "$ALERTS")
echo "▶ migrar com R2"; migrate_r2 rt_block; echo "  código de saída: ${PIPESTATUS[0]}"
echo "▶ iniciar API R2"; start_r2 rt_block; sleep 20
echo "  estado: $(docker inspect -f 'running={{.State.Running}} exit={{.State.ExitCode}}' rt-api)"; docker logs rt-api 2>&1 | grep -E "RETORNO|•|guarda" | head -5
/var/tmp/rb-snapshot.sh $P/rt_block > /tmp/rt1-b.txt
diff -q /tmp/rt1-a.txt /tmp/rt1-b.txt >/dev/null && echo "✔ 22 tabelas idênticas" || { echo "✘ TABELAS ALTERADAS"; diff /tmp/rt1-a.txt /tmp/rt1-b.txt; }
echo "  avisos: total $n0 → $(psql $P/rt_block -Atc 'select count(*) from notifications') · F4 abertos $a0 → $(psql $P/rt_block -Atc "$ALERTS")"
echo "  migrations: $(psql $P/rt_block -Atc 'select count(*) from _prisma_migrations')"

echo "████ CASO 2 — peças entregues na versão integrada: retorno LIBERADO"
fresh rt_ok
echo "▶ F2: prontidão e entrega das peças pela API (sem SQL)"
docker rm -f rt-f2 >/dev/null 2>&1
docker run -d --name rt-f2 --network host "${NOPROXY[@]}" -v /var/tmp/rb-storage:/data/storage \
  -e APP_ENV=staging -e NODE_ENV=production -e MIGRATE_ON_START=0 -e DATABASE_URL=$P/rt_ok \
  -e API_HOST=127.0.0.1 -e API_PORT=4601 -e ALLOWED_ORIGINS=https://homolog.local -e COOKIE_SECURE=true \
  -e TOKEN_HASH_SECRET="$(openssl rand -hex 24)" -e STORAGE_DIR=/data/storage -e CHECKPOINT_DISABLE=1 \
  -e DISABLE_BACKGROUND_JOBS=true --memory=512m local/api:F2 >/dev/null
for i in $(seq 1 45); do curl -sf http://127.0.0.1:4601/api/ready >/dev/null && break; sleep 2; done
node /var/tmp/rt-f2.mjs http://127.0.0.1:4601 /var/tmp/rb-ids.json
docker rm -f rt-f2 >/dev/null
/var/tmp/rb-snapshot.sh $P/rt_ok > /tmp/rt2-a.txt
a0=$(psql $P/rt_ok -Atc "$ALERTS")
echo "▶ migrar com R2"; migrate_r2 rt_ok; echo "  código de saída: ${PIPESTATUS[0]}"
echo "  avisos F4 abertos: $a0 → $(psql $P/rt_ok -Atc "$ALERTS") · auditoria: $(psql $P/rt_ok -Atc "select count(*) || ' · ' || coalesce(max(summary),'') from audit_logs where action='system.rollback_prepared'")"
echo "▶ migrar de novo (idempotência)"; migrate_r2 rt_ok | grep -E "guarda|up to date"; echo "  auditorias: $(psql $P/rt_ok -Atc "select count(*) from audit_logs where action='system.rollback_prepared'")"
echo "▶ iniciar API R2 e ler as telas"; start_r2 rt_ok
for i in $(seq 1 45); do curl -sf http://127.0.0.1:4600/api/ready >/dev/null && break; sleep 2; done
echo "  ready=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:4600/api/ready)"; docker logs rt-api 2>&1 | grep -E "guarda" | head -2
node /var/tmp/rb-verify.mjs http://127.0.0.1:4600 /var/tmp/rb-ids.json /var/tmp/rt-verify.json | python3 -c "import sys,json; d=json.load(sys.stdin); print('  rotas:', {k:v for k,v in d['statuses'].items() if v!=200}, '(demais 200)'); print('  peças:', d['pieceSofa'], d['piecePoltronas']); print('  mão de obra E:', d['laborE'], '· Q:', d['laborQ']); print('  cobrança:', d['receivable'])"
echo "  aguardando 180 s com as rotinas periódicas ligadas…"; sleep 180
/var/tmp/rb-snapshot.sh $P/rt_ok > /tmp/rt2-b.txt
diff -q /tmp/rt2-a.txt /tmp/rt2-b.txt >/dev/null && echo "✔ 22 tabelas idênticas ao estado antes do retorno" || { echo "✘ TABELAS ALTERADAS"; diff /tmp/rt2-a.txt /tmp/rt2-b.txt; }
docker rm -f rt-api >/dev/null
