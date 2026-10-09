import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { E2E } from '../env';
import { loginAdmin, openTablet, registerDevice, setPin } from './helpers';

/**
 * Fase 12 — auditoria visual. Roda por último (usa os dados criados pelas outras specs).
 * Visita TODAS as telas do painel (com identificadores reais) em desktop, tablet e celular, e o
 * app do tablet em tablet e celular, registrando: erros de JavaScript, erros no console,
 * rolagem horizontal (layout quebrado) e o título de cada tela. Com E2E_EVIDENCE=1, salva
 * capturas e o resultado em docs/evidencias/fase-12/.
 */
const origin = `http://localhost:${E2E.webPort}`;
const OUT = '../../docs/evidencias/fase-12';
const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 820, height: 1180 },
  { name: 'celular', width: 390, height: 844 },
] as const;

type Finding = {
  route: string;
  viewport: string;
  status: number | null;
  heading: string | null;
  overflowPx: number;
  offenders?: string[];
  pageErrors: string[];
  consoleErrors: string[];
};

async function get(page: Page, path: string) {
  const r = await page.request.get(path, { headers: { origin } });
  return r.ok() ? r.json() : null;
}
const first = (x: unknown): string | null => {
  const list = Array.isArray(x) ? x : ((x as { items?: unknown[] } | null)?.items ?? []);
  return ((list[0] as { id?: string } | undefined)?.id ?? null) as string | null;
};

async function audit(page: Page, route: string, viewport: string, shot: string): Promise<Finding> {
  const pageErrors: string[] = [];
  const consoleErrors: string[] = [];
  const onError = (e: Error) => pageErrors.push(e.message);
  const onConsole = (m: { type(): string; text(): string }) => {
    // Erros esperados de permissão/negócio aparecem como respostas HTTP, não como falhas da tela.
    if (
      m.type() === 'error' &&
      !/Failed to load resource: the server responded with a status of (401|403|404|409|422)/.test(
        m.text(),
      )
    )
      consoleErrors.push(m.text().slice(0, 200));
  };
  page.on('pageerror', onError);
  page.on('console', onConsole);
  const res = await page.goto(route, { waitUntil: 'networkidle' });
  await page.waitForTimeout(300);
  const heading = await page
    .locator('main h1, h1')
    .first()
    .textContent({ timeout: 5000 })
    .catch(() => null);
  const overflowPx = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth,
  );
  const offenders = overflowPx > 2 ? await page.evaluate(widest) : undefined;
  if (process.env.E2E_EVIDENCE)
    await page.screenshot({ path: `${OUT}/${viewport}/${shot}.png`, fullPage: false });
  page.off('pageerror', onError);
  page.off('console', onConsole);
  return {
    route,
    viewport,
    status: res?.status() ?? null,
    heading: heading?.trim() ?? null,
    overflowPx,
    offenders,
    pageErrors,
    consoleErrors,
  };
}

/** Elementos mais internos que ultrapassam a largura da tela (para corrigir o layout). */
function widest() {
  const over = (e: Element) => e.getBoundingClientRect().right > window.innerWidth + 1;
  return Array.from(document.querySelectorAll('body *'))
    .filter((e) => over(e) && !Array.from(e.children).some(over))
    .slice(0, 4)
    .map(
      (e) =>
        `${e.tagName.toLowerCase()}.${String(e.className).slice(0, 80)} "${(e.textContent ?? '').trim().slice(0, 30)}"`,
    );
}

test.describe.serial('Fase 12 — auditoria visual', () => {
  test('todas as telas do painel e do tablet, em desktop, tablet e celular', async ({
    page,
    browser,
  }) => {
    test.setTimeout(600_000);
    for (const v of VIEWPORTS) mkdirSync(`${OUT}/${v.name}`, { recursive: true });
    await loginAdmin(page);
    const ids = {
      cliente: first(await get(page, '/api/v1/customers?limit=1')),
      pedido: first(await get(page, '/api/v1/orders?limit=1')),
      os: first(await get(page, '/api/v1/service-orders?limit=1')),
      compra: first(await get(page, '/api/v1/purchase-orders')),
      entrega: first(await get(page, '/api/v1/deliveries')),
      inspecao: first(await get(page, '/api/v1/quality/inspections?scope=all')),
      medicao: first(await get(page, '/api/v1/measurements')),
      ocorrencia: first(await get(page, '/api/v1/issues')),
      ocorrenciaLogistica: first(await get(page, '/api/v1/logistics-occurrences')),
    };
    const board = await get(page, '/api/v1/production/board');
    const taskId =
      (JSON.stringify(board ?? {}).match(/"id":"([0-9a-f-]{36})","number":\d+,"[^"]*"?/)?.[1] as
        | string
        | undefined) ?? null;
    const routes: [string | null, string][] = [
      ['/painel', 'inicio'],
      ['/painel/atencao', 'atencao'],
      ['/painel/funcionarios', 'funcionarios'],
      ['/painel/funcoes', 'funcoes'],
      ['/painel/dispositivos', 'dispositivos'],
      ['/painel/clientes', 'clientes'],
      [ids.cliente && `/painel/clientes/${ids.cliente}`, 'cliente'],
      ['/painel/pedidos', 'pedidos'],
      ['/painel/pedidos/novo', 'pedido-novo'],
      [ids.pedido && `/painel/pedidos/${ids.pedido}`, 'pedido'],
      [ids.pedido && `/painel/pedidos/${ids.pedido}/editar`, 'pedido-editar'],
      ['/painel/retiradas', 'retiradas'],
      ['/painel/recebimentos', 'recebimentos'],
      ['/painel/recebimentos/novo', 'recebimento-novo'],
      ['/painel/os', 'os-lista'],
      ['/painel/os/nova', 'os-nova'],
      [ids.os && `/painel/os/${ids.os}`, 'os'],
      ['/painel/medicoes', 'medicoes'],
      [ids.medicao && `/painel/medicoes/${ids.medicao}`, 'medicao'],
      ['/painel/materiais', 'materiais'],
      ['/painel/compras', 'compras'],
      ['/painel/compras/novo', 'compra-nova'],
      [ids.compra && `/painel/compras/${ids.compra}`, 'compra'],
      ['/painel/fornecedores', 'fornecedores'],
      ['/painel/recebimento-materiais', 'recebimento-materiais'],
      ['/painel/estoque', 'estoque'],
      ['/painel/prontidao', 'prontidao'],
      ['/painel/planejamento', 'planejamento-sexta'],
      ['/painel/producao/planejamento', 'planejamento-producao'],
      ['/painel/producao', 'quadro'],
      ['/painel/producao/modelos', 'modelos'],
      [taskId && `/painel/producao/tarefas/${taskId}`, 'tarefa'],
      ['/painel/ajuda', 'ajuda'],
      ['/painel/reprogramacao', 'reprogramacao'],
      ['/painel/competencias', 'competencias'],
      [ids.ocorrencia && `/painel/ocorrencias/${ids.ocorrencia}`, 'ocorrencia'],
      ['/painel/qualidade', 'qualidade'],
      [ids.inspecao && `/painel/qualidade/inspecoes/${ids.inspecao}`, 'inspecao'],
      ['/painel/entregas', 'entregas'],
      [ids.entrega && `/painel/entregas/${ids.entrega}`, 'entrega'],
      [
        ids.ocorrenciaLogistica && `/painel/entregas/ocorrencias/${ids.ocorrenciaLogistica}`,
        'ocorrencia-logistica',
      ],
      ['/painel/devolucoes', 'devolucoes'],
      ['/painel/presenca', 'presenca'],
      ['/painel/financeiro', 'financeiro'],
      ['/painel/empresa', 'empresa'],
      ['/painel/auditoria', 'auditoria'],
      ['/painel/sincronizacao', 'sincronizacao'],
      ['/painel/conta', 'conta'],
    ];
    const findings: Finding[] = [];
    for (const v of VIEWPORTS) {
      await page.setViewportSize({ width: v.width, height: v.height });
      for (const [route, shot] of routes) {
        if (!route) continue;
        findings.push(await audit(page, route, v.name, shot));
      }
    }
    // App do tablet (Ricardo) em tablet e celular, telas principais.
    const people = await get(page, '/api/v1/production/workers');
    const ricardo = (people as { displayName: string }[]).find((w) =>
      w.displayName.startsWith('Ricardo'),
    )!.displayName;
    await setPin(page, ricardo, '482915');
    const code = await registerDevice(page, 'Tablet Ricardo (auditoria)', ricardo);
    const t = await openTablet(browser, code, '482915');
    for (const v of VIEWPORTS.slice(1)) {
      await t.page.setViewportSize({ width: v.width, height: v.height });
      findings.push(await audit(t.page, '/tablet', v.name, 'tablet-meu-dia'));
      for (const tile of ['tile-materials', 'tile-measurements']) {
        const el = t.page.getByTestId(tile);
        if (await el.count()) {
          await el.click();
          const overflowPx = await t.page.evaluate(
            () => document.documentElement.scrollWidth - window.innerWidth,
          );
          const offenders = overflowPx > 2 ? await t.page.evaluate(widest) : undefined;
          if (process.env.E2E_EVIDENCE)
            await t.page.screenshot({ path: `${OUT}/${v.name}/${tile}.png` });
          findings.push({
            route: `/tablet#${tile}`,
            viewport: v.name,
            status: 200,
            heading: null,
            overflowPx,
            offenders,
            pageErrors: [],
            consoleErrors: [],
          });
          await t.page
            .getByRole('button', { name: /Voltar/ })
            .first()
            .click();
        }
      }
    }
    await t.context.close();

    if (process.env.E2E_EVIDENCE)
      writeFileSync(`${OUT}/auditoria-visual.json`, JSON.stringify(findings, null, 2));
    const broken = findings.filter(
      (f) => f.pageErrors.length || (f.status !== null && f.status >= 500),
    );
    const overflow = findings.filter((f) => f.overflowPx > 2);
    const noHeading = findings.filter((f) => f.route.startsWith('/painel') && !f.heading);
    console.warn(
      `Auditoria visual: ${findings.length} telas×tamanhos; erros JS: ${broken.length}; rolagem horizontal: ${overflow.length}; sem título: ${noHeading.length}; erros de console: ${findings.filter((f) => f.consoleErrors.length).length}`,
    );
    for (const f of [...broken, ...overflow, ...noHeading])
      console.warn(
        `  ${f.viewport} ${f.route} overflow=${f.overflowPx} ${JSON.stringify(f.offenders ?? [])} erros=${f.pageErrors.join(' | ')}`,
      );
    expect(broken, JSON.stringify(broken, null, 1)).toEqual([]);
    expect(
      overflow,
      JSON.stringify(overflow.map((f) => `${f.viewport} ${f.route} ${f.overflowPx}px`)),
    ).toEqual([]);
    expect(noHeading.map((f) => `${f.viewport} ${f.route}`)).toEqual([]);
  });
});
