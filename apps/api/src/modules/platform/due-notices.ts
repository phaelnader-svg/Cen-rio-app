import type { PrismaClient } from '@cenario/db';
import { PLANS } from '@cenario/shared';
import { COMPANY_BILLING_SELECT, cycleOf, planOf, statusOf } from '../../core/billing';
import { now as clockNow } from '../../core/clock';
import { enqueueEmail, simpleEmail } from '../../core/mailer';
import { companyPriceCents, refreshPlatformConfig } from '../../core/platform-config';
import { PLATFORM_COMPANY_ID, runAsCompany } from '../../core/tenant';
import { daysBetween } from './routes';

const fmtDay = (d: Date) => d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
const fmtBRL = (cents: number) =>
  (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/**
 * Aviso para o dono da plataforma (2026-11-25): X dias antes de cada vencimento (padrão 3, no
 * painel), um e-mail com quem vence, quando e quanto. Vale também para o fim do teste grátis.
 * Um aviso por vencimento: `due_notice_for` guarda a data já avisada (pagou = data nova = novo
 * aviso no próximo ciclo). Sem e-mail configurado, o aviso fica só no Início do painel.
 */
export async function sendDueNotices(system: PrismaClient, webUrl: string): Promise<number> {
  const cfg = await refreshPlatformConfig(system);
  const admins = await system.platformAdmin.findMany({
    where: { active: true },
    select: { email: true },
  });
  if (admins.length === 0) return 0;
  const now = clockNow();
  const companies = await system.companySettings.findMany({
    where: {
      id: { not: PLATFORM_COMPANY_ID },
      isDemo: false,
      billingCourtesy: false,
      canceledAt: null,
    },
    select: {
      ...COMPANY_BILLING_SELECT,
      tradeName: true,
      billingPriceCents: true,
      dueNoticeFor: true,
    },
  });
  let sent = 0;
  for (const c of companies) {
    const status = statusOf(c, undefined, now);
    const due = status === 'TESTE' ? c.trialEndsAt : status === 'ATIVA' ? c.paidUntil : null;
    if (!due) continue;
    const days = daysBetween(now, due);
    if (days < 0 || days > cfg.noticeDays) continue;
    if (c.dueNoticeFor && c.dueNoticeFor.getTime() === due.getTime()) continue;
    const price = companyPriceCents({
      plan: planOf(c),
      cycle: cycleOf(c),
      billingPriceCents: c.billingPriceCents,
    });
    const quando = days === 0 ? 'hoje' : days === 1 ? 'amanhã' : `em ${days} dias`;
    const subject =
      status === 'TESTE'
        ? `Teste grátis da ${c.tradeName} acaba ${quando} (${fmtDay(due)})`
        : `${c.tradeName} vence ${quando}: ${fmtBRL(price)} (${fmtDay(due)})`;
    const body = simpleEmail({
      title: status === 'TESTE' ? 'Teste grátis acabando' : 'Mensalidade vencendo',
      paragraphs: [
        status === 'TESTE'
          ? `O teste grátis da ${c.tradeName} acaba ${quando}, em ${fmtDay(due)}. Para continuar, o valor é ${fmtBRL(price)} ${cycleOf(c) === 'ANUAL' ? 'por ano' : 'por mês'} (${PLANS[planOf(c)].label}).`
          : `A mensalidade da ${c.tradeName} vence ${quando}, em ${fmtDay(due)}: ${fmtBRL(price)} (${PLANS[planOf(c)].label}, ${cycleOf(c) === 'ANUAL' ? 'anual' : 'mensal'}).`,
        'Quando o PIX cair, é só clicar em "Recebi o pagamento" na Cobrança do painel.',
      ],
      button: { label: 'Abrir a Cobrança', url: `${webUrl}/plataforma/cobranca` },
    });
    await runAsCompany(PLATFORM_COMPANY_ID, () =>
      system.$transaction(async (tx) => {
        // Os e-mails ficam na fila da empresa da plataforma.
        await tx.$executeRaw`SELECT set_config('app.company_id', ${String(PLATFORM_COMPANY_ID)}, true)`;
        await tx.companySettings.update({ where: { id: c.id }, data: { dueNoticeFor: due } });
        for (const a of admins)
          await enqueueEmail(tx, { to: a.email, subject, kind: 'plataforma-vencimento', ...body });
      }),
    );
    sent++;
  }
  return sent;
}
