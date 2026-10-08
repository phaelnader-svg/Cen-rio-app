import { EVENT_TYPES, companySettingsSchema, type CompanySettingsDto } from '@cenario/shared';
import type { CompanySettings } from '@cenario/db';
import type { FastifyInstance } from 'fastify';
import { actorFrom, audit } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import { lockRow } from '../../core/locking';
import { diffObjects } from '../../lib/diff';
import { Errors } from '../../lib/errors';

function toDto(c: CompanySettings): CompanySettingsDto {
  return {
    tradeName: c.tradeName,
    legalName: c.legalName,
    document: c.document,
    phone: c.phone,
    email: c.email,
    address: c.address,
    timezone: c.timezone,
    workdayStart: c.workdayStart,
    arrivalAlertAt: c.arrivalAlertAt,
    workdayEnd: c.workdayEnd,
    workingDays: [...c.workingDays].sort(),
    planningWeekday: c.planningWeekday,
    measurementWeekday: c.measurementWeekday,
    version: c.version,
    updatedAt: c.updatedAt.toISOString(),
  };
}

export async function companyRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;

  app.get(
    '/api/company/settings',
    { config: { access: { session: 'WEB', permissions: ['empresa.ver'] } } },
    async () => {
      const settings = await prisma.companySettings.findUnique({ where: { id: 1 } });
      if (!settings) throw Errors.notFound('Configuração da empresa');
      return toDto(settings);
    },
  );

  app.put(
    '/api/company/settings',
    { config: { access: { session: 'WEB', permissions: ['empresa.configurar'] } } },
    async (request) => {
      const input = companySettingsSchema.parse(request.body);
      const settings = await prisma.$transaction(async (tx) => {
        if (!(await lockRow(tx, 'company_settings', 1)))
          throw Errors.notFound('Configuração da empresa');
        const before = await tx.companySettings.findUniqueOrThrow({ where: { id: 1 } });
        if (before.version !== input.version) throw Errors.versionConflict(before.version);
        const actor = actorFrom(request);
        const updated = await tx.companySettings.update({
          where: { id: 1 },
          data: {
            tradeName: input.tradeName,
            legalName: input.legalName ?? null,
            document: input.document ?? null,
            phone: input.phone ?? null,
            email: input.email ?? null,
            address: input.address ?? null,
            timezone: input.timezone,
            workdayStart: input.workdayStart,
            arrivalAlertAt: input.arrivalAlertAt,
            workdayEnd: input.workdayEnd,
            workingDays: [...new Set(input.workingDays)].sort(),
            planningWeekday: input.planningWeekday,
            measurementWeekday: input.measurementWeekday,
            updatedById: actor.userId,
            version: { increment: 1 },
          },
        });
        const changes = diffObjects(before, updated);
        delete changes.updatedById;
        await audit(tx, actor, {
          action: 'company.settings_updated',
          entityType: 'company_settings',
          entityId: '1',
          summary: 'Configurações da empresa alteradas.',
          changes,
        });
        await appendEvent(tx, actor, {
          type: EVENT_TYPES.COMPANY_SETTINGS_UPDATED,
          aggregateType: 'company_settings',
          aggregateId: '1',
          payload: {
            tradeName: updated.tradeName,
            timezone: updated.timezone,
            workdayStart: updated.workdayStart,
            arrivalAlertAt: updated.arrivalAlertAt,
            workdayEnd: updated.workdayEnd,
            version: updated.version,
          },
        });
        return updated;
      });
      return toDto(settings);
    },
  );
}
