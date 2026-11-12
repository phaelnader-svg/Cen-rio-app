// Guarda da VERSÃO DE RETORNO integrada (3e0d2d0 + migrations das Fases 2 e 3).
//
// Esta versão é o código anterior às Fases 2–4 rodando sobre o banco já migrado. Ela não conhece
// a embalagem opcional da Fase 3: uma peça aprovada SEM embalagem e ainda não entregue ficaria
// presa (a entrega exige embalagem concluída, e não existe registro de embalagem para ela). Por
// isso o retorno é BLOQUEADO enquanto houver peças assim — nenhuma regra de embalagem, entrega ou
// financeiro é alterada para permitir o retorno.
//
// Modos (sem dependências além do cliente `pg` da própria imagem):
//   verificar  só lê. Lista as peças incompatíveis; código 78 se houver (a API não inicia).
//   preparar   verifica; se houver peça incompatível, sai com código 3 SEM alterar nada. Se não
//              houver, encerra numa única transação os avisos internos da Fase 4 ainda abertos
//              (PRAZO_EM_RISCO, PECA_PRONTA_SEM_ENTREGA, MATERIAL_FALTANTE — esta versão não os
//              recalcula nem os encerra sozinha) e registra uma auditoria. Idempotente.
// Usado por `pnpm db:migrate` (antes das migrations: é o passo que `vm.sh migrar` executa antes de
// ativar) e por infra/homolog/api-iniciar.sh (verificar, antes de iniciar a API).
import { createRequire } from 'node:module';

const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const { Client } = require('pg');

const PHASE4_ALERTS = ['PRAZO_EM_RISCO', 'PECA_PRONTA_SEM_ENTREGA', 'MATERIAL_FALTANTE'];
const mode = process.argv[2];
if (mode !== 'verificar' && mode !== 'preparar') {
  console.error('Uso: node infra/homolog/retorno-guarda.mjs verificar|preparar');
  process.exit(2);
}
const url = process.env.DATABASE_URL;
if (!url) {
  console.error('✘ DATABASE_URL não definido.');
  process.exit(2);
}

const code = (n, p) => `OS-${String(n).padStart(5, '0')}/${p}`;

async function incompatiblePieces(db) {
  const col = await db.query(
    `SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'quality_inspections'
        AND column_name = 'packaging_required'`,
  );
  if (col.rowCount === 0) return []; // banco anterior à Fase 3: não existe peça sem embalagem.
  const r = await db.query(
    `WITH ultima AS (
       SELECT DISTINCT ON (qi.service_order_item_id)
              qi.service_order_item_id, qi.status, qi.packaging_required
         FROM quality_inspections qi
        ORDER BY qi.service_order_item_id, qi.round DESC
     )
     SELECT i.id, so.number, i.position, i.description, i.fulfillment_stage
       FROM ultima u
       JOIN service_order_items i ON i.id = u.service_order_item_id
       JOIN service_orders so ON so.id = i.service_order_id
      WHERE u.status = 'APROVADA'
        AND NOT u.packaging_required
        AND i.fulfillment_stage NOT IN ('ENTREGUE', 'DEVOLVIDA', 'CANCELADA')
      ORDER BY so.number, i.position`,
  );
  return r.rows.map((x) => ({
    id: x.id,
    code: code(x.number, x.position),
    description: x.description,
    stage: x.fulfillment_stage,
  }));
}

const db = new Client({ connectionString: url });
try {
  await db.connect();
} catch (e) {
  console.error(
    `✘ guarda do retorno: banco inacessível (${e.code ?? e.message}). Nada foi alterado.`,
  );
  process.exit(4);
}
let exitCode = 0;
try {
  const pieces = await incompatiblePieces(db);
  if (pieces.length) {
    console.error(
      `✘ RETORNO BLOQUEADO: ${pieces.length} peça(s) aprovada(s) sem embalagem e ainda não entregue(s).`,
    );
    for (const p of pieces)
      console.error(`   • ${p.code} · ${p.description} · ${p.stage} · id ${p.id}`);
    console.error(
      '  Entregue essas peças na versão integrada antes de voltar para esta versão. Nada foi alterado.',
    );
    exitCode = mode === 'verificar' ? 78 : 3;
  } else if (mode === 'verificar') {
    console.log('✔ guarda do retorno: nenhuma peça aprovada sem embalagem pendente de entrega.');
  } else {
    await db.query('BEGIN');
    const res = await db.query(
      `UPDATE notifications SET resolved_at = now()
        WHERE resolved_at IS NULL AND kind = ANY($1::text[])
        RETURNING id, kind`,
      [PHASE4_ALERTS],
    );
    const byKind = {};
    for (const row of res.rows) byKind[row.kind] = (byKind[row.kind] ?? 0) + 1;
    if (res.rowCount > 0) {
      await db.query(
        `INSERT INTO audit_logs (id, action, entity_type, entity_id, summary, changes)
         VALUES (gen_random_uuid(), 'system.rollback_prepared', 'system', NULL, $1, $2::jsonb)`,
        [
          `Retorno de versão: ${res.rowCount} aviso(s) interno(s) da Fase 4 encerrado(s)`,
          JSON.stringify({ resolvedAlerts: byKind, notificationIds: res.rows.map((r) => r.id) }),
        ],
      );
    }
    await db.query('COMMIT');
    console.log(
      `✔ guarda do retorno: nenhuma peça incompatível; avisos da Fase 4 encerrados: ${res.rowCount}` +
        (res.rowCount ? ` (${JSON.stringify(byKind)})` : ''),
    );
  }
} catch (e) {
  await db.query('ROLLBACK').catch(() => {});
  console.error(`✘ guarda do retorno falhou: ${e.message}. Nada foi alterado.`);
  exitCode = 4;
} finally {
  await db.end();
}
process.exit(exitCode);
