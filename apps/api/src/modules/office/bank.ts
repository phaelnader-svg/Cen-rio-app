/**
 * Banco PJ, pagamentos e maquininha (agente Financeiro).
 * - Extrato importado (OFX/CSV) é a fonte da conciliação; reimportar não duplica (fitId).
 * - Pagamento preparado mostra favorecido, valor, vencimento, conta de origem e vínculo; o gestor
 *   confirma; a autorização final acontece no app do banco. Só vira PAGO quando o extrato
 *   (conciliação) ou o provedor confirmar — nunca pelo clique de preparar.
 * - Maquininha: bruto, taxa, líquido e previsão de depósito.
 */
import { createHash } from 'node:crypto';
import type { Tx } from '@cenario/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorFrom, audit } from '../../core/audit';
import { Errors } from '../../lib/errors';
import { shopTimezone, todayIso } from '../finance/common';
import { payPayable } from '../finance/payables';
import { receivePayment } from '../finance/revenue';
import { idParams } from '../presenters';
import { type Db, OFFICE_FIN, OFFICE_FIN_VIEW, brl, officeEvent } from './common';

const dateOnly = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const d10 = (d: Date | null) => d?.toISOString().slice(0, 10) ?? null;

// ───────────────────────────── Leitura de extratos ─────────────────────────────

export interface StatementLine {
  fitId: string;
  date: string;
  amountCents: number;
  description: string;
}
const money = (s: string) => {
  const t = s.trim().replace(/R\$\s?/, '');
  const n = /,\d{1,2}$/.test(t) ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  return Math.round(Number(n) * 100);
};
const brDate = (s: string) => {
  const m = s.trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : s.trim().slice(0, 10);
};

export function parseStatement(format: 'OFX' | 'CSV', content: string): StatementLine[] {
  if (format === 'OFX') {
    return [
      ...content.matchAll(
        /<STMTTRN>([\s\S]*?)(?:<\/STMTTRN>|(?=<STMTTRN>)|(?=<\/BANKTRANLIST>))/gi,
      ),
    ].map((m) => {
      const tag = (t: string) =>
        m[1]!.match(new RegExp(`<${t}>([^<\\r\\n]*)`, 'i'))?.[1]?.trim() ?? '';
      const dt = tag('DTPOSTED');
      return {
        fitId: tag('FITID') || createHash('sha1').update(m[1]!).digest('hex'),
        date: `${dt.slice(0, 4)}-${dt.slice(4, 6)}-${dt.slice(6, 8)}`,
        amountCents: Math.round(Number(tag('TRNAMT').replace(',', '.')) * 100),
        description: (tag('MEMO') || tag('NAME')).slice(0, 300),
      };
    });
  }
  const rows = content.split(/\r?\n/).filter((l) => l.trim());
  const sep = rows[0]?.includes(';') ? ';' : ',';
  const head = rows[0]!.toLowerCase();
  const body = /data|date/.test(head) ? rows.slice(1) : rows;
  const seen = new Map<string, number>();
  return body.map((l) => {
    const [date, desc, amount, id] = l.split(sep).map((x) => x.replace(/^"|"$/g, ''));
    const base = `${brDate(date!)}|${amount}|${desc}`;
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return {
      fitId: id?.trim() || createHash('sha1').update(`${base}|${n}`).digest('hex'),
      date: brDate(date!),
      amountCents: money(amount!),
      description: (desc ?? '').trim().slice(0, 300),
    };
  });
}

/** Sugestões de conciliação: recebimentos (contas a receber em aberto / baixas do provedor) e pagamentos. */
async function suggestions(db: Db, t: { amountCents: number; date: Date }) {
  const amount = Math.abs(t.amountCents);
  const from = new Date(t.date.getTime() - 5 * 86400_000);
  const to = new Date(t.date.getTime() + 5 * 86400_000);
  if (t.amountCents > 0) {
    const paid = await db.customerPayment.findMany({
      where: { amountCents: amount, receivedAt: { gte: from, lte: to }, reversalOfId: null },
      include: { receivable: { include: { customer: true } } },
      take: 5,
    });
    const open = await db.customerReceivable.findMany({
      where: { status: { in: ['ABERTO', 'PARCIAL'] } },
      include: { customer: true },
      take: 200,
    });
    return [
      ...paid.map((p) => ({
        kind: 'RECEBIMENTO' as const,
        refType: 'customer_payment',
        refId: p.id,
        label: `Recebimento já registrado: ${p.receivable.customer.name} — ${p.receivable.description} (${brl(p.amountCents)})`,
      })),
      ...open
        .filter((r) => r.amountCents - r.receivedCents === amount)
        .map((r) => ({
          kind: 'RECEBIMENTO' as const,
          refType: 'customer_receivable',
          refId: r.id,
          label: `Baixar: ${r.customer.name} — ${r.description} (${brl(amount)})`,
        })),
    ];
  }
  const orders = await db.paymentOrder.findMany({
    where: { amountCents: amount, status: { in: ['PREPARADO', 'AGUARDANDO_APP'] } },
    take: 5,
  });
  const payables = await db.accountPayable.findMany({
    where: { status: { in: ['ABERTO', 'PARCIAL'] } },
    take: 300,
  });
  return [
    ...orders.map((o) => ({
      kind: 'PAGAMENTO' as const,
      refType: 'payment_order',
      refId: o.id,
      label: `Pagamento preparado: ${o.beneficiary} (${brl(o.amountCents)})`,
    })),
    ...payables
      .filter(
        (p) => p.amountCents - p.paidCents === amount && !orders.some((o) => o.payableId === p.id),
      )
      .map((p) => ({
        kind: 'PAGAMENTO' as const,
        refType: 'account_payable',
        refId: p.id,
        label: `Conta a pagar: ${p.beneficiary} — ${p.description} (${brl(amount)})`,
      })),
  ];
}

async function settlePaymentOrder(
  tx: Tx,
  actor: Parameters<typeof audit>[1],
  orderId: string,
  paidAt: string,
  via: string,
) {
  const o = await tx.paymentOrder.findUniqueOrThrow({
    where: { id: orderId },
    include: { payable: true },
  });
  if (o.status === 'PAGO') return o;
  if (!['PREPARADO', 'AGUARDANDO_APP'].includes(o.status))
    throw Errors.business('Pagamento cancelado ou com falha.');
  const r = await payPayable(tx, actor, o.payableId, {
    amountCents: o.amountCents,
    paidAt,
    method: o.method as never,
    note: `Pago (${via}).`,
    version: o.payable.version,
  });
  return tx.paymentOrder.update({
    where: { id: o.id },
    data: {
      status: 'PAGO',
      paidAt: new Date(`${paidAt}T12:00:00Z`),
      providerRef: o.providerRef ?? `${via}:${r.paymentId}`,
      version: { increment: 1 },
    },
  });
}

export async function bankRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;

  app.get('/api/v1/office/bank/accounts', { config: { access: OFFICE_FIN_VIEW } }, () =>
    prisma.bankAccount.findMany({ where: { active: true }, orderBy: { createdAt: 'asc' } }),
  );
  app.post(
    '/api/v1/office/bank/accounts',
    { config: { access: OFFICE_FIN, idempotent: true } },
    async (request) => {
      const b = z
        .object({
          label: z.string().trim().min(2).max(120),
          bank: z.string().trim().min(2).max(80),
          masked: z.string().trim().max(80).optional(),
        })
        .parse(request.body);
      const a = await prisma.bankAccount.create({ data: { ...b, provider: 'IMPORTACAO' } });
      await prisma.$transaction((tx) =>
        audit(tx, actorFrom(request), {
          action: 'office.bank_account_added',
          entityType: 'bank_account',
          entityId: a.id,
          summary: `Conta ${a.label} (${a.bank}) cadastrada.`,
        }),
      );
      return a;
    },
  );

  app.post(
    '/api/v1/office/bank/accounts/:id/import',
    { config: { access: OFFICE_FIN, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const b = z
        .object({ format: z.enum(['OFX', 'CSV']), content: z.string().min(10).max(2_000_000) })
        .parse(request.body);
      const acc = await prisma.bankAccount.findUnique({ where: { id } });
      if (!acc) throw Errors.notFound('Conta');
      const lines = parseStatement(b.format, b.content).filter(
        (l) =>
          /^\d{4}-\d{2}-\d{2}$/.test(l.date) &&
          Number.isFinite(l.amountCents) &&
          l.amountCents !== 0,
      );
      const res = await prisma.bankTransaction.createMany({
        data: lines.map((l) => ({
          accountId: id,
          fitId: l.fitId,
          date: new Date(`${l.date}T00:00:00Z`),
          amountCents: l.amountCents,
          description: l.description,
          source: b.format,
        })),
        skipDuplicates: true,
      });
      await prisma.$transaction(async (tx) => {
        const months = [...new Set(lines.map((l) => l.date.slice(0, 7)))];
        for (const m of months)
          await tx.accountingDocument.create({
            data: {
              month: m,
              kind: 'EXTRATO',
              title: `Extrato ${acc.label} importado (${b.format}, ${lines.filter((l) => l.date.startsWith(m)).length} lançamentos)`,
              refType: 'bank_account',
              refId: id,
            },
          });
        await audit(tx, actorFrom(request), {
          action: 'office.statement_imported',
          entityType: 'bank_account',
          entityId: id,
          summary: `Extrato importado: ${res.count} novo(s), ${lines.length - res.count} já existente(s).`,
        });
        await officeEvent(tx, actorFrom(request), 'bank_account', id);
      });
      return { read: lines.length, imported: res.count, duplicates: lines.length - res.count };
    },
  );

  app.get(
    '/api/v1/office/bank/transactions',
    { config: { access: OFFICE_FIN_VIEW } },
    async (request) => {
      const q = z.object({ pending: z.coerce.boolean().default(true) }).parse(request.query);
      const rows = await prisma.bankTransaction.findMany({
        where: q.pending ? { reconciledAt: null } : {},
        orderBy: { date: 'desc' },
        take: 100,
        include: { account: true },
      });
      return Promise.all(
        rows.map(async (t) => ({
          id: t.id,
          account: t.account.label,
          date: d10(t.date),
          amountCents: t.amountCents,
          description: t.description,
          reconciledKind: t.reconciledKind,
          reconciledAt: t.reconciledAt?.toISOString() ?? null,
          suggestions: t.reconciledAt ? [] : await suggestions(prisma, t),
        })),
      );
    },
  );

  /** Conciliação: liga a linha do extrato ao registro oficial (e registra a baixa quando faltar). */
  app.post(
    '/api/v1/office/bank/transactions/:id/reconcile',
    { config: { access: OFFICE_FIN, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const b = z
        .object({
          refType: z.enum([
            'customer_payment',
            'customer_receivable',
            'payment_order',
            'account_payable',
            'ignorar',
          ]),
          refId: z.string().uuid().optional(),
        })
        .parse(request.body);
      const actor = actorFrom(request);
      return prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM bank_transactions WHERE id = ${id}::uuid FOR UPDATE`;
        const t = await tx.bankTransaction.findUniqueOrThrow({ where: { id } });
        if (t.reconciledAt) throw Errors.conflict('Esta linha do extrato já foi conciliada.');
        const date = d10(t.date)!;
        const amount = Math.abs(t.amountCents);
        let kind = 'IGNORADO';
        let ref: string | null = null;
        if (b.refType === 'customer_payment') {
          kind = 'RECEBIMENTO';
          ref = b.refId!;
        } else if (b.refType === 'customer_receivable') {
          const r = await tx.customerReceivable.findUniqueOrThrow({ where: { id: b.refId! } });
          const { payment } = await receivePayment(tx, actor, r.id, {
            amountCents: amount,
            receivedAt: date,
            method: 'TRANSFERENCIA',
            note: `Conciliado com o extrato (${t.description}).`,
            version: r.version,
          });
          kind = 'RECEBIMENTO';
          ref = payment.id;
        } else if (b.refType === 'payment_order') {
          const o = await settlePaymentOrder(tx, actor, b.refId!, date, 'extrato');
          kind = 'PAGAMENTO';
          ref = o.id;
        } else if (b.refType === 'account_payable') {
          const p = await tx.accountPayable.findUniqueOrThrow({ where: { id: b.refId! } });
          const r = await payPayable(tx, actor, p.id, {
            amountCents: amount,
            paidAt: date,
            method: 'TRANSFERENCIA',
            note: `Conciliado com o extrato (${t.description}).`,
            version: p.version,
          });
          kind = 'PAGAMENTO';
          ref = r.paymentId;
        }
        await tx.bankTransaction.update({
          where: { id },
          data: {
            reconciledKind: kind,
            reconciledRef: ref,
            reconciledAt: new Date(),
            reconciledById: actor.userId,
          },
        });
        await audit(tx, actor, {
          action: 'office.reconciled',
          entityType: 'bank_transaction',
          entityId: id,
          summary: `Extrato ${date} ${brl(t.amountCents)} conciliado como ${kind.toLowerCase()}.`,
        });
        await officeEvent(tx, actor, 'bank_transaction', id);
        return { id, kind, ref };
      });
    },
  );

  // ── Pagamentos preparados ──
  app.get('/api/v1/office/payment-orders', { config: { access: OFFICE_FIN_VIEW } }, async () => {
    const rows = await prisma.paymentOrder.findMany({
      orderBy: { createdAt: 'desc' },
      take: 50,
      include: { payable: true, account: true },
    });
    return rows.map((o) => ({
      id: o.id,
      payableId: o.payableId,
      payable: `${o.payable.description}`,
      beneficiary: o.beneficiary,
      amountCents: o.amountCents,
      dueDate: d10(o.dueDate),
      method: o.method,
      account: o.account.label,
      status: o.status,
      paidAt: o.paidAt?.toISOString() ?? null,
      proofFileUrl: o.proofFileId ? `/api/files/${o.proofFileId}` : null,
      version: o.version,
    }));
  });

  app.post(
    '/api/v1/office/payables/:id/payment-order',
    { config: { access: OFFICE_FIN, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const b = z
        .object({
          accountId: z.string().uuid(),
          method: z.enum(['PIX', 'BOLETO', 'TRANSFERENCIA']),
        })
        .parse(request.body);
      const actor = actorFrom(request);
      return prisma.$transaction(async (tx) => {
        const p = await tx.accountPayable.findUnique({
          where: { id },
          include: { supplier: true },
        });
        if (!p) throw Errors.notFound('Conta a pagar');
        if (!['ABERTO', 'PARCIAL'].includes(p.status))
          throw Errors.business('Conta já paga ou cancelada.');
        const open = await tx.paymentOrder.findFirst({
          where: { payableId: id, status: { in: ['PREPARADO', 'AGUARDANDO_APP'] } },
        });
        if (open) return open;
        const o = await tx.paymentOrder.create({
          data: {
            payableId: id,
            accountId: b.accountId,
            beneficiary: p.supplier?.name ?? p.beneficiary,
            amountCents: p.amountCents - p.paidCents,
            dueDate: p.dueDate,
            method: b.method,
            createdById: actor.userId,
          },
        });
        await tx.agentAction.create({
          data: {
            agentId: null,
            channel: 'BANCO_PJ',
            accountLabel: null,
            kind: 'PAGAMENTO_PREPARADO',
            summary: `Pagamento preparado: ${o.beneficiary} ${brl(o.amountCents)} (vence ${d10(o.dueDate)})`,
            content: p.description,
            status: 'RASCUNHO',
            ref: { paymentOrderId: o.id, payableId: id },
          },
        });
        await audit(tx, actor, {
          action: 'office.payment_prepared',
          entityType: 'payment_order',
          entityId: o.id,
          summary: `Pagamento preparado para ${o.beneficiary}: ${brl(o.amountCents)}.`,
        });
        await officeEvent(tx, actor, 'payment_order', o.id);
        return o;
      });
    },
  );

  /** Confirmação do gestor: fica aguardando a autorização no app do banco (não marca como pago). */
  app.post(
    '/api/v1/office/payment-orders/:id/confirm',
    { config: { access: OFFICE_FIN, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const { version } = z.object({ version: z.number().int().positive() }).parse(request.body);
      const actor = actorFrom(request);
      return prisma.$transaction(async (tx) => {
        const o = await tx.paymentOrder.findUnique({ where: { id } });
        if (!o) throw Errors.notFound('Pagamento');
        if (o.version !== version) throw Errors.conflict('O pagamento mudou. Recarregue.');
        if (o.status !== 'PREPARADO')
          throw Errors.business('Este pagamento não está aguardando confirmação.');
        const u = await tx.paymentOrder.update({
          where: { id },
          data: {
            status: 'AGUARDANDO_APP',
            confirmedById: actor.userId,
            confirmedAt: new Date(),
            version: { increment: 1 },
          },
        });
        await tx.agentAction.create({
          data: {
            agentId: null,
            channel: 'BANCO_PJ',
            accountLabel: null,
            kind: 'PAGAMENTO_CONFIRMADO',
            summary: `Pagamento ${o.beneficiary} ${brl(o.amountCents)} confirmado — autorizar no app do banco`,
            content: null,
            status: 'AGUARDANDO_APP',
            approvedById: actor.userId,
            ref: { paymentOrderId: id },
          },
        });
        await audit(tx, actor, {
          action: 'office.payment_confirmed',
          entityType: 'payment_order',
          entityId: id,
          summary: 'Pagamento confirmado pelo gestor; aguardando autorização no app do banco.',
        });
        await officeEvent(tx, actor, 'payment_order', id);
        return u;
      });
    },
  );

  app.post(
    '/api/v1/office/payment-orders/:id/cancel',
    { config: { access: OFFICE_FIN, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const actor = actorFrom(request);
      return prisma.$transaction(async (tx) => {
        const o = await tx.paymentOrder.findUniqueOrThrow({ where: { id } });
        if (o.status === 'PAGO') throw Errors.business('Já pago: estorne pelo financeiro.');
        const u = await tx.paymentOrder.update({
          where: { id },
          data: { status: 'CANCELADO', version: { increment: 1 } },
        });
        await audit(tx, actor, {
          action: 'office.payment_cancelled',
          entityType: 'payment_order',
          entityId: id,
          summary: 'Pagamento preparado cancelado.',
        });
        return u;
      });
    },
  );

  // ── Previsão (agente Financeiro) ──
  app.get('/api/v1/office/forecast', { config: { access: OFFICE_FIN_VIEW } }, async (request) => {
    const q = z
      .object({ days: z.coerce.number().int().min(1).max(90).default(7) })
      .parse(request.query);
    const today = todayIso(await shopTimezone(prisma));
    const end = addDays(today, q.days - 1);
    const range = { gte: new Date(`${today}T00:00:00Z`), lte: new Date(`${end}T00:00:00Z`) };
    const [rec, pay, cards, overdueRec] = await Promise.all([
      prisma.customerReceivable.findMany({
        where: { status: { in: ['ABERTO', 'PARCIAL'] }, dueDate: range },
        include: { customer: true },
      }),
      prisma.accountPayable.findMany({
        where: { status: { in: ['ABERTO', 'PARCIAL'] }, dueDate: { lte: range.lte } },
      }),
      prisma.cardSettlement.findMany({ where: { settledAt: null, expectedDate: range } }),
      prisma.customerReceivable.findMany({
        where: { status: { in: ['ABERTO', 'PARCIAL'] }, dueDate: { lt: range.gte } },
        include: { customer: true },
      }),
    ]);
    const inC =
      rec.reduce((a, r) => a + r.amountCents - r.receivedCents, 0) +
      cards.reduce((a, c) => a + c.netCents, 0);
    const outC = pay.reduce((a, p) => a + p.amountCents - p.paidCents, 0);
    return {
      from: today,
      to: end,
      inCents: inC,
      outCents: outC,
      netCents: inC - outC,
      receivables: rec.map((r) => ({
        id: r.id,
        label: `${r.customer.name} — ${r.description}`,
        amountCents: r.amountCents - r.receivedCents,
        dueDate: d10(r.dueDate),
      })),
      overdue: overdueRec.map((r) => ({
        id: r.id,
        label: `${r.customer.name} — ${r.description}`,
        amountCents: r.amountCents - r.receivedCents,
        dueDate: d10(r.dueDate),
      })),
      payables: pay.map((p) => ({
        id: p.id,
        label: `${p.beneficiary} — ${p.description}`,
        amountCents: p.amountCents - p.paidCents,
        dueDate: d10(p.dueDate),
        overdue: p.dueDate < range.gte,
      })),
      cards: cards.map((c) => ({
        id: c.id,
        netCents: c.netCents,
        expectedDate: d10(c.expectedDate),
      })),
    };
  });

  // ── Maquininha ──
  app.post(
    '/api/v1/office/card/import',
    { config: { access: OFFICE_FIN, idempotent: true } },
    async (request) => {
      const b = z
        .object({
          provider: z.string().trim().min(2).max(40),
          content: z.string().min(10).max(2_000_000),
        })
        .parse(request.body);
      const rows = b.content.split(/\r?\n/).filter((l) => l.trim());
      const sep = rows[0]?.includes(';') ? ';' : ',';
      const data = rows
        .slice(/data|date/i.test(rows[0] ?? '') ? 1 : 0)
        .map((l) => l.split(sep).map((x) => x.replace(/^"|"$/g, '').trim()))
        .map(([sale, gross, fee, net, inst, expected, ext]) => {
          const g = money(gross!);
          const f = Math.abs(money(fee!));
          return {
            provider: b.provider,
            externalId:
              ext ||
              createHash('sha1').update(`${sale}|${gross}|${expected}|${inst}`).digest('hex'),
            saleDate: new Date(`${brDate(sale!)}T00:00:00Z`),
            grossCents: g,
            feeCents: f,
            netCents: net ? money(net) : g - f,
            installments: Number(inst) || 1,
            expectedDate: new Date(`${brDate(expected!)}T00:00:00Z`),
          };
        });
      const r = await prisma.cardSettlement.createMany({ data, skipDuplicates: true });
      return { read: data.length, imported: r.count, duplicates: data.length - r.count };
    },
  );

  app.get('/api/v1/office/card/summary', { config: { access: OFFICE_FIN_VIEW } }, async () => {
    const today = todayIso(await shopTimezone(prisma));
    const start = addDays(today, -((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7));
    const end = addDays(start, 6);
    const w = { gte: new Date(`${start}T00:00:00Z`), lte: new Date(`${end}T00:00:00Z`) };
    const [sold, toFall] = await Promise.all([
      prisma.cardSettlement.findMany({ where: { saleDate: w } }),
      prisma.cardSettlement.findMany({ where: { expectedDate: w } }),
    ]);
    const sum = (xs: { grossCents: number; feeCents: number; netCents: number }[]) =>
      xs.reduce(
        (a, x) => ({
          gross: a.gross + x.grossCents,
          fee: a.fee + x.feeCents,
          net: a.net + x.netCents,
        }),
        { gross: 0, fee: 0, net: 0 },
      );
    return {
      week: { start, end },
      sold: sum(sold),
      received: sum(toFall.filter((x) => x.settledAt || d10(x.expectedDate)! <= today)),
      toFall: sum(toFall.filter((x) => !x.settledAt && d10(x.expectedDate)! > today)),
    };
  });
}
