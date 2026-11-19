import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App as CenarioApp } from '../../api/src/app';
import { setClock } from '../../api/src/core/clock';
import { Client, db as cenarioDb, loginAdmin } from '../../api/test/helpers';
import type { FirmaApp } from '../src/app';
import { Browser, fdb, resetAll, setup } from './helpers';

/**
 * Isolamento entre empresas no botão "Firma Viva" do Cenário (incidente de 19/11/2026: entrando
 * com a conta de outra empresa, o jogo abriu a Cenário Estofados).
 * - O jogo nunca reaproveita a sessão aberta no navegador: toda entrada passa pelo Cenário.
 * - A empresa é reconhecida pelo NÚMERO dela no Cenário, nunca pelo nome (nomes se repetem).
 * - Ligação antiga (pelo nome) só é reaproveitada se o Cenário confirmar que é a mesma empresa.
 */
// Precisa do Cenário multi-empresa (página "Criar conta"), o mesmo da produção. Na cópia antiga do
// Cenário que acompanha esta branch (uma empresa só), os testes ficam de fora; eles rodam juntando
// esta branch com a linha de produção do Cenário (ver docs/operacoes do incidente).
const multiEmpresa = readFileSync(
  resolve(__dirname, '../../api/src/modules/auth/routes.ts'),
  'utf8',
).includes("'/api/auth/signup'");

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

const MESMO_NOME = 'Cenário Estofados';
// Tipos do banco do Cenário multi-empresa (a cópia antiga desta branch não tem companyId/plan).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const cdb = () => cenarioDb() as any;

/** Segue o botão do Cenário até o fim, com a pessoa logada no Cenário em `gestor`. */
async function enter(gestor: Client, b = new Browser(firma)) {
  let res = await b.get('/api/entrar/cenario');
  const hops: string[] = [];
  for (let i = 0; i < 6 && res.status === 302; i++) {
    const loc = new URL(String(res.headers.location));
    hops.push(loc.pathname);
    if (loc.origin === 'http://localhost:3000' && loc.pathname === '/autorizar') {
      const auth = await gestor.post('/api/oauth/authorize', {
        ...Object.fromEntries(loc.searchParams),
        decision: 'allow',
      });
      expect(auth.status, JSON.stringify(auth.body)).toBe(200);
      const back = new URL(auth.body.redirect as string);
      res = await b.get(`${back.pathname}${back.search}`);
    } else if (loc.origin === 'http://localhost:3100' && loc.pathname.startsWith('/api/')) {
      res = await b.get(`${loc.pathname}${loc.search}`);
    } else break;
  }
  const me = await b.get('/api/auth/me');
  return { b, hops, location: String(res.headers.location), me };
}

/**
 * Segunda empresa no Cenário (conta criada pela página "Criar conta"), com o MESMO nome da
 * primeira e sem CNPJ, e o complemento do jogo ligado. Devolve o navegador logado no Cenário.
 */
async function outraEmpresa(email = 'lucas@outra.local') {
  const c = new Client(cenario);
  const r = await c.post('/api/auth/signup', {
    email,
    password: 'senha1234',
    passwordConfirm: 'senha1234',
  });
  expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
  const companyId = (await cdb().user.findUniqueOrThrow({ where: { email } })).companyId;
  expect(companyId).not.toBe(1);
  await cdb().companySettings.update({
    where: { id: companyId },
    data: { tradeName: MESMO_NOME, document: null, plan: 'gestao_jogo' },
  });
  await cdb().companySettings.update({
    where: { id: 1 },
    data: { tradeName: MESMO_NOME, document: null },
  });
  return { c, companyId };
}

const peopleNames = async (b: Browser) => {
  const r = await b.get('/api/v1/game/people');
  expect(r.status, JSON.stringify(r.body)).toBe(200);
  return (r.body as { name: string; userId: string }[]).map((p) => p.userId);
};

describe.skipIf(!multiEmpresa)('Firma Viva: duas empresas do Cenário nunca se enxergam', () => {
  it('mesmo nome, sem CNPJ: cada empresa entra na sua própria organização e vê só a sua equipe', async () => {
    const raphael = await loginAdmin(cenario);
    const { c: lucas, companyId } = await outraEmpresa();

    const a = await enter(raphael);
    expect(a.location).toBe('http://localhost:3100/jogo');
    const b = await enter(lucas);
    expect(b.location).toBe('http://localhost:3100/jogo');

    expect(a.me.body.organization.id).not.toBe(b.me.body.organization.id);
    expect(a.me.body.user.id).not.toBe(b.me.body.user.id);
    const keys = (await fdb().cenarioConnection.findMany()).map((x) => x.companyKey).sort();
    expect(keys).toEqual([
      'http://cenario.interno#empresa:1',
      `http://cenario.interno#empresa:${companyId}`,
    ]);

    // Equipe vista pelo jogo: cada um só a da própria empresa.
    const daEmpresa = async (id: number) =>
      (await cdb().user.findMany({ where: { companyId: id }, select: { id: true } })).map(
        (u: { id: string }) => u.id,
      );
    const pA = await peopleNames(a.b);
    const pB = await peopleNames(b.b);
    const usersA = await daEmpresa(1);
    const usersB = await daEmpresa(companyId);
    expect(pA.length).toBeGreaterThan(0);
    expect(pB.length).toBeGreaterThan(0);
    expect(pA.every((id) => usersA.includes(id))).toBe(true);
    expect(pB.every((id) => usersB.includes(id))).toBe(true);
    expect(pB.some((id) => usersA.includes(id))).toBe(false);

    // Ninguém virou membro da organização da outra empresa.
    const membersOf = async (orgId: string) =>
      (await fdb().membership.findMany({ where: { orgId } })).map((m) => m.userId);
    expect(await membersOf(a.me.body.organization.id)).toEqual([a.me.body.user.id]);
    expect(await membersOf(b.me.body.organization.id)).toEqual([b.me.body.user.id]);
  });

  it('mesmo navegador: sessão do jogo de uma empresa não abre quando outra conta clica no botão', async () => {
    const raphael = await loginAdmin(cenario);
    const { c: lucas } = await outraEmpresa();
    const browser = new Browser(firma);

    const a = await enter(raphael, browser);
    const orgA = a.me.body.organization.id as string;
    const oldSession = browser.cookies.get('fv_sessao');
    expect(oldSession).toBeTruthy();

    // Mesmo navegador, agora logado no Cenário com a conta da outra empresa.
    const first = await browser.get('/api/entrar/cenario');
    expect(String(first.headers.location)).toContain('http://localhost:3000/autorizar');
    // A sessão da Cenário Estofados foi encerrada no clique (nem com o cookie antigo ela volta).
    const stale = new Browser(firma);
    stale.cookies.set('fv_sessao', oldSession!);
    expect((await stale.get('/api/auth/me')).status).toBe(401);

    const b = await enter(lucas, browser);
    expect(b.me.status).toBe(200);
    expect(b.me.body.organization.id).not.toBe(orgA);

    // E de volta: a conta da Cenário Estofados reabre a organização dela, não a do Lucas.
    const again = await enter(raphael, browser);
    expect(again.me.body.organization.id).toBe(orgA);
    expect(again.me.body.user.id).toBe(a.me.body.user.id);
  });

  it('entrada recusada no Cenário não deixa o jogo aberto com a sessão anterior', async () => {
    const raphael = await loginAdmin(cenario);
    const browser = new Browser(firma);
    await enter(raphael, browser);
    // Clique no botão, mas a pessoa recusa (ou o Cenário recusa) a entrada.
    const start = await browser.get('/api/entrar/cenario');
    const loc = new URL(String(start.headers.location));
    const auth = await raphael.post('/api/oauth/authorize', {
      ...Object.fromEntries(loc.searchParams),
      decision: 'deny',
    });
    const back = new URL(auth.body.redirect as string);
    const r = await browser.get(`${back.pathname}${back.search}`);
    expect(String(r.headers.location)).toContain('/acesso?erro=');
    expect((await browser.get('/api/auth/me')).status).toBe(401);
  });

  it('ligação antiga pelo nome (como estava em produção): a outra empresa não entra nela; a dona entra e ela passa a valer pelo número', async () => {
    const raphael = await loginAdmin(cenario);
    const { c: lucas, companyId } = await outraEmpresa();
    const a = await enter(raphael);
    const orgA = a.me.body.organization.id as string;
    // Como os dados estavam antes da correção: chave pelo nome da empresa.
    const legacy = `http://cenario.interno#${MESMO_NOME}`.toLowerCase();
    await fdb().cenarioConnection.updateMany({ data: { companyKey: legacy } });
    await fdb().cenarioLogin.updateMany({ data: { companyKey: legacy } });

    // A outra empresa com o mesmo nome: o Cenário diz que a ligação antiga é da empresa 1.
    const b = await enter(lucas);
    expect(b.me.body.organization.id).not.toBe(orgA);
    expect(await fdb().membership.count({ where: { orgId: orgA } })).toBe(1);
    const connA = await fdb().cenarioConnection.findUniqueOrThrow({ where: { orgId: orgA } });
    expect(connA.companyKey).toBe(legacy); // intocada
    expect(
      (
        await fdb().cenarioConnection.findUniqueOrThrow({
          where: { orgId: b.me.body.organization.id },
        })
      ).companyKey,
    ).toBe(`http://cenario.interno#empresa:${companyId}`);

    // A dona entra: mesma organização, mesma conta, e a ligação passa a usar o número.
    const again = await enter(raphael);
    expect(again.location).toBe('http://localhost:3100/jogo');
    expect(again.me.body.organization.id).toBe(orgA);
    expect(again.me.body.user.id).toBe(a.me.body.user.id);
    expect(
      (await fdb().cenarioConnection.findUniqueOrThrow({ where: { orgId: orgA } })).companyKey,
    ).toBe('http://cenario.interno#empresa:1');
    expect(await fdb().organization.count()).toBe(2);
  });
});
