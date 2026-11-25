import {
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
} from '@cenario/shared';
import { createCompanyContent, isUniqueViolation } from '@cenario/db';
import { randomBytes } from 'node:crypto';
import { hashSecret } from '../../lib/crypto';
import { searchTextFor } from '../customers/service';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Errors } from '../../lib/errors';
import { PLATFORM_COMPANY_ID } from '../../core/tenant';
import { COMPANY_BILLING_SELECT, blocksAt, cycleOf, planOf, statusOf } from '../../core/billing';
import { now as clockNow } from '../../core/clock';
import {
  companyPriceCents,
  platformConfig,
  refreshPlatformConfig,
} from '../../core/platform-config';
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
} as const;

/**
 * Painel da plataforma (/plataforma, 2026-11-25). Só com o login do painel (cookie próprio). Lista
 * e edita as empresas, registra os pagamentos recebidos por PIX, define preços e como o cliente
 * paga. Atravessa empresas: usa o banco do sistema e mostra só o resumo de cada empresa (nenhum
 * cliente, pedido ou valor delas).
 */
export async function platformRoutes(app: FastifyInstance) {
  const { system, env, mailer } = app.ctx;

  async function companyRows(where?: { id: number }): Promise<PlatformCompanyDto[]> {
    const companies = await system.companySettings.findMany({
      where,
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
      const priceCents = companyPriceCents({
        plan,
        cycle,
        billingPriceCents: c.billingPriceCents,
      });
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
      const chargeText =
        status === 'TESTE'
          ? `Olá${firstName ? `, ${firstName}` : ''}! Aqui é do Cenário Gestão. O teste grátis da ${c.tradeName} vai até ${dueAt ? fmtDay(dueAt) : ''}. Para continuar, o valor é ${fmtBRL(priceCents)} ${cycle === 'ANUAL' ? 'por ano' : 'por mês'}${cfg.pixKey ? `, pelo PIX ${cfg.pixKey}` : ''}.`
          : `Olá${firstName ? `, ${firstName}` : ''}! Aqui é do Cenário Gestão. A mensalidade da ${c.tradeName} (${fmtBRL(priceCents)}) ${daysToDue !== null && daysToDue < 0 ? 'venceu' : 'vence'} em ${dueAt ? fmtDay(dueAt) : ''}.${cfg.pixKey ? ` A chave PIX é ${cfg.pixKey}.` : ''} Qualquer dúvida, é só chamar.`;
      const digits = (phone ?? '').replace(/\D/g, '');
      const u = usr.get(c.id);
      const p = pay.get(c.id);
      return {
        id: c.id,
        tradeName: c.tradeName,
        ownerName: o?.displayName ?? null,
        ownerEmail: o?.email ?? c.email ?? null,
        ownerEmailConfirmed: !!o?.emailConfirmedAt,
        email: c.email,
        phone: c.phone,
        document: c.document,
        note: c.platformNote,
        createdAt: c.createdAt.toISOString(),
        lastLoginAt: u?._max.lastLoginAt?.toISOString() ?? null,
        users: u?._count._all ?? 0,
        orders: ord.get(c.id)?._count._all ?? 0,
        lastOrderAt: ord.get(c.id)?._max.createdAt?.toISOString() ?? null,
        isPlatform: c.id === PLATFORM_COMPANY_ID,
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
        paidTotalCents: p?._sum.amountCents ?? 0,
        lastPaymentAt: p?._max.paidAt?.toISOString() ?? null,
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
    if (id === PLATFORM_COMPANY_ID && input.courtesy === false)
      throw Errors.business('A Cenário Estofados não paga mensalidade.');
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
    await system.$transaction(async (tx) => {
      await tx.companySettings.update({ where: { id }, data });
      await platformLog(tx, request, {
        action: 'platform.company_edited',
        companyId: id,
        summary: `${before.tradeName}: ${changes.join(', ') || 'sem mudança'}.`,
      });
    });
    const [row] = await companyRows({ id });
    return row;
  });

  app.post(
    '/api/v1/platform/companies/:id/block',
    { config: { access: PLATFORM } },
    async (request) => {
      const id = companyId(request);
      const input = blockSchema.parse(request.body ?? {});
      if (id === PLATFORM_COMPANY_ID)
        throw Errors.business('A Cenário Estofados não pode ser bloqueada por aqui.');
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
      if (id === PLATFORM_COMPANY_ID)
        throw Errors.business('A Cenário Estofados não paga mensalidade.');
      const result = await system.$transaction(async (tx) => {
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
            ...(input.unblock ? { blockedAt: null, blockedReason: null } : {}),
          },
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
        await tx.$executeRaw`SELECT set_config('app.company_id', ${String(PLATFORM_COMPANY_ID)}, true)`;
        await platformLog(tx, request, {
          action: 'platform.payment',
          companyId: id,
          summary: `Recebi ${fmtBRL(input.amountCents)} de ${c.tradeName} em ${fmtDay(received)}: pago até ${fmtDay(periodEnd)}${input.note ? ` (${input.note})` : ''}.`,
        });
        return { invoiceId: inv.id, paidUntil: periodEnd.toISOString() };
      });
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
    const rows = (await companyRows()).filter((c) => !c.isPlatform && !c.isDemo);
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
    };
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
      where: { id: { not: PLATFORM_COMPANY_ID }, blockedAt: null },
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
    ] as const)
      if (data[k] !== undefined && data[k] !== (before?.[k] ?? null)) parts.push(label);
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
