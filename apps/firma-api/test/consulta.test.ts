import type { GameSnapshotDto, GameSpaceDto } from '@cenario/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildApp, type FirmaApp } from '../src/app';
import { loadEnv } from '../src/env';
import { type Browser, createOrg, fdb, login } from './helpers';

/**
 * Conexão em MODO CONSULTA com um Cenário Gestão como o de produção (sem a API do jogo, com o
 * mapa da oficina e o escopo "consulta"). O Cenário aqui é um dublê que registra cada chamada,
 * para provar que o Firma Viva nunca envia alterações (OS, estoque, financeiro) a ele.
 */
const calls: { method: string; path: string }[] = [];
const PIECE = (id: string, code: string, stage: string) => ({
  id,
  code,
  description: 'Sofá 3 lugares',
  pieceType: 'SOFA',
  quantity: 1,
  serviceOrderId: `so-${id}`,
  serviceOrderCode: code.split('/')[0]!,
  customerName: 'Cliente Real',
  stage,
  receiptLocations: [],
  movedAt: '2026-11-15T12:00:00.000Z',
  movedBy: 'Gestor',
});
const fakeCenario = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  const method = init?.method ?? 'GET';
  calls.push({ method, path: url.pathname });
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (url.pathname === '/api/oauth/token')
    return json({
      access_token: 'acesso',
      refresh_token: 'renovacao',
      expires_in: 3600,
      scope: 'consulta',
      grant_id: 'g1',
      user: { id: 'u1', name: 'Gestor Real', email: 'gestor@empresa' },
      company: { name: 'Cenário Estofados', document: '00.000.000/0001-00' },
    });
  if (url.pathname === '/api/v1/apps/me')
    return json({
      permissions: ['painel.acessar', 'empresa.ver', 'os.ver', 'producao.ver', 'entregas.ver'],
    });
  if (url.pathname === '/api/v1/workshop-map')
    return json({
      areas: [
        {
          id: 'l1',
          key: 'MESA_PRODUCAO',
          label: 'Mesa de produção',
          position: 1,
          active: true,
          pieces: [PIECE('p1', 'OS-00123/1', 'EM_PRODUCAO')],
        },
      ],
      unplaced: [PIECE('p2', 'OS-00124/1', 'RECEBIDA')],
      can: { move: false, manageAreas: false },
    });
  return json({ error: { code: 'NOT_FOUND', message: 'Rota não encontrada.' } }, 404);
}) as typeof fetch;

let firma: FirmaApp;
beforeAll(async () => {
  firma = await buildApp({
    env: loadEnv({ ...process.env, FIRMA_CENARIO_SCOPES: 'consulta' }),
    db: fdb(),
    logger: false,
    cenarioFetch: fakeCenario,
  });
});
afterAll(() => firma.close());
beforeEach(async () => {
  calls.length = 0;
  const t = await fdb().$queryRaw<{ tablename: string }[]>`
    SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations'`;
  await fdb().$executeRawUnsafe(`TRUNCATE ${t.map((x) => `"${x.tablename}"`).join(', ')} CASCADE`);
});

async function connectConsulta(b: Browser) {
  const start = await b.post('/api/conexoes/cenario/iniciar');
  const url = new URL(start.body.url as string);
  expect(url.searchParams.get('scope')).toBe('consulta');
  expect(url.searchParams.get('redirect_uri')).toBe(
    'http://localhost:3100/api/conexoes/cenario/retorno',
  );
  const ret = await b.get(
    `/api/conexoes/cenario/retorno?state=${url.searchParams.get('state')}&code=codigo-unico`,
  );
  expect(String(ret.headers.location)).toContain('conexao=ok');
}

describe('modo consulta (Cenário de produção)', () => {
  it('mostra as OS reais no mapa e nunca envia alterações ao Cenário', async () => {
    await createOrg('Cenário Estofados', 'dono@firma.test', 'SenhaFirma2026');
    const b = await login(firma, 'dono@firma.test', 'SenhaFirma2026');
    const planta = (await b.get('/api/v1/game/spaces')).body as GameSpaceDto[];
    await connectConsulta(b);
    const conn = (await b.get('/api/conexoes/cenario')).body;
    expect(conn).toMatchObject({
      status: 'CONECTADA',
      mode: 'CONSULTA',
      company: { name: 'Cenário Estofados' },
    });
    expect((await b.get('/api/auth/me')).body.permissions).toContain('os.ver');

    const snap = (await b.get('/api/v1/game/snapshot')).body as GameSnapshotDto;
    expect(snap.mode).toBe('CONSULTA');
    expect(snap.pieces.map((p) => p.itemCode)).toEqual(['OS-00123/1', 'OS-00124/1']);
    const mesa = snap.pieces[0]!;
    const montagem = planta[0]!.areas.find((a) => a.function === 'MONTAGEM')!;
    expect(mesa.placement).toMatchObject({ areaId: montagem.id, label: 'Mesa de produção' });
    expect(mesa.customerName).toBe('Cliente Real');
    expect(snap.canPlan).toBe(false);
    expect(snap.pieces[1]!.placement.label).toBe('Sem localização registrada');

    // Tentativas de alterar a empresa pelo jogo: recusadas aqui, sem chegar ao Cenário.
    for (const [m, path] of [
      ['POST', '/api/v1/production/plan-services'],
      ['POST', '/api/v1/stock-reservations'],
      ['POST', '/api/v1/finance/payments'],
      ['PUT', '/api/v1/service-orders/so-p1'],
    ] as const) {
      const r = await b.req(m, path, {}, { 'idempotency-key': crypto.randomUUID() });
      expect(r.status, path).toBe(403);
      expect(r.body.error.code).toBe('CONEXAO_SOMENTE_CONSULTA');
    }
    // A planta continua sendo editada no Firma Viva (nada vai ao Cenário).
    const saved = await b.put(
      '/api/v1/game/spaces/TAPECARIA',
      { ...planta[0]!, name: 'Tapeçaria' },
      { 'idempotency-key': 'x1' },
    );
    expect(saved.status).toBe(200);
    const writes = calls.filter((c) => c.method !== 'GET' && !c.path.startsWith('/api/oauth/'));
    expect(writes).toEqual([]);
    expect(calls.some((c) => c.path.startsWith('/api/v1/game/'))).toBe(false);
  });
});
