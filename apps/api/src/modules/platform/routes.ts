import { GESTOR_ROLE_KEY } from '@cenario/shared';
import { createCompanyContent, isUniqueViolation } from '@cenario/db';
import { randomBytes } from 'node:crypto';
import { hashSecret } from '../../lib/crypto';
import { searchTextFor } from '../customers/service';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { actorFrom, audit } from '../../core/audit';
import { Errors } from '../../lib/errors';

import { PLATFORM_COMPANY_ID } from '../../core/tenant';
import { PLANS, platformSubscriptionSchema } from '@cenario/shared';
import { COMPANY_BILLING_SELECT, planOf, statusOf } from '../../core/billing';
import { now as clockNow } from '../../core/clock';

const blockSchema = z.object({ reason: z.string().trim().max(200).optional() });

/**
 * Multi-empresa — etapa 4: painel simples do dono da plataforma (decisão do dono, 16/11/2026).
 * Lista as empresas e bloqueia/libera o acesso de cada uma. Só o gestor da empresa nº 1 (quem
 * configura a Cenário Estofados) enxerga estas rotas; para qualquer outra empresa elas não
 * existem (404). Usa o banco do sistema, porque atravessa empresas; nada além do resumo de cada
 * empresa é mostrado (nenhum cliente, pedido ou valor).
 */
export async function platformRoutes(app: FastifyInstance) {
  const { system, env } = app.ctx;
  const access = { session: 'WEB', permissions: ['empresa.configurar'] } as const;

  function assertPlatformOwner(request: FastifyRequest) {
    if (request.auth?.companyId !== PLATFORM_COMPANY_ID) throw Errors.notFound('Página');
  }

  app.get('/api/v1/platform/companies', { config: { access } }, async (request) => {
    assertPlatformOwner(request);
    const companies = await system.companySettings.findMany({
      orderBy: { id: 'asc' },
      select: {
        ...COMPANY_BILLING_SELECT,
        tradeName: true,
        email: true,
        createdAt: true,
        blockedAt: true,
        blockedReason: true,
        isDemo: true,
        supportAccessUntil: true,
        canceledAt: true,
        pausedUntil: true,
        cancelReason: true,
      },
    });
    const users = await system.user.groupBy({ by: ['companyId'], _count: { _all: true } });
    const lastLogin = await system.user.groupBy({ by: ['companyId'], _max: { lastLoginAt: true } });
    const owners = await system.user.findMany({
      where: { roles: { some: { role: { key: GESTOR_ROLE_KEY } } } },
      orderBy: { createdAt: 'asc' },
      select: { companyId: true, email: true, emailConfirmedAt: true },
    });
    // Melhoria 7: sinais de uso para ver quem está desistindo (só contagens, nenhum dado).
    const orders = await system.commercialOrder.groupBy({
      by: ['companyId'],
      _count: { _all: true },
      _max: { createdAt: true },
    });
    const ord = new Map(orders.map((o) => [o.companyId, o]));
    const lastInvoice = await system.subscriptionInvoice.findMany({
      orderBy: { dueDate: 'desc' },
      distinct: ['companyId'],
      select: { companyId: true, status: true, dueDate: true, amountCents: true },
    });
    const inv = new Map(lastInvoice.map((i) => [i.companyId, i]));
    const count = new Map(users.map((u) => [u.companyId, u._count._all]));
    const last = new Map(lastLogin.map((u) => [u.companyId, u._max.lastLoginAt]));
    const owner = new Map<number, { email: string; confirmed: boolean }>();
    for (const o of owners)
      if (o.email && !owner.has(o.companyId))
        owner.set(o.companyId, { email: o.email, confirmed: o.emailConfirmedAt !== null });
    const now = clockNow();
    return {
      items: companies.map(
        ({ plan, billingCycle, billingCourtesy, trialEndsAt, paidUntil, ...c }) => ({
          ...c,
          ownerEmail: owner.get(c.id)?.email ?? c.email ?? null,
          ownerEmailConfirmed: owner.get(c.id)?.confirmed ?? false,
          orders: ord.get(c.id)?._count._all ?? 0,
          lastOrderAt: ord.get(c.id)?._max.createdAt ?? null,
          subscription: {
            plan: planOf({ plan }),
            planLabel: PLANS[planOf({ plan })].label,
            cycle: billingCycle,
            courtesy: billingCourtesy,
            trialEndsAt,
            paidUntil,
            status: statusOf(
              { id: c.id, plan, billingCycle, billingCourtesy, trialEndsAt, paidUntil },
              env,
              now,
            ),
            lastInvoice: inv.get(c.id) ?? null,
          },
          users: count.get(c.id) ?? 0,
          lastLoginAt: last.get(c.id) ?? null,
          isPlatform: c.id === PLATFORM_COMPANY_ID,
        }),
      ),
    };
  });

  /**
   * Melhoria 128: conta de demonstração separada (para mostrar o sistema a quem quer conhecer),
   * no lugar dos dados "[Exemplo]" dentro da Cenário Estofados. Fica fora dos números do negócio
   * e não é cobrada. A senha aparece uma vez, só para quem criou.
   */
  app.post('/api/v1/platform/demo-company', { config: { access } }, async (request) => {
    assertPlatformOwner(request);
    const { email } = z
      .object({ email: z.string().trim().toLowerCase().email({ message: 'E-mail inválido.' }) })
      .parse(request.body);
    const password = randomBytes(9).toString('base64url');
    const passwordHash = await hashSecret(password);
    const actor = actorFrom(request);
    try {
      const companyId = await system.$transaction(async (tx) => {
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
        return company.id;
      });
      await audit(system, actor, {
        action: 'platform.demo_created',
        entityType: 'company',
        entityId: String(companyId),
        summary: `Conta de demonstração criada (${email}): empresa nº ${companyId}.`,
      });
      return { companyId, email, password };
    } catch (error) {
      if (isUniqueViolation(error, 'email'))
        throw Errors.conflict('Já existe uma conta com este e-mail. Use outro.');
      throw error;
    }
  });

  app.post('/api/v1/platform/companies/:id/block', { config: { access } }, async (request) => {
    assertPlatformOwner(request);
    const id = Number((request.params as { id: string }).id);
    const input = blockSchema.parse(request.body ?? {});
    if (id === PLATFORM_COMPANY_ID)
      throw Errors.business('A Cenário Estofados não pode ser bloqueada por aqui.');
    return setBlocked(request, id, true, input.reason ?? null);
  });

  app.post('/api/v1/platform/companies/:id/unblock', { config: { access } }, async (request) => {
    assertPlatformOwner(request);
    const id = Number((request.params as { id: string }).id);
    return setBlocked(request, id, false, null);
  });

  /**
   * Plano e cobrança de uma empresa, pelo dono da plataforma: trocar o plano (liga/desliga o
   * jogo), dar cortesia, estender o teste grátis ou registrar um pagamento recebido fora do
   * Asaas (pago até).
   */
  app.put(
    '/api/v1/platform/companies/:id/subscription',
    { config: { access } },
    async (request) => {
      assertPlatformOwner(request);
      const id = Number((request.params as { id: string }).id);
      if (!Number.isInteger(id) || id < 1) throw Errors.notFound('Empresa');
      const input = platformSubscriptionSchema.parse(request.body ?? {});
      return system.$transaction(async (tx) => {
        const company = await tx.companySettings.findUnique({ where: { id } });
        if (!company) throw Errors.notFound('Empresa');
        const endOfDay = (d: string) => new Date(`${d}T23:59:59.000-03:00`);
        const data = {
          ...(input.plan ? { plan: input.plan } : {}),
          ...(input.cycle ? { billingCycle: input.cycle } : {}),
          ...(input.courtesy !== undefined ? { billingCourtesy: input.courtesy } : {}),
          ...(input.paidUntil ? { paidUntil: endOfDay(input.paidUntil) } : {}),
          ...(input.trialEndsAt ? { trialEndsAt: endOfDay(input.trialEndsAt) } : {}),
        };
        const updated = await tx.companySettings.update({ where: { id }, data });
        const parts = [
          input.plan ? `plano ${PLANS[input.plan].label}` : null,
          input.cycle ? `ciclo ${input.cycle.toLowerCase()}` : null,
          input.courtesy !== undefined
            ? input.courtesy
              ? 'cortesia ligada'
              : 'cortesia desligada'
            : null,
          input.paidUntil ? `pago até ${input.paidUntil.split('-').reverse().join('/')}` : null,
          input.trialEndsAt
            ? `teste até ${input.trialEndsAt.split('-').reverse().join('/')}`
            : null,
        ].filter(Boolean);
        await tx.$executeRaw`SELECT set_config('app.company_id', ${String(PLATFORM_COMPANY_ID)}, true)`;
        await audit(tx, actorFrom(request), {
          action: 'platform.company_subscription',
          entityType: 'company',
          entityId: String(id),
          summary: `Empresa nº ${id} (${company.tradeName}): ${parts.join(', ') || 'sem mudança'}.`,
        });
        return {
          id: updated.id,
          status: statusOf(updated, env, clockNow()),
          plan: planOf(updated),
        };
      });
    },
  );

  async function setBlocked(
    request: FastifyRequest,
    id: number,
    blocked: boolean,
    reason: string | null,
  ) {
    if (!Number.isInteger(id) || id < 1) throw Errors.notFound('Empresa');
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
      // O registro fica na auditoria da empresa da plataforma (quem bloqueou e por quê).
      await tx.$executeRaw`SELECT set_config('app.company_id', ${String(PLATFORM_COMPANY_ID)}, true)`;
      await audit(tx, actorFrom(request), {
        action: blocked ? 'platform.company_blocked' : 'platform.company_unblocked',
        entityType: 'company',
        entityId: String(id),
        summary: `Empresa nº ${id} (${company.tradeName}) ${blocked ? 'bloqueada' : 'liberada'}${reason ? `: ${reason}` : ''}.`,
      });
      return updated;
    });
  }
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
