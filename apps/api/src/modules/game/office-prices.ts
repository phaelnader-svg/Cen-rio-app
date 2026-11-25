/**
 * Preço dos materiais (2026-11-25). A nota da compra lida pelo Financeiro (despesa pela foto)
 * guarda o preço de cada material e de quem foi comprado. Com isso:
 * - Compras compara os fornecedores (o pedido mostra quem cobrou menos da última vez);
 * - Orçamentos avisa quando o material subiu acima do custo da tabela e propõe atualizar
 *   (mudar preço sempre pede aprovação).
 */
import type { OfficeMaterialPricesDto } from '@cenario/shared';
import type { PrismaClient, Tx } from '@cenario/db';
import type { ActorContext } from '../../core/types';
import { audit } from '../../core/audit';
import { Errors } from '../../lib/errors';
import type { ProposalDraft } from './agent-engines';

type Db = PrismaClient | Tx;

export interface ReceiptItem {
  description: string;
  quantity: number | null;
  unit: string | null;
  unitPriceCents: number;
}

const STOP = new Set([
  'de',
  'da',
  'do',
  'das',
  'dos',
  'com',
  'e',
  'ltda',
  'me',
  'epp',
  'eireli',
  'sa',
  'comercio',
  'industria',
]);
export const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
const tokens = (s: string) =>
  norm(s)
    .split(' ')
    .filter((t) => t && !STOP.has(t));

const UNITS: Record<string, string> = {
  m: 'm',
  mt: 'm',
  mts: 'm',
  metro: 'm',
  metros: 'm',
  kg: 'kg',
  quilo: 'kg',
  un: 'un',
  und: 'un',
  unid: 'un',
  unidade: 'un',
  unidades: 'un',
  pc: 'un',
  pca: 'un',
  peca: 'un',
  pecas: 'un',
  rolo: 'rolo',
  rolos: 'rolo',
  folha: 'folha',
  folhas: 'folha',
  placa: 'folha',
  placas: 'folha',
  l: 'l',
  litro: 'l',
  litros: 'l',
  cx: 'cx',
  caixa: 'cx',
};
export const unitKey = (u: string | null | undefined) => {
  const k = norm(u ?? '').replace(/ /g, '');
  return k ? (UNITS[k] ?? k) : null;
};
/** Mesma unidade (sem unidade de um lado, aceita). */
const sameUnit = (a: string | null, b: string | null) =>
  !unitKey(a) || !unitKey(b) || unitKey(a) === unitKey(b);

/** O nome do material da tabela está todo dentro da descrição da nota (ex.: "Linho" em "Tecido linho bege"). */
const contains = (desc: string, name: string) => {
  const d = new Set(tokens(desc));
  const n = tokens(name);
  return n.length > 0 && n.every((t) => d.has(t));
};

export function matchCatalog<T extends { id: string; name: string; unit: string | null }>(
  item: { description: string; unit: string | null },
  catalog: T[],
): T | null {
  const hits = catalog
    .filter((c) => contains(item.description, c.name) && sameUnit(item.unit, c.unit))
    .sort((a, b) => tokens(b.name).length - tokens(a.name).length);
  return hits[0] ?? null;
}

/** O mesmo fornecedor com nomes diferentes ("Tecidos Vale" e "TECIDOS VALE LTDA"). */
export function sameSupplier(a: string, b: string) {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.length || !tb.length) return false;
  const [small, big] = ta.length <= tb.length ? [ta, new Set(tb)] : [tb, new Set(ta)];
  return small.every((t) => big.has(t));
}

/** Guarda o preço de cada material da nota (despesa aprovada). */
export async function saveReceiptPrices(
  tx: Tx,
  input: {
    items: ReceiptItem[];
    supplierName: string;
    date: string;
    expenseId: string | null;
    fileId: string | null;
  },
) {
  const items = input.items.filter((i) => i.unitPriceCents > 0 && i.description.trim().length > 1);
  if (!items.length) return 0;
  const catalog = await tx.quoteCatalogItem.findMany({
    where: { kind: 'MATERIAL' },
    select: { id: true, name: true, unit: true },
  });
  await tx.materialPrice.createMany({
    data: items.slice(0, 40).map((i) => ({
      description: i.description.trim().slice(0, 200),
      unit: i.unit?.trim().slice(0, 20) || null,
      quantity: i.quantity ?? null,
      unitPriceCents: i.unitPriceCents,
      supplierName: input.supplierName.slice(0, 160),
      purchasedOn: new Date(`${input.date}T00:00:00Z`),
      expenseId: input.expenseId,
      fileId: input.fileId,
      catalogItemId: matchCatalog(i, catalog)?.id ?? null,
    })),
  });
  return items.length;
}

const brl = (c: number) =>
  (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const br = (d: Date) => d.toISOString().slice(0, 10).split('-').reverse().join('/');
const per = (u: string | null) =>
  unitKey(u) ? ` o ${unitKey(u) === 'm' ? 'metro' : unitKey(u)}` : '';
const daysAgo = (today: string, n: number) => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d;
};

/** Subiu 3% ou mais: menos que isso é arredondamento e não vale mexer na tabela. */
const RISE = 1.03;

/** Orçamentos: o material da tabela que saiu mais caro na última compra (últimos 60 dias). */
export async function tableAdjustProposals(db: Db, today: string): Promise<ProposalDraft[]> {
  const catalog = await db.quoteCatalogItem.findMany({
    where: { kind: 'MATERIAL', priceCents: { gt: 0 } },
    select: {
      id: true,
      name: true,
      unit: true,
      priceCents: true,
      version: true,
      prices: {
        where: { purchasedOn: { gte: daysAgo(today, 60) } },
        orderBy: [{ purchasedOn: 'desc' }, { createdAt: 'desc' }],
        take: 1,
      },
    },
  });
  const out: ProposalDraft[] = [];
  for (const c of catalog) {
    const last = c.prices[0];
    if (!last || !c.priceCents || last.unitPriceCents < c.priceCents * RISE) continue;
    const pct = Math.round((last.unitPriceCents / c.priceCents - 1) * 100);
    out.push({
      kind: 'AJUSTAR_TABELA',
      title: `${c.name} subiu ${pct}%: atualizar a tabela para ${brl(last.unitPriceCents)}${per(c.unit)}`,
      detail: [
        `Na tabela do orçamento o custo está ${brl(c.priceCents)}${per(c.unit)}.`,
        `Na última compra (${last.supplierName}, ${br(last.purchasedOn)}) saiu ${brl(last.unitPriceCents)}${per(last.unit)}.`,
        'Atualizando, os próximos orçamentos já saem com o preço certo. Os que já foram enviados não mudam.',
      ].join('\n'),
      payload: {
        task: 'AJUSTAR_TABELA',
        dedupe: `AJUSTAR_TABELA:${c.id}:${last.unitPriceCents}`,
        catalogItemId: c.id,
        catalogName: c.name,
        unit: c.unit,
        fromCents: c.priceCents,
        toCents: last.unitPriceCents,
        supplierName: last.supplierName,
        purchasedOn: last.purchasedOn.toISOString().slice(0, 10),
      },
      evidence: [],
    });
  }
  return out;
}

/** Aprovar: muda o custo do material na tabela (o dono pode escolher outro valor). */
export async function applyTableAdjust(
  tx: Tx,
  actor: ActorContext,
  perms: ReadonlySet<string>,
  p: { payload: unknown },
  edits: { priceCents?: number } | undefined,
) {
  if (!perms.has('orcamentos.gerenciar'))
    throw Errors.forbidden('Mudar a tabela exige a permissão de orçamentos.');
  const pl = (p.payload ?? {}) as Record<string, unknown>;
  const to = edits?.priceCents ?? Number(pl.toCents);
  if (!Number.isInteger(to) || to <= 0 || to > 100_000_000)
    throw Errors.validation(undefined, 'Preço inválido.');
  const item = await tx.quoteCatalogItem.findUnique({ where: { id: String(pl.catalogItemId) } });
  if (!item) throw Errors.notFound('Material da tabela');
  if (item.priceCents !== Number(pl.fromCents))
    throw Errors.conflict('O preço deste material já mudou na tabela. Confira em Orçamentos.');
  await tx.quoteCatalogItem.update({
    where: { id: item.id },
    data: { priceCents: to, version: { increment: 1 } },
  });
  await audit(tx, actor, {
    action: 'quotes.catalog_price_adjusted',
    entityType: 'quote_catalog_item',
    entityId: item.id,
    summary: `Custo de ${item.name} na tabela: ${brl(item.priceCents ?? 0)} → ${brl(to)} (aviso do Orçamentos).`,
  });
  return { priceCents: to, ...(to !== Number(pl.toCents) ? { edited: true } : {}) };
}

/** Compras: preço que cada fornecedor cobrou da última vez, por material (últimos 6 meses). */
export async function materialPrices(db: Db, today: string): Promise<OfficeMaterialPricesDto> {
  const rows = await db.materialPrice.findMany({
    where: { purchasedOn: { gte: daysAgo(today, 180) } },
    include: { catalogItem: { select: { name: true, unit: true } } },
    orderBy: [{ purchasedOn: 'desc' }, { createdAt: 'desc' }],
    take: 500,
  });
  const groups = new Map<
    string,
    { name: string; unit: string | null; suppliers: Map<string, (typeof rows)[number]> }
  >();
  for (const r of rows) {
    const name = r.catalogItem?.name ?? r.description;
    const unit = r.catalogItem?.unit ?? r.unit;
    const key = `${r.catalogItemId ?? norm(r.description)}|${unitKey(unit) ?? ''}`;
    const g = groups.get(key) ?? { name, unit, suppliers: new Map() };
    groups.set(key, g);
    // Só a compra mais recente de cada fornecedor (as linhas vêm da mais nova para a mais velha).
    const sup = [...g.suppliers.keys()].find((s) => sameSupplier(s, r.supplierName));
    if (!sup) g.suppliers.set(r.supplierName, r);
  }
  const materials = [...groups.values()]
    .map((g) => {
      const list = [...g.suppliers.values()]
        .map((r) => ({
          supplierName: r.supplierName,
          unitPriceCents: r.unitPriceCents,
          date: r.purchasedOn.toISOString().slice(0, 10),
        }))
        .sort((a, b) => a.unitPriceCents - b.unitPriceCents);
      return { name: g.name, unit: unitKey(g.unit), suppliers: list };
    })
    // Primeiro os que têm mais de um fornecedor (dá para comparar).
    .sort((a, b) => b.suppliers.length - a.suppliers.length || a.name.localeCompare(b.name));
  return { materials: materials.slice(0, 30) };
}

/**
 * Pedido ao fornecedor: para cada material do pedido, o que cada fornecedor cobrou da última vez.
 * Se outro fornecedor cobrou menos (3% ou mais), a proposta avisa.
 */
export async function withSupplierPrices(db: Db, ps: ProposalDraft[], today: string) {
  if (!ps.some((p) => p.kind === 'PEDIR_FORNECEDOR')) return ps;
  const { materials } = await materialPrices(db, today);
  if (!materials.length) return ps;
  const needs = await db.serviceOrderMaterial.findMany({
    where: {
      id: { in: ps.flatMap((p) => (p.payload.materialIds as string[] | undefined) ?? []) },
    },
    select: { id: true, description: true, unit: true },
  });
  return ps.map((p) => {
    if (p.kind !== 'PEDIR_FORNECEDOR') return p;
    const ids = new Set((p.payload.materialIds as string[] | undefined) ?? []);
    const supplier = String(p.payload.supplierName ?? '');
    const prices: {
      description: string;
      unit: string | null;
      suppliers: { supplierName: string; unitPriceCents: number; date: string }[];
    }[] = [];
    const hints: string[] = [];
    for (const n of needs.filter((x) => ids.has(x.id))) {
      const m = materials.find(
        (x) =>
          (contains(n.description, x.name) || contains(x.name, n.description)) &&
          sameUnit(n.unit, x.unit),
      );
      if (!m) continue;
      prices.push({ description: n.description, unit: m.unit, suppliers: m.suppliers });
      const mine = m.suppliers.find((s) => sameSupplier(s.supplierName, supplier));
      const best = m.suppliers[0]!;
      if (
        mine &&
        !sameSupplier(best.supplierName, supplier) &&
        best.unitPriceCents * RISE <= mine.unitPriceCents
      )
        hints.push(
          `${n.description}: na ${best.supplierName} saiu ${brl(best.unitPriceCents)}${per(m.unit)} e na ${mine.supplierName} ${brl(mine.unitPriceCents)}.`,
        );
    }
    if (!prices.length) return p;
    return {
      ...p,
      payload: {
        ...p.payload,
        prices,
        ...(hints.length ? { cheaperElsewhere: hints } : {}),
      },
    };
  });
}
