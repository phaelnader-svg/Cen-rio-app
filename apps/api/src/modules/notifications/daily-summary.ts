/**
 * Resumo do dia para levar ao WhatsApp (avisos fora do sininho): atrasos e prazos em risco, peças
 * prontas, materiais a comprar, avisos ativos e, para quem vê o financeiro, o vencido a receber.
 * Sem integração: o painel abre o WhatsApp com o texto pronto (para a própria pessoa ou para quem
 * ela escolher). Só leitura.
 */
import { DEADLINE_STATE_LABEL, whatsappLink } from '@cenario/shared';
import type { FastifyInstance } from 'fastify';
import { serviceOrderCode } from '../commercial/common';
import { serviceDeadlines } from '../deadlines/service';
import { shopTimezone, todayIso } from '../finance/common';
import { dueContext, dueOf } from '../finance/revenue';
import { companyName, purchaseNeeds } from '../game/agent-office';

const brl = (c: number) =>
  (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export async function notificationSummaryRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;
  app.get(
    '/api/v1/notifications/daily-summary',
    { config: { access: { session: 'WEB', permissions: ['painel.acessar'] } } },
    async (request) => {
      const auth = request.auth!;
      const perms = auth.permissions;
      const today = todayIso(await shopTimezone(prisma));
      const lines: string[] = [
        `*Resumo do dia — ${await companyName(prisma)}* (${today.split('-').reverse().join('/')})`,
      ];
      if (perms.has('os.ver') || perms.has('producao.ver')) {
        const deadlines = await serviceDeadlines(prisma, { status: 'ABERTA' });
        const risky = [...deadlines.entries()].filter(
          ([, d]) => d.state === 'ATRASADO' || d.state === 'EM_RISCO',
        );
        const so = await prisma.serviceOrder.findMany({
          where: { id: { in: risky.map(([id]) => id) } },
          select: { id: true, number: true, customer: { select: { name: true } } },
        });
        lines.push(
          '',
          risky.length
            ? `⚠ Atrasos e prazos em risco (${risky.length}):`
            : '✓ Nenhum prazo em risco.',
        );
        for (const [id, d] of risky.slice(0, 8)) {
          const s = so.find((x) => x.id === id);
          if (s)
            lines.push(
              `• ${serviceOrderCode(s.number)} ${s.customer.name}: ${DEADLINE_STATE_LABEL[d.state]}${d.promisedDate ? ` (prazo ${d.promisedDate.split('-').reverse().slice(0, 2).join('/')})` : ''}`,
            );
        }
        const ready = await prisma.serviceOrder.findMany({
          where: { status: 'ABERTA', items: { some: { fulfillmentStage: 'PRONTA_ENTREGA' } } },
          select: { number: true, customer: { select: { name: true } } },
          take: 10,
        });
        if (ready.length) {
          lines.push('', `✓ Prontas para entregar (${ready.length}):`);
          for (const r of ready) lines.push(`• ${serviceOrderCode(r.number)} ${r.customer.name}`);
        }
        const needs = await purchaseNeeds(prisma);
        if (needs.length) {
          lines.push('', `🛒 Materiais a comprar (${needs.length}):`);
          for (const n of needs.slice(0, 8))
            lines.push(`• ${n.description}${n.quantity ? ` — ${n.quantity}` : ''} (${n.osCode})`);
        }
      }
      if (perms.has('financeiro.ver')) {
        const receivables = await prisma.customerReceivable.findMany({
          where: { status: { in: ['ABERTO', 'PARCIAL'] } },
          select: {
            orderId: true,
            dueTrigger: true,
            dueDate: true,
            amountCents: true,
            receivedCents: true,
            status: true,
          },
          take: 500,
        });
        const ctx = await dueContext(
          prisma,
          receivables.map((r) => r.orderId),
        );
        const overdue = receivables.filter((r) => dueOf(r, ctx).overdue);
        if (overdue.length)
          lines.push(
            '',
            `💰 A receber vencido: ${brl(overdue.reduce((s, r) => s + r.amountCents - r.receivedCents, 0))} (${overdue.length})`,
          );
      }
      const notes = await prisma.notification.findMany({
        where: { userId: auth.userId, resolvedAt: null },
        orderBy: { createdAt: 'desc' },
        take: 6,
      });
      if (notes.length) {
        lines.push('', `🔔 Avisos (${notes.length}):`);
        for (const n of notes) lines.push(`• ${n.title}: ${n.body}`);
      }
      const text = lines.join('\n');
      const me = await prisma.employee.findFirst({
        where: { userId: auth.userId },
        select: { phone: true },
      });
      return { text, href: whatsappLink(me?.phone ?? null, text), phone: me?.phone ?? null };
    },
  );
}
