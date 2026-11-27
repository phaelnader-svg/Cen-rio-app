import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AgentDto, GameSpaceDto } from '@cenario/shared';
import type { App } from '../src/app';
import { type Client, createTestApp, db, idemKey, loginAdmin, resetDatabase } from './helpers';

/**
 * Agente contratado pelo Escritório do Cenário aparece no Firma Viva (2026-11-25): o jogo só
 * desenha agente sentado numa mesa, então quem é contratado já ganha mesa livre do escritório e,
 * sem mesa sobrando, a planta ganha mesas novas.
 */
let app: App;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(() => app.close());
beforeEach(async () => {
  await resetDatabase();
  await db().companySettings.update({ where: { id: 1 }, data: { plan: 'gestao_jogo' } });
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;
const ok = <T = J>(r: { status: number; body: J }, status = 200): T => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body as T;
};
const hire = (c: Client, roleKey: string) =>
  c
    .req('POST', '/api/v1/office/hire', { roleKey }, { 'idempotency-key': idemKey() })
    .then((r) => ok(r, 201));

async function seatedEveryone(c: Client, expected: number) {
  const agents = ok<AgentDto[]>(await c.get('/api/v1/game/agents')).filter(
    (a) => a.status !== 'DESATIVADO',
  );
  expect(agents).toHaveLength(expected);
  const office = ok<GameSpaceDto>(await c.get('/api/v1/game/spaces/ESCRITORIO'));
  const desks = new Set(
    office.stations.filter((s) => s.kind === 'MESA_ESCRITORIO').map((s) => s.id),
  );
  for (const a of agents) expect(desks.has(a.deskStationId ?? ''), a.name).toBe(true);
  expect(new Set(agents.map((a) => a.deskStationId)).size).toBe(agents.length);
  return { agents, office, desks };
}

describe('Contratar no Escritório põe o agente no jogo', () => {
  it('ocupa as mesas livres e, sem mesa sobrando, a sala ganha mesas novas', async () => {
    const admin = await loginAdmin(app);
    ok(await admin.get('/api/v1/game/spaces')); // jogo aberto: Gerente e Financeiro já sentados
    for (const role of ['ATENDIMENTO', 'COMPRAS', 'ORCAMENTOS', 'MARKETING'])
      await hire(admin, role);
    const { office, desks } = await seatedEveryone(admin, 6);
    expect(desks.size).toBe(6); // 4 da sala sugerida + 2 novas
    expect(office.version).toBe(3); // uma mesa nova a cada contratação sem mesa livre
    const rev = await db().gameLayoutRevision.findFirst({ orderBy: { version: 'desc' } });
    expect(rev?.summary).toMatch(/Mesa nova para agente contratado/);
  });

  it('quem foi contratado antes de abrir o jogo senta ao abrir', async () => {
    const admin = await loginAdmin(app);
    await hire(admin, 'ORCAMENTOS');
    await hire(admin, 'MARKETING');
    await seatedEveryone(admin, 2);
  });
});
