import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { E2E } from '../env';
import { loginAdmin } from './helpers';

/**
 * Correção global de interface — auditoria de GEOMETRIA dos formulários, em todas as telas do
 * painel (e formulários em diálogo), em 390 / 768 / 1280 / 1440 px. Mede no navegador:
 *  - alturas dos campos de uma linha (input/select): quantas alturas distintas existem;
 *  - linhas de formulário desalinhadas: campos lado a lado (mesma linha de um grid/flex) com
 *    topo ou altura diferentes;
 *  - alturas distintas de botões;
 *  - rolagem horizontal da página e campos que ultrapassam o próprio contêiner.
 * E2E_GEOMETRIA=antes|depois grava capturas e o JSON em docs/evidencias/interface/<fase>/.
 * E2E_GEOMETRIA_ESTRITO=1 exige zero desalinhamentos e zero rolagem horizontal (critério de aceite).
 */
const origin = `http://localhost:${E2E.webPort}`;
const FASE = process.env.E2E_GEOMETRIA ?? '';
const OUT = `../../docs/evidencias/interface/${FASE || 'tmp'}`;
const ESTRITO = process.env.E2E_GEOMETRIA_ESTRITO === '1';
const VIEWPORTS = [
  { name: '390', width: 390, height: 844 },
  { name: '768', width: 768, height: 1024 },
  { name: '1280', width: 1280, height: 800 },
  { name: '1440', width: 1440, height: 900 },
] as const;

type Medida = {
  rota: string;
  largura: string;
  campos: number;
  alturasCampos: number[];
  linhasDesalinhadas: { y: number; detalhes: string }[];
  alturasBotoes: number[];
  rolagemHorizontalPx: number;
  camposEstourados: string[];
};

/** Executado no navegador: mede a geometria da área visível (página ou diálogo aberto). */
function medir(): Omit<Medida, 'rota' | 'largura'> {
  const root: Element =
    (document.querySelector('dialog[open]') as Element | null) ??
    (document.querySelector('main') as Element | null) ??
    document.body;
  const visivel = (e: Element) => {
    const r = e.getBoundingClientRect();
    const s = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const umaLinha = Array.from(
    root.querySelectorAll(
      'input:not([type=checkbox]):not([type=radio]):not([type=hidden]):not([type=file]):not([type=range]):not([type=color]), select',
    ),
  ).filter(visivel) as HTMLElement[];
  const alturas = [...new Set(umaLinha.map((e) => Math.round(e.getBoundingClientRect().height)))];
  // Linhas: campos cujo "item de layout" (filho direto do grid/flex) começa no mesmo y.
  const item = (e: Element) => {
    let el: Element | null = e;
    while (el && el.parentElement && el.parentElement !== root) {
      const d = getComputedStyle(el.parentElement).display;
      if (d.includes('grid') || d.includes('flex')) {
        const fd = getComputedStyle(el.parentElement).flexDirection;
        if (d.includes('grid') || !fd.startsWith('column'))
          return { item: el, pai: el.parentElement };
      }
      el = el.parentElement;
    }
    return null;
  };
  const grupos = new Map<Element, Map<number, HTMLElement[]>>();
  for (const c of umaLinha) {
    const it = item(c);
    if (!it) continue;
    const y = Math.round(it.item.getBoundingClientRect().top);
    const g = grupos.get(it.pai) ?? new Map<number, HTMLElement[]>();
    g.set(y, [...(g.get(y) ?? []), c]);
    grupos.set(it.pai, g);
  }
  const desal: { y: number; detalhes: string }[] = [];
  for (const g of grupos.values())
    for (const [y, cs] of g) {
      if (cs.length < 2) continue;
      const rs = cs.map((c) => c.getBoundingClientRect());
      const tops = rs.map((r) => Math.round(r.top));
      const hs = rs.map((r) => Math.round(r.height));
      if (Math.max(...tops) - Math.min(...tops) > 1 || Math.max(...hs) - Math.min(...hs) > 1)
        desal.push({
          y,
          detalhes: cs
            .map(
              (c, i) =>
                `${c.tagName.toLowerCase()}[${(c as HTMLInputElement).type ?? ''}] "${(c.getAttribute('aria-label') ?? c.id ?? '').slice(0, 20)}" top=${tops[i]} h=${hs[i]}`,
            )
            .join(' | '),
        });
    }
  const botoes = Array.from(root.querySelectorAll('button')).filter(visivel);
  const alturasBotoes = [
    ...new Set(botoes.map((b) => Math.round(b.getBoundingClientRect().height))),
  ];
  const estourados = umaLinha
    .filter((c) => {
      const p = c.parentElement;
      if (!p) return false;
      return c.getBoundingClientRect().right > p.getBoundingClientRect().right + 1;
    })
    .map(
      (c) => `${c.tagName.toLowerCase()} "${(c.getAttribute('aria-label') ?? c.id).slice(0, 30)}"`,
    );
  return {
    campos: umaLinha.length,
    alturasCampos: alturas.sort((a, b) => a - b),
    linhasDesalinhadas: desal,
    alturasBotoes: alturasBotoes.sort((a, b) => a - b),
    rolagemHorizontalPx: document.documentElement.scrollWidth - window.innerWidth,
    camposEstourados: estourados,
  };
}

async function get(page: Page, path: string) {
  const r = await page.request.get(path, { headers: { origin } });
  return r.ok() ? r.json() : null;
}
const first = (x: unknown): string | null => {
  const list = Array.isArray(x) ? x : ((x as { items?: unknown[] } | null)?.items ?? []);
  return ((list[0] as { id?: string } | undefined)?.id ?? null) as string | null;
};
const slug = (s: string) =>
  s
    .replace(/^\/painel\/?/, 'painel-')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/-+$/, '')
    .slice(0, 60);

test.describe.serial('Interface — geometria dos formulários', () => {
  test('todas as telas e formulários em diálogo, em 390/768/1280/1440', async ({ page }) => {
    test.setTimeout(1_200_000);
    if (FASE) for (const v of VIEWPORTS) mkdirSync(`${OUT}/${v.name}`, { recursive: true });
    await loginAdmin(page);
    const ids = {
      cliente: first(await get(page, '/api/v1/customers?limit=1')),
      pedido: first(await get(page, '/api/v1/orders?limit=1')),
      os: first(await get(page, '/api/v1/service-orders?limit=1')),
      compra: first(await get(page, '/api/v1/purchase-orders')),
      entrega: first(await get(page, '/api/v1/deliveries')),
      medicao: first(await get(page, '/api/v1/measurements')),
      retirada: first(await get(page, '/api/v1/pickups')),
    };
    const pedidoComRecebimento = (
      (await get(page, '/api/v1/orders?limit=50')) as { items?: { id: string }[] } | null
    )?.items?.[0]?.id;
    const hoje = new Date().toISOString().slice(0, 10);
    // [rota, aba a clicar (opcional), botão que abre um formulário em diálogo (opcional)]
    const alvos: [string | null, string | null, string | null][] = [
      ['/painel', null, null],
      ['/painel/atencao', null, null],
      ['/painel/funcionarios', null, null],
      ['/painel/funcionarios', null, 'Novo funcionário'],
      ['/painel/funcoes', null, 'Nova função'],
      ['/painel/competencias', null, null],
      ['/painel/dispositivos', null, 'Cadastrar dispositivo'],
      ['/painel/clientes', null, 'Novo cliente'],
      [ids.cliente && `/painel/clientes/${ids.cliente}`, null, null],
      ['/painel/pedidos', null, null],
      ['/painel/pedidos/novo', null, null],
      [ids.pedido && `/painel/pedidos/${ids.pedido}`, null, null],
      [
        pedidoComRecebimento ? `/painel/pedidos/${pedidoComRecebimento}` : null,
        null,
        'Solicitar retirada',
      ],
      [ids.pedido && `/painel/pedidos/${ids.pedido}/editar`, null, null],
      ['/painel/retiradas', null, null],
      ['/painel/roteiro', null, null],
      [`/painel/roteiro?data=${hoje}`, null, null],
      ['/painel/recebimentos', null, null],
      ['/painel/recebimentos/novo', null, null],
      ['/painel/os', null, null],
      [pedidoComRecebimento ? `/painel/os/nova?pedido=${pedidoComRecebimento}` : null, null, null],
      [ids.os && `/painel/os/${ids.os}`, null, null],
      ['/painel/medicoes', null, null],
      [ids.medicao && `/painel/medicoes/${ids.medicao}`, null, null],
      ['/painel/materiais', null, null],
      ['/painel/compras', null, null],
      ['/painel/compras/novo', null, null],
      [ids.compra && `/painel/compras/${ids.compra}`, null, null],
      ['/painel/fornecedores', null, 'Novo fornecedor'],
      ['/painel/recebimento-materiais', null, null],
      ['/painel/estoque', null, null],
      ['/painel/estoque', null, 'Novo material'],
      ['/painel/prontidao', null, null],
      ['/painel/planejamento', null, null],
      ['/painel/producao/planejamento', null, null],
      ['/painel/producao', null, null],
      ['/painel/producao/modelos', null, 'Novo modelo'],
      ['/painel/ajuda', null, null],
      ['/painel/reprogramacao', null, null],
      ['/painel/qualidade', null, null],
      ['/painel/qualidade', 'Checklists', 'Novo checklist'],
      ['/painel/entregas', null, null],
      ['/painel/entregas', null, 'Agendar entrega'],
      [ids.entrega && `/painel/entregas/${ids.entrega}`, null, null],
      ['/painel/devolucoes', null, null],
      ['/painel/presenca', null, null],
      ['/painel/financeiro', null, null],
      ['/painel/financeiro', 'Receitas e recebimentos', 'Lançar cobrança'],
      ['/painel/financeiro', 'Fechamento semanal', null],
      ['/painel/financeiro', 'Contas a pagar', 'Nova conta a pagar'],
      ['/painel/financeiro', 'Produção e equipe', 'Combinar valor'],
      ['/painel/financeiro', 'Custos e resultado por OS', 'Lançar custo logístico'],
      ['/painel/financeiro', 'Despesas', 'Nova despesa'],
      ['/painel/empresa', null, null],
      ['/painel/auditoria', null, null],
      ['/painel/conta', null, null],
    ];
    const medidas: Medida[] = [];
    for (const v of VIEWPORTS) {
      await page.setViewportSize({ width: v.width, height: v.height });
      for (const [rota, aba, botao] of alvos) {
        if (!rota) continue;
        const res = await page.goto(rota, { waitUntil: 'networkidle' });
        if (!res || res.status() >= 400) continue;
        await page.waitForTimeout(250);
        if (aba) {
          const t = page.getByRole('tab', { name: new RegExp(`^${aba}`) }).first();
          if (!(await t.count())) continue;
          await t.click();
          await page.waitForTimeout(250);
        }
        let nome = `${slug(rota)}${aba ? `-${slug(aba)}` : ''}`;
        if (botao) {
          const b = page.getByRole('button', { name: botao, exact: true }).first();
          if (!(await b.count()) || !(await b.isEnabled())) continue;
          await b.click();
          if (!(await page.locator('dialog[open]').count())) {
            await page.waitForTimeout(400);
            if (!(await page.locator('dialog[open]').count())) continue;
          }
          await page.waitForTimeout(250);
          nome += `-dialogo-${slug(botao)}`;
        }
        const m = await page.evaluate(medir);
        medidas.push({ rota: nome, largura: v.name, ...m });
        if (FASE)
          await page.screenshot({
            path: `${OUT}/${v.name}/${nome}.png`,
            fullPage: !botao,
          });
        if (botao) await page.keyboard.press('Escape');
      }
    }
    const resumo = {
      telas: new Set(medidas.map((m) => m.rota)).size,
      medicoes: medidas.length,
      comDesalinhamento: medidas.filter((m) => m.linhasDesalinhadas.length).length,
      linhasDesalinhadas: medidas.reduce((a, m) => a + m.linhasDesalinhadas.length, 0),
      comRolagemHorizontal: medidas.filter((m) => m.rolagemHorizontalPx > 2).length,
      comCampoEstourado: medidas.filter((m) => m.camposEstourados.length).length,
      alturasDeCampoNoSistema: [...new Set(medidas.flatMap((m) => m.alturasCampos))].sort(
        (a, b) => a - b,
      ),
      alturasDeBotaoNoSistema: [...new Set(medidas.flatMap((m) => m.alturasBotoes))].sort(
        (a, b) => a - b,
      ),
    };
    if (FASE) writeFileSync(`${OUT}/geometria.json`, JSON.stringify({ resumo, medidas }, null, 2));
    console.warn('GEOMETRIA', JSON.stringify(resumo));
    if (ESTRITO) {
      const ruins = medidas.filter(
        (m) =>
          m.linhasDesalinhadas.length || m.rolagemHorizontalPx > 2 || m.camposEstourados.length,
      );
      expect(
        ruins.map((m) => ({
          rota: m.rota,
          largura: m.largura,
          desal: m.linhasDesalinhadas,
          rolagem: m.rolagemHorizontalPx,
          estourados: m.camposEstourados,
        })),
      ).toEqual([]);
    }
  });
});
