import {
  EVENT_TYPES,
  GESTOR_ROLE_KEY,
  PERMISSIONS,
  PERMISSION_GROUPS,
  createRoleSchema,
  isPermission,
  updateRoleSchema,
  type RoleDto,
} from '@cenario/shared';
import { isUniqueViolation, type Role } from '@cenario/db';
import type { FastifyInstance } from 'fastify';
import { actorFrom, audit } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import { lockRow } from '../../core/locking';
import { Errors } from '../../lib/errors';
import { assertCanGrant, idParams } from '../presenters';

const VIEW = { session: 'WEB', permissions: ['funcoes.ver'] } as const;
const MANAGE = { session: 'WEB', permissions: ['funcoes.gerenciar'] } as const;

type RoleWithRelations = Role & {
  permissions: { permission: string }[];
  _count: { users: number };
};

const roleInclude = {
  permissions: { select: { permission: true } },
  _count: { select: { users: true } },
} as const;

function toRoleDto(r: RoleWithRelations): RoleDto {
  return {
    id: r.id,
    key: r.key,
    name: r.name,
    description: r.description,
    system: r.system,
    locked: r.key === GESTOR_ROLE_KEY,
    permissions: r.permissions.map((p) => p.permission).filter(isPermission),
    memberCount: r._count.users,
    version: r.version,
  };
}

function validatePermissions(list: string[]): string[] {
  const unique = [...new Set(list)];
  const invalid = unique.filter((p) => !isPermission(p));
  if (invalid.length)
    throw Errors.validation({ invalid }, `Permissão inexistente: ${invalid.join(', ')}`);
  return unique;
}

export async function roleRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;

  app.get('/api/permissions', { config: { access: VIEW } }, async () => ({
    groups: PERMISSION_GROUPS,
    permissions: Object.entries(PERMISSIONS).map(([key, def]) => ({ key, ...def })),
  }));

  app.get('/api/roles', { config: { access: VIEW } }, async () => {
    const roles = await prisma.role.findMany({
      include: roleInclude,
      orderBy: [{ system: 'desc' }, { name: 'asc' }],
    });
    return roles.map(toRoleDto);
  });

  app.post(
    '/api/roles',
    { config: { access: MANAGE, idempotent: true } },
    async (request, reply) => {
      const input = createRoleSchema.parse(request.body);
      const permissions = validatePermissions(input.permissions);
      assertCanGrant(request.auth!, permissions);
      try {
        const role = await prisma.$transaction(async (tx) => {
          const actor = actorFrom(request);
          const created = await tx.role.create({
            data: {
              name: input.name,
              description: input.description ?? null,
              permissions: { create: permissions.map((permission) => ({ permission })) },
            },
            include: roleInclude,
          });
          await audit(tx, actor, {
            action: 'role.created',
            entityType: 'role',
            entityId: created.id,
            summary: `Função "${created.name}" criada.`,
            changes: { permissions },
          });
          await appendEvent(tx, actor, {
            type: EVENT_TYPES.ROLE_CREATED,
            aggregateType: 'role',
            aggregateId: created.id,
            payload: { id: created.id, name: created.name, version: created.version },
            audience: 'permission:funcoes.ver',
          });
          return created;
        });
        return reply.status(201).send(toRoleDto(role));
      } catch (error) {
        if (isUniqueViolation(error, 'name'))
          throw Errors.conflict('Já existe uma função com este nome.');
        throw error;
      }
    },
  );

  app.put('/api/roles/:id', { config: { access: MANAGE } }, async (request) => {
    const { id } = idParams.parse(request.params);
    const input = updateRoleSchema.parse(request.body);
    const permissions = validatePermissions(input.permissions);
    try {
      const role = await prisma.$transaction(async (tx) => {
        if (!(await lockRow(tx, 'roles', id))) throw Errors.notFound('Função');
        const before = await tx.role.findUniqueOrThrow({ where: { id }, include: roleInclude });
        if (before.version !== input.version) throw Errors.versionConflict(before.version);
        if (before.key === GESTOR_ROLE_KEY) {
          throw Errors.business(
            'A função Gestor é protegida: ela sempre mantém todas as permissões do sistema.',
          );
        }
        const beforePerms = before.permissions.map((p) => p.permission).sort();
        const added = permissions.filter((p) => !beforePerms.includes(p));
        assertCanGrant(request.auth!, added);
        await tx.rolePermission.deleteMany({ where: { roleId: id } });
        await tx.rolePermission.createMany({
          data: permissions.map((permission) => ({ roleId: id, permission })),
        });
        const updated = await tx.role.update({
          where: { id, version: input.version },
          data: {
            name: input.name,
            description: input.description ?? null,
            version: { increment: 1 },
          },
          include: roleInclude,
        });
        const actor = actorFrom(request);
        const afterPerms = [...permissions].sort();
        await audit(tx, actor, {
          action: 'role.updated',
          entityType: 'role',
          entityId: id,
          summary: `Função "${updated.name}" alterada.`,
          changes: {
            ...(before.name !== updated.name
              ? { name: { from: before.name, to: updated.name } }
              : {}),
            ...(before.description !== updated.description
              ? { description: { from: before.description, to: updated.description } }
              : {}),
            ...(JSON.stringify(beforePerms) !== JSON.stringify(afterPerms)
              ? { permissions: { from: beforePerms, to: afterPerms } }
              : {}),
          },
        });
        await appendEvent(tx, actor, {
          type: EVENT_TYPES.ROLE_UPDATED,
          aggregateType: 'role',
          aggregateId: id,
          payload: { id, name: updated.name, version: updated.version },
          audience: 'permission:funcoes.ver',
        });
        return updated;
      });
      return toRoleDto(role);
    } catch (error) {
      if (isUniqueViolation(error, 'name'))
        throw Errors.conflict('Já existe uma função com este nome.');
      throw error;
    }
  });

  app.delete('/api/roles/:id', { config: { access: MANAGE } }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    await prisma.$transaction(async (tx) => {
      if (!(await lockRow(tx, 'roles', id))) throw Errors.notFound('Função');
      const role = await tx.role.findUniqueOrThrow({ where: { id }, include: roleInclude });
      if (role.system) throw Errors.business('Funções padrão do sistema não podem ser excluídas.');
      if (role._count.users > 0) {
        throw Errors.business('Remova a função dos funcionários antes de excluí-la.');
      }
      await tx.role.delete({ where: { id } });
      const actor = actorFrom(request);
      await audit(tx, actor, {
        action: 'role.deleted',
        entityType: 'role',
        entityId: id,
        summary: `Função "${role.name}" excluída.`,
        changes: { permissions: role.permissions.map((p) => p.permission) },
      });
      await appendEvent(tx, actor, {
        type: EVENT_TYPES.ROLE_DELETED,
        aggregateType: 'role',
        aggregateId: id,
        payload: { id, name: role.name },
        audience: 'permission:funcoes.ver',
      });
    });
    return reply.status(204).send();
  });
}
