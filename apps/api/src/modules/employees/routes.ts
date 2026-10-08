import {
  EVENT_TYPES,
  createEmployeeSchema,
  setAdminCredentialsSchema,
  setEmployeeStatusSchema,
  setPinSchema,
  updateEmployeeSchema,
} from '@cenario/shared';
import { isUniqueViolation, type Tx } from '@cenario/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { actorFrom, audit } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import { lockRow } from '../../core/locking';
import { revokeSessions } from '../../core/sessions';
import { sniffImageType } from '../../core/storage/storage';
import { diffObjects } from '../../lib/diff';
import { hashSecret, sha256Hex } from '../../lib/crypto';
import { Errors } from '../../lib/errors';
import {
  assertCanGrant,
  employeeEventPayload,
  employeeInclude,
  idParams,
  toEmployeeDto,
} from '../presenters';
import { assertActiveGestorRemains, lockGestorInvariant } from './guards';

const VIEW = { session: 'WEB', permissions: ['funcionarios.ver'] } as const;
const MANAGE = { session: 'WEB', permissions: ['funcionarios.gerenciar'] } as const;

export async function employeeRoutes(app: FastifyInstance) {
  const { prisma, storage, env } = app.ctx;

  async function loadRolesPermissions(tx: Tx, roleIds: string[]) {
    const roles = await tx.role.findMany({
      where: { id: { in: roleIds } },
      include: { permissions: true },
    });
    if (roles.length !== new Set(roleIds).size)
      throw Errors.validation(undefined, 'Função inexistente.');
    return roles.flatMap((r) => r.permissions.map((p) => p.permission));
  }

  async function getEmployeeOr404(tx: Tx, id: string, forUpdate = false) {
    if (forUpdate) await lockRow(tx, 'employees', id);
    const e = await tx.employee.findUnique({ where: { id }, include: employeeInclude });
    if (!e) throw Errors.notFound('Funcionário');
    return e;
  }

  app.get('/api/employees', { config: { access: VIEW } }, async () => {
    const list = await prisma.employee.findMany({
      include: employeeInclude,
      orderBy: [{ active: 'desc' }, { displayName: 'asc' }],
    });
    return list.map(toEmployeeDto);
  });

  app.get('/api/employees/:id', { config: { access: VIEW } }, async (request) => {
    const { id } = idParams.parse(request.params);
    return toEmployeeDto(await getEmployeeOr404(prisma, id));
  });

  app.post(
    '/api/employees',
    { config: { access: MANAGE, idempotent: true } },
    async (request, reply) => {
      const input = createEmployeeSchema.parse(request.body);
      const auth = request.auth!;
      const [pinHash, passwordHash] = await Promise.all([
        input.pin ? hashSecret(input.pin) : null,
        input.password ? hashSecret(input.password) : null,
      ]);
      try {
        const employee = await prisma.$transaction(async (tx) => {
          const rolePerms = await loadRolesPermissions(tx, input.roleIds);
          assertCanGrant(auth, [...rolePerms, ...input.extraPermissions]);
          const actor = actorFrom(request);
          const user = await tx.user.create({
            data: {
              displayName: input.displayName,
              email: input.email ?? null,
              passwordHash,
              pinHash,
              credentialsChangedAt: pinHash || passwordHash ? new Date() : null,
              roles: { create: input.roleIds.map((roleId) => ({ roleId })) },
              permissions: {
                create: [...new Set(input.extraPermissions)].map((permission) => ({ permission })),
              },
            },
          });
          const created = await tx.employee.create({
            data: {
              userId: user.id,
              fullName: input.fullName,
              displayName: input.displayName,
              jobTitle: input.jobTitle,
              responsibilities: input.responsibilities ?? null,
              phone: input.phone ?? null,
              color: input.color.toUpperCase(),
            },
            include: employeeInclude,
          });
          await audit(tx, actor, {
            action: 'employee.created',
            entityType: 'employee',
            entityId: created.id,
            summary: `Funcionário ${created.displayName} cadastrado.`,
            changes: {
              roles: created.user.roles.map((r) => r.role.name),
              extraPermissions: input.extraPermissions,
              tabletAccess: Boolean(pinHash),
              panelAccess: Boolean(passwordHash),
            },
          });
          await appendEvent(tx, actor, {
            type: EVENT_TYPES.EMPLOYEE_CREATED,
            aggregateType: 'employee',
            aggregateId: created.id,
            payload: employeeEventPayload(created),
          });
          return created;
        });
        return reply.status(201).send(toEmployeeDto(employee));
      } catch (error) {
        if (isUniqueViolation(error, 'email')) {
          throw Errors.conflict('Já existe um usuário com este e-mail.');
        }
        throw error;
      }
    },
  );

  app.put('/api/employees/:id', { config: { access: MANAGE } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const input = updateEmployeeSchema.parse(request.body);
    const auth = request.auth!;
    const employee = await prisma.$transaction(async (tx) => {
      await lockGestorInvariant(tx);
      const before = await getEmployeeOr404(tx, id, true);
      if (before.version !== input.version) throw Errors.versionConflict(before.version);

      const beforeRoleIds = before.user.roles.map((r) => r.role.id).sort();
      const beforeExtra = before.user.permissions.map((p) => p.permission).sort();
      const nextRoleIds = [...new Set(input.roleIds)].sort();
      const nextExtra = [...new Set(input.extraPermissions)].sort();
      const rolesChanged = JSON.stringify(beforeRoleIds) !== JSON.stringify(nextRoleIds);
      const extraChanged = JSON.stringify(beforeExtra) !== JSON.stringify(nextExtra);

      if (rolesChanged || extraChanged) {
        // Só é preciso possuir as permissões que estão sendo ADICIONADAS.
        const beforePerms = new Set([
          ...(await loadRolesPermissions(tx, beforeRoleIds)),
          ...beforeExtra,
        ]);
        const nextPerms = [...(await loadRolesPermissions(tx, nextRoleIds)), ...nextExtra];
        assertCanGrant(
          auth,
          nextPerms.filter((p) => !beforePerms.has(p)),
        );
        await tx.userRole.deleteMany({ where: { userId: before.userId } });
        await tx.userRole.createMany({
          data: nextRoleIds.map((roleId) => ({ userId: before.userId, roleId })),
        });
        await tx.userPermission.deleteMany({ where: { userId: before.userId } });
        await tx.userPermission.createMany({
          data: nextExtra.map((permission) => ({ userId: before.userId, permission })),
        });
      }

      const updated = await tx.employee.update({
        where: { id, version: input.version },
        data: {
          fullName: input.fullName,
          displayName: input.displayName,
          jobTitle: input.jobTitle,
          responsibilities: input.responsibilities ?? null,
          phone: input.phone ?? null,
          color: input.color.toUpperCase(),
          version: { increment: 1 },
        },
        include: employeeInclude,
      });
      await tx.user.update({
        where: { id: before.userId },
        data: { displayName: input.displayName },
      });
      if (rolesChanged) await assertActiveGestorRemains(tx);

      const actor = actorFrom(request);
      const changes = {
        ...diffObjects(before, updated, [
          'fullName',
          'displayName',
          'jobTitle',
          'responsibilities',
          'phone',
          'color',
        ]),
        ...(rolesChanged
          ? {
              roles: {
                from: before.user.roles.map((r) => r.role.name).sort(),
                to: updated.user.roles.map((r) => r.role.name).sort(),
              },
            }
          : {}),
        ...(extraChanged ? { extraPermissions: { from: beforeExtra, to: nextExtra } } : {}),
      };
      await audit(tx, actor, {
        action: 'employee.updated',
        entityType: 'employee',
        entityId: id,
        summary: `Cadastro de ${updated.displayName} alterado.`,
        changes,
      });
      await appendEvent(tx, actor, {
        type: EVENT_TYPES.EMPLOYEE_UPDATED,
        aggregateType: 'employee',
        aggregateId: id,
        payload: {
          ...employeeEventPayload(updated),
          permissionsChanged: rolesChanged || extraChanged,
        },
      });
      return updated;
    });
    return toEmployeeDto(employee);
  });

  /** Ativa/desativa. Desativar encerra imediatamente todas as sessões do funcionário. */
  app.post('/api/employees/:id/status', { config: { access: MANAGE } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const input = setEmployeeStatusSchema.parse(request.body);
    const auth = request.auth!;
    const employee = await prisma.$transaction(async (tx) => {
      await lockGestorInvariant(tx);
      const before = await getEmployeeOr404(tx, id, true);
      if (before.version !== input.version) throw Errors.versionConflict(before.version);
      if (!input.active && before.userId === auth.userId) {
        throw Errors.business('Você não pode desativar o seu próprio cadastro.');
      }
      const actor = actorFrom(request);
      const updated = await tx.employee.update({
        where: { id, version: input.version },
        data: { active: input.active, version: { increment: 1 } },
        include: employeeInclude,
      });
      await tx.user.update({ where: { id: before.userId }, data: { active: input.active } });
      if (!input.active) {
        await assertActiveGestorRemains(tx);
        await revokeSessions(tx, actor, { userId: before.userId }, 'user_deactivated');
      }
      await audit(tx, actor, {
        action: input.active ? 'employee.activated' : 'employee.deactivated',
        entityType: 'employee',
        entityId: id,
        summary: `${updated.displayName} ${input.active ? 'reativado' : 'desativado'}.`,
      });
      await appendEvent(tx, actor, {
        type: EVENT_TYPES.EMPLOYEE_UPDATED,
        aggregateType: 'employee',
        aggregateId: id,
        payload: employeeEventPayload(updated),
      });
      return updated;
    });
    return toEmployeeDto(employee);
  });

  async function credentialChange(
    request: FastifyRequest,
    id: string,
    apply: (
      tx: Tx,
      before: Awaited<ReturnType<typeof getEmployeeOr404>>,
    ) => Promise<{
      action: string;
      summary: string;
      revokeKind: 'WEB' | 'DEVICE';
      checkGestor?: boolean;
    }>,
  ) {
    return prisma.$transaction(async (tx) => {
      await lockGestorInvariant(tx);
      const before = await getEmployeeOr404(tx, id, true);
      const result = await apply(tx, before);
      const actor = actorFrom(request);
      await tx.user.update({
        where: { id: before.userId },
        data: { credentialsChangedAt: new Date(), version: { increment: 1 } },
      });
      const updated = await tx.employee.update({
        where: { id },
        data: { version: { increment: 1 } },
        include: employeeInclude,
      });
      if (result.checkGestor) await assertActiveGestorRemains(tx);
      // Credencial alterada: sessões daquele tipo deixam de valer (exceto a do próprio gestor que alterou).
      await revokeSessions(
        tx,
        actor,
        {
          userId: before.userId,
          kind: result.revokeKind,
          id: { not: request.auth!.sessionId },
        },
        'credentials_changed',
      );
      await audit(tx, actor, {
        action: result.action,
        entityType: 'employee',
        entityId: id,
        summary: result.summary,
      });
      await appendEvent(tx, actor, {
        type: EVENT_TYPES.EMPLOYEE_UPDATED,
        aggregateType: 'employee',
        aggregateId: id,
        payload: employeeEventPayload(updated),
      });
      return toEmployeeDto(updated);
    });
  }

  app.put('/api/employees/:id/pin', { config: { access: MANAGE } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const { pin } = setPinSchema.parse(request.body);
    const pinHash = await hashSecret(pin);
    return credentialChange(request, id, async (tx, before) => {
      await tx.user.update({ where: { id: before.userId }, data: { pinHash } });
      return {
        action: 'employee.pin_set',
        summary: `PIN de acesso aos tablets definido para ${before.displayName}.`,
        revokeKind: 'DEVICE',
      };
    });
  });

  app.delete('/api/employees/:id/pin', { config: { access: MANAGE } }, async (request) => {
    const { id } = idParams.parse(request.params);
    return credentialChange(request, id, async (tx, before) => {
      await tx.user.update({ where: { id: before.userId }, data: { pinHash: null } });
      return {
        action: 'employee.pin_removed',
        summary: `Acesso aos tablets removido de ${before.displayName}.`,
        revokeKind: 'DEVICE',
      };
    });
  });

  app.put('/api/employees/:id/admin-access', { config: { access: MANAGE } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const input = setAdminCredentialsSchema.parse(request.body);
    const passwordHash = await hashSecret(input.password);
    try {
      return await credentialChange(request, id, async (tx, before) => {
        await tx.user.update({
          where: { id: before.userId },
          data: { email: input.email, passwordHash },
        });
        return {
          action: 'employee.panel_access_set',
          summary: `Acesso ao painel definido para ${before.displayName} (${input.email}).`,
          revokeKind: 'WEB',
        };
      });
    } catch (error) {
      if (isUniqueViolation(error, 'email')) {
        throw Errors.conflict('Já existe um usuário com este e-mail.');
      }
      throw error;
    }
  });

  app.delete('/api/employees/:id/admin-access', { config: { access: MANAGE } }, async (request) => {
    const { id } = idParams.parse(request.params);
    return credentialChange(request, id, async (tx, before) => {
      if (before.userId === request.auth!.userId) {
        throw Errors.business('Você não pode remover o seu próprio acesso ao painel.');
      }
      await tx.user.update({
        where: { id: before.userId },
        data: { email: null, passwordHash: null },
      });
      return {
        action: 'employee.panel_access_removed',
        summary: `Acesso ao painel removido de ${before.displayName}.`,
        revokeKind: 'WEB',
        checkGestor: true,
      };
    });
  });

  /** Foto de identificação (armazenamento privado). Aceita JPEG, PNG ou WebP. */
  app.post('/api/employees/:id/photo', { config: { access: MANAGE } }, async (request) => {
    const { id } = idParams.parse(request.params);
    if (!request.isMultipart())
      throw Errors.unsupportedMedia('Envie a foto como multipart/form-data.');
    const file = await request.file({
      limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 1 },
    });
    if (!file) throw Errors.validation(undefined, 'Nenhum arquivo enviado.');
    const data = await file.toBuffer().catch((error: unknown) => {
      if ((error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE') {
        throw Errors.payloadTooLarge(`A foto deve ter no máximo ${env.MAX_UPLOAD_MB} MB.`);
      }
      throw error;
    });
    const mime = sniffImageType(data);
    if (!mime) throw Errors.unsupportedMedia('Formato não suportado. Envie JPEG, PNG ou WebP.');

    await getEmployeeOr404(prisma, id);
    const fileId = randomUUID();
    const storageKey = `employee-photo/${fileId}`;
    await storage.put(storageKey, data);

    try {
      const { employee, oldFile } = await prisma.$transaction(async (tx) => {
        const before = await getEmployeeOr404(tx, id, true);
        const actor = actorFrom(request);
        await tx.storedFile.create({
          data: {
            id: fileId,
            storageKey,
            purpose: 'employee-photo',
            originalName: (file.filename || 'foto').slice(0, 200),
            mimeType: mime,
            sizeBytes: data.length,
            sha256: sha256Hex(data),
            uploadedById: actor.userId,
          },
        });
        const updated = await tx.employee.update({
          where: { id },
          data: { photoFileId: fileId, version: { increment: 1 } },
          include: employeeInclude,
        });
        let old = null;
        if (before.photoFileId) {
          old = await tx.storedFile.update({
            where: { id: before.photoFileId },
            data: { deletedAt: new Date() },
          });
        }
        await audit(tx, actor, {
          action: 'employee.photo_updated',
          entityType: 'employee',
          entityId: id,
          summary: `Foto de ${updated.displayName} atualizada.`,
        });
        await appendEvent(tx, actor, {
          type: EVENT_TYPES.EMPLOYEE_UPDATED,
          aggregateType: 'employee',
          aggregateId: id,
          payload: employeeEventPayload(updated),
        });
        return { employee: updated, oldFile: old };
      });
      if (oldFile) await storage.remove(oldFile.storageKey).catch(() => undefined);
      return toEmployeeDto(employee);
    } catch (error) {
      await storage.remove(storageKey).catch(() => undefined);
      throw error;
    }
  });

  app.delete('/api/employees/:id/photo', { config: { access: MANAGE } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const { employee, oldFile } = await prisma.$transaction(async (tx) => {
      const before = await getEmployeeOr404(tx, id, true);
      if (!before.photoFileId) return { employee: before, oldFile: null };
      const actor = actorFrom(request);
      const updated = await tx.employee.update({
        where: { id },
        data: { photoFileId: null, version: { increment: 1 } },
        include: employeeInclude,
      });
      const old = await tx.storedFile.update({
        where: { id: before.photoFileId },
        data: { deletedAt: new Date() },
      });
      await audit(tx, actor, {
        action: 'employee.photo_removed',
        entityType: 'employee',
        entityId: id,
        summary: `Foto de ${updated.displayName} removida.`,
      });
      await appendEvent(tx, actor, {
        type: EVENT_TYPES.EMPLOYEE_UPDATED,
        aggregateType: 'employee',
        aggregateId: id,
        payload: employeeEventPayload(updated),
      });
      return { employee: updated, oldFile: old };
    });
    if (oldFile) await storage.remove(oldFile.storageKey).catch(() => undefined);
    return toEmployeeDto(employee);
  });
}
