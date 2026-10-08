import {
  EVENT_TYPES,
  createDeviceSchema,
  updateDeviceSchema,
  type DeviceDto,
  type EventType,
  type PairingCodeDto,
} from '@cenario/shared';
import { isUniqueViolation, type Device, type Employee, type Tx } from '@cenario/db';
import type { FastifyInstance } from 'fastify';
import { actorFrom, audit } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import { lockRow } from '../../core/locking';
import { revokeSessions } from '../../core/sessions';
import type { ActorContext } from '../../core/types';
import { diffObjects } from '../../lib/diff';
import { formatPairingCode, generatePairingCode } from '../../lib/crypto';
import { Errors } from '../../lib/errors';
import { idParams, toEmployeeSummary } from '../presenters';

const VIEW = { session: 'WEB', permissions: ['dispositivos.ver'] } as const;
const MANAGE = { session: 'WEB', permissions: ['dispositivos.gerenciar'] } as const;
const PAIRING_TTL_MS = 15 * 60_000;

type DeviceWithRelations = Device & {
  assignedEmployee: Employee | null;
  _count: { sessions: number };
};

export async function deviceRoutes(app: FastifyInstance) {
  const { prisma, hub, hashToken } = app.ctx;

  /** Relações para a resposta (a contagem considera apenas sessões ainda válidas agora). */
  const includeNow = () => ({
    assignedEmployee: true,
    _count: { select: { sessions: { where: { revokedAt: null, expiresAt: { gt: new Date() } } } } },
  });

  function toDto(d: DeviceWithRelations): DeviceDto {
    return {
      id: d.id,
      name: d.name,
      kind: d.kind,
      location: d.location,
      status: d.status,
      assignedEmployee: d.assignedEmployee ? toEmployeeSummary(d.assignedEmployee) : null,
      restrictToAssigned: d.restrictToAssigned,
      pairedAt: d.pairedAt?.toISOString() ?? null,
      lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
      online: d.status === 'ACTIVE' && hub.isDeviceOnline(d.id),
      userAgent: d.userAgent,
      pairingCodeExpiresAt:
        d.pairingCodeExpiresAt && d.pairingCodeExpiresAt > new Date()
          ? d.pairingCodeExpiresAt.toISOString()
          : null,
      activeSessions: d._count.sessions,
      version: d.version,
      createdAt: d.createdAt.toISOString(),
    };
  }

  async function issuePairingCode(tx: Tx, deviceId: string) {
    const code = generatePairingCode();
    const expiresAt = new Date(Date.now() + PAIRING_TTL_MS);
    await tx.device.update({
      where: { id: deviceId },
      data: { pairingCodeHash: hashToken(`pairing:${code}`), pairingCodeExpiresAt: expiresAt },
    });
    return { code: formatPairingCode(code), expiresAt };
  }

  async function assertEmployee(tx: Tx, id: string | null | undefined) {
    if (!id) return;
    const e = await tx.employee.findUnique({ where: { id } });
    if (!e || !e.active)
      throw Errors.validation(undefined, 'Funcionário atribuído inválido ou inativo.');
  }

  async function emitUpdated(
    tx: Tx,
    actor: ActorContext,
    d: Device,
    type: EventType = EVENT_TYPES.DEVICE_UPDATED,
  ) {
    await appendEvent(tx, actor, {
      type,
      aggregateType: 'device',
      aggregateId: d.id,
      payload: { id: d.id, name: d.name, status: d.status, version: d.version },
      audience: 'permission:dispositivos.ver',
    });
  }

  app.get('/api/devices', { config: { access: VIEW } }, async () => {
    const list = await prisma.device.findMany({
      include: includeNow(),
      orderBy: [{ status: 'asc' }, { name: 'asc' }],
    });
    return list.map(toDto);
  });

  app.post(
    '/api/devices',
    { config: { access: MANAGE, idempotent: true } },
    async (request, reply) => {
      const input = createDeviceSchema.parse(request.body);
      try {
        const result = await prisma.$transaction(async (tx) => {
          await assertEmployee(tx, input.assignedEmployeeId);
          const actor = actorFrom(request);
          const created = await tx.device.create({
            data: {
              name: input.name,
              kind: input.kind,
              location: input.location ?? null,
              assignedEmployeeId: input.assignedEmployeeId ?? null,
              restrictToAssigned: input.restrictToAssigned,
              createdById: actor.userId,
            },
          });
          const pairing = await issuePairingCode(tx, created.id);
          await audit(tx, actor, {
            action: 'device.registered',
            entityType: 'device',
            entityId: created.id,
            summary: `Dispositivo "${created.name}" cadastrado; código de vinculação emitido.`,
          });
          await emitUpdated(tx, actor, created, EVENT_TYPES.DEVICE_REGISTERED);
          const device = await tx.device.findUniqueOrThrow({
            where: { id: created.id },
            include: includeNow(),
          });
          return { device, pairing };
        });
        const pairing: PairingCodeDto = {
          deviceId: result.device.id,
          code: result.pairing.code,
          expiresAt: result.pairing.expiresAt.toISOString(),
        };
        return reply.status(201).send({ device: toDto(result.device), pairing });
      } catch (error) {
        if (isUniqueViolation(error, 'name'))
          throw Errors.conflict('Já existe um dispositivo com este nome.');
        throw error;
      }
    },
  );

  app.put('/api/devices/:id', { config: { access: MANAGE } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const input = updateDeviceSchema.parse(request.body);
    try {
      const device = await prisma.$transaction(async (tx) => {
        if (!(await lockRow(tx, 'devices', id))) throw Errors.notFound('Dispositivo');
        const before = await tx.device.findUniqueOrThrow({ where: { id } });
        if (before.version !== input.version) throw Errors.versionConflict(before.version);
        await assertEmployee(tx, input.assignedEmployeeId);
        const actor = actorFrom(request);
        const updated = await tx.device.update({
          where: { id, version: input.version },
          data: {
            name: input.name,
            location: input.location ?? null,
            assignedEmployeeId: input.assignedEmployeeId,
            restrictToAssigned: input.restrictToAssigned,
            version: { increment: 1 },
          },
        });
        // Se o tablet passou a ser exclusivo de outra pessoa, encerra sessões de terceiros.
        if (updated.restrictToAssigned && updated.assignedEmployeeId) {
          const owner = await tx.employee.findUniqueOrThrow({
            where: { id: updated.assignedEmployeeId },
          });
          await revokeSessions(
            tx,
            actor,
            { deviceId: id, userId: { not: owner.userId } },
            'revoked_by_admin',
          );
        }
        await audit(tx, actor, {
          action: 'device.updated',
          entityType: 'device',
          entityId: id,
          summary: `Dispositivo "${updated.name}" alterado.`,
          changes: diffObjects(before, updated, [
            'name',
            'location',
            'assignedEmployeeId',
            'restrictToAssigned',
          ]),
        });
        await emitUpdated(tx, actor, updated);
        return tx.device.findUniqueOrThrow({ where: { id }, include: includeNow() });
      });
      return toDto(device);
    } catch (error) {
      if (isUniqueViolation(error, 'name'))
        throw Errors.conflict('Já existe um dispositivo com este nome.');
      throw error;
    }
  });

  /**
   * Emite novo código de vinculação (primeira vinculação, troca de tablet ou
   * reativação após revogação). A credencial atual continua válida até o novo
   * vínculo ser concluído.
   */
  app.post(
    '/api/devices/:id/pairing-code',
    { config: { access: MANAGE, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const result = await prisma.$transaction(async (tx) => {
        if (!(await lockRow(tx, 'devices', id))) throw Errors.notFound('Dispositivo');
        const before = await tx.device.findUniqueOrThrow({ where: { id } });
        const pairing = await issuePairingCode(tx, id);
        const updated = await tx.device.update({
          where: { id },
          data: {
            version: { increment: 1 },
            ...(before.status === 'REVOKED' ? { status: 'PENDING_PAIRING' as const } : {}),
          },
        });
        const actor = actorFrom(request);
        await audit(tx, actor, {
          action: 'device.pairing_code_issued',
          entityType: 'device',
          entityId: id,
          summary: `Novo código de vinculação emitido para "${updated.name}".`,
        });
        await emitUpdated(tx, actor, updated);
        return pairing;
      });
      const dto: PairingCodeDto = {
        deviceId: id,
        code: result.code,
        expiresAt: result.expiresAt.toISOString(),
      };
      return dto;
    },
  );

  /** Revogação remota: o tablet perde a credencial e todas as sessões são encerradas na hora. */
  app.post('/api/devices/:id/revoke', { config: { access: MANAGE } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const device = await prisma.$transaction(async (tx) => {
      if (!(await lockRow(tx, 'devices', id))) throw Errors.notFound('Dispositivo');
      const before = await tx.device.findUniqueOrThrow({ where: { id } });
      if (before.status === 'REVOKED') throw Errors.business('Dispositivo já está revogado.');
      const actor = actorFrom(request);
      const updated = await tx.device.update({
        where: { id },
        data: {
          status: 'REVOKED',
          credentialHash: null,
          pairingCodeHash: null,
          pairingCodeExpiresAt: null,
          revokedAt: new Date(),
          revokedById: actor.userId,
          version: { increment: 1 },
        },
      });
      await revokeSessions(tx, actor, { deviceId: id }, 'device_revoked');
      await audit(tx, actor, {
        action: 'device.revoked',
        entityType: 'device',
        entityId: id,
        summary: `Dispositivo "${updated.name}" revogado remotamente.`,
      });
      await emitUpdated(tx, actor, updated, EVENT_TYPES.DEVICE_REVOKED);
      return tx.device.findUniqueOrThrow({ where: { id }, include: includeNow() });
    });
    return toDto(device);
  });

  /** Exclui dispositivo que não está ativo (nunca vinculado ou já revogado). */
  app.delete('/api/devices/:id', { config: { access: MANAGE } }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    await prisma.$transaction(async (tx) => {
      if (!(await lockRow(tx, 'devices', id))) throw Errors.notFound('Dispositivo');
      const device = await tx.device.findUniqueOrThrow({ where: { id } });
      if (device.status === 'ACTIVE') {
        throw Errors.business('Revogue o dispositivo antes de excluí-lo.');
      }
      await tx.device.delete({ where: { id } });
      const actor = actorFrom(request);
      await audit(tx, actor, {
        action: 'device.deleted',
        entityType: 'device',
        entityId: id,
        summary: `Dispositivo "${device.name}" excluído.`,
      });
      await appendEvent(tx, actor, {
        type: EVENT_TYPES.DEVICE_UPDATED,
        aggregateType: 'device',
        aggregateId: id,
        payload: { id, name: device.name, deleted: true },
        audience: 'permission:dispositivos.ver',
      });
    });
    return reply.status(204).send();
  });
}
