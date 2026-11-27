import type { PrismaClient } from '@cenario/db';
import { GESTOR_ROLE_KEY, PLANS } from '@cenario/shared';
import { COMPANY_BILLING_SELECT, blocksAt, cycleOf, planOf, statusOf } from '../../core/billing';
import { now as clockNow } from '../../core/clock';
import { enqueueEmail, simpleEmail } from '../../core/mailer';
import { companyPriceCents, refreshPlatformConfig } from '../../core/platform-config';
import { runAsCompany } from '../../core/tenant';
import { notifyPlatformAdmins } from '../onboarding/routes';
import { daysBetween } from './routes';

const DAY = 86_400_000;
const fmtBRL = (cents: number) =>
  (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtDay = (d: Date) => d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
const daySP = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(d);
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

async function ownerEmails(system: PrismaClient, companyId: number) {
  return system.user.findMany({
    where: {
      companyId,
      active: true,
      email: { not: null },
      supportAgent: false,
      roles: { some: { role: { key: GESTOR_ROLE_KEY } } },
    },
    select: { email: true, displayName: true },
  });
}

/**
 * E-mails da mensalidade (aprovados pelo dono em 26/11/2026), um de cada por vencimento:
 * - 3 dias antes ("antes"), no dia ("no-dia") e, com o bloqueio automático ligado, no dia anterior
 *   ao bloqueio ("bloqueio"). Todos com o valor certo e o caminho do PIX com QR Code.
 * - Para o dono da plataforma: empresa com a mensalidade atrasada (uma vez por vencimento).
 *   Pagamento confirmado já avisa a empresa na hora (recordPaymentTx).
 */
export async function sendBillingEmails(system: PrismaClient, webUrl: string): Promise<number> {
  const cfg = await refreshPlatformConfig(system);
  const now = clockNow();
  const companies = await system.companySettings.findMany({
    where: {
      isPlatform: false,
      isDemo: false,
      billingCourtesy: false,
      closedAt: null,
      canceledAt: null,
      paidUntil: { not: null },
    },
    select: {
      ...COMPANY_BILLING_SELECT,
      tradeName: true,
      email: true,
      billingPriceCents: true,
      billingPriceUntil: true,
      feeEmails: true,
      feeEmailsFor: true,
      lateNoticeFor: true,
      pausedUntil: true,
    },
  });
  let sent = 0;
  for (const c of companies) {
    if (c.pausedUntil && c.pausedUntil.getTime() > now.getTime()) continue;
    const status = statusOf(c, undefined, now);
    if (status === 'TESTE' || status === 'CORTESIA') continue;
    const due = c.paidUntil!;
    const days = daysBetween(now, due);
    const price = companyPriceCents(
      {
        plan: planOf(c),
        cycle: cycleOf(c),
        billingPriceCents: c.billingPriceCents,
        billingPriceUntil: c.billingPriceUntil,
      },
      now,
    );
    const done = new Set(
      c.feeEmailsFor && c.feeEmailsFor.getTime() === due.getTime() ? c.feeEmails : [],
    );
    const block = cfg.autoBlock ? blocksAt(c) : null;

    // Atrasada: aviso para o dono da plataforma (uma vez por vencimento).
    if (days < 0 && (!c.lateNoticeFor || c.lateNoticeFor.getTime() !== due.getTime())) {
      await notifyPlatformAdmins(system, {
        subject: `${c.tradeName} está com a mensalidade atrasada (${fmtBRL(price)})`,
        title: `Mensalidade atrasada: ${c.tradeName}`,
        paragraphs: [
          `A mensalidade da ${c.tradeName} (${fmtBRL(price)}) venceu em ${fmtDay(due)}.`,
          block
            ? `Pelo bloqueio automático, o sistema dela bloqueia em ${fmtDay(block)}.`
            : 'O bloqueio automático está desligado: ela continua usando até você decidir.',
          'O botão de cobrança no WhatsApp já está pronto na Cobrança do painel.',
        ],
        url: `${webUrl}/plataforma/cobranca`,
        kind: 'plataforma-atrasada',
        push: `${fmtBRL(price)}, venceu em ${fmtDay(due)}.`,
      });
      await system.companySettings.update({
        where: { id: c.id },
        data: { lateNoticeFor: due },
      });
      sent++;
    }

    let which: 'antes' | 'no-dia' | 'bloqueio' | null = null;
    if (block && !done.has('bloqueio')) {
      const toBlock = daysBetween(now, block);
      if (toBlock === 1 || (toBlock === 0 && block.getTime() > now.getTime())) which = 'bloqueio';
    }
    if (!which && days === 0 && !done.has('no-dia')) which = 'no-dia';
    if (!which && days > 0 && days <= 3 && !done.has('antes') && !done.has('no-dia'))
      which = 'antes';
    if (!which) continue;

    const owners = await runAsCompany(c.id, () => ownerEmails(system, c.id));
    const first = (owners[0]?.displayName ?? '').split(/\s+/)[0] || '';
    const hi = first ? `Oi, ${first}!` : 'Oi!';
    const perCycle = cycleOf(c) === 'ANUAL' ? 'anuidade' : 'mensalidade';
    const pay = cfg.pixKey
      ? 'Na tela Assinatura o PIX já vem com o valor certo: é só apontar a câmera do app do banco para o QR Code ou copiar o código. Depois, mande o comprovante por lá mesmo.'
      : 'Na tela Assinatura você vê como pagar e manda o comprovante.';
    let subject: string;
    let paragraphs: string[];
    if (which === 'antes') {
      subject = `Sua ${perCycle} vence ${days === 1 ? 'amanhã' : `em ${days} dias`} (${fmtDay(due)})`;
      paragraphs = [
        `${hi} A ${perCycle} da ${c.tradeName} (${fmtBRL(price)}, ${PLANS[planOf(c)].label}) vence em ${fmtDay(due)}.`,
        pay,
      ];
    } else if (which === 'no-dia') {
      subject = `Sua ${perCycle} vence hoje: ${fmtBRL(price)}`;
      paragraphs = [`${hi} Hoje é o dia da ${perCycle} da ${c.tradeName}: ${fmtBRL(price)}.`, pay];
    } else {
      subject = `O sistema da ${c.tradeName} bloqueia ${fmtDay(block!)}`;
      paragraphs = [
        `${hi} A ${perCycle} da ${c.tradeName} (${fmtBRL(price)}) venceu em ${fmtDay(due)} e ainda não recebemos.`,
        `Para não parar a oficina, o sistema bloqueia em ${fmtDay(block!)}. Os seus dados ficam guardados, nada é apagado.`,
        pay,
      ];
    }
    const body = simpleEmail({
      title: subject,
      paragraphs,
      button: { label: 'Abrir a assinatura', url: `${webUrl}/painel/assinatura` },
    });
    const to = new Set([c.email, ...owners.map((o) => o.email)].filter(Boolean) as string[]);
    await runAsCompany(c.id, () =>
      system.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.company_id', ${String(c.id)}, true)`;
        for (const addr of to)
          await enqueueEmail(tx, { to: addr, subject, kind: `mensalidade-${which}`, ...body });
        await tx.companySettings.update({
          where: { id: c.id },
          data: { feeEmails: [...done, which!], feeEmailsFor: due },
        });
      }),
    );
    if (to.size) sent++;
  }
  return sent;
}

/**
 * Resumo da semana para o dono da empresa (segunda-feira de manhã, a partir das 7h): o que a
 * oficina fez na semana que passou e o que pede atenção. Um por semana (`weekly_email_for`).
 * Empresa sem nenhum movimento na semana não recebe (nada a contar).
 */
export async function sendWeeklySummaries(system: PrismaClient, webUrl: string): Promise<number> {
  const now = clockNow();
  const today = daySP(now);
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', {
      timeZone: 'America/Sao_Paulo',
      hour: '2-digit',
      hour12: false,
    }).format(now),
  );
  if (weekday !== 1 || hour < 7) return 0;
  const monday = new Date(`${today}T00:00:00.000Z`);
  const from = new Date(Date.parse(`${today}T03:00:00.000Z`) - 7 * DAY);
  const to = new Date(`${today}T03:00:00.000Z`);
  const dayRange = { gte: new Date(monday.getTime() - 7 * DAY), lt: monday };
  const companies = await system.companySettings.findMany({
    where: {
      isPlatform: false,
      isDemo: false,
      closedAt: null,
      blockedAt: null,
      OR: [{ weeklyEmailFor: null }, { weeklyEmailFor: { lt: monday } }],
    },
    select: { ...COMPANY_BILLING_SELECT, tradeName: true },
  });
  let sent = 0;
  for (const c of companies) {
    if (statusOf(c, undefined, now) === 'VENCIDA') continue;
    const done = await runAsCompany(c.id, () =>
      system.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.company_id', ${String(c.id)}, true)`;
        const where = { companyId: c.id };
        // O banco do sistema atravessa empresas: toda consulta abaixo filtra pela empresa.
        const [quotes, approved, orders, delivered, received, manual, lateOs, owners] =
          await Promise.all([
            tx.quote.count({
              where: { ...where, deletedAt: null, createdAt: { gte: from, lt: to } },
            }),
            tx.quote.findMany({
              where: {
                ...where,
                deletedAt: null,
                status: 'APROVADO',
                statusChangedAt: { gte: from, lt: to },
              },
              select: { totalCents: true },
            }),
            tx.commercialOrder.findMany({
              where: { ...where, createdAt: { gte: from, lt: to }, status: { not: 'CANCELADO' } },
              select: { agreedValueCents: true },
            }),
            tx.deliveryItem.count({
              where: { ...where, status: 'ENTREGUE', deliveredAt: { gte: from, lt: to } },
            }),
            tx.customerPayment.aggregate({
              where: { ...where, receivedAt: dayRange },
              _sum: { amountCents: true },
            }),
            tx.manualRevenue.aggregate({
              where: { ...where, receivedAt: dayRange, cancelledAt: null },
              _sum: { amountCents: true },
            }),
            tx.serviceOrder.count({
              where: {
                ...where,
                status: 'ABERTA',
                promisedDate: { lt: monday },
                items: {
                  some: { fulfillmentStage: { notIn: ['ENTREGUE', 'DEVOLVIDA', 'CANCELADA'] } },
                },
              },
            }),
            tx.user.findMany({
              where: {
                ...where,
                active: true,
                email: { not: null },
                supportAgent: false,
                roles: { some: { role: { key: GESTOR_ROLE_KEY } } },
              },
              select: { email: true, displayName: true },
            }),
          ]);
        await tx.companySettings.update({ where: { id: c.id }, data: { weeklyEmailFor: monday } });
        const money = (received._sum.amountCents ?? 0) + (manual._sum.amountCents ?? 0);
        const activity = quotes + approved.length + orders.length + delivered + lateOs + money;
        if (activity === 0 || owners.length === 0) return false;
        const lines = [
          `Orçamentos: ${plural(quotes, 'feito', 'feitos')}, ${plural(approved.length, 'aprovado', 'aprovados')}${approved.length ? ` (${fmtBRL(approved.reduce((s, q) => s + q.totalCents, 0))})` : ''}.`,
          `Serviços fechados: ${orders.length}${orders.length ? ` (${fmtBRL(orders.reduce((s, o) => s + (o.agreedValueCents ?? 0), 0))})` : ''}.`,
          `Peças entregues: ${delivered}.`,
          `Recebido na semana: ${fmtBRL(money)}.`,
          lateOs > 0
            ? `Atenção: ${plural(lateOs, 'OS passou', 'OS passaram')} do prazo e ainda não foi entregue.`
            : 'Nenhuma OS atrasada.',
        ];
        const first = (owners[0]?.displayName ?? '').split(/\s+/)[0] || '';
        const body = simpleEmail({
          title: `A semana da ${c.tradeName}`,
          paragraphs: [
            `Bom dia${first ? `, ${first}` : ''}! Um resumo da semana que passou:`,
            ...lines,
          ],
          button: { label: 'Ver o resumo completo', url: `${webUrl}/painel/resumo` },
        });
        for (const o of owners)
          await enqueueEmail(tx, {
            to: o.email!,
            subject: `Resumo da semana da ${c.tradeName}`,
            kind: 'resumo-semana',
            ...body,
          });
        return true;
      }),
    );
    if (done) sent++;
  }
  return sent;
}
