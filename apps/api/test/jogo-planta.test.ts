import { createHash, randomBytes } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { GameSnapshotDto, GameSpaceDto } from '@cenario/shared';
import type { App } from '../src/app';
import { setClock } from '../src/core/clock';
import { createTokenHasher } from '../src/lib/crypto';
import { panelUserWith } from './commercial-helpers';
import { Client, createTestApp, db, idemKey, loginAdmin, resetDatabase } from './helpers';
import { tabletOf, userIdOf } from './production-helpers';

/**
 * Ambiente interativo, etapa 1: a planta da oficina e do escritório fica guardada no Cenário
 * (ids estáveis, versão, histórico), com as pessoas reais nas estações, e o Firma Viva lê tudo
 * pelo escopo "jogo". Dados fictícios.
 */
let app: App;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(() => app.close());
beforeEach(async () => {
  await resetDatabase();
  setClock();
});

const put = (c: Client, url: string, body: unknown) =>
  c.req('PUT', url, body, { 'idempotency-key': idemKey() });
const space = async (c: Client, key: string) =>
  (await c.get(`/api/v1/game/spaces/${key}`)).body as GameSpaceDto;

describe('jogo — planta persistente', () => {
  it('cria a planta sugerida com a equipe real, salva com versão e reabre com os vínculos', async () => {
    const admin = await loginAdmin(app);
    const office = await space(admin, 'ESCRITORIO');
    const shop = await space(admin, 'TAPECARIA');
    expect(shop.illustrative).toBe(true);

    const deskId = crypto.randomUUID();
    const bigger = {
      ...office,
      depthCm: office.depthCm + 300,
      stations: [
        ...office.stations,
        {
          id: deskId,
          kind: 'MESA_ESCRITORIO',
          name: 'Mesa 5',
          areaId: office.areas[0]!.id,
          xCm: 60,
          yCm: 650,
          wCm: 140,
          dCm: 70,
          rotation: 0,
          activities: [],
          shared: false,
          assigneeUserIds: [],
        },
      ],
    };
    const savedOffice = await put(admin, '/api/v1/game/spaces/ESCRITORIO', bigger);
    expect(savedOffice.status, JSON.stringify(savedOffice.body)).toBe(200);
    expect(savedOffice.body.version).toBe(office.version + 1);

    // A bancada sugerida já vem com o funcionário real; mudar de lugar mantém id e vínculo.
    const ricardo = await userIdOf('Ricardo');
    const bench = shop.stations.find((s) => s.name === 'Bancada do Ricardo')!;
    expect(bench.assigneeUserIds).toEqual([ricardo]);
    const moved = {
      ...shop,
      stations: shop.stations.map((s) =>
        s.id === bench.id ? { ...s, xCm: s.xCm + 50, rotation: 180 } : s,
      ),
    };
    expect((await put(admin, '/api/v1/game/spaces/TAPECARIA', moved)).status).toBe(200);
    expect((await put(admin, '/api/v1/game/spaces/TAPECARIA', moved)).body.error.code).toBe(
      'VERSION_CONFLICT',
    );

    const again = await loginAdmin(app);
    const shop2 = await space(again, 'TAPECARIA');
    expect(shop2.stations.find((s) => s.id === bench.id)).toMatchObject({
      xCm: bench.xCm + 50,
      rotation: 180,
      assigneeUserIds: [ricardo],
    });
    expect((await space(again, 'ESCRITORIO')).stations.some((s) => s.id === deskId)).toBe(true);
    const revs = (await again.get('/api/v1/game/spaces/TAPECARIA/revisions')).body as {
      version: number;
    }[];
    expect(revs[0]!.version).toBe(shop2.version);
    expect(await db().auditLog.count({ where: { action: 'game.layout_saved' } })).toBe(2);

    const people = await again.get('/api/v1/game/people');
    expect(people.status).toBe(200);
    expect(JSON.stringify(people.body)).toContain('Ricardo');
    const snap = await again.get('/api/v1/game/snapshot');
    expect(snap.status, JSON.stringify(snap.body)).toBe(200);
    const snapshot = snap.body as GameSnapshotDto;
    expect(snapshot.employees.map((e) => e.userId)).toContain(ricardo);
  });

  it('remover estação com vínculos exige escolher o destino; a removida fica desativada', async () => {
    const admin = await loginAdmin(app);
    const shop = await space(admin, 'TAPECARIA');
    const ricardoBench = shop.stations.find((s) => s.name === 'Bancada do Ricardo')!;
    const marcioBench = shop.stations.find((s) => s.name === 'Bancada do Márcio')!;
    const without = { ...shop, stations: shop.stations.filter((s) => s.id !== ricardoBench.id) };
    const r = await put(admin, '/api/v1/game/spaces/TAPECARIA', without);
    expect(r.status).toBe(409);
    expect(r.body.error.details.impacts[0]).toMatchObject({ kind: 'ESTACAO', id: ricardoBench.id });
    const ok2 = await put(admin, '/api/v1/game/spaces/TAPECARIA', {
      ...without,
      transfers: { stations: { [ricardoBench.id]: marcioBench.id } },
    });
    expect(ok2.status, JSON.stringify(ok2.body)).toBe(200);
    expect(
      (ok2.body as GameSpaceDto).stations.find((s) => s.id === marcioBench.id)!.assigneeUserIds,
    ).toHaveLength(2);
    expect((await db().gameStation.findUnique({ where: { id: ricardoBench.id } }))!.active).toBe(
      false,
    );
  });

  it('só quem tem a permissão do jogo entra; tablet nunca entra', async () => {
    const admin = await loginAdmin(app);
    const t = await tabletOf(app, admin, 'João', '121212');
    expect((await t.get('/api/v1/game/spaces')).status).toBe(403);
    expect((await t.get('/api/v1/game/snapshot')).status).toBe(403);
    const seller = await panelUserWith(app, admin, 'vendas', ['os.ver', 'producao.ver']);
    expect((await seller.get('/api/v1/game/spaces')).status).toBe(403);
    const viewer = await panelUserWith(app, admin, 'jogo-ver', ['jogo.acessar']);
    expect((await viewer.get('/api/v1/game/spaces')).status).toBe(200);
    const shop = await space(viewer, 'TAPECARIA');
    expect((await put(viewer, '/api/v1/game/spaces/TAPECARIA', shop)).status).toBe(403);
  });
});

describe('jogo — leitura pelo Firma Viva (escopo "jogo")', () => {
  const SECRET = 'segredo-de-teste-do-firma-viva-0123456789abcdef';
  const REDIRECT = 'http://localhost:3100/api/conexoes/cenario/retorno';

  async function tokenFor(admin: Client, scope: string) {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const r = await admin.post('/api/oauth/authorize', {
      client_id: 'firma-viva',
      redirect_uri: REDIRECT,
      scope,
      state: 'estado-123456',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      org_ref: `org-${scope.replace(/\W/g, '')}`,
      org_label: 'Cenário Estofados',
      decision: 'allow',
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const code = new URL(r.body.redirect as string).searchParams.get('code')!;
    const server = new Client(app, null);
    const t = await server.post('/api/oauth/token', {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      redirect_uri: REDIRECT,
      client_id: 'firma-viva',
      client_secret: SECRET,
    });
    expect(t.status, JSON.stringify(t.body)).toBe(200);
    return { server, token: t.body.access_token as string, scope: t.body.scope as string };
  }

  it('com "jogo" lê a planta e salva; só com "consulta" não entra', async () => {
    const hash = createTokenHasher(process.env.TOKEN_HASH_SECRET!);
    await db().oAuthClient.create({
      data: {
        clientId: 'firma-viva',
        name: 'Firma Viva',
        secretHash: hash(SECRET),
        redirectUris: [REDIRECT],
        allowedScopes: ['consulta', 'jogo'],
      },
    });
    const admin = await loginAdmin(app);
    const full = await tokenFor(admin, 'consulta jogo');
    expect(full.scope.split(' ').sort()).toEqual(['consulta', 'jogo']);
    const auth = { authorization: `Bearer ${full.token}` };
    const spaces = await full.server.req('GET', '/api/v1/game/spaces', undefined, auth);
    expect(spaces.status, JSON.stringify(spaces.body)).toBe(200);
    expect((await full.server.req('GET', '/api/v1/game/snapshot', undefined, auth)).status).toBe(
      200,
    );

    const read = await tokenFor(admin, 'consulta');
    const denied = await read.server.req('GET', '/api/v1/game/spaces', undefined, {
      authorization: `Bearer ${read.token}`,
    });
    expect(denied.status).toBe(403);
  });
});
