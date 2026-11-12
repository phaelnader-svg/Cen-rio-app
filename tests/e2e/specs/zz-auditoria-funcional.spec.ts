import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { E2E } from '../env';
import { loginAdmin } from './helpers';

/**
 * Auditoria funcional da versão F′ (63674f1) — percorre TODAS as páginas do painel pela interface
 * real (Chromium, build de produção), como o gestor (1440 e 390 px) e como perfis de teste `HML-`,
 * registrando: status do documento, erros de página, erros de console, respostas da API ≥ 500 e
 * 403, requisições falhas, rolagem lateral e tempo de carga. Os achados vão para
 * test-results/auditoria/*.json (com capturas em E2E_EVIDENCE=1). Só dados `HML-`.
 */
const origin = `http://localhost:${E2E.webPort}`;
const OUT = 'test-results/auditoria';
mkdirSync(OUT, { recursive: true });
const shotDir = '../../docs/evidencias/homologacao-funcional';
if (process.env.AUDITORIA_EVIDENCIAS) mkdirSync(shotDir, { recursive: true });

const STATIC = [
  '/painel',
  '/painel/ajuda',
  '/painel/atencao',
  '/painel/auditoria',
  '/painel/clientes',
  '/painel/competencias',
  '/painel/compras',
  '/painel/compras/novo',
  '/painel/conta',
  '/painel/devolucoes',
  '/painel/dispositivos',
  '/painel/empresa',
  '/painel/entregas',
  '/painel/estoque',
  '/painel/estoque-oficina',
  '/painel/financeiro',
  '/painel/fornecedores',
  '/painel/funcionarios',
  '/painel/funcoes',
  '/painel/materiais',
  '/painel/medicoes',
  '/painel/os',
  '/painel/os/nova',
  '/painel/pedidos',
  '/painel/pedidos/novo',
  '/painel/planejamento',
  '/painel/presenca',
  '/painel/producao',
  '/painel/producao/a-planejar',
  '/painel/producao/mapa',
  '/painel/producao/modelos',
  '/painel/producao/planejamento',
  '/painel/producao/programacao',
  '/painel/prontidao',
  '/painel/qualidade',
  '/painel/recebimento-materiais',
  '/painel/recebimentos',
  '/painel/recebimentos/novo',
  '/painel/reprogramacao',
  '/painel/retiradas',
  '/painel/roteiro',
  '/painel/servicos/novo',
  '/painel/sincronizacao',
];
const PUBLIC = ['/', '/conheca', '/entrar', '/tablet'];

type Visita = {
  rota: string;
  perfil: string;
  largura: number;
  status: number | null;
  urlFinal: string;
  ms: number;
  errosPagina: string[];
  errosConsole: string[];
  api5xx: string[];
  api403: string[];
  falhas: string[];
  rolagemLateral: boolean;
  textoErro: string | null;
  semPermissao: boolean;
};

const ERRO_TELA =
  /Application error|Algo deu errado|Erro inesperado|Unhandled Runtime Error|Internal Server Error/i;
const SEM_PERMISSAO =
  /sem permissão|não tem permissão|não tem acesso|acesso negado|Permissão necessária/i;

async function visitar(page: Page, rota: string, perfil: string, largura: number): Promise<Visita> {
  const errosPagina: string[] = [];
  const errosConsole: string[] = [];
  const api5xx: string[] = [];
  const api403: string[] = [];
  const falhas: string[] = [];
  const onErr = (e: Error) => errosPagina.push(String(e.message).slice(0, 200));
  const onCon = (m: { type(): string; text(): string }) => {
    if (m.type() === 'error') errosConsole.push(m.text().slice(0, 200));
  };
  const onResp = (r: { url(): string; status(): number; request(): { method(): string } }) => {
    const u = r.url().replace(origin, '');
    if (!u.startsWith('/api/')) return;
    if (r.status() >= 500) api5xx.push(`${r.request().method()} ${u} → ${r.status()}`);
    if (r.status() === 403) api403.push(`${r.request().method()} ${u.split('?')[0]}`);
  };
  const onFail = (r: { url(): string; failure(): { errorText: string } | null }) => {
    const u = r.url().replace(origin, '');
    if (u.startsWith('/api/realtime') || u.includes('_next/webpack-hmr')) return;
    const t = r.failure()?.errorText ?? '';
    if (!/ERR_ABORTED/.test(t)) falhas.push(`${u.slice(0, 120)} (${t})`);
  };
  page.on('pageerror', onErr);
  page.on('console', onCon);
  page.on('response', onResp);
  page.on('requestfailed', onFail);
  const t0 = Date.now();
  let status: number | null = null;
  try {
    const r = await page.goto(rota, { waitUntil: 'domcontentloaded' });
    status = r?.status() ?? null;
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
    await page.waitForTimeout(400);
  } catch (e) {
    errosPagina.push(`navegação: ${String(e).slice(0, 160)}`);
  }
  const ms = Date.now() - t0;
  const corpo = await page
    .locator('body')
    .innerText()
    .catch(() => '');
  const rolagemLateral = await page
    .evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
    .catch(() => false);
  page.off('pageerror', onErr);
  page.off('console', onCon);
  page.off('response', onResp);
  page.off('requestfailed', onFail);
  if (process.env.AUDITORIA_EVIDENCIAS && perfil === 'gestor') {
    const nome =
      (rota.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'raiz') + `-${largura}`;
    await page
      .screenshot({ path: `${shotDir}/${nome}.png`, fullPage: false })
      .catch(() => undefined);
  }
  return {
    rota,
    perfil,
    largura,
    status,
    urlFinal: page.url().replace(origin, ''),
    ms,
    errosPagina,
    // 403/401 do próprio navegador aparecem no console como "Failed to load resource": separados.
    errosConsole: errosConsole.filter((c) => !/status of 40[13]/.test(c)),
    api5xx,
    api403: [...new Set(api403)],
    falhas,
    rolagemLateral,
    textoErro: ERRO_TELA.exec(corpo)?.[0] ?? null,
    semPermissao: SEM_PERMISSAO.test(corpo),
  };
}

/** Primeiro `id` encontrado num JSON (lista paginada ou não). */
function primeiroId(v: unknown): string | null {
  if (Array.isArray(v)) {
    for (const x of v) {
      const r = primeiroId(x);
      if (r) return r;
    }
    return null;
  }
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (typeof o.id === 'string' && /^[0-9a-f-]{36}$/.test(o.id)) return o.id;
    for (const k of ['items', 'rows', 'data', 'list', 'tasks']) if (k in o) return primeiroId(o[k]);
  }
  return null;
}

async function dinamicas(page: Page): Promise<{ rota: string; motivo?: string }[]> {
  const get = async (p: string) => {
    const r = await page.request.get(p, { headers: { origin } });
    return r.ok() ? r.json() : null;
  };
  const fontes: [string, string, (id: string) => string][] = [
    ['/painel/clientes/[id]', '/api/v1/customers', (i) => `/painel/clientes/${i}`],
    ['/painel/compras/[id]', '/api/v1/purchase-orders', (i) => `/painel/compras/${i}`],
    ['/painel/entregas/[id]', '/api/v1/deliveries', (i) => `/painel/entregas/${i}`],
    [
      '/painel/entregas/ocorrencias/[id]',
      '/api/v1/logistics-occurrences',
      (i) => `/painel/entregas/ocorrencias/${i}`,
    ],
    ['/painel/medicoes/[id]', '/api/v1/measurements', (i) => `/painel/medicoes/${i}`],
    ['/painel/ocorrencias/[id]', '/api/v1/issues', (i) => `/painel/ocorrencias/${i}`],
    ['/painel/os/[id]', '/api/v1/service-orders', (i) => `/painel/os/${i}`],
    ['/painel/pedidos/[id]', '/api/v1/orders', (i) => `/painel/pedidos/${i}`],
    ['/painel/pedidos/[id]/editar', '/api/v1/orders', (i) => `/painel/pedidos/${i}/editar`],
    [
      '/painel/qualidade/inspecoes/[id]',
      '/api/v1/quality/inspections',
      (i) => `/painel/qualidade/inspecoes/${i}`,
    ],
  ];
  const out: { rota: string; motivo?: string }[] = [];
  for (const [modelo, api, rota] of fontes) {
    const id = primeiroId(await get(api));
    out.push(id ? { rota: rota(id) } : { rota: modelo, motivo: `sem registro em ${api}` });
  }
  // Tarefa: primeiro plano com tarefa.
  const planos = (await get('/api/v1/production-plans')) as { id: string }[] | null;
  let tarefa: string | null = null;
  for (const p of planos ?? []) {
    const d = (await get(`/api/v1/production-plans/${p.id}`)) as {
      tasks?: { id: string }[];
    } | null;
    if (d?.tasks?.length) {
      tarefa = d.tasks[0]!.id;
      break;
    }
  }
  out.push(
    tarefa
      ? { rota: `/painel/producao/tarefas/${tarefa}` }
      : { rota: '/painel/producao/tarefas/[id]', motivo: 'sem tarefa' },
  );
  return out;
}

const salvar = (nome: string, dados: unknown) =>
  writeFileSync(`${OUT}/${nome}.json`, JSON.stringify(dados, null, 2));

function problemas(v: Visita) {
  return [
    ...v.errosPagina.map((e) => `erro de página: ${e}`),
    ...v.api5xx.map((e) => `API 5xx: ${e}`),
    ...(v.status && v.status >= 500 ? [`documento HTTP ${v.status}`] : []),
    ...(v.textoErro ? [`tela de erro: ${v.textoErro}`] : []),
    ...v.falhas.map((e) => `requisição falhou: ${e}`),
  ];
}

test.describe('Auditoria funcional F′ — navegação completa', () => {
  test.setTimeout(900_000);

  for (const vp of [
    { nome: 'desktop', width: 1440, height: 900 },
    { nome: 'celular', width: 390, height: 844 },
  ]) {
    test(`gestor percorre todas as páginas (${vp.nome})`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await loginAdmin(page);
      const din = await dinamicas(page);
      const visitas: Visita[] = [];
      for (const r of [...STATIC, ...din.filter((d) => !d.motivo).map((d) => d.rota)])
        visitas.push(await visitar(page, r, 'gestor', vp.width));
      // Públicas (sem sessão também são acessíveis; aqui com sessão).
      for (const r of PUBLIC) visitas.push(await visitar(page, r, 'gestor', vp.width));
      salvar(`gestor-${vp.nome}`, { semDado: din.filter((d) => d.motivo), visitas });
      for (const v of visitas) {
        expect.soft(problemas(v), `${v.rota} (${vp.nome})`).toEqual([]);
        if (vp.width === 390 && v.rota.startsWith('/painel'))
          expect.soft(v.rolagemLateral, `rolagem lateral em ${v.rota}`).toBe(false);
      }
    });
  }

  test('perfis HML-: menu × acesso direto a cada página', async ({ page, browser }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await loginAdmin(page);
    const call = async (method: string, path: string, data?: unknown) => {
      const r = await page.request.fetch(path, {
        method,
        data,
        headers: { origin, 'idempotency-key': crypto.randomUUID().replace(/-/g, '') },
      });
      return { status: r.status(), body: await r.json().catch(() => null) };
    };
    const tag = Date.now().toString(36);
    const PERFIS: Record<string, string[]> = {
      'HML-Financeiro': ['painel.acessar', 'financeiro.ver', 'financeiro.gerenciar'],
      'HML-Planejamento': ['painel.acessar', 'producao.ver', 'producao.planejar', 'os.ver'],
      'HML-Entregas': ['painel.acessar', 'os.ver', 'entregas.ver', 'entregas.gerenciar'],
      'HML-Comercial': [
        'painel.acessar',
        'clientes.ver',
        'clientes.gerenciar',
        'pedidos.ver',
        'pedidos.gerenciar',
        'os.ver',
      ],
      'HML-Leitura': ['painel.acessar', 'os.ver'],
    };
    const resultado: Record<string, unknown> = {};
    for (const [nome, perms] of Object.entries(PERFIS)) {
      const role = await call('POST', '/api/roles', { name: `${nome} ${tag}`, permissions: perms });
      expect(role.status, JSON.stringify(role.body)).toBe(201);
      const email = `${nome.toLowerCase()}-${tag}@hml.teste.local`;
      const emp = await call('POST', '/api/employees', {
        fullName: `${nome} ${tag}`,
        displayName: `${nome}`.slice(0, 40),
        jobTitle: 'Teste de homologação',
        color: '#445566',
        roleIds: [role.body.id],
        email,
        password: 'SenhaHml12345',
      });
      expect(emp.status, JSON.stringify(emp.body)).toBe(201);
      const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const p = await ctx.newPage();
      await p.goto('/entrar');
      await p.getByLabel('E-mail').fill(email);
      await p.getByLabel('Senha').fill('SenhaHml12345');
      await p.getByRole('button', { name: 'Entrar' }).click();
      await expect(p).toHaveURL(/\/painel$/);
      const menu = await p
        .getByRole('navigation', { name: 'Navegação principal' })
        .first()
        .locator('a[href^="/painel"]')
        .evaluateAll((as) => as.map((a) => a.getAttribute('href')));
      const visitas: Visita[] = [];
      for (const r of STATIC) visitas.push(await visitar(p, r, nome, 1440));
      await ctx.close();
      const fora = visitas.filter((v) => !menu.includes(v.rota) && v.rota !== '/painel/conta');
      resultado[nome] = {
        permissoes: perms,
        menu,
        visitas: visitas.map((v) => ({
          rota: v.rota,
          noMenu: menu.includes(v.rota),
          api403: v.api403,
          semPermissao: v.semPermissao,
          problemas: problemas(v),
        })),
      };
      for (const v of visitas) expect.soft(problemas(v), `${nome}: ${v.rota}`).toEqual([]);
      // Itens do menu precisam funcionar sem 403 na carga principal.
      for (const v of visitas.filter((x) => menu.includes(x.rota)))
        expect.soft(v.api403, `${nome}: item do menu ${v.rota} com 403`).toEqual([]);
      resultado[`${nome}:foraDoMenu`] = fora.map((v) => ({
        rota: v.rota,
        api403: v.api403.length,
        semPermissao: v.semPermissao,
      }));
    }
    salvar('perfis', resultado);
  });

  test('perfis de tablet (sem painel.acessar) não entram no painel', async ({ page, browser }) => {
    await loginAdmin(page);
    const roles = (await (
      await page.request.get('/api/roles', { headers: { origin } })
    ).json()) as {
      id: string;
      key: string | null;
      name: string;
      permissions: string[];
    }[];
    const tablet = roles.filter((r) => r.key && r.key !== 'gestor');
    const tag = Date.now().toString(36);
    const out: unknown[] = [];
    for (const r of tablet) {
      const email = `hml-${r.key}-${tag}@hml.teste.local`;
      const emp = await page.request.post('/api/employees', {
        data: {
          fullName: `HML-${r.name} ${tag}`.slice(0, 120),
          displayName: `HML-${r.key}`.slice(0, 40),
          jobTitle: 'Teste de homologação',
          color: '#445566',
          roleIds: [r.id],
          email,
          password: 'SenhaHml12345',
        },
        headers: { origin, 'idempotency-key': crypto.randomUUID().replace(/-/g, '') },
      });
      const ctx = await browser.newContext();
      const p = await ctx.newPage();
      await p.goto('/entrar');
      await p.getByLabel('E-mail').fill(email);
      await p.getByLabel('Senha').fill('SenhaHml12345');
      await p.getByRole('button', { name: 'Entrar' }).click();
      await p.waitForTimeout(2500);
      const corpo = await p.locator('body').innerText();
      out.push({
        perfil: r.key,
        criado: emp.status(),
        temPainel: r.permissions.includes('painel.acessar'),
        url: p.url().replace(origin, ''),
        mensagem: corpo.match(/[^\n]*(acesso|permiss|tablet|produção)[^\n]*/i)?.[0] ?? null,
      });
      if (!r.permissions.includes('painel.acessar'))
        expect
          .soft(p.url(), `${r.key} não deveria ver o painel`)
          .not.toMatch(/\/painel(\/|$)(?!.*entrar)/);
      await ctx.close();
    }
    salvar('perfis-tablet', out);
  });
});
