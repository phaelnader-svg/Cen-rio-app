import {
  EVENT_TYPES,
  MODULES,
  MODULE_KEYS,
  companySettingsSchema,
  isModuleKey,
  resolveModules,
  updateModuleSchema,
  type CompanySettingsDto,
  type ModuleSettingDto,
} from '@cenario/shared';
import type { CompanySettings, PrismaClient } from '@cenario/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorFrom, audit } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import { lockRow } from '../../core/locking';
import { moduleState } from '../../core/modules';
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
    arrivalWindowStart: c.arrivalWindowStart,
    lateAlertMinutes: c.lateAlertMinutes,
    workingDays: [...c.workingDays].sort(),
    planningWeekday: c.planningWeekday,
    measurementWeekday: c.measurementWeekday,
    version: c.version,
    updatedAt: c.updatedAt.toISOString(),
  };
}

/** Reformulação, Fase 0: catálogo de funcionalidades com o estado efetivo e quem alterou. */
async function moduleSettings(prisma: PrismaClient): Promise<ModuleSettingDto[]> {
  const rows = await prisma.moduleSetting.findMany({
    include: { updatedBy: { select: { id: true, displayName: true } } },
  });
  const state = resolveModules(rows);
  return MODULE_KEYS.map((key) => {
    const row = rows.find((r) => r.key === key);
    return {
      key,
      label: MODULES[key].label,
      description: MODULES[key].description,
      enabled: state[key],
      defaultEnabled: MODULES[key].defaultEnabled,
      configurable: MODULES[key].configurable,
      version: row?.version ?? 0,
      updatedAt: row?.updatedAt.toISOString() ?? null,
      updatedBy: row?.updatedBy ?? null,
    };
  });
}

const moduleParams = z.object({ key: z.string().max(40) });

export async function companyRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;

  /**
   * Estado efetivo das funcionalidades (só booleanos, nenhum dado pessoal ou financeiro). Qualquer
   * sessão válida — painel ou tablet — precisa saber o que mostrar; quem decide continua sendo o
   * servidor em cada rota.
   */
  app.get('/api/v1/modules', { config: { access: { session: 'any' } } }, async () =>
    moduleState(prisma),
  );

  app.get(
    '/api/company/modules',
    { config: { access: { session: 'WEB', permissions: ['empresa.ver'] } } },
    async () => moduleSettings(prisma),
  );

  /**
   * Liga/desliga uma funcionalidade. Mesma proteção da configuração da empresa: só o gestor com
   * `empresa.configurar`, versão conferida sob bloqueio (a linha da empresa serializa as
   * alterações, inclusive a primeira, quando ainda não existe registro), auditoria e evento na
   * mesma transação. Repetir o mesmo estado não grava nada.
   */
  app.put(
    '/api/company/modules/:key',
    {
      config: { access: { session: 'WEB', permissions: ['empresa.configurar'] }, idempotent: true },
    },
    async (request) => {
      const { key } = moduleParams.parse(request.params);
      if (!isModuleKey(key)) throw Errors.notFound('Funcionalidade');
      const input = updateModuleSchema.parse(request.body);
      if (!MODULES[key].configurable)
        throw Errors.business(
          `${MODULES[key].label} ainda não pode ser alterada: depende de uma fase posterior da reformulação.`,
        );
      const actor = actorFrom(request);
      await prisma.$transaction(async (tx) => {
        if (!(await lockRow(tx, 'company_settings', 1)))
          throw Errors.notFound('Configuração da empresa');
        const before = await tx.moduleSetting.findUnique({ where: { key } });
        const currentVersion = before?.version ?? 0;
        if (input.version !== currentVersion) throw Errors.versionConflict(currentVersion);
        const wasEnabled = before?.enabled ?? MODULES[key].defaultEnabled;
        if (wasEnabled === input.enabled) return;
        if (before)
          await tx.moduleSetting.update({
            where: { key },
            data: { enabled: input.enabled, updatedById: actor.userId, version: { increment: 1 } },
          });
        else
          await tx.moduleSetting.create({
            data: { key, enabled: input.enabled, updatedById: actor.userId },
          });
        await audit(tx, actor, {
          action: 'company.module_updated',
          entityType: 'module_setting',
          entityId: key,
          summary: `${MODULES[key].label}: ${input.enabled ? 'ativada' : 'desativada'}.`,
          changes: { enabled: { from: wasEnabled, to: input.enabled } },
        });
        await appendEvent(tx, actor, {
          type: EVENT_TYPES.COMPANY_MODULE_UPDATED,
          aggregateType: 'module_setting',
          aggregateId: key,
          payload: { key, enabled: input.enabled },
        });
      });
      return (await moduleSettings(prisma)).find((m) => m.key === key)!;
    },
  );

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
            arrivalWindowStart: input.arrivalWindowStart,
            lateAlertMinutes: input.lateAlertMinutes,
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
            arrivalWindowStart: updated.arrivalWindowStart,
            lateAlertMinutes: updated.lateAlertMinutes,
            version: updated.version,
          },
        });
        return updated;
      });
      return toDto(settings);
    },
  );
}
