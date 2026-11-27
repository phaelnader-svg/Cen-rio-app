import type { PrismaClient } from '@cenario/db';
import { PLANS } from '@cenario/shared';
import { COMPANY_BILLING_SELECT, cycleOf, planOf, statusOf } from '../../core/billing';
import { now as clockNow } from '../../core/clock';
import { enqueueEmail, simpleEmail } from '../../core/mailer';
import { companyPriceCents, refreshPlatformConfig } from '../../core/platform-config';
import { runAsCompany } from '../../core/tenant';
import { notifyPlatformAdmins } from './routes';

const DAY = 86_400_000;
const fmtBRL = (cents: number) =>
  (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtDay = (d: Date) =>
  d.toLocaleDateString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    day: '2-digit',
    month: '2-digit',
  });
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * E-mails do teste grátis (aprovados pelo dono em 26/11/2026), um de cada por empresa:
 * - dia 2 sem nenhum orçamento nem pedido: "faça o seu primeiro orçamento em 2 minutos";
 * - faltando 2 dias: o valor e o resumo do que a empresa já fez;
 * - no fim do teste, sem pagamento: como pagar (PIX do painel da plataforma).
 * As boas-vindas saem no próprio cadastro (junto com o link de confirmar o e-mail).
 *
 * E o aviso de empresa nova para o dono da plataforma: assim que ela informa o telefone (ou
 * depois de 1 hora, sem telefone), com nome, quem criou, e-mail e telefone.
 *
 * Sem e-mail configurado, os e-mails ficam na fila e nada sai (como os demais).
 */
export async function sendOnboardingEmails(system: PrismaClient, webUrl: string): Promise<number> {
  const cfg = await refreshPlatformConfig(system);
  const now = clockNow();
  const companies = await system.companySettings.findMany({
    where: {
      isPlatform: false,
      isDemo: false,
      createdAt: { gte: new Date(now.getTime() - 60 * DAY) },
    },
    select: {
      ...COMPANY_BILLING_SELECT,
      tradeName: true,
      email: true,
      phone: true,
      createdAt: true,
      billingPriceCents: true,
      billingPriceUntil: true,
      onboardingEmails: true,
      platformNewNoticeAt: true,
    },
  });
  let sent = 0;
  for (const c of companies) {
    // Aviso de empresa nova para o dono da plataforma.
    if (!c.platformNewNoticeAt && (c.phone || now.getTime() - c.createdAt.getTime() > 3_600_000)) {
      const owner = await runAsCompany(c.id, () =>
        system.user.findFirst({
          where: { companyId: c.id, roles: { some: { role: { key: 'gestor' } } } },
          orderBy: { createdAt: 'asc' },
          select: { displayName: true, email: true },
        }),
      );
      await notifyPlatformAdmins(system, {
        subject: `Empresa nova: ${c.tradeName}`,
        title: `Empresa nova: ${c.tradeName}`,
        paragraphs: [
          `${owner?.displayName ?? 'Alguém'} criou a conta em ${c.createdAt.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' })}.`,
          `Telefone: ${c.phone ?? 'ainda não informou'}.`,
          `E-mail: ${owner?.email ?? c.email ?? 'sem e-mail'}.`,
        ],
        url: `${webUrl}/plataforma/empresas`,
        kind: 'plataforma-empresa-nova',
      });
      await system.companySettings.update({
        where: { id: c.id },
        data: { platformNewNoticeAt: now },
      });
      sent++;
    }

    if (c.billingCourtesy || !c.trialEndsAt) continue;
    const status = statusOf(c, undefined, now);
    const done = new Set(c.onboardingEmails);
    const msLeft = c.trialEndsAt.getTime() - now.getTime();
    const ageMs = now.getTime() - c.createdAt.getTime();
    const price = companyPriceCents({
      plan: planOf(c),
      cycle: cycleOf(c),
      billingPriceCents: c.billingPriceCents,
      billingPriceUntil: c.billingPriceUntil,
    });
    const perCycle = cycleOf(c) === 'ANUAL' ? 'por ano' : 'por mês';

    let which: string | null = null;
    if (!done.has('fim-teste') && msLeft <= 0 && status !== 'ATIVA' && msLeft > -7 * DAY)
      which = 'fim-teste';
    else if (!done.has('dia-5') && status === 'TESTE' && msLeft > 0 && msLeft <= 2 * DAY)
      which = 'dia-5';
    else if (!done.has('dia-2') && status === 'TESTE' && ageMs >= 2 * DAY && msLeft > 2 * DAY)
      which = 'dia-2';
    if (!which) continue;

    const ok = await runAsCompany(c.id, () =>
      system.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT set_config('app.company_id', ${String(c.id)}, true)`;
        const [quotes, orders, employees, serviceOrders, owners] = await Promise.all([
          tx.quote.count({ where: { companyId: c.id, deletedAt: null } }),
          tx.commercialOrder.count({ where: { companyId: c.id } }),
          tx.employee.count({ where: { companyId: c.id, active: true } }),
          tx.serviceOrder.count({ where: { companyId: c.id } }),
          tx.user.findMany({
            where: {
              companyId: c.id,
              active: true,
              email: { not: null },
              supportAgent: false,
              roles: { some: { role: { key: 'gestor' } } },
            },
            select: { email: true, displayName: true },
          }),
        ]);
        // O banco do sistema atravessa empresas: toda consulta acima filtra pela empresa.
        // Dia 2: só para quem ainda não fez nada.
        if (which === 'dia-2' && (quotes > 0 || orders > 0)) {
          await tx.companySettings.update({
            where: { id: c.id },
            data: { onboardingEmails: { push: which } },
          });
          return false;
        }
        const first = (owners[0]?.displayName ?? '').split(/\s+/)[0] || '';
        const hi = first ? `Oi, ${first}!` : 'Oi!';
        let subject = '';
        let body: { text: string; html: string };
        if (which === 'dia-2') {
          subject = 'Faça o seu primeiro orçamento em 2 minutos';
          body = simpleEmail({
            title: 'Faça o seu primeiro orçamento em 2 minutos',
            paragraphs: [
              `${hi} A ${c.tradeName} já está com o Cenário Gestão há 2 dias.`,
              'O jeito mais rápido de ver o sistema funcionando é fazer um orçamento de verdade: escolha o cliente, a peça e o tecido, e a proposta sai pronta para mandar no WhatsApp.',
              'Se preferir, peça ajuda no Início, em "Quero ajuda para começar", e a gente conversa com você no dia e no horário que você escolher.',
            ],
            button: { label: 'Fazer um orçamento', url: `${webUrl}/painel/orcamentos` },
          });
        } else if (which === 'dia-5') {
          subject = `Seu teste grátis acaba ${fmtDay(c.trialEndsAt!)}`;
          const fez =
            quotes + orders + serviceOrders === 0
              ? 'Ainda dá tempo de fazer o primeiro orçamento e ver como fica.'
              : `Até agora: ${plural(quotes, 'orçamento', 'orçamentos')}, ${plural(orders, 'pedido', 'pedidos')}, ${plural(serviceOrders, 'OS', 'OS')} e ${plural(employees, 'pessoa cadastrada', 'pessoas cadastradas')}.`;
          body = simpleEmail({
            title: 'Faltam 2 dias do seu teste grátis',
            paragraphs: [
              `${hi} O teste da ${c.tradeName} acaba em ${fmtDay(c.trialEndsAt!)}.`,
              fez,
              `Para continuar, o valor é ${fmtBRL(price)} ${perCycle} (${PLANS[planOf(c)].label}). Tudo o que você cadastrou continua lá.`,
            ],
            button: { label: 'Ver a assinatura', url: `${webUrl}/painel/assinatura` },
          });
        } else {
          subject = 'Seu teste grátis acabou: veja como continuar';
          const pix = cfg.pixKey
            ? [
                `É só pagar ${fmtBRL(price)} pelo PIX: ${cfg.pixKey}${cfg.pixName ? ` (${cfg.pixName}${cfg.pixBank ? `, ${cfg.pixBank}` : ''})` : ''}.`,
                'Na tela Assinatura você vê o PIX e manda o comprovante.',
              ]
            : ['Na tela Assinatura você vê como pagar e manda o comprovante.'];
          body = simpleEmail({
            title: 'Seu teste grátis acabou',
            paragraphs: [
              `${hi} O teste da ${c.tradeName} acabou em ${fmtDay(c.trialEndsAt!)}.`,
              'Os seus dados estão guardados, nada foi apagado.',
              ...pix,
            ],
            button: { label: 'Abrir a assinatura', url: `${webUrl}/painel/assinatura` },
          });
        }
        const to = new Set([c.email, ...owners.map((o) => o.email)].filter(Boolean) as string[]);
        for (const addr of to)
          await enqueueEmail(tx, { to: addr, subject, kind: `teste-${which}`, ...body });
        await tx.companySettings.update({
          where: { id: c.id },
          data: { onboardingEmails: { push: which! } },
        });
        return to.size > 0;
      }),
    );
    if (ok) sent++;
  }
  return sent;
}
