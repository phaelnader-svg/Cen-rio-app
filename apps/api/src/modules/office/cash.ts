/**
 * Quadro de Metas — caixa da empresa a partir dos registros OFICIAIS do Cenário Gestão.
 *
 * Ponto de partida: o saldo informado de cada conta (com data e hora). Depois dele entram só os
 * movimentos posteriores, sem contar o mesmo dinheiro duas vezes:
 * - conta "por registros": recebimentos de clientes (customer_payments, inclusive estornos),
 *   pagamentos de contas (payable_payments e estornos) e de mão de obra por produção
 *   (professional_payments e estornos) — cada um uma vez, pela data do registro oficial;
 * - conta "por extrato": só as linhas do extrato importado; a conciliação liga cada linha ao
 *   registro oficial (OS, conta, mão de obra). Registros oficiais sem conciliação aparecem como
 *   "a conciliar" e não somam (o banco já é a fonte);
 * - lançamentos manuais (aporte, retirada, transferência, despesa sem registro): somam enquanto
 *   não houver a linha correspondente do extrato; conciliados a ela, a linha representa o valor.
 * - cartão: com relatório da maquininha importado, entra o líquido quando cai; sem relatório,
 *   o recebimento no cartão entra pela data da venda (taxa desconhecida).
 */
import { randomUUID } from 'node:crypto';
import { PLATFORM_COMPANY_ID, requireCompanyId } from '../../core/tenant';
import {
  type CashMoveDto,
  type GoalView,
  type WeekFigures,
  addDaysIso,
  brlCents,
  goalView,
  spDate,
  spInstant,
  weekFigures,
  weekStartOf,
} from '@cenario/shared';
import type { PrismaClient } from '@cenario/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorFrom, audit } from '../../core/audit';
import { now as clockNow } from '../../core/clock';
import { Errors } from '../../lib/errors';
import { dueContext, dueOf } from '../finance/revenue';
import { idParams } from '../presenters';
import { type Db, OFFICE_FIN, OFFICE_FIN_VIEW, officeEvent } from './common';

const osCode = (n: number) => `OS-${String(n).padStart(5, '0')}`;
const pedCode = (n: number) => `PED-${String(n).padStart(5, '0')}`;
const CARD = ['CARTAO_CREDITO', 'CARTAO_DEBITO'];
const PAYABLE_CATEGORY: Record<string, string> = {
  MATERIAL: 'Material (fornecedor)',
  LOGISTICA: 'Logística',
  SERVICOS: 'Serviços de terceiros',
  ALUGUEL: 'Aluguel',
  ENERGIA: 'Energia',
  AGUA: 'Água',
  INTERNET: 'Internet',
  COMBUSTIVEL: 'Combustível',
  MARKETING: 'Marketing',
  CONTABILIDADE: 'Contabilidade',
  SISTEMAS: 'Sistemas',
  OUTRAS: 'Outras despesas',
};
const MANUAL_KIND: Record<string, CashMoveDto['kind']> = {
  TRANSFERENCIA: 'TRANSFERENCIA',
  APORTE: 'APORTE',
  RETIRADA: 'RETIRADA',
};

/** Instante de um registro oficial com data de negócio: a hora do lançamento se for no mesmo dia. */
function instantOf(businessDate: Date, createdAt: Date) {
  const d = businessDate.toISOString().slice(0, 10);
  return spDate(createdAt) === d ? createdAt : spInstant(d, '12:00');
}

interface Account {
  id: string;
  label: string;
  bank: string;
  source: 'REGISTROS' | 'EXTRATO';
  isDefault: boolean;
  snapshot: {
    amountCents: number;
    takenAt: Date;
    source: string;
    by: string | null;
    note: string | null;
  } | null;
}

export interface CashState {
  today: string;
  accounts: (Account & {
    balanceCents: number;
    lastUpdate: { at: string | null; origin: string };
  })[];
  moves: CashMoveDto[];
  /** Registros oficiais em conta "por extrato" sem conciliação (não somam). */
  toReconcile: { id: string; date: string; amountCents: number; description: string }[];
  /** Lançamentos manuais casados automaticamente com o extrato (contados uma vez). */
  autoMatched: { entryId: string; txId: string; amountCents: number }[];
  balanceCents: number;
  startedAt: string | null;
}

/** Monta o razão do caixa (contas incluídas, opcionalmente filtradas). */
export async function cashState(db: Db, onlyAccounts?: string[]): Promise<CashState> {
  const now = clockNow();
  const today = spDate(now);
  const rows = await db.bankAccount.findMany({
    where: {
      active: true,
      includedInCash: true,
      ...(onlyAccounts?.length ? { id: { in: onlyAccounts } } : {}),
    },
    include: {
      cashSnapshots: {
        orderBy: { takenAt: 'desc' },
        take: 1,
        include: { createdBy: { select: { displayName: true } } },
      },
    },
    orderBy: { createdAt: 'asc' },
  });
  const accounts: Account[] = rows.map((a) => ({
    id: a.id,
    label: a.label,
    bank: a.bank,
    source: a.cashSource as Account['source'],
    isDefault: a.cashDefault,
    snapshot: a.cashSnapshots[0]
      ? {
          amountCents: a.cashSnapshots[0].amountCents,
          takenAt: a.cashSnapshots[0].takenAt,
          source: a.cashSnapshots[0].source,
          by: a.cashSnapshots[0].createdBy?.displayName ?? null,
          note: a.cashSnapshots[0].note,
        }
      : null,
  }));
  const allDefault = await db.bankAccount.findFirst({
    where: { active: true, includedInCash: true, cashDefault: true },
  });
  const defaultId = allDefault?.id ?? rows[0]?.id ?? null;
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const moves: CashMoveDto[] = [];
  const toReconcile: CashState['toReconcile'] = [];
  const after = (accountId: string, at: Date) => {
    const s = byId.get(accountId)?.snapshot;
    return Boolean(s) && at.getTime() > s!.takenAt.getTime();
  };
  const push = (m: Omit<CashMoveDto, 'accountLabel' | 'date' | 'at'> & { atDate: Date }) => {
    const acc = byId.get(m.accountId);
    if (!acc || !after(m.accountId, m.atDate)) return;
    const { atDate, ...rest } = m;
    moves.push({
      ...rest,
      at: atDate.toISOString(),
      date: spDate(atDate),
      accountLabel: acc.label,
    });
  };

  // Linhas de extrato conciliadas: liga o registro oficial à conta e à linha.
  const txs = await db.bankTransaction.findMany({
    where: { accountId: { in: accounts.map((a) => a.id) } },
  });
  const reconciledRef = new Map(
    txs.filter((t) => t.reconciledRef).map((t) => [t.reconciledRef!, t]),
  );
  const accountOfOfficial = (id: string) => reconciledRef.get(id)?.accountId ?? defaultId;
  const hasCardReports = (await db.cardSettlement.count()) > 0;

  // 1. Recebimentos de clientes (inclui estornos e reembolsos: valores negativos).
  const pays = await db.customerPayment.findMany({
    include: {
      receivable: {
        include: {
          order: { select: { number: true } },
          serviceOrder: { select: { id: true, number: true } },
          customer: { select: { name: true } },
        },
      },
    },
  });
  for (const p of pays) {
    const acc = accountOfOfficial(p.id);
    if (!acc) continue;
    const at = instantOf(p.receivedAt, p.createdAt);
    const card = CARD.includes(p.method);
    if (card && hasCardReports) continue; // o líquido entra pelo relatório da maquininha
    const r = p.receivable;
    const links: CashMoveDto['links'] = [
      {
        type: 'PEDIDO',
        id: r.orderId,
        label: pedCode(r.order.number),
        href: `/painel/financeiro?aba=receitas&pedido=${r.orderId}`,
      },
    ];
    if (r.serviceOrder)
      links.unshift({
        type: 'OS',
        id: r.serviceOrder.id,
        label: osCode(r.serviceOrder.number),
        href: `/painel/os/${r.serviceOrder.id}`,
      });
    if (byId.get(acc)?.source === 'EXTRATO') {
      if (!reconciledRef.has(p.id) && after(acc, at))
        toReconcile.push({
          id: p.id,
          date: spDate(at),
          amountCents: p.amountCents,
          description: `Recebimento ${r.customer.name} — ${r.description}`,
        });
      continue;
    }
    push({
      id: `rec:${p.id}`,
      atDate: at,
      accountId: acc,
      amountCents: p.amountCents,
      kind: 'OPERACAO',
      category:
        p.amountCents < 0
          ? p.refund
            ? 'Reembolso ao cliente'
            : 'Estorno de recebimento'
          : 'Recebimento de cliente',
      description: `${r.customer.name} — ${r.description}${card ? ' (cartão, sem relatório da maquininha: taxa desconhecida)' : ''}`,
      source: 'RECEBIMENTO',
      sourceLabel: `Financeiro › Recebimentos (${p.method})`,
      links,
      reversal: p.amountCents < 0,
      note: p.note,
    });
  }

  // 2. Pagamentos de contas (material, despesas, logística) e seus estornos.
  const pps = await db.payablePayment.findMany({
    include: { payable: { include: { supplier: { select: { name: true } } } }, reversal: true },
  });
  for (const p of pps) {
    const acc = accountOfOfficial(p.id);
    if (!acc) continue;
    const at = instantOf(p.paidAt, p.createdAt);
    const name = p.payable.supplier?.name ?? p.payable.beneficiary;
    const links: CashMoveDto['links'] = [
      {
        type: 'CONTA',
        id: p.payableId,
        label: `${name} — ${p.payable.description}`,
        href: `/painel/financeiro?aba=contas&conta=${p.payableId}`,
      },
    ];
    if (byId.get(acc)?.source === 'EXTRATO') {
      if (!reconciledRef.has(p.id) && after(acc, at))
        toReconcile.push({
          id: p.id,
          date: spDate(at),
          amountCents: -p.amountCents,
          description: `Pagamento ${name} — ${p.payable.description}`,
        });
      continue;
    }
    const cat = PAYABLE_CATEGORY[p.payable.category] ?? p.payable.category;
    push({
      id: `pag:${p.id}`,
      atDate: at,
      accountId: acc,
      amountCents: -p.amountCents,
      kind: 'OPERACAO',
      category: cat,
      description: `${name} — ${p.payable.description}`,
      source: 'PAGAMENTO_CONTA',
      sourceLabel: `Financeiro › Contas a pagar (${p.method})`,
      links,
      reversal: false,
      note: p.note,
    });
    if (p.reversal)
      push({
        id: `pag-est:${p.id}`,
        atDate: p.reversal.createdAt,
        accountId: acc,
        amountCents: p.amountCents,
        kind: 'OPERACAO',
        category: `Estorno: ${cat}`,
        description: `Estorno do pagamento a ${name} — ${p.reversal.reason}`,
        source: 'PAGAMENTO_CONTA',
        sourceLabel: 'Financeiro › Contas a pagar (estorno)',
        links,
        reversal: true,
        note: p.reversal.reason,
      });
  }

  // 3. Mão de obra por produção (vinculada à OS) e estornos.
  const labor = await db.professionalPayment.findMany({
    include: {
      payable: {
        include: {
          serviceOrder: { select: { id: true, number: true } },
          professional: { select: { displayName: true } },
        },
      },
      reversal: true,
    },
  });
  for (const p of labor) {
    const acc = accountOfOfficial(p.id);
    if (!acc) continue;
    const at = instantOf(p.paidAt, p.createdAt);
    const so = p.payable.serviceOrder;
    const links: CashMoveDto['links'] = [
      {
        type: 'MAO_DE_OBRA',
        id: p.productionPayableId,
        label: `Mão de obra ${p.payable.professional.displayName}`,
        href: `/painel/financeiro/mao-de-obra?id=${p.productionPayableId}`,
      },
      { type: 'OS', id: so.id, label: osCode(so.number), href: `/painel/os/${so.id}` },
    ];
    if (byId.get(acc)?.source === 'EXTRATO') {
      if (!reconciledRef.has(p.id) && after(acc, at))
        toReconcile.push({
          id: p.id,
          date: spDate(at),
          amountCents: -p.amountCents,
          description: `Mão de obra ${p.payable.professional.displayName} (${osCode(so.number)})`,
        });
      continue;
    }
    push({
      id: `mo:${p.id}`,
      atDate: at,
      accountId: acc,
      amountCents: -p.amountCents,
      kind: 'OPERACAO',
      category: 'Mão de obra (produção)',
      description: `${p.payable.professional.displayName} — ${p.payable.service} (${osCode(so.number)})`,
      source: 'MAO_DE_OBRA',
      sourceLabel: `Financeiro › Mão de obra (${p.method})`,
      links,
      reversal: false,
      note: p.note,
    });
    if (p.reversal)
      push({
        id: `mo-est:${p.id}`,
        atDate: p.reversal.createdAt,
        accountId: acc,
        amountCents: p.amountCents,
        kind: 'OPERACAO',
        category: 'Estorno: mão de obra',
        description: `Estorno do pagamento a ${p.payable.professional.displayName} — ${p.reversal.reason}`,
        source: 'MAO_DE_OBRA',
        sourceLabel: 'Financeiro › Mão de obra (estorno)',
        links,
        reversal: true,
        note: p.reversal.reason,
      });
  }

  // 4. Maquininha: líquido quando cai (relatório importado).
  if (hasCardReports && defaultId) {
    const cards = await db.cardSettlement.findMany();
    for (const c of cards) {
      const day = (c.settledAt ?? c.expectedDate).toISOString().slice(0, 10);
      if (day > today) continue;
      push({
        id: `card:${c.id}`,
        atDate: spInstant(day, '09:00'),
        accountId: defaultId,
        amountCents: c.netCents,
        kind: 'OPERACAO',
        category: 'Cartão (maquininha)',
        description: `${c.provider}: bruto ${brlCents(c.grossCents)} − taxas ${brlCents(c.feeCents)} = líquido ${brlCents(c.netCents)}${c.installments > 1 ? ` (${c.installments}×)` : ''}`,
        source: 'CARTAO',
        sourceLabel: 'Financeiro › Maquininha (relatório importado)',
        links: [],
        reversal: false,
        note: null,
      });
    }
  }

  // 5. Lançamentos manuais (e estornos), salvo os representados por uma linha do extrato.
  const manual = await db.cashEntry.findMany({
    where: { accountId: { in: accounts.map((a) => a.id) } },
    include: {
      serviceOrder: { select: { id: true, number: true } },
      payable: { select: { id: true, description: true } },
      createdBy: { select: { displayName: true } },
    },
  });
  const supersededByTx = new Set(
    txs
      .filter((t) => t.reconciledKind === 'MANUAL' && t.reconciledRef)
      .map((t) => t.reconciledRef!),
  );
  // Casamento automático manual × extrato (mesmo valor, até 3 dias, ainda sem conciliação).
  const autoMatched: CashState['autoMatched'] = [];
  const usedTx = new Set<string>();
  for (const e of manual) {
    if (supersededByTx.has(e.id) || byId.get(e.accountId)?.source !== 'EXTRATO') continue;
    const tx = txs.find(
      (t) =>
        !usedTx.has(t.id) &&
        (!t.reconciledAt ||
          (t.reconciledKind === 'TRANSFERENCIA' &&
            !t.reconciledRef &&
            e.kind === 'TRANSFERENCIA')) &&
        t.accountId === e.accountId &&
        t.amountCents === e.amountCents &&
        Math.abs(t.date.getTime() - spInstant(spDate(e.occurredAt)).getTime()) <= 3 * 86400000,
    );
    if (tx) {
      usedTx.add(tx.id);
      autoMatched.push({ entryId: e.id, txId: tx.id, amountCents: e.amountCents });
    }
  }
  const autoEntry = new Set(autoMatched.map((x) => x.entryId));
  for (const e of manual) {
    if (supersededByTx.has(e.id) || autoEntry.has(e.id)) continue;
    const links: CashMoveDto['links'] = [
      {
        type: 'LANCAMENTO',
        id: e.id,
        label: 'Lançamento manual',
        href: `/jogo?caixa=lancamento:${e.id}`,
      },
    ];
    if (e.serviceOrder)
      links.push({
        type: 'OS',
        id: e.serviceOrder.id,
        label: osCode(e.serviceOrder.number),
        href: `/painel/os/${e.serviceOrder.id}`,
      });
    if (e.payable)
      links.push({
        type: 'CONTA',
        id: e.payable.id,
        label: e.payable.description,
        href: `/painel/financeiro?aba=contas&conta=${e.payable.id}`,
      });
    push({
      id: `man:${e.id}`,
      atDate: e.occurredAt,
      accountId: e.accountId,
      amountCents: e.amountCents,
      kind: MANUAL_KIND[e.kind] ?? 'OPERACAO',
      category: e.category,
      description: e.description,
      source: 'MANUAL',
      sourceLabel: `Quadro de Metas › lançamento manual${e.createdBy ? ` (${e.createdBy.displayName})` : ''}`,
      links,
      reversal: e.kind === 'ESTORNO',
      note: e.reason,
    });
  }

  // 6. Extrato (contas "por extrato"): cada linha uma vez, com o vínculo da conciliação.
  const officialLinks = new Map(moves.map((m) => [m.id.split(':')[1], m.links]));
  void officialLinks;
  for (const t of txs) {
    const acc = byId.get(t.accountId);
    if (!acc || acc.source !== 'EXTRATO' || !acc.snapshot) continue;
    if (t.date.toISOString().slice(0, 10) <= spDate(acc.snapshot.takenAt)) continue;
    const at = spInstant(t.date.toISOString().slice(0, 10), '12:00');
    const linkedManual =
      t.reconciledKind === 'MANUAL'
        ? manual.find((e) => e.id === t.reconciledRef)
        : autoMatched.find((x) => x.txId === t.id)
          ? manual.find((e) => e.id === autoMatched.find((x) => x.txId === t.id)!.entryId)
          : undefined;
    const kind: CashMoveDto['kind'] =
      t.reconciledKind === 'TRANSFERENCIA'
        ? 'TRANSFERENCIA'
        : linkedManual
          ? (MANUAL_KIND[linkedManual.kind] ?? 'OPERACAO')
          : 'OPERACAO';
    const matchedManual = autoMatched.find((x) => x.txId === t.id);
    moves.push({
      id: `ext:${t.id}`,
      at: at.toISOString(),
      date: spDate(at),
      accountId: t.accountId,
      accountLabel: acc.label,
      amountCents: t.amountCents,
      kind,
      category: linkedManual
        ? linkedManual.category
        : t.reconciledKind === 'RECEBIMENTO'
          ? 'Recebimento de cliente'
          : t.reconciledKind === 'PAGAMENTO'
            ? 'Pagamento (conciliado)'
            : t.reconciledKind === 'TRANSFERENCIA'
              ? 'Transferência entre contas'
              : t.reconciledAt
                ? 'Sem vínculo (tarifa/outros)'
                : 'Extrato a conciliar',
      description: t.description,
      source: 'EXTRATO',
      sourceLabel: `Extrato ${acc.label} (${t.source})${matchedManual ? ' · casado com lançamento manual' : ''}`,
      links: [
        {
          type: 'EXTRATO',
          id: t.id,
          label: `Linha do extrato ${t.date.toISOString().slice(0, 10).split('-').reverse().join('/')}`,
          href: '/jogo?financeiro=BANCO',
        },
      ],
      reversal: false,
      note: null,
    });
  }

  moves.sort((a, b) => a.at.localeCompare(b.at) || a.id.localeCompare(b.id));
  const balanceOf = (accountId: string) =>
    (byId.get(accountId)?.snapshot?.amountCents ?? 0) +
    moves.filter((m) => m.accountId === accountId).reduce((s, m) => s + m.amountCents, 0);
  const lastTx = (accountId: string) =>
    txs
      .filter((t) => t.accountId === accountId)
      .sort((a, b) => b.importedAt.getTime() - a.importedAt.getTime())[0];
  const enriched = accounts.map((a) => {
    const lastMove = moves.filter((m) => m.accountId === a.id).at(-1);
    const tx = lastTx(a.id);
    const candidates = [
      a.snapshot
        ? {
            at: a.snapshot.takenAt.toISOString(),
            origin: `Saldo informado (${a.snapshot.source === 'EXTRATO' ? 'extrato' : 'manual'}${a.snapshot.by ? `, ${a.snapshot.by}` : ''})`,
          }
        : null,
      lastMove ? { at: lastMove.at, origin: lastMove.sourceLabel } : null,
      tx ? { at: tx.importedAt.toISOString(), origin: `Extrato importado (${tx.source})` } : null,
    ].filter((x): x is { at: string; origin: string } => Boolean(x));
    const last = candidates.sort((x, y) => y.at.localeCompare(x.at))[0] ?? {
      at: null,
      origin: 'Sem saldo informado',
    };
    return { ...a, balanceCents: balanceOf(a.id), lastUpdate: last };
  });
  const started = accounts
    .map((a) => a.snapshot?.takenAt)
    .filter((x): x is Date => Boolean(x))
    .sort((a, b) => a.getTime() - b.getTime())[0];
  return {
    today,
    accounts: enriched,
    moves,
    toReconcile,
    autoMatched,
    balanceCents: enriched.reduce((s, a) => s + a.balanceCents, 0),
    startedAt: started?.toISOString() ?? null,
  };
}

/** Saldo das contas num instante (contas sem saldo informado até lá contam pelo valor informado). */
export function balanceAt(st: CashState, at: Date) {
  const base = st.accounts.reduce((s, a) => s + (a.snapshot?.amountCents ?? 0), 0);
  return (
    base +
    st.moves
      .filter((m) => new Date(m.at).getTime() <= at.getTime())
      .reduce((s, m) => s + m.amountCents, 0)
  );
}

export function weekOf(
  st: CashState,
  weekStart: string,
): WeekFigures & { moves: CashMoveDto[]; partial: boolean } {
  const start = spInstant(weekStart);
  const end = spInstant(addDaysIso(weekStart, 7));
  const inWeek = st.moves.filter((m) => new Date(m.at) >= start && new Date(m.at) < end);
  const opening = balanceAt(st, new Date(start.getTime() - 1));
  return {
    ...weekFigures(weekStart, opening, inWeek),
    moves: inWeek,
    partial: spDate(clockNow()) <= addDaysIso(weekStart, 6),
  };
}

/** Semanas desde o primeiro saldo informado até a atual. */
export function weeksOf(st: CashState) {
  if (!st.startedAt) return [];
  const out = [];
  for (let w = weekStartOf(spDate(st.startedAt)); w <= weekStartOf(st.today); w = addDaysIso(w, 7))
    out.push(weekOf(st, w));
  return out;
}

const DEFAULT_GOALS = [
  { name: 'Nível 1 · R$ 100 mil', targetCents: 10_000_000 },
  { name: 'Nível 2 · R$ 200 mil', targetCents: 20_000_000 },
  { name: 'Nível 3 · R$ 300 mil', targetCents: 30_000_000 },
];

/**
 * Metas iniciais só para a empresa da plataforma (histórico). Empresa nova começa sem meta: o
 * jogo pergunta a meta no primeiro acesso, em vez de mostrar 0% de R$ 100 mil.
 */
async function ensureGoals(db: Db) {
  if (requireCompanyId() !== PLATFORM_COMPANY_ID) return;
  if (await db.cashGoal.count()) return;
  await db.cashGoal.createMany({ data: DEFAULT_GOALS });
}

/** Conquistas: primeira vez que o saldo (das contas da meta) alcançou o valor. */
async function detectAchievements(
  db: Db,
  goals: { id: string; targetCents: number; accountIds: string[] }[],
  states: Map<string, CashState>,
) {
  const found: string[] = [];
  for (const g of goals) {
    const st =
      states.get(g.accountIds.slice().sort().join(',')) ?? (await cashState(db, g.accountIds));
    if (!st.startedAt) continue;
    const exists = await db.cashGoalAchievement.findUnique({ where: { goalId: g.id } });
    if (exists) continue;
    let bal = st.accounts.reduce((s, a) => s + (a.snapshot?.amountCents ?? 0), 0);
    let hit: { at: string; bal: number } | null =
      bal >= g.targetCents ? { at: st.startedAt, bal } : null;
    if (!hit)
      for (const m of st.moves) {
        bal += m.amountCents;
        if (bal >= g.targetCents) {
          hit = { at: m.at, bal };
          break;
        }
      }
    if (hit) {
      await db.cashGoalAchievement
        .create({ data: { goalId: g.id, achievedAt: new Date(hit.at), balanceCents: hit.bal } })
        .catch(() => null);
      found.push(g.id);
    }
  }
  return found;
}

/** A receber, a pagar e projeção até uma data (premissas explícitas). */
export async function obligations(db: Db, until: string) {
  const today = spDate(clockNow());
  const receivables = await db.customerReceivable.findMany({
    where: { status: { in: ['ABERTO', 'PARCIAL'] } },
    include: {
      order: { select: { number: true } },
      serviceOrder: { select: { id: true, number: true } },
      customer: { select: { name: true } },
    },
  });
  const dctx = await dueContext(
    db,
    receivables.map((r) => r.orderId),
  );
  const rec = receivables.map((r) => {
    const d = dueOf(r, dctx);
    const ev = dctx.events.get(r.orderId);
    const bucket = d.overdue
      ? 'VENCIDO'
      : r.dueTrigger === 'DATA'
        ? 'COM_DATA'
        : (r.dueTrigger === 'ENTREGA' && ev?.delivery) ||
            (r.dueTrigger === 'RETIRADA' && ev?.pickup)
          ? 'APOS_EVENTO'
          : 'CONDICIONADO';
    return {
      id: r.id,
      label: `${r.customer.name} — ${r.description}`,
      amountCents: r.amountCents - r.receivedCents,
      due: d.effectiveDue,
      trigger: r.dueTrigger,
      bucket: bucket as 'VENCIDO' | 'COM_DATA' | 'APOS_EVENTO' | 'CONDICIONADO',
      method: r.expectedMethod,
      links: [
        ...(r.serviceOrder
          ? [
              {
                type: 'OS',
                id: r.serviceOrder.id,
                label: osCode(r.serviceOrder.number),
                href: `/painel/os/${r.serviceOrder.id}`,
              },
            ]
          : []),
        {
          type: 'PEDIDO',
          id: r.orderId,
          label: pedCode(r.order.number),
          href: `/painel/financeiro?aba=receitas&pedido=${r.orderId}`,
        },
      ],
    };
  });
  const payables = await db.accountPayable.findMany({
    where: { status: { in: ['ABERTO', 'PARCIAL'] } },
    include: {
      supplier: { select: { name: true } },
      paymentOrders: { where: { status: { in: ['PREPARADO', 'AGUARDANDO_APP'] } } },
    },
  });
  const pay = payables.map((p) => ({
    id: p.id,
    label: `${p.supplier?.name ?? p.beneficiary} — ${p.description}`,
    amountCents: p.amountCents - p.paidCents,
    due: p.dueDate.toISOString().slice(0, 10),
    category: PAYABLE_CATEGORY[p.category] ?? p.category,
    prepared: p.paymentOrders[0]?.status ?? null,
    overdue: p.dueDate.toISOString().slice(0, 10) < today,
    links: [
      {
        type: 'CONTA',
        id: p.id,
        label: p.description,
        href: `/painel/financeiro?aba=contas&conta=${p.id}`,
      },
    ],
  }));
  const laborRows = await db.productionPayable.findMany({
    where: { status: { in: ['LIBERADO', 'PAGO_PARCIAL', 'PREVISTO'] } },
    include: {
      serviceOrder: { select: { id: true, number: true } },
      professional: { select: { displayName: true } },
    },
  });
  const labor = laborRows
    .map((l) => ({
      id: l.id,
      label: `${l.professional.displayName} — ${l.service} (${osCode(l.serviceOrder.number)})`,
      amountCents: l.agreedCents + l.adjustmentsCents - l.paidCents,
      released: l.status !== 'PREVISTO',
      links: [
        {
          type: 'OS',
          id: l.serviceOrder.id,
          label: osCode(l.serviceOrder.number),
          href: `/painel/os/${l.serviceOrder.id}`,
        },
      ],
    }))
    .filter((l) => l.amountCents > 0);
  const cards = await db.cardSettlement.findMany({
    where: { settledAt: null, expectedDate: { gt: new Date(`${today}T00:00:00Z`) } },
  });
  const sum = <T extends { amountCents: number }>(xs: T[]) =>
    xs.reduce((s, x) => s + x.amountCents, 0);
  const inWindow = <T extends { due: string | null }>(xs: T[]) =>
    xs.filter((x) => !x.due || x.due <= until);
  const recConfirmed = rec.filter((r) => r.bucket === 'COM_DATA' && r.due && r.due <= until);
  const recOverdue = rec.filter((r) => r.bucket === 'VENCIDO' || r.bucket === 'APOS_EVENTO');
  const recConditional = rec.filter((r) => r.bucket === 'CONDICIONADO');
  const payDue = inWindow(pay);
  const cardsDue = cards.filter((c) => c.expectedDate.toISOString().slice(0, 10) <= until);
  return {
    until,
    receivable: {
      totalCents: sum(rec),
      overdue: recOverdue,
      confirmed: recConfirmed,
      conditional: recConditional,
      later: rec.filter((r) => r.bucket === 'COM_DATA' && r.due && r.due > until),
      cards: cards.map((c) => ({
        id: c.id,
        provider: c.provider,
        grossCents: c.grossCents,
        feeCents: c.feeCents,
        netCents: c.netCents,
        expected: c.expectedDate.toISOString().slice(0, 10),
      })),
    },
    payable: {
      totalCents: sum(pay),
      due: payDue,
      later: pay.filter((p) => !payDue.includes(p)),
      laborReleased: labor.filter((l) => l.released),
      laborForecast: labor.filter((l) => !l.released),
    },
    totals: {
      confirmedInCents: sum(recConfirmed) + cardsDue.reduce((s, c) => s + c.netCents, 0),
      overdueInCents: sum(recOverdue),
      conditionalInCents: sum(recConditional),
      outCents: sum(payDue) + sum(labor.filter((l) => l.released)),
      laborForecastCents: sum(labor.filter((l) => !l.released)),
    },
  };
}

export async function cashBoard(db: Db) {
  await ensureGoals(db);
  const st = await cashState(db);
  const goals = await db.cashGoal.findMany({
    where: { active: true },
    include: { achievement: true },
    orderBy: { targetCents: 'asc' },
  });
  const states = new Map<string, CashState>([['', st]]);
  for (const g of goals) {
    const k = g.accountIds.slice().sort().join(',');
    if (!states.has(k)) states.set(k, await cashState(db, g.accountIds));
  }
  const newly = await detectAchievements(db, goals, states);
  const fresh = newly.length
    ? await db.cashGoal.findMany({
        where: { active: true },
        include: { achievement: true },
        orderBy: { targetCents: 'asc' },
      })
    : goals;
  const views: GoalView[] = fresh.map((g) => {
    const s = states.get(g.accountIds.slice().sort().join(','))!;
    const start = s.accounts.reduce((acc, a) => acc + (a.snapshot?.amountCents ?? 0), 0);
    const deadline = g.deadline?.toISOString().slice(0, 10) ?? null;
    return goalView(
      {
        id: g.id,
        name: g.name,
        targetCents: g.targetCents,
        deadline,
        accountIds: g.accountIds,
        active: g.active,
        version: g.version,
      },
      s.balanceCents,
      start,
      st.today,
      g.achievement
        ? { at: g.achievement.achievedAt.toISOString(), balanceCents: g.achievement.balanceCents }
        : null,
      deadline ? balanceAt(s, spInstant(addDaysIso(deadline, 1))) : null,
    );
  });
  const next =
    views.find((v) => v.balanceCents < v.targetCents && !v.achieved) ??
    views.find((v) => v.balanceCents < v.targetCents) ??
    null;
  const weeks = weeksOf(st);
  // Fechamentos: grava a semana encerrada uma vez e mostra correções feitas depois.
  const closings = await db.cashWeekClosing.findMany();
  const weekViews = [];
  for (const w of weeks) {
    const snap = w.moves.map((m) => ({
      id: m.id,
      amountCents: m.amountCents,
      description: m.description,
    }));
    let stored = closings.find((c) => c.weekStart.toISOString().slice(0, 10) === w.weekStart);
    if (!w.partial && !stored)
      stored = await db.cashWeekClosing
        .create({
          data: {
            weekStart: new Date(`${w.weekStart}T00:00:00Z`),
            openingCents: w.openingCents,
            closingCents: w.closingCents,
            inCents: w.inCents,
            outCents: w.outCents,
            entries: snap,
          },
        })
        .catch(() => undefined);
    let corrections: {
      id: string;
      description: string;
      beforeCents: number | null;
      afterCents: number | null;
    }[] = [];
    if (stored && !w.partial) {
      const before = new Map(
        (stored.entries as { id: string; amountCents: number; description: string }[]).map((e) => [
          e.id,
          e,
        ]),
      );
      const now = new Map(snap.map((e) => [e.id, e]));
      corrections = [
        ...[...now.values()]
          .filter((e) => before.get(e.id)?.amountCents !== e.amountCents)
          .map((e) => ({
            id: e.id,
            description: e.description,
            beforeCents: before.get(e.id)?.amountCents ?? null,
            afterCents: e.amountCents,
          })),
        ...[...before.values()]
          .filter((e) => !now.has(e.id))
          .map((e) => ({
            id: e.id,
            description: e.description,
            beforeCents: e.amountCents,
            afterCents: null,
          })),
      ];
    }
    const top = (sign: 1 | -1) =>
      w.moves
        .filter((m) => m.kind !== 'TRANSFERENCIA' && Math.sign(m.amountCents) === sign)
        .sort((a, b) => Math.abs(b.amountCents) - Math.abs(a.amountCents))
        .slice(0, 5);
    weekViews.push({
      ...w,
      moves: undefined,
      moveIds: w.moves.map((m) => m.id),
      topIn: top(1),
      topOut: top(-1),
      closedAt: stored?.closedAt.toISOString() ?? null,
      closedFigures: stored
        ? { openingCents: stored.openingCents, closingCents: stored.closingCents }
        : null,
      corrections,
    });
  }
  const horizon =
    next?.deadline ??
    addDaysIso(st.today, 6 - ((new Date(`${st.today}T12:00:00Z`).getUTCDay() + 6) % 7));
  const ob = await obligations(db, horizon);
  const projection = {
    until: horizon,
    balanceCents: st.balanceCents,
    confirmedCents: st.balanceCents + ob.totals.confirmedInCents - ob.totals.outCents,
    withOverdueCents:
      st.balanceCents + ob.totals.confirmedInCents + ob.totals.overdueInCents - ob.totals.outCents,
    withConditionalCents:
      st.balanceCents +
      ob.totals.confirmedInCents +
      ob.totals.overdueInCents +
      ob.totals.conditionalInCents -
      ob.totals.outCents,
    premises: [
      `Saldo de hoje: ${brlCents(st.balanceCents)} (contas incluídas).`,
      `Entra com data até ${horizon.split('-').reverse().join('/')}: ${brlCents(ob.totals.confirmedInCents)} (inclui maquininha com previsão).`,
      `Vencido a cobrar: ${brlCents(ob.totals.overdueInCents)} — só entra se o cliente pagar.`,
      `Depende de entrega/retirada: ${brlCents(ob.totals.conditionalInCents)} — só entra se a entrega acontecer.`,
      `Sai até ${horizon.split('-').reverse().join('/')}: ${brlCents(ob.totals.outCents)} (contas a pagar e mão de obra liberada).`,
      ob.totals.laborForecastCents
        ? `Mão de obra ainda prevista (não liberada): ${brlCents(ob.totals.laborForecastCents)}, fora do cálculo.`
        : null,
    ].filter(Boolean),
  };
  // Entregas concluídas (fluxo oficial) nos últimos 14 dias: comemora e mostra o saldo que
  // continua em "A receber" até ser liquidado.
  const since = new Date(clockNow().getTime() - 14 * 86400_000);
  const delivered = await db.delivery.findMany({
    where: { status: 'CONCLUIDA', completedAt: { gte: since } },
    include: {
      customer: { select: { name: true } },
      items: {
        where: { status: { in: ['ENTREGUE', 'DIVERGENTE'] } },
        include: {
          serviceOrderItem: {
            include: { serviceOrder: { select: { id: true, number: true, orderId: true } } },
          },
        },
      },
    },
    orderBy: { completedAt: 'desc' },
  });
  const deliveries = [];
  for (const d of delivered) {
    const sos = [
      ...new Map(
        d.items.map((i) => [i.serviceOrderItem.serviceOrder.id, i.serviceOrderItem.serviceOrder]),
      ).values(),
    ];
    let open = 0;
    for (const orderId of new Set(sos.map((s) => s.orderId))) {
      const r = await db.customerReceivable.findMany({
        where: { orderId, status: { in: ['ABERTO', 'PARCIAL'] } },
      });
      open += r.reduce((s, x) => s + x.amountCents - x.receivedCents, 0);
    }
    deliveries.push({
      id: d.id,
      customer: d.customer.name,
      completedAt: d.completedAt!.toISOString(),
      osCodes: sos.map((s) => osCode(s.number)),
      serviceOrderIds: sos.map((s) => s.id),
      openCents: open,
    });
  }
  return {
    today: st.today,
    startedAt: st.startedAt,
    balanceCents: st.balanceCents,
    accounts: st.accounts.map((a) => ({
      ...a,
      snapshot: a.snapshot ? { ...a.snapshot, takenAt: a.snapshot.takenAt.toISOString() } : null,
    })),
    toReconcile: st.toReconcile,
    autoMatched: st.autoMatched,
    goals: views,
    nextGoalId: next?.id ?? null,
    newlyAchieved: newly,
    weeks: weekViews.reverse(),
    obligations: ob,
    projection,
    deliveries,
    moveCount: st.moves.length,
  };
}

const kindSchema = z.enum([
  'RECEBIMENTO',
  'DESPESA',
  'MATERIAL',
  'MAO_DE_OBRA',
  'TRANSFERENCIA',
  'APORTE',
  'RETIRADA',
  'AJUSTE',
]);
const KIND_CATEGORY: Record<string, string> = {
  RECEBIMENTO: 'Recebimento (manual)',
  DESPESA: 'Despesa (manual)',
  MATERIAL: 'Material (manual)',
  MAO_DE_OBRA: 'Mão de obra (manual)',
  TRANSFERENCIA: 'Transferência entre contas',
  APORTE: 'Aporte dos sócios',
  RETIRADA: 'Retirada dos sócios',
  AJUSTE: 'Ajuste de saldo',
};
const OUTGOING = ['DESPESA', 'MATERIAL', 'MAO_DE_OBRA', 'RETIRADA'];

export async function cashRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;

  app.get('/api/v1/office/cash', { config: { access: OFFICE_FIN_VIEW } }, async () =>
    cashBoard(prisma),
  );

  /** Lançamentos que compõem um número (drill-down): por ids, semana, conta, categoria ou período. */
  app.get('/api/v1/office/cash/moves', { config: { access: OFFICE_FIN_VIEW } }, async (request) => {
    const q = z
      .object({
        ids: z.string().max(20000).optional(),
        week: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}$/)
          .optional(),
        from: z.string().optional(),
        to: z.string().optional(),
        accountId: z.string().uuid().optional(),
        category: z.string().max(60).optional(),
        goalId: z.string().uuid().optional(),
      })
      .parse(request.query);
    const goal = q.goalId ? await prisma.cashGoal.findUnique({ where: { id: q.goalId } }) : null;
    const st = await cashState(prisma, goal?.accountIds);
    let moves = st.moves;
    if (q.ids) {
      const set = new Set(q.ids.split(','));
      moves = moves.filter((m) => set.has(m.id));
    }
    if (q.week) {
      const w = weekOf(st, q.week);
      moves = w.moves;
    }
    if (q.from) moves = moves.filter((m) => m.date >= q.from!);
    if (q.to) moves = moves.filter((m) => m.date <= q.to!);
    if (q.accountId) moves = moves.filter((m) => m.accountId === q.accountId);
    if (q.category) moves = moves.filter((m) => m.category === q.category);
    return {
      moves: moves.slice().reverse(),
      totalCents: moves.reduce((s, m) => s + m.amountCents, 0),
      base: st.accounts.map((a) => ({
        account: a.label,
        snapshot: a.snapshot
          ? {
              amountCents: a.snapshot.amountCents,
              takenAt: a.snapshot.takenAt.toISOString(),
              origin: a.snapshot.source,
            }
          : null,
      })),
    };
  });

  app.post(
    '/api/v1/office/cash/accounts',
    { config: { access: OFFICE_FIN, idempotent: true } },
    async (request) => {
      const b = z
        .object({
          label: z.string().trim().min(2).max(120),
          bank: z.string().trim().min(2).max(80),
          masked: z.string().trim().max(80).optional(),
          isDefault: z.boolean().default(false),
        })
        .parse(request.body);
      const actor = actorFrom(request);
      return prisma.$transaction(async (tx) => {
        const first = (await tx.bankAccount.count({ where: { cashDefault: true } })) === 0;
        if (b.isDefault)
          await tx.bankAccount.updateMany({
            where: { cashDefault: true },
            data: { cashDefault: false },
          });
        const a = await tx.bankAccount.create({
          data: {
            label: b.label,
            bank: b.bank,
            masked: b.masked,
            cashDefault: b.isDefault || first,
          },
        });
        await audit(tx, actor, {
          action: 'office.cash_account_added',
          entityType: 'bank_account',
          entityId: a.id,
          summary: `Conta ${a.label} incluída no caixa.`,
        });
        await officeEvent(tx, actor, 'cash', a.id);
        return a;
      });
    },
  );

  app.put(
    '/api/v1/office/cash/accounts/:id',
    { config: { access: OFFICE_FIN, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const b = z
        .object({
          includedInCash: z.boolean().optional(),
          isDefault: z.boolean().optional(),
          cashSource: z.enum(['REGISTROS', 'EXTRATO']).optional(),
        })
        .parse(request.body);
      const actor = actorFrom(request);
      return prisma.$transaction(async (tx) => {
        if (b.isDefault)
          await tx.bankAccount.updateMany({
            where: { cashDefault: true, id: { not: id } },
            data: { cashDefault: false },
          });
        const a = await tx.bankAccount.update({
          where: { id },
          data: {
            includedInCash: b.includedInCash,
            cashDefault: b.isDefault,
            cashSource: b.cashSource,
          },
        });
        await audit(tx, actor, {
          action: 'office.cash_account_changed',
          entityType: 'bank_account',
          entityId: id,
          summary: `Conta ${a.label}: ${a.includedInCash ? 'incluída' : 'fora do caixa'}${a.cashDefault ? ', conta padrão' : ''}, fonte ${a.cashSource === 'EXTRATO' ? 'extrato' : 'registros oficiais'}.`,
          changes: b,
        });
        await officeEvent(tx, actor, 'cash', id);
        return a;
      });
    },
  );

  /** Saldo informado (ponto de partida). Corrigir = informar de novo; o anterior fica no histórico. */
  app.post(
    '/api/v1/office/cash/snapshots',
    { config: { access: OFFICE_FIN, idempotent: true } },
    async (request) => {
      const b = z
        .object({
          accountId: z.string().uuid(),
          amountCents: z.number().int().min(-1_000_000_000).max(10_000_000_000),
          takenAt: z.string().datetime({ offset: true }).optional(),
          note: z.string().trim().max(300).optional(),
        })
        .parse(request.body);
      const actor = actorFrom(request);
      const takenAt = b.takenAt ? new Date(b.takenAt) : clockNow();
      if (takenAt.getTime() > clockNow().getTime() + 60_000)
        throw Errors.business('O saldo informado não pode ser de um horário futuro.');
      return prisma.$transaction(async (tx) => {
        const acc = await tx.bankAccount.findUnique({ where: { id: b.accountId } });
        if (!acc) throw Errors.notFound('Conta');
        const s = await tx.cashSnapshot.create({
          data: {
            accountId: b.accountId,
            amountCents: b.amountCents,
            takenAt,
            note: b.note ?? null,
            createdById: actor.userId,
          },
        });
        await audit(tx, actor, {
          action: 'office.cash_snapshot',
          entityType: 'bank_account',
          entityId: b.accountId,
          summary: `Saldo de ${acc.label} informado: ${brlCents(b.amountCents)} em ${takenAt.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}.`,
        });
        await officeEvent(tx, actor, 'cash', b.accountId);
        return s;
      });
    },
  );

  app.get('/api/v1/office/cash/snapshots', { config: { access: OFFICE_FIN_VIEW } }, async () => {
    const rows = await prisma.cashSnapshot.findMany({
      include: {
        account: { select: { label: true } },
        createdBy: { select: { displayName: true } },
      },
      orderBy: { takenAt: 'desc' },
      take: 50,
    });
    return rows.map((r) => ({
      id: r.id,
      account: r.account.label,
      amountCents: r.amountCents,
      takenAt: r.takenAt.toISOString(),
      source: r.source,
      note: r.note,
      by: r.createdBy?.displayName ?? null,
    }));
  });

  /** Lançamento manual (enquanto não há integração) e transferência entre contas incluídas. */
  app.post(
    '/api/v1/office/cash/entries',
    { config: { access: OFFICE_FIN, idempotent: true } },
    async (request) => {
      const b = z
        .object({
          accountId: z.string().uuid(),
          kind: kindSchema,
          amountCents: z.number().int().positive().max(10_000_000_000),
          occurredAt: z.string().datetime({ offset: true }).optional(),
          description: z.string().trim().min(2).max(300),
          serviceOrderId: z.string().uuid().optional(),
          payableId: z.string().uuid().optional(),
          toAccountId: z.string().uuid().optional(),
        })
        .refine(
          (v) => v.kind !== 'TRANSFERENCIA' || (v.toAccountId && v.toAccountId !== v.accountId),
          'Escolha a conta de destino da transferência.',
        )
        .parse(request.body);
      const actor = actorFrom(request);
      const at = b.occurredAt ? new Date(b.occurredAt) : clockNow();
      return prisma.$transaction(async (tx) => {
        const base = {
          occurredAt: at,
          category: KIND_CATEGORY[b.kind]!,
          description: b.description,
          serviceOrderId: b.serviceOrderId ?? null,
          payableId: b.payableId ?? null,
          createdById: actor.userId,
        };
        const out = [];
        if (b.kind === 'TRANSFERENCIA') {
          const group = randomUUID();
          out.push(
            await tx.cashEntry.create({
              data: {
                ...base,
                accountId: b.accountId,
                kind: 'TRANSFERENCIA',
                amountCents: -b.amountCents,
                transferGroupId: group,
              },
            }),
          );
          out.push(
            await tx.cashEntry.create({
              data: {
                ...base,
                accountId: b.toAccountId!,
                kind: 'TRANSFERENCIA',
                amountCents: b.amountCents,
                transferGroupId: group,
              },
            }),
          );
        } else
          out.push(
            await tx.cashEntry.create({
              data: {
                ...base,
                accountId: b.accountId,
                kind: b.kind,
                amountCents: OUTGOING.includes(b.kind) ? -b.amountCents : b.amountCents,
              },
            }),
          );
        await audit(tx, actor, {
          action: 'office.cash_entry',
          entityType: 'cash_entry',
          entityId: out[0]!.id,
          summary: `${KIND_CATEGORY[b.kind]}: ${brlCents(b.amountCents)} — ${b.description}.`,
        });
        await officeEvent(tx, actor, 'cash', out[0]!.id);
        return out;
      });
    },
  );

  /** Correção: estorno com motivo (o original fica no histórico). Transferência estorna os dois lados. */
  app.post(
    '/api/v1/office/cash/entries/:id/reverse',
    { config: { access: OFFICE_FIN, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const { reason } = z
        .object({ reason: z.string().trim().min(3).max(500) })
        .parse(request.body);
      const actor = actorFrom(request);
      return prisma.$transaction(async (tx) => {
        const e = await tx.cashEntry.findUnique({ where: { id }, include: { reversedBy: true } });
        if (!e) throw Errors.notFound('Lançamento');
        if (e.kind === 'ESTORNO') throw Errors.business('Um estorno não pode ser estornado.');
        if (e.reversedBy) throw Errors.conflict('Este lançamento já foi estornado.');
        const group = e.transferGroupId
          ? await tx.cashEntry.findMany({ where: { transferGroupId: e.transferGroupId } })
          : [e];
        const out = [];
        for (const g of group)
          out.push(
            await tx.cashEntry.create({
              data: {
                accountId: g.accountId,
                occurredAt: clockNow(),
                amountCents: -g.amountCents,
                kind: 'ESTORNO',
                category: `Estorno: ${g.category}`,
                description: `Estorno de "${g.description}"`,
                reversalOfId: g.id,
                reason,
                transferGroupId: g.transferGroupId,
                createdById: actor.userId,
              },
            }),
          );
        await audit(tx, actor, {
          action: 'office.cash_entry_reversed',
          entityType: 'cash_entry',
          entityId: id,
          summary: `Lançamento estornado: ${e.description} (${reason}).`,
        });
        await officeEvent(tx, actor, 'cash', id);
        return out;
      });
    },
  );

  app.post(
    '/api/v1/office/cash/goals',
    { config: { access: OFFICE_FIN, idempotent: true } },
    async (request) => {
      const b = z
        .object({
          name: z.string().trim().min(2).max(80),
          targetCents: z.number().int().positive().max(100_000_000_000),
          deadline: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .nullable()
            .optional(),
          accountIds: z.array(z.string().uuid()).max(20).default([]),
        })
        .parse(request.body);
      const actor = actorFrom(request);
      return prisma.$transaction(async (tx) => {
        const g = await tx.cashGoal.create({
          data: {
            name: b.name,
            targetCents: b.targetCents,
            deadline: b.deadline ? new Date(`${b.deadline}T00:00:00Z`) : null,
            accountIds: b.accountIds,
            createdById: actor.userId,
          },
        });
        await audit(tx, actor, {
          action: 'office.cash_goal_created',
          entityType: 'cash_goal',
          entityId: g.id,
          summary: `Meta "${g.name}" (${brlCents(g.targetCents)}) criada.`,
        });
        await officeEvent(tx, actor, 'cash', g.id);
        return g;
      });
    },
  );

  app.put(
    '/api/v1/office/cash/goals/:id',
    { config: { access: OFFICE_FIN, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const b = z
        .object({
          name: z.string().trim().min(2).max(80),
          targetCents: z.number().int().positive().max(100_000_000_000),
          deadline: z
            .string()
            .regex(/^\d{4}-\d{2}-\d{2}$/)
            .nullable(),
          accountIds: z.array(z.string().uuid()).max(20),
          active: z.boolean().default(true),
          version: z.number().int().positive(),
        })
        .parse(request.body);
      const actor = actorFrom(request);
      return prisma.$transaction(async (tx) => {
        const g = await tx.cashGoal.findUnique({ where: { id }, include: { achievement: true } });
        if (!g) throw Errors.notFound('Meta');
        if (g.version !== b.version) throw Errors.conflict('A meta mudou. Recarregue.');
        // Meta mais alta que o saldo da conquista: a conquista antiga não vale para o novo valor.
        if (g.achievement && b.targetCents > g.achievement.balanceCents)
          await tx.cashGoalAchievement.delete({ where: { goalId: id } });
        const u = await tx.cashGoal.update({
          where: { id },
          data: {
            name: b.name,
            targetCents: b.targetCents,
            deadline: b.deadline ? new Date(`${b.deadline}T00:00:00Z`) : null,
            accountIds: b.accountIds,
            active: b.active,
            version: { increment: 1 },
          },
        });
        await audit(tx, actor, {
          action: 'office.cash_goal_changed',
          entityType: 'cash_goal',
          entityId: id,
          summary: `Meta "${u.name}" ajustada (${brlCents(u.targetCents)}${b.deadline ? `, prazo ${b.deadline.split('-').reverse().join('/')}` : ''}).`,
          changes: { from: { targetCents: g.targetCents, deadline: g.deadline }, to: b },
        });
        await officeEvent(tx, actor, 'cash', id);
        return u;
      });
    },
  );
}

export type CashBoardDto = Awaited<ReturnType<typeof cashBoard>>;
export const cashDb = (p: PrismaClient) => p;
