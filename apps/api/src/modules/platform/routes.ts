import { GESTOR_ROLE_KEY } from '@cenario/shared';
import { z } from 'zod';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { actorFrom, audit } from '../../core/audit';
import { Errors } from '../../lib/errors';

/** A empresa da instalação (Cenário Estofados) é a dona da plataforma. */
export const PLATFORM_COMPANY_ID = 1;

const blockSchema = z.object({ reason: z.string().trim().max(200).optional() });

/**
 * Multi-empresa — etapa 4: painel simples do dono da plataforma (decisão do dono, 16/11/2026).
 * Lista as empresas e bloqueia/libera o acesso de cada uma. Só o gestor da empresa nº 1 (quem
 * configura a Cenário Estofados) enxerga estas rotas; para qualquer outra empresa elas não
 * existem (404). Usa o banco do sistema, porque atravessa empresas; nada além do resumo de cada
 * empresa é mostrado (nenhum cliente, pedido ou valor).
 */
export async function platformRoutes(app: FastifyInstance) {
  const { system } = app.ctx;
  const access = { session: 'WEB', permissions: ['empresa.configurar'] } as const;

  function assertPlatformOwner(request: FastifyRequest) {
    if (request.auth?.companyId !== PLATFORM_COMPANY_ID) throw Errors.notFound('Página');
  }

  app.get('/api/v1/platform/companies', { config: { access } }, async (request) => {
    assertPlatformOwner(request);
    const companies = await system.companySettings.findMany({
      orderBy: { id: 'asc' },
      select: {
        id: true,
        tradeName: true,
        email: true,
        createdAt: true,
        blockedAt: true,
        blockedReason: true,
      },
    });
    const users = await system.user.groupBy({ by: ['companyId'], _count: { _all: true } });
    const lastLogin = await system.user.groupBy({ by: ['companyId'], _max: { lastLoginAt: true } });
    const owners = await system.user.findMany({
      where: { roles: { some: { role: { key: GESTOR_ROLE_KEY } } } },
      orderBy: { createdAt: 'asc' },
      select: { companyId: true, email: true },
    });
    const count = new Map(users.map((u) => [u.companyId, u._count._all]));
    const last = new Map(lastLogin.map((u) => [u.companyId, u._max.lastLoginAt]));
    const owner = new Map<number, string>();
    for (const o of owners) if (o.email && !owner.has(o.companyId)) owner.set(o.companyId, o.email);
    return {
      items: companies.map((c) => ({
        ...c,
        ownerEmail: owner.get(c.id) ?? c.email ?? null,
        users: count.get(c.id) ?? 0,
        lastLoginAt: last.get(c.id) ?? null,
        isPlatform: c.id === PLATFORM_COMPANY_ID,
      })),
    };
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
