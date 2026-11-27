import {
  gettingStartedSteps,
  DEFAULT_ROLE_SKILLS,
  GESTOR_ROLE_KEY,
  PLANS,
  addCycle,
  isPlanKey,
  platformCompanyCreateSchema,
  platformCompanyEditSchema,
  platformPaymentSchema,
  platformSettingsSchema,
  type PlatformCompanyDto,
  type PlatformDashboardDto,
  type PlatformDueTone,
  type PlatformPaymentDto,
  type PlatformSettingsDto,
  formatWhatsapp,
  whatsappDigits,
  fillTemplate,
  type PlatformPaymentInput,
  type SignupSource,
} from '@cenario/shared';
import type { Tx } from '@cenario/db';
import { createCompanyContent, isUniqueViolation } from '@cenario/db';
import { randomBytes } from 'node:crypto';
import { hashSecret } from '../../lib/crypto';
import { searchTextFor } from '../customers/service';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Errors } from '../../lib/errors';
import { PLATFORM_RECORD_ID, runAsCompany } from '../../core/tenant';
import { gettingStartedFacts } from '../onboarding/routes';
import { COMPANY_BILLING_SELECT, blocksAt, cycleOf, planOf, statusOf } from '../../core/billing';
import { now as clockNow } from '../../core/clock';
import {
  companyPriceCents,
  messageTemplate,
  platformConfig,
  refreshPlatformConfig,
} from '../../core/platform-config';
import { pushKeys } from '../push/push';
import { enqueueEmail, simpleEmail } from '../../core/mailer';
import { platformLog } from './admin-auth';

const PLATFORM = { platform: true } as const;
const DAY_MS = 86_400_000;
const blockSchema = z.object({ reason: z.string().trim().max(200).optional() });

/** Fim do dia em São Paulo (as datas do painel são dias, não horários). */
const endOfDay = (d: string) => new Date(`${d}T23:59:59.000-03:00`);
const fmtDay = (d: Date) => d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
const fmtBRL = (cents: number) =>
  (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const daySP = (d: Date) =>
  new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Sao_Paulo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
/** Dias corridos entre hoje e a data, contados no calendário de São Paulo. */
export function daysBetween(from: Date, to: Date): number {
  return Math.round(
    (Date.parse(`${daySP(to)}T12:00:00Z`) - Date.parse(`${daySP(from)}T12:00:00Z`)) / DAY_MS,
  );
}

const COMPANY_SELECT = {
  ...COMPANY_BILLING_SELECT,
  tradeName: true,
  serverConnections: true,
  email: true,
  phone: true,
  document: true,
  createdAt: true,
  blockedAt: true,
  blockedReason: true,
  isDemo: true,
  supportAccessUntil: true,
  canceledAt: true,
  pausedUntil: true,
  cancelReason: true,
  billingPriceCents: true,
  platformNote: true,
  setupDoneAt: true,
  gettingStartedHiddenAt: true,
  billingPriceUntil: true,
  signupSource: true,
  signupSourceDetail: true,
  closedAt: true,
  closeReason: true,
  purgeAfter: true,
} as const;

/**
 * Painel da plataforma (/plataforma, 2026-11-25). Só com o login do painel (cookie próprio). Lista
 * e edita as empresas, registra os pagamentos recebidos por PIX, define preços e como o cliente
 * paga. Atravessa empresas: usa o banco do sistema e mostra só o resumo de cada empresa (nenhum
 * cliente, pedido ou valor delas).
 */
/**
 * "Recebi o pagamento" dentro de uma transação: usado pelo botão da Cobrança e pelo Confirmar do
 * comprovante mandado pela tela (item 41).
 */
export async function recordPaymentTx(
  tx: Tx,
  request: FastifyRequest,
  id: number,
  input: PlatformPaymentInput,
) {
  const c = await tx.companySettings.findUnique({ where: { id }, select: COMPANY_SELECT });
  if (!c) throw Errors.notFound('Empresa');
  const cycle = cycleOf(c);
  const plan = planOf(c);
  const received = endOfDay(input.receivedOn);
  const trialEnd = c.trialEndsAt && !c.paidUntil ? c.trialEndsAt : null;
  let base = c.paidUntil ?? trialEnd ?? received;
  // Muito atrasado (mais de um ciclo): recomeça do dia em que pagou.
  if (addCycle(base, cycle).getTime() < received.getTime()) base = received;
  let periodEnd = base;
  for (let i = 0; i < input.cycles; i++) periodEnd = addCycle(periodEnd, cycle);
  periodEnd = endOfDay(daySP(periodEnd));
  await tx.$executeRaw`SELECT set_config('app.company_id', ${String(id)}, true)`;
  const inv = await tx.subscriptionInvoice.create({
    data: {
      companyId: id,
      provider: 'MANUAL',
      plan,
      cycle,
      amountCents: input.amountCents,
      dueDate: new Date(`${daySP(base)}T12:00:00.000Z`),
      status: 'PAGA',
      paidAt: received,
      periodEnd,
    },
  });
  await tx.companySettings.update({
    where: { id },
    data: {
      paidUntil: periodEnd,
      dueNoticeFor: null,
      // Empresa encerrada continua fechada mesmo pagando (reabre só pelo painel).
      ...(input.unblock && !c.closedAt ? { blockedAt: null, blockedReason: null } : {}),
      // Pagou: os e-mails da mensalidade recomeçam no próximo vencimento.
      feeEmails: [],
      feeEmailsFor: null,
    },
  });
  // Aviso para quem administra a empresa: pagamento confirmado e até quando está liberado.
  const owners = await tx.user.findMany({
    where: {
      companyId: id,
      active: true,
      email: { not: null },
      supportAgent: false,
      roles: { some: { role: { key: GESTOR_ROLE_KEY } } },
    },
    select: { email: true },
  });
  const paidMail = simpleEmail({
    title: 'Pagamento confirmado',
    paragraphs: [
      `Recebemos ${fmtBRL(input.amountCents)} da ${c.tradeName}. Obrigado!`,
      `O sistema está liberado até ${fmtDay(periodEnd)}.`,
    ],
  });
  for (const to of new Set(
    [c.email, ...owners.map((o) => o.email)].filter((e): e is string => !!e),
  ))
    await enqueueEmail(tx, {
      to,
      subject: `Pagamento confirmado: liberado até ${fmtDay(periodEnd)}`,
      kind: 'assinatura-paga',
      ...paidMail,
    });
  await tx.auditLog.create({
    data: {
      companyId: id,
      action: 'billing.paid',
      entityType: 'company',
      entityId: String(id),
      summary: `Pagamento de ${fmtBRL(input.amountCents)} recebido pelo Cenário Gestão: liberado até ${fmtDay(periodEnd)}.`,
    },
  });
  await tx.$executeRaw`SELECT set_config('app.company_id', ${String(PLATFORM_RECORD_ID)}, true)`;
  await platformLog(tx, request, {
    action: 'platform.payment',
    companyId: id,
    summary: `Recebi ${fmtBRL(input.amountCents)} de ${c.tradeName} em ${fmtDay(received)}: pago até ${fmtDay(periodEnd)}${input.note ? ` (${input.note})` : ''}.`,
  });
  return { invoiceId: inv.id, paidUntil: periodEnd.toISOString(), tradeName: c.tradeName };
}

export async function platformRoutes(app: FastifyInstance) {
  const { system, env, mailer } = app.ctx;

  async function companyRows(where?: { id: number }): Promise<PlatformCompanyDto[]> {
    const companies = await system.companySettings.findMany({
      // O registro interno da plataforma não é uma empresa cliente.
      where: { ...where, isPlatform: false },
      orderBy: { id: 'asc' },
      select: COMPANY_SELECT,
    });
    const ids = companies.map((c) => c.id);
    const users = await system.user.groupBy({
      by: ['companyId'],
      where: { companyId: { in: ids }, supportAgent: false },
      _count: { _all: true },
      _max: { lastLoginAt: true },
    });
    const owners = await system.user.findMany({
      where: {
        companyId: { in: ids },
        supportAgent: false,
        roles: { some: { role: { key: GESTOR_ROLE_KEY } } },
      },
      orderBy: { createdAt: 'asc' },
      select: {
        companyId: true,
        email: true,
        displayName: true,
        emailConfirmedAt: true,
        employee: { select: { phone: true } },
      },
    });
    const orders = await system.commercialOrder.groupBy({
      by: ['companyId'],
      where: { companyId: { in: ids } },
      _count: { _all: true },
      _max: { createdAt: true },
    });
    const paid = await system.subscriptionInvoice.groupBy({
      by: ['companyId'],
      where: { companyId: { in: ids }, status: 'PAGA' },
      _sum: { amountCents: true },
      _max: { paidAt: true },
    });
    // Item 42: passos do começo de cada empresa nova (as antigas não passaram por ele).
    const started = new Map<number, ReturnType<typeof gettingStartedSteps>>();
    for (const c of companies)
      if (
        !c.isDemo &&
        (c.setupDoneAt === null ||
          c.gettingStartedHiddenAt === null ||
          c.createdAt.getTime() > clockNow().getTime() - 30 * 86_400_000)
      )
        started.set(
          c.id,
          gettingStartedSteps(await runAsCompany(c.id, () => gettingStartedFacts(app.ctx.prisma))),
        );
    const helps = await system.contactRequest.findMany({
      where: { companyId: { in: ids }, kind: 'AJUDA_COMECAR', status: 'PENDENTE' },
      select: { companyId: true, preferredAt: true },
    });
    const help = new Map(helps.map((h) => [h.companyId, h.preferredAt]));
    const proofs = await system.paymentProof.groupBy({
      by: ['companyId'],
      where: { companyId: { in: ids }, status: 'PENDENTE' },
      _count: { _all: true },
    });
    const proof = new Map(proofs.map((p) => [p.companyId, p._count._all]));
    const ord = new Map(orders.map((o) => [o.companyId, o]));
    const usr = new Map(users.map((u) => [u.companyId, u]));
    const pay = new Map(paid.map((p) => [p.companyId, p]));
    const owner = new Map<number, (typeof owners)[number]>();
    for (const o of owners) if (!owner.has(o.companyId)) owner.set(o.companyId, o);
    const now = clockNow();
    const cfg = platformConfig();
    return companies.map((c) => {
      const plan = planOf(c);
      const cycle = cycleOf(c);
      const status = statusOf(c, env, now);
      const dueAt = c.billingCourtesy
        ? null
        : status === 'TESTE'
          ? c.trialEndsAt
          : (c.paidUntil ?? c.trialEndsAt);
      const daysToDue = dueAt ? daysBetween(now, dueAt) : null;
      const priceCents = companyPriceCents(
        {
          plan,
          cycle,
          billingPriceCents: c.billingPriceCents,
          billingPriceUntil: c.billingPriceUntil,
        },
        now,
      );
      let tone: PlatformDueTone;
      if (status === 'CORTESIA') tone = 'courtesy';
      else if (c.blockedAt || status === 'VENCIDA')
        tone = c.blockedAt || cfg.autoBlock ? 'blocked' : 'late';
      else if (status === 'ATRASADA') tone = 'late';
      else if (status === 'TESTE') tone = 'trial';
      else tone = daysToDue !== null && daysToDue <= cfg.noticeDays ? 'soon' : 'ok';
      const o = owner.get(c.id);
      const phone = c.phone || o?.employee?.phone || null;
      const firstName = (o?.displayName ?? '').split(' ')[0];
      // Item 47: os textos vêm do painel (Como eu recebo → Mensagens prontas) ou do padrão.
      const steps = started.get(c.id) ?? null;
      const next = steps?.find((x) => !x.done) ?? null;
      const fill = {
        nome: firstName,
        empresa: c.tradeName,
        valor: `${fmtBRL(priceCents)} ${cycle === 'ANUAL' ? 'por ano' : 'por mês'}`,
        vencimento: dueAt ? fmtDay(dueAt) : '',
        passo: next?.label ?? '',
        pix: cfg.pixKey ?? '',
      };
      const chargeText = fillTemplate(
        messageTemplate(status === 'TESTE' ? 'cobrancaTeste' : 'cobranca', cfg),
        fill,
      );
      // Primeiro contato com quem criou a conta (sem falar de cobrança).
      const contactText = fillTemplate(
        messageTemplate(next ? 'contatoPasso' : 'contato', cfg),
        fill,
      );
      const digits = whatsappDigits(phone);
      const u = usr.get(c.id);
      const p = pay.get(c.id);
      return {
        id: c.id,
        gettingStarted: steps
          ? {
              done: steps.filter((x) => x.done).length,
              total: steps.length,
              nextLabel: next?.label ?? null,
            }
          : null,
        helpRequestedFor: help.get(c.id)?.toISOString() ?? null,
        tradeName: c.tradeName,
        ownerName: o?.displayName ?? null,
        ownerEmail: o?.email ?? c.email ?? null,
        ownerEmailConfirmed: !!o?.emailConfirmedAt,
        email: c.email,
        phone: phone ? formatWhatsapp(phone) : null,
        document: c.document,
        note: c.platformNote,
        createdAt: c.createdAt.toISOString(),
        lastLoginAt: u?._max.lastLoginAt?.toISOString() ?? null,
        users: u?._count._all ?? 0,
        orders: ord.get(c.id)?._count._all ?? 0,
        lastOrderAt: ord.get(c.id)?._max.createdAt?.toISOString() ?? null,
        serverConnections: c.serverConnections,
        isDemo: c.isDemo,
        blockedAt: c.blockedAt?.toISOString() ?? null,
        blockedReason: c.blockedReason,
        canceledAt: c.canceledAt?.toISOString() ?? null,
        cancelReason: c.cancelReason,
        pausedUntil: c.pausedUntil?.toISOString() ?? null,
        supportAccessUntil: c.supportAccessUntil?.toISOString() ?? null,
        plan,
        planLabel: PLANS[plan].label,
        cycle,
        courtesy: c.billingCourtesy,
        trialEndsAt: c.trialEndsAt?.toISOString() ?? null,
        paidUntil: c.paidUntil?.toISOString() ?? null,
        status,
        dueAt: dueAt?.toISOString() ?? null,
        blocksAt: c.billingCourtesy ? null : (blocksAt(c)?.toISOString() ?? null),
        daysToDue,
        tone,
        priceCents,
        billingPriceCents: c.billingPriceCents,
        billingPriceUntil: c.billingPriceUntil?.toISOString() ?? null,
        signupSource: (c.signupSource as SignupSource | null) ?? null,
        signupSourceDetail: c.signupSourceDetail,
        closedAt: c.closedAt?.toISOString() ?? null,
        closeReason: c.closeReason,
        purgeAfter: c.purgeAfter?.toISOString() ?? null,
        pendingProofs: proof.get(c.id) ?? 0,
        paidTotalCents: p?._sum.amountCents ?? 0,
        lastPaymentAt: p?._max.paidAt?.toISOString() ?? null,
        contactWhatsappUrl:
          digits.length >= 10
            ? `https://wa.me/${digits.length <= 11 ? `55${digits}` : digits}?text=${encodeURIComponent(contactText)}`
            : null,
        chargeWhatsappUrl:
          digits.length >= 10
            ? `https://wa.me/${digits.length <= 11 ? `55${digits}` : digits}?text=${encodeURIComponent(chargeText)}`
            : null,
      };
    });
  }

  function companyId(request: FastifyRequest): number {
    const id = Number((request.params as { id: string }).id);
    if (!Number.isInteger(id) || id < 1) throw Errors.notFound('Empresa');
    return id;
  }

  // ───────────────────────── Empresas ─────────────────────────
  app.get('/api/v1/platform/companies', { config: { access: PLATFORM } }, async () => ({
    items: await companyRows(),
  }));

  /** Cadastrar empresa: o dono da plataforma cria a conta para o cliente (senha provisória). */
  app.post('/api/v1/platform/companies', { config: { access: PLATFORM } }, async (request) => {
    const input = platformCompanyCreateSchema.parse(request.body);
    const password = `${randomBytes(6).toString('base64url')}${Math.floor(Math.random() * 90 + 10)}`;
    const passwordHash = await hashSecret(password);
    try {
      const id = await system.$transaction(async (tx) => {
        const company = await tx.companySettings.create({
          data: {
            tradeName: input.tradeName,
            email: input.email,
            phone: input.phone ?? null,
            plan: input.plan,
            billingCycle: input.cycle,
            billingPriceCents: input.billingPriceCents ?? null,
            trialEndsAt:
              input.trialDays > 0 ? new Date(Date.now() + input.trialDays * DAY_MS) : null,
            // Sem teste: começa "vencendo hoje" até o primeiro pagamento ser registrado.
            paidUntil: input.trialDays > 0 ? null : endOfDay(daySP(new Date())),
            // Cadastrada pelo próprio dono da plataforma: sem aviso de "empresa nova" para ele.
            platformNewNoticeAt: new Date(),
          },
        });
        await tx.$executeRaw`SELECT set_config('app.company_id', ${String(company.id)}, true),
          set_config('app.bypass_rls', 'off', true)`;
        const roles = await createCompanyContent(tx);
        const user = await tx.user.create({
          data: {
            email: input.email,
            passwordHash,
            displayName: input.ownerName,
            credentialsChangedAt: new Date(),
            roles: { create: { roleId: roles.get(GESTOR_ROLE_KEY)! } },
          },
        });
        const employee = await tx.employee.create({
          data: {
            userId: user.id,
            fullName: input.ownerName,
            displayName: input.ownerName.split(' ')[0]!,
            jobTitle: 'Gestor',
            color: '#1D4ED8',
            phone: input.phone ?? null,
          },
        });
        const skills = DEFAULT_ROLE_SKILLS[GESTOR_ROLE_KEY] ?? [];
        if (skills.length)
          await tx.employeeSkill.createMany({
            data: skills.map((skill) => ({ employeeId: employee.id, skill })),
          });
        await tx.auditLog.create({
          data: {
            action: 'platform.company_created',
            entityType: 'company',
            entityId: String(company.id),
            summary: `Conta criada pelo Cenário Gestão para ${input.ownerName} (${input.email}).`,
          },
        });
        await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
        await platformLog(tx, request, {
          action: 'platform.company_created',
          companyId: company.id,
          summary: `Empresa cadastrada: ${input.tradeName} (${input.email}), ${PLANS[input.plan].label} ${input.cycle.toLowerCase()}${input.trialDays > 0 ? `, ${input.trialDays} dias de teste` : ', sem teste'}.`,
        });
        return company.id;
      });
      const [row] = await companyRows({ id });
      return { company: row, email: input.email, password };
    } catch (error) {
      if (isUniqueViolation(error, 'email'))
        throw Errors.conflict('Já existe uma conta com este e-mail. Use outro.');
      throw error;
    }
  });

  app.put('/api/v1/platform/companies/:id', { config: { access: PLATFORM } }, async (request) => {
    const id = companyId(request);
    const input = platformCompanyEditSchema.parse(request.body ?? {});
    const before = await system.companySettings.findUnique({ where: { id } });
    if (!before) throw Errors.notFound('Empresa');
    if (before.isPlatform) throw Errors.notFound('Empresa');
    const data = {
      ...(input.tradeName !== undefined ? { tradeName: input.tradeName } : {}),
      ...(input.email !== undefined ? { email: input.email } : {}),
      ...(input.phone !== undefined ? { phone: input.phone } : {}),
      ...(input.document !== undefined ? { document: input.document } : {}),
      ...(input.plan ? { plan: input.plan } : {}),
      ...(input.cycle ? { billingCycle: input.cycle } : {}),
      ...(input.courtesy !== undefined ? { billingCourtesy: input.courtesy } : {}),
      ...(input.billingPriceCents !== undefined
        ? { billingPriceCents: input.billingPriceCents }
        : {}),
      ...(input.paidUntil !== undefined
        ? { paidUntil: input.paidUntil ? endOfDay(input.paidUntil) : null }
        : {}),
      ...(input.trialEndsAt !== undefined
        ? { trialEndsAt: input.trialEndsAt ? endOfDay(input.trialEndsAt) : null }
        : {}),
      ...(input.note !== undefined ? { platformNote: input.note } : {}),
      ...(input.billingPriceUntil !== undefined
        ? { billingPriceUntil: input.billingPriceUntil ? endOfDay(input.billingPriceUntil) : null }
        : {}),
      ...(input.signupSource !== undefined ? { signupSource: input.signupSource } : {}),
      ...(input.signupSourceDetail !== undefined
        ? { signupSourceDetail: input.signupSourceDetail }
        : {}),
    };
    const changes: string[] = [];
    if (data.tradeName && data.tradeName !== before.tradeName)
      changes.push(`nome ${data.tradeName}`);
    if (data.plan && data.plan !== before.plan) changes.push(`plano ${PLANS[data.plan].label}`);
    if (data.billingCycle && data.billingCycle !== before.billingCycle)
      changes.push(`ciclo ${data.billingCycle.toLowerCase()}`);
    if (data.billingCourtesy !== undefined && data.billingCourtesy !== before.billingCourtesy)
      changes.push(data.billingCourtesy ? 'cortesia ligada' : 'cortesia desligada');
    if ('billingPriceCents' in data && data.billingPriceCents !== before.billingPriceCents)
      changes.push(
        data.billingPriceCents
          ? `valor combinado ${fmtBRL(data.billingPriceCents)}`
          : 'preço da tabela',
      );
    if (input.paidUntil !== undefined)
      changes.push(
        input.paidUntil ? `pago até ${fmtDay(endOfDay(input.paidUntil))}` : 'sem pago até',
      );
    if (input.trialEndsAt !== undefined)
      changes.push(
        input.trialEndsAt ? `teste até ${fmtDay(endOfDay(input.trialEndsAt))}` : 'sem teste',
      );
    if (data.email !== undefined && data.email !== before.email) changes.push('e-mail');
    if (data.phone !== undefined && data.phone !== before.phone) changes.push('telefone');
    if (data.document !== undefined && data.document !== before.document) changes.push('CPF/CNPJ');
    if (data.platformNote !== undefined && data.platformNote !== before.platformNote)
      changes.push('anotação');
    if (input.billingPriceUntil !== undefined)
      changes.push(
        input.billingPriceUntil
          ? `valor combinado até ${fmtDay(endOfDay(input.billingPriceUntil))}`
          : 'valor combinado sem prazo',
      );
    if (data.signupSource !== undefined && data.signupSource !== before.signupSource)
      changes.push(`origem ${data.signupSource ?? 'não informada'}`);
    const conn = input.serverConnections;
    if (conn !== undefined && conn !== before.serverConnections)
      changes.push(conn ? 'conexões do servidor liberadas' : 'conexões do servidor retiradas');
    await system.$transaction(async (tx) => {
      // Conexões do servidor: uma empresa só. Liberar aqui tira da que tinha.
      if (conn === true && !before.serverConnections)
        await tx.companySettings.updateMany({
          where: { serverConnections: true, id: { not: id } },
          data: { serverConnections: false },
        });
      await tx.companySettings.update({
        where: { id },
        data: { ...data, ...(conn !== undefined ? { serverConnections: conn } : {}) },
      });
      await platformLog(tx, request, {
        action: 'platform.company_edited',
        companyId: id,
        summary: `${before.tradeName}: ${changes.join(', ') || 'sem mudança'}.`,
      });
    });
    if (conn !== undefined) await refreshPlatformConfig(system, true);
    const [row] = await companyRows({ id });
    return row;
  });

  /** Item 6: o pedido de ajuda para começar foi atendido. */
  app.post(
    '/api/v1/platform/companies/:id/help-done',
    { config: { access: PLATFORM } },
    async (request) => {
      const id = companyId(request);
      await system.$transaction(async (tx) => {
        const r = await tx.contactRequest.updateMany({
          where: { companyId: id, kind: 'AJUDA_COMECAR', status: 'PENDENTE' },
          data: { status: 'FEITO', doneAt: new Date() },
        });
        if (r.count > 0)
          await platformLog(tx, request, {
            action: 'platform.help_done',
            companyId: id,
            summary: 'Pedido de ajuda para começar atendido.',
          });
      });
      const [row] = await companyRows({ id });
      return row;
    },
  );

  app.post(
    '/api/v1/platform/companies/:id/block',
    { config: { access: PLATFORM } },
    async (request) => {
      const id = companyId(request);
      const input = blockSchema.parse(request.body ?? {});
      return setBlocked(request, id, true, input.reason ?? null);
    },
  );

  app.post(
    '/api/v1/platform/companies/:id/unblock',
    { config: { access: PLATFORM } },
    async (request) => setBlocked(request, companyId(request), false, null),
  );

  async function setBlocked(
    request: FastifyRequest,
    id: number,
    blocked: boolean,
    reason: string | null,
  ) {
    return system.$transaction(async (tx) => {
      const company = await tx.companySettings.findUnique({ where: { id } });
      if (!company) throw Errors.notFound('Empresa');
      const updated = await tx.companySettings.update({
        where: { id },
        data: blocked
          ? { blockedAt: company.blockedAt ?? new Date(), blockedReason: reason }
          : { blockedAt: null, blockedReason: null },
        select: { id: true, tradeName: true, blockedAt: true, blockedReason: true },
      });
      await platformLog(tx, request, {
        action: blocked ? 'platform.company_blocked' : 'platform.company_unblocked',
        companyId: id,
        summary: `${company.tradeName} ${blocked ? 'bloqueada' : 'liberada'}${reason ? `: ${reason}` : ''}.`,
      });
      return updated;
    });
  }

  // ───────────────────────── Cobrança ─────────────────────────
  /**
   * "Recebi o pagamento": guarda o pagamento (histórico) e empurra o "pago até" um ciclo (ou
   * mais). A conta parte do vencimento atual, para o dia do vencimento não mudar quando o
   * cliente paga atrasado; quem nunca pagou começa no fim do teste (ou hoje, se já acabou).
   */
  app.post(
    '/api/v1/platform/companies/:id/payments',
    { config: { access: PLATFORM } },
    async (request) => {
      const id = companyId(request);
      const input = platformPaymentSchema.parse(request.body ?? {});
      const result = await system.$transaction((tx) => recordPaymentTx(tx, request, id, input));
      const [row] = await companyRows({ id });
      return { ...result, company: row };
    },
  );

  /** Desfazer um pagamento lançado errado: volta o "pago até" para o que era antes dele. */
  app.delete(
    '/api/v1/platform/payments/:paymentId',
    { config: { access: PLATFORM } },
    async (request) => {
      const { paymentId } = z.object({ paymentId: z.guid() }).parse(request.params);
      return system.$transaction(async (tx) => {
        const inv = await tx.subscriptionInvoice.findUnique({ where: { id: paymentId } });
        if (!inv || inv.provider !== 'MANUAL' || inv.status !== 'PAGA')
          throw Errors.notFound('Pagamento');
        const c = await tx.companySettings.findUniqueOrThrow({
          where: { id: inv.companyId },
          select: { tradeName: true, paidUntil: true },
        });
        const later = await tx.subscriptionInvoice.count({
          where: { companyId: inv.companyId, status: 'PAGA', createdAt: { gt: inv.createdAt } },
        });
        if (later > 0)
          throw Errors.business('Só dá para desfazer o último pagamento desta empresa.');
        const previous = await tx.subscriptionInvoice.findFirst({
          where: { companyId: inv.companyId, status: 'PAGA', id: { not: inv.id } },
          orderBy: { createdAt: 'desc' },
        });
        await tx.subscriptionInvoice.update({
          where: { id: inv.id },
          data: { status: 'CANCELADA' },
        });
        const back = previous?.periodEnd ?? null;
        await tx.companySettings.update({
          where: { id: inv.companyId },
          data: { paidUntil: back },
        });
        await platformLog(tx, request, {
          action: 'platform.payment_undone',
          companyId: inv.companyId,
          summary: `Pagamento de ${fmtBRL(inv.amountCents)} de ${c.tradeName} desfeito: pago até volta para ${back ? fmtDay(back) : 'vazio'}.`,
        });
        return { ok: true };
      });
    },
  );

  app.get('/api/v1/platform/payments', { config: { access: PLATFORM } }, async (request) => {
    const { companyId: only } = z
      .object({ companyId: z.coerce.number().int().positive().optional() })
      .parse(request.query);
    const rows = await system.subscriptionInvoice.findMany({
      where: { status: 'PAGA', ...(only ? { companyId: only } : {}) },
      orderBy: { paidAt: 'desc' },
      take: 300,
      include: { company: { select: { tradeName: true } } },
    });
    return {
      items: rows.map(
        (r): PlatformPaymentDto => ({
          id: r.id,
          companyId: r.companyId,
          tradeName: r.company.tradeName,
          amountCents: r.amountCents,
          receivedOn: daySP(r.paidAt ?? r.createdAt),
          periodEnd: r.periodEnd?.toISOString() ?? null,
          plan: isPlanKey(r.plan) ? r.plan : 'gestao',
          cycle: r.cycle === 'ANUAL' ? 'ANUAL' : 'MENSAL',
          provider: r.provider,
        }),
      ),
    };
  });

  // ───────────────────────── Início ─────────────────────────
  app.get('/api/v1/platform/dashboard', { config: { access: PLATFORM } }, async () => {
    const rows = (await companyRows()).filter((c) => !c.isDemo);
    const now = clockNow();
    const cfg = platformConfig();
    const month = daySP(now).slice(0, 7);
    const dto: PlatformDashboardDto = {
      mrrCents: 0,
      paying: 0,
      trial: 0,
      courtesy: 0,
      late: 0,
      blocked: 0,
      newThisMonth: 0,
      receivedThisMonthCents: 0,
      dueNext7Cents: 0,
      dueNext7: [],
      lateList: [],
      trialEnding: [],
      byMonth: [],
      autoBlock: cfg.autoBlock,
      pixConfigured: !!cfg.pixKey,
      pendingProofs: rows.reduce((n, c) => n + c.pendingProofs, 0),
      demosPending: await system.contactRequest.count({
        where: { companyId: PLATFORM_RECORD_ID, kind: 'DEMONSTRACAO', status: 'PENDENTE' },
      }),
      bySource: [],
    };
    const bySource = new Map<SignupSource | null, { companies: number; paying: number }>();
    for (const c of rows) {
      const k = c.signupSource;
      const v = bySource.get(k) ?? { companies: 0, paying: 0 };
      v.companies++;
      if ((c.status === 'ATIVA' || c.status === 'ATRASADA') && !c.canceledAt) v.paying++;
      bySource.set(k, v);
    }
    dto.bySource = [...bySource]
      .map(([source, v]) => ({ source, ...v }))
      .sort((a, b) => b.companies - a.companies);
    for (const c of rows) {
      if (daySP(new Date(c.createdAt)).slice(0, 7) === month) dto.newThisMonth++;
      if (c.blockedAt) dto.blocked++;
      if (c.status === 'CORTESIA') {
        dto.courtesy++;
        continue;
      }
      if (c.status === 'TESTE') {
        dto.trial++;
        if (c.daysToDue !== null && c.daysToDue <= 3)
          dto.trialEnding.push({ id: c.id, tradeName: c.tradeName, trialEndsAt: c.dueAt! });
      }
      if ((c.status === 'ATIVA' || c.status === 'ATRASADA') && !c.canceledAt) {
        dto.paying++;
        dto.mrrCents += c.cycle === 'ANUAL' ? Math.round(c.priceCents / 12) : c.priceCents;
      }
      if (c.status === 'ATRASADA' || (c.status === 'VENCIDA' && c.paidUntil && !c.canceledAt)) {
        dto.late++;
        dto.lateList.push({
          id: c.id,
          tradeName: c.tradeName,
          dueAt: c.dueAt!,
          priceCents: c.priceCents,
          days: -(c.daysToDue ?? 0),
        });
      }
      if (c.status === 'ATIVA' && c.daysToDue !== null && c.daysToDue <= 7 && !c.canceledAt) {
        dto.dueNext7Cents += c.priceCents;
        dto.dueNext7.push({
          id: c.id,
          tradeName: c.tradeName,
          dueAt: c.dueAt!,
          priceCents: c.priceCents,
        });
      }
    }
    dto.dueNext7.sort((a, b) => a.dueAt.localeCompare(b.dueAt));
    dto.lateList.sort((a, b) => b.days - a.days);
    const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));
    const paid = await system.subscriptionInvoice.findMany({
      where: { status: 'PAGA', paidAt: { gte: since } },
      select: { amountCents: true, paidAt: true },
    });
    const byMonth = new Map<string, number>();
    for (let i = 11; i >= 0; i--) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 15));
      byMonth.set(d.toISOString().slice(0, 7), 0);
    }
    for (const p of paid) {
      const m = daySP(p.paidAt!).slice(0, 7);
      if (byMonth.has(m)) byMonth.set(m, byMonth.get(m)! + p.amountCents);
    }
    dto.byMonth = [...byMonth].map(([m, cents]) => ({ month: m, cents }));
    dto.receivedThisMonthCents = byMonth.get(month) ?? 0;
    return dto;
  });

  // ───────────────────────── Planos e preços / Como eu recebo ─────────────────────────
  async function settingsDto(): Promise<PlatformSettingsDto> {
    const cfg = await refreshPlatformConfig(system, true);
    // Quem ficaria bloqueado já, se o bloqueio automático fosse ligado agora.
    const all = await system.companySettings.findMany({
      where: { isPlatform: false, blockedAt: null },
      select: { ...COMPANY_BILLING_SELECT, tradeName: true },
    });
    const now = clockNow();
    return {
      priceGestaoCents: cfg.prices.gestao,
      priceJogoCents: cfg.prices.gestao_jogo,
      annualDiscountPct: cfg.annualDiscountBps / 100,
      trialDays: cfg.trialDays,
      graceDays: cfg.graceDays,
      noticeDays: cfg.noticeDays,
      autoBlock: cfg.autoBlock,
      pixKey: cfg.pixKey,
      pixName: cfg.pixName,
      pixBank: cfg.pixBank,
      whatsapp: cfg.whatsapp,
      paymentMessage: cfg.paymentMessage,
      pixCity: cfg.pixCity,
      messageTemplates: cfg.messageTemplates,
      pushDevices: await system.platformPushSubscription.count(),
      pushPublicKey: (await pushKeys(system)).publicKey,
      wouldBlockNow: all
        .filter((c) => statusOf(c, env, now) === 'VENCIDA')
        .map((c) => ({ id: c.id, tradeName: c.tradeName })),
      emailEnabled: mailer.configured,
    };
  }

  app.get('/api/v1/platform/settings', { config: { access: PLATFORM } }, settingsDto);

  app.put('/api/v1/platform/settings', { config: { access: PLATFORM } }, async (request) => {
    const input = platformSettingsSchema.parse(request.body ?? {});
    const before = await system.platformSettings.findUnique({ where: { id: 1 } });
    const data = {
      ...(input.priceGestaoCents !== undefined ? { priceGestaoCents: input.priceGestaoCents } : {}),
      ...(input.priceJogoCents !== undefined ? { priceJogoCents: input.priceJogoCents } : {}),
      ...(input.annualDiscountPct !== undefined
        ? { annualDiscountBps: input.annualDiscountPct * 100 }
        : {}),
      ...(input.trialDays !== undefined ? { trialDays: input.trialDays } : {}),
      ...(input.graceDays !== undefined ? { graceDays: input.graceDays } : {}),
      ...(input.noticeDays !== undefined ? { noticeDays: input.noticeDays } : {}),
      ...(input.autoBlock !== undefined ? { autoBlock: input.autoBlock } : {}),
      ...(input.pixKey !== undefined ? { pixKey: input.pixKey } : {}),
      ...(input.pixName !== undefined ? { pixName: input.pixName } : {}),
      ...(input.pixBank !== undefined ? { pixBank: input.pixBank } : {}),
      ...(input.whatsapp !== undefined ? { whatsapp: input.whatsapp } : {}),
      ...(input.paymentMessage !== undefined ? { paymentMessage: input.paymentMessage } : {}),
      ...(input.pixCity !== undefined ? { pixCity: input.pixCity } : {}),
      ...(input.messageTemplates !== undefined
        ? {
            messageTemplates: Object.fromEntries(
              Object.entries({
                ...platformConfig().messageTemplates,
                ...input.messageTemplates,
              }).filter((e): e is [string, string] => typeof e[1] === 'string' && !!e[1]),
            ),
          }
        : {}),
    };
    const parts: string[] = [];
    if (data.priceGestaoCents !== undefined && data.priceGestaoCents !== before?.priceGestaoCents)
      parts.push(`Cenário Gestão ${fmtBRL(data.priceGestaoCents)}`);
    if (data.priceJogoCents !== undefined && data.priceJogoCents !== before?.priceJogoCents)
      parts.push(`com Firma Viva ${fmtBRL(data.priceJogoCents)}`);
    if (
      data.annualDiscountBps !== undefined &&
      data.annualDiscountBps !== before?.annualDiscountBps
    )
      parts.push(`desconto do anual ${data.annualDiscountBps / 100}%`);
    if (data.trialDays !== undefined && data.trialDays !== before?.trialDays)
      parts.push(`teste ${data.trialDays} dias`);
    if (data.graceDays !== undefined && data.graceDays !== before?.graceDays)
      parts.push(`bloqueia ${data.graceDays} dias depois do vencimento`);
    if (data.noticeDays !== undefined && data.noticeDays !== before?.noticeDays)
      parts.push(`aviso ${data.noticeDays} dias antes`);
    if (data.autoBlock !== undefined && data.autoBlock !== before?.autoBlock)
      parts.push(data.autoBlock ? 'bloqueio automático LIGADO' : 'bloqueio automático desligado');
    for (const [k, label] of [
      ['pixKey', 'chave PIX'],
      ['pixName', 'nome do PIX'],
      ['pixBank', 'banco'],
      ['whatsapp', 'WhatsApp'],
      ['paymentMessage', 'mensagem'],
      ['pixCity', 'cidade do PIX'],
    ] as const)
      if (data[k] !== undefined && data[k] !== (before?.[k] ?? null)) parts.push(label);
    if (input.messageTemplates !== undefined) parts.push('mensagens prontas');
    await system.$transaction(async (tx) => {
      await tx.platformSettings.upsert({
        where: { id: 1 },
        create: { id: 1, ...data },
        update: data,
      });
      if (parts.length)
        await platformLog(tx, request, {
          action: 'platform.settings',
          summary: `Configuração mudada: ${parts.join(', ')}.`,
        });
    });
    return settingsDto();
  });

  // ───────────────────────── Demonstração (melhoria 128) ─────────────────────────
  app.post('/api/v1/platform/demo-company', { config: { access: PLATFORM } }, async (request) => {
    const { email } = z
      .object({ email: z.string().trim().toLowerCase().email({ message: 'E-mail inválido.' }) })
      .parse(request.body);
    const password = randomBytes(9).toString('base64url');
    const passwordHash = await hashSecret(password);
    try {
      const companyIdNew = await system.$transaction(async (tx) => {
        const company = await tx.companySettings.create({
          data: {
            tradeName: 'Tapeçaria Demonstração',
            email,
            plan: 'gestao_jogo',
            billingCourtesy: true,
            isDemo: true,
            setupDoneAt: new Date(),
            gettingStartedHiddenAt: new Date(),
            platformNewNoticeAt: new Date(),
          },
        });
        await tx.$executeRaw`SELECT set_config('app.company_id', ${String(company.id)}, true),
          set_config('app.bypass_rls', 'off', true)`;
        const roles = await createCompanyContent(tx);
        const user = await tx.user.create({
          data: {
            email,
            passwordHash,
            displayName: 'Demonstração',
            credentialsChangedAt: new Date(),
            emailConfirmedAt: new Date(),
            roles: { create: { roleId: roles.get(GESTOR_ROLE_KEY)! } },
          },
        });
        await tx.employee.create({
          data: {
            userId: user.id,
            fullName: 'Gestor da demonstração',
            displayName: 'Demonstração',
            jobTitle: 'Gestor',
            color: '#1D4ED8',
          },
        });
        for (const c of DEMO_CUSTOMERS)
          await tx.customer.create({
            data: {
              kind: 'PF',
              name: c.name,
              phone: c.phone,
              whatsapp: c.phone,
              searchText: searchTextFor({ name: c.name, phone: c.phone, whatsapp: c.phone }),
              createdById: user.id,
              addresses: {
                create: {
                  label: 'Principal',
                  street: c.street,
                  number: c.number,
                  district: c.district,
                  city: 'São José dos Campos',
                  state: 'SP',
                  isPrimary: true,
                },
              },
            },
          });
        await tx.$executeRaw`SELECT set_config('app.bypass_rls', 'on', true)`;
        await platformLog(tx, request, {
          action: 'platform.demo_created',
          companyId: company.id,
          summary: `Conta de demonstração criada (${email}): empresa nº ${company.id}.`,
        });
        return company.id;
      });
      return { companyId: companyIdNew, email, password };
    } catch (error) {
      if (isUniqueViolation(error, 'email'))
        throw Errors.conflict('Já existe uma conta com este e-mail. Use outro.');
      throw error;
    }
  });
}

/** Clientes fictícios da conta de demonstração (nomes e telefones inventados). */
const DEMO_CUSTOMERS = [
  {
    name: 'Ana Paula Ribeiro',
    phone: '12999990001',
    street: 'Rua das Acácias',
    number: '120',
    district: 'Jardim Aquarius',
  },
  {
    name: 'Carlos Henrique Souza',
    phone: '12999990002',
    street: 'Av. Andrômeda',
    number: '845',
    district: 'Bosque dos Eucaliptos',
  },
  {
    name: 'Fernanda Lima',
    phone: '12999990003',
    street: 'Rua Ipê Amarelo',
    number: '33',
    district: 'Urbanova',
  },
  {
    name: 'Roberto Almeida',
    phone: '12999990004',
    street: 'Rua Paraíba',
    number: '510',
    district: 'Vila Adyana',
  },
  {
    name: 'Juliana Martins',
    phone: '12999990005',
    street: 'Rua Euclides Miragaia',
    number: '77',
    district: 'Centro',
  },
];
