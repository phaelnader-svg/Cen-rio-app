import {
  pieceWorkflow,
  type GamePieceDto,
  type GameSnapshotDto,
  type GameSpaceDto,
} from '@cenario/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App as CenarioApp } from '../../api/src/app';
import { setClock } from '../../api/src/core/clock';
import { db as cenarioDb, loginAdmin } from '../../api/test/helpers';
import {
  act,
  serviceOrderWith,
  tabletOf,
  today,
  userIdOf,
} from '../../api/test/production-helpers';
import type { FirmaApp } from '../src/app';
import { Browser, createOrg, fdb, login, resetAll, setup } from './helpers';

/**
 * Firma Viva como produto independente, com o Cenário Gestão real em processo:
 * login próprio, planta antes da conexão, conexão pela tela oficial do Cenário (PKCE), OS da
 * empresa no mapa, atribuição pelo jogo e início confirmado no tablet oficial, desconexão e
 * revogação suspendendo só as ações integradas, e isolamento entre organizações.
 */
let cenario: CenarioApp;
let firma: FirmaApp;
beforeAll(async () => {
  ({ cenario, firma } = await setup());
});
afterAll(async () => {
  await firma.close();
  await cenario.close();
});
beforeEach(async () => {
  await resetAll();
  setClock();
});

const PW = 'SenhaFirma2026';
const idem = () => ({ 'idempotency-key': crypto.randomUUID().replace(/-/g, '') });

/** Conecta a organização da sessão: tela oficial do Cenário (gestor entra lá) → retorno. */
async function connect(b: Browser) {
  const start = await b.post('/api/conexoes/cenario/iniciar');
  expect(start.status).toBe(200);
  const url = new URL(start.body.url as string);
  expect(url.origin + url.pathname).toBe('http://localhost:3000/autorizar');
  const params = Object.fromEntries(url.searchParams);
  // Senha digitada SÓ no Cenário (login oficial do painel).
  const gestor = await loginAdmin(cenario);
  const info = await gestor.get(`/api/oauth/authorize/info?${url.searchParams.toString()}`);
  expect(info.status).toBe(200);
  const auth = await gestor.post('/api/oauth/authorize', { ...params, decision: 'allow' });
  const back = new URL(auth.body.redirect as string);
  const ret = await b.get(`${back.pathname}${back.search}`);
  expect(ret.status).toBe(302);
  return { location: String(ret.headers.location), gestor };
}

describe('Firma Viva', () => {
  it('antes de conectar: entra, monta a planta e vê o convite para conectar', async () => {
    await createOrg('Cenário Estofados', 'dono@firma.test', PW);
    expect(
      (
        await new Browser(firma).post('/api/auth/login', {
          email: 'dono@firma.test',
          password: 'errada',
        })
      ).status,
    ).toBe(401);
    const b = await login(firma, 'dono@firma.test', PW);
    const me = await b.get('/api/auth/me');
    expect(me.body.organization).toMatchObject({
      name: 'Cenário Estofados',
      role: 'DONO',
      cenario: { status: 'NAO_CONECTADA' },
    });

    const spaces = (await b.get('/api/v1/game/spaces')).body as GameSpaceDto[];
    expect(spaces.map((s) => s.key)).toEqual(['TAPECARIA', 'ESCRITORIO']);
    const office = spaces[1]!;
    const saved = await b.put(
      '/api/v1/game/spaces/ESCRITORIO',
      { ...office, name: 'Escritório da Firma', summary: 'Renomeado' },
      idem(),
    );
    expect(saved.status).toBe(200);
    expect(saved.body.version).toBe(2);
    expect((await b.get('/api/v1/game/agents')).body.map((a: { name: string }) => a.name)).toEqual([
      'Gerente',
      'Compras',
    ]);
    // Mapa abre sem empresa; dados da empresa pedem a conexão.
    const snap = await b.get('/api/v1/game/snapshot');
    expect(snap.status).toBe(200);
    expect(snap.body.pieces).toEqual([]);
    const os = await b.get('/api/v1/service-orders');
    expect(os.status).toBe(409);
    expect(os.body.error.code).toBe('CONEXAO_NECESSARIA');
    const central = (await b.get('/api/v1/connections')).body as {
      key: string;
      status: string;
      label: string;
    }[];
    expect(central).toHaveLength(1);
    expect(central[0]).toMatchObject({
      key: 'CENARIO',
      label: 'Cenário Gestão',
      status: 'DESCONECTADA',
    });
  });

  it('conecta pela tela oficial, mostra a empresa, atribui pelo jogo e o funcionário inicia no tablet', async () => {
    await createOrg('Cenário Estofados', 'dono@firma.test', PW);
    const b = await login(firma, 'dono@firma.test', PW);
    // Planta editada antes: como o Cenário só tem a sugerida, a do Firma Viva é enviada.
    const spaces = (await b.get('/api/v1/game/spaces')).body as GameSpaceDto[];
    await b.put(
      '/api/v1/game/spaces/ESCRITORIO',
      { ...spaces[1]!, name: 'Escritório da Firma' },
      idem(),
    );

    const { location, gestor } = await connect(b);
    expect(location).toBe('http://localhost:3100/jogo?central=CENARIO&conexao=ok');
    const conn = await b.get('/api/conexoes/cenario');
    expect(conn.body.status).toBe('CONECTADA');
    expect(conn.body.company.name).toBeTruthy();
    expect(conn.body.permissions).toContain('producao.planejar');
    expect(conn.body.permissions).not.toContain('producao.executar');
    const row = await fdb().cenarioConnection.findFirstOrThrow();
    expect(row.accessEnc).toMatch(/^v1\./); // selado
    expect(JSON.stringify(conn.body)).not.toMatch(/access|refresh|v1\./);
    expect(row.lastError, row.lastError ?? '').toBeNull();
    const remoteOffice = await cenarioDb().gameSpace.findUniqueOrThrow({
      where: { key: 'ESCRITORIO' },
    });
    expect(remoteOffice.name).toBe('Escritório da Firma');

    // OS de teste da empresa aparece no mapa do Firma Viva.
    const { so } = await serviceOrderWith(gestor, 'complete', 'Cliente Firma');
    const piece = async () =>
      ((await b.get('/api/v1/game/snapshot')).body as GameSnapshotDto).pieces.find(
        (p) => p.id === so.items[0].id,
      ) as GamePieceDto;
    expect(pieceWorkflow(await piece()).phase).toBe('AGUARDANDO_PLANEJAMENTO');

    // Atribuição pelo jogo (fluxo oficial de planejamento e publicação).
    const marcioId = await userIdOf('Márcio');
    const planned = await b.post(
      '/api/v1/production/plan-services',
      {
        entries: [
          {
            serviceOrderId: so.id,
            startDate: today(),
            pieces: so.items.map((i: { id: string }) => ({
              serviceOrderItemId: i.id,
              upholstererUserId: marcioId,
            })),
          },
        ],
      },
      idem(),
    );
    expect(planned.status, JSON.stringify(planned.body)).toBe(201);
    const planId = planned.body.planned[0].planId;
    const plan = (await b.get(`/api/v1/production-plans/${planId}`)).body;
    expect(
      (
        await b.post(
          `/api/v1/production-plans/${planId}/publish`,
          { version: plan.version },
          idem(),
        )
      ).status,
    ).toBe(200);
    const corte = (await piece()).tasks.find((t) => t.activity === 'CORTE_TECIDO')!;
    expect(corte.status).toBe('LIBERADA');
    // O jogo não inicia a etapa: só o funcionário, no tablet oficial.
    expect((await b.post(`/api/v1/production-tasks/${corte.id}/start`, {}, idem())).status).toBe(
      403,
    );
    const marcio = await tabletOf(cenario, gestor, 'Márcio', '736152');
    expect((await act(marcio, corte.id, 'start')).status).toBe(200);
    expect(pieceWorkflow(await piece()).phase).toBe('EM_EXECUCAO');

    // Auditoria: no Cenário com aplicativo/organização/pessoa; no Firma Viva com a empresa.
    const cenarioLog = await cenarioDb().auditLog.findFirst({
      where: { summary: { contains: 'via Firma Viva · Cenário Estofados' } },
    });
    expect(cenarioLog).toBeTruthy();
    const firmaLog = await fdb().auditLog.findFirst({ where: { action: 'cenario.acao' } });
    expect(firmaLog?.company).toBeTruthy();
  });

  it('desconectar e revogar suspendem só as ações integradas; a planta continua', async () => {
    await createOrg('Cenário Estofados', 'dono@firma.test', PW);
    const b = await login(firma, 'dono@firma.test', PW);
    const { gestor } = await connect(b);
    expect((await b.get('/api/v1/service-orders')).status).toBe(200);

    // Revogação no painel do Cenário → o Firma Viva suspende e explica como reconectar.
    const grants = await gestor.get('/api/v1/apps/grants');
    await gestor.post(`/api/v1/apps/grants/${grants.body[0].id}/revoke`);
    await fdb().cenarioConnection.updateMany({ data: { accessExpiresAt: new Date(0) } }); // força renovação
    const after = await b.get('/api/v1/service-orders');
    expect(after.status).toBe(409);
    expect(after.body.error.code).toBe('CONEXAO_SUSPENSA');
    expect(after.body.error.message).toMatch(/Reconecte/);
    expect((await b.get('/api/conexoes/cenario')).body.status).toBe('REVOGADA');
    expect((await b.get('/api/v1/game/spaces')).status).toBe(200);

    // Reconectar e depois Desconectar pelo jogo.
    await connect(b);
    expect((await b.get('/api/conexoes/cenario')).body.status).toBe('CONECTADA');
    const d = await b.post('/api/conexoes/cenario/desconectar');
    expect(d.body.status).toBe('DESCONECTADA');
    expect((await b.get('/api/v1/service-orders')).body.error.code).toBe('CONEXAO_NECESSARIA');
    const spaces = await b.get('/api/v1/game/spaces');
    expect(spaces.status).toBe(200);
    expect(spaces.body.length).toBe(2);
    expect(await cenarioDb().oAuthGrant.count({ where: { revokedAt: null } })).toBe(0);
  });

  it('isolamento: outra organização não abre OS, planta nem integração da empresa A', async () => {
    const a = await createOrg('Cenário Estofados', 'dono@firma.test', PW);
    const bOrg = await createOrg('Oficina Modelo', 'outra@firma.test', PW);
    const ownerA = await login(firma, 'dono@firma.test', PW);
    const { gestor } = await connect(ownerA);
    const { so } = await serviceOrderWith(gestor, 'complete', 'Cliente Firma');
    const planA = (await ownerA.get('/api/v1/game/spaces')).body as GameSpaceDto[];

    const ownerB = await login(firma, 'outra@firma.test', PW);
    expect((await ownerB.get('/api/auth/me')).body.organization.name).toBe('Oficina Modelo');
    // Pelo ID direto: a OS da empresa A não é alcançável pela organização B.
    const direct = await ownerB.get(`/api/v1/service-orders/${so.id}`);
    expect(direct.status).toBe(409);
    expect(direct.body.error.code).toBe('CONEXAO_NECESSARIA');
    // Trocar para a organização A: recusado (não é membro).
    expect((await ownerB.post('/api/auth/organizacao', { orgId: a.org.id })).status).toBe(404);
    // Editar a "Tapeçaria" mexe só na planta da própria organização.
    const planB = (await ownerB.get('/api/v1/game/spaces')).body as GameSpaceDto[];
    expect(planB[0]!.id).not.toBe(planA[0]!.id);
    await ownerB.put(
      '/api/v1/game/spaces/TAPECARIA',
      { ...planB[0]!, name: 'Tapeçaria B' },
      idem(),
    );
    const aSpaces = await fdb().space.findMany({ where: { orgId: a.org.id } });
    expect(aSpaces.find((s) => s.key === 'TAPECARIA')!.name).not.toBe('Tapeçaria B');
    // Integração: a organização B não consegue vincular a mesma empresa.
    const start = await ownerB.post('/api/conexoes/cenario/iniciar');
    const url = new URL(start.body.url as string);
    const auth = await gestor.post('/api/oauth/authorize', {
      ...Object.fromEntries(url.searchParams),
      decision: 'allow',
    });
    const back = new URL(auth.body.redirect as string);
    const ret = await ownerB.get(`${back.pathname}${back.search}`);
    expect(decodeURIComponent(String(ret.headers.location))).toMatch(
      /já está vinculada a outra organização/,
    );
    expect(
      await fdb().cenarioConnection.count({ where: { orgId: bOrg.org.id, status: 'CONECTADA' } }),
    ).toBe(0);
    // A conexão de A segue funcionando.
    expect((await ownerA.get(`/api/v1/service-orders/${so.id}`)).status).toBe(200);
    // Retorno com o state de A não serve para B (state ligado à pessoa).
    const startA = await ownerA.post('/api/conexoes/cenario/iniciar');
    const stA = new URL(startA.body.url as string).searchParams.get('state');
    const stolen = await ownerB.get(`/api/conexoes/cenario/retorno?state=${stA}&code=qualquer`);
    expect(decodeURIComponent(String(stolen.headers.location))).toMatch(/inválido ou expirado/);
  });

  it('convite, papéis e recuperação de senha', async () => {
    await createOrg('Cenário Estofados', 'dono@firma.test', PW);
    const owner = await login(firma, 'dono@firma.test', PW);
    const inv = await owner.post('/api/org/convites', {
      email: 'ricardo@firma.test',
      role: 'MEMBRO',
    });
    expect(inv.status).toBe(200);
    const token = String(inv.body.devLink).split('/convite/')[1]!;
    const anon = new Browser(firma);
    expect((await anon.get(`/api/auth/convite/${token}`)).body).toMatchObject({
      organization: 'Cenário Estofados',
      hasAccount: false,
    });
    const accepted = await anon.post(`/api/auth/convite/${token}`, {
      name: 'Ricardo',
      password: 'Ricardo2026x',
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body.organization.role).toBe('MEMBRO');
    expect(
      (await anon.post(`/api/auth/convite/${token}`, { name: 'X', password: 'Outra2026xx' }))
        .status,
    ).toBe(400);
    // Membro acompanha, não altera.
    const spaces = (await anon.get('/api/v1/game/spaces')).body as GameSpaceDto[];
    expect(
      (await anon.put('/api/v1/game/spaces/TAPECARIA', { ...spaces[0]! }, idem())).status,
    ).toBe(403);
    expect((await anon.post('/api/conexoes/cenario/iniciar')).status).toBe(403);
    // Sem convite não há cadastro aberto; recuperação não revela se a conta existe.
    const r1 = await anon.post('/api/auth/recuperar', { email: 'ninguem@firma.test' });
    const r2 = await anon.post('/api/auth/recuperar', { email: 'ricardo@firma.test' });
    expect(r1.body.message).toBe(r2.body.message);
    const mail = await fdb().outboxMail.findFirstOrThrow({
      where: { to: 'ricardo@firma.test', subject: { contains: 'redefinir' } },
    });
    const resetToken = mail.link!.split('/redefinir-senha/')[1]!;
    expect(
      (await anon.post('/api/auth/redefinir', { token: resetToken, password: 'NovaSenha2026' }))
        .status,
    ).toBe(200);
    expect(
      (await anon.post('/api/auth/redefinir', { token: resetToken, password: 'NovaSenha2027' }))
        .status,
    ).toBe(400);
    await login(firma, 'ricardo@firma.test', 'NovaSenha2026');
    // Origem estranha é recusada (CSRF).
    expect(
      (
        await owner.post(
          '/api/org/convites',
          { email: 'x@y.com', role: 'MEMBRO' },
          { origin: 'https://malicioso.example' },
        )
      ).status,
    ).toBe(403);
  });

  it('entrar com a conta do Cenário (botão do painel): sem senha, sem confirmação, conta ligada', async () => {
    await createOrg('Cenário Estofados', 'dono@firma.test', PW);
    const gestor = await loginAdmin(cenario);
    const cenarioEmail = String((await gestor.get('/api/auth/me')).body.user?.email ?? '');

    /** Navegador novo: botão do Cenário → Firma Viva → tela oficial → retorno. */
    async function enter(expectSkip: boolean) {
      const b = new Browser(firma);
      const start = await b.get('/api/entrar/cenario');
      expect(start.status).toBe(302);
      const url = new URL(String(start.headers.location));
      expect(url.origin + url.pathname).toBe('http://localhost:3000/autorizar');
      expect(url.searchParams.get('prompt')).toBe('none');
      const info = await gestor.get(`/api/oauth/authorize/info?${url.searchParams.toString()}`);
      expect(info.status).toBe(200);
      expect(info.body.skipConsent).toBe(expectSkip);
      const params = Object.fromEntries(url.searchParams);
      const auth = await gestor.post('/api/oauth/authorize', { ...params, decision: 'allow' });
      const back = new URL(auth.body.redirect as string);
      return { b, path: `${back.pathname}${back.search}` };
    }

    // Antes de a empresa conectar o Firma Viva: a tela de confirmação aparece e a entrada é recusada.
    const early = await enter(false);
    const r0 = await early.b.get(early.path);
    expect(String(r0.headers.location)).toContain('/entrar?erro=');
    expect(decodeURIComponent(String(r0.headers.location))).toContain('ainda não está conectada');

    const dono = await login(firma, 'dono@firma.test', PW);
    await connect(dono);

    // Outro navegador não consegue usar o retorno (preso ao navegador que começou).
    const stolen = await enter(true);
    const other = new Browser(firma);
    const r1 = await other.get(stolen.path);
    expect(String(r1.headers.location)).toContain('/entrar?erro=');
    expect((await other.get('/api/auth/me')).status).toBe(401);

    // Entrada direta: sessão aberta na organização conectada, já no jogo.
    const ok = await enter(true);
    const r2 = await ok.b.get(ok.path);
    expect(r2.status).toBe(302);
    expect(String(r2.headers.location)).toBe('http://localhost:3100/jogo');
    const me = await ok.b.get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.organization).toMatchObject({ name: 'Cenário Estofados' });
    const role = me.body.organization.role as string;
    if (cenarioEmail.toLowerCase() === 'dono@firma.test') expect(role).toBe('DONO');
    else expect(role).toBe('MEMBRO');

    // A entrada não deixa acesso guardado no Cenário: só a conexão da organização segue ativa.
    const active = await cenarioDb().oAuthGrant.findMany({ where: { revokedAt: null } });
    expect(active).toHaveLength(1);
    expect(active[0]!.externalRef).toBeTruthy();

    // Segunda entrada usa a mesma conta (sem duplicar) e o navegador já logado vai direto ao jogo.
    const again = await enter(true);
    await again.b.get(again.path);
    expect((await again.b.get('/api/auth/me')).body.user.id).toBe(me.body.user.id);
    expect(await fdb().cenarioLogin.count()).toBe(1);
    const direct = await again.b.get('/api/entrar/cenario');
    expect(String(direct.headers.location)).toBe('http://localhost:3100/jogo');
  });

  it('entrar com a conta do Cenário abre a conta do mesmo e-mail que já é da organização', async () => {
    const gestor = await loginAdmin(cenario);
    const email = String((await gestor.get('/api/auth/me')).body.user?.email ?? '');
    expect(email).toContain('@');
    await createOrg('Cenário Estofados', email, PW);
    await connect(await login(firma, email, PW));
    const b = new Browser(firma);
    const url = new URL(String((await b.get('/api/entrar/cenario')).headers.location));
    const auth = await gestor.post('/api/oauth/authorize', {
      ...Object.fromEntries(url.searchParams),
      decision: 'allow',
    });
    const back = new URL(auth.body.redirect as string);
    await b.get(`${back.pathname}${back.search}`);
    const me = await b.get('/api/auth/me');
    expect(me.body.user.email).toBe(email.toLowerCase());
    expect(me.body.organization.role).toBe('DONO');
  });
});
