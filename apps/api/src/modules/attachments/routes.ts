import {
  ATTACHMENT_ENTITIES,
  EVENT_TYPES,
  anyPermissionAudience,
  type AttachmentDto,
  type AttachmentEntity,
} from '@cenario/shared';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { actorFrom, audit } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import { readImageUpload } from '../../core/storage/upload';
import { sha256Hex } from '../../lib/crypto';
import { Errors } from '../../lib/errors';
import { idParams } from '../presenters';
import {
  MANAGE_PERMISSIONS,
  VIEW_PERMISSIONS,
  allowed,
  entityExists,
  viewableAsMeasurementAssignee,
} from './policy';

const listQuery = z.object({
  entityType: z.enum(ATTACHMENT_ENTITIES),
  entityId: z.string().uuid(),
});
const uploadFields = z.object({
  entityType: z.enum(ATTACHMENT_ENTITIES),
  entityId: z.string().uuid(),
  caption: z.string().trim().max(200).optional(),
});

/**
 * Fotografias dos registros do fluxo (pedido, retirada, recebimento, OS).
 * Arquivos ficam no armazenamento privado; a leitura passa pela rota
 * /api/files/:id, que aplica a mesma política por tipo de registro.
 */
export async function attachmentRoutes(app: FastifyInstance) {
  const { prisma, storage, env } = app.ctx;

  app.get('/api/v1/attachments', { config: { access: { session: 'any' } } }, async (request) => {
    const q = listQuery.parse(request.query);
    if (
      !allowed(request.auth!.permissions, VIEW_PERMISSIONS[q.entityType]) &&
      !(await viewableAsMeasurementAssignee(prisma, request.auth!.userId, q.entityType, q.entityId))
    ) {
      throw Errors.forbidden();
    }
    const rows = await prisma.attachment.findMany({
      where: { entityType: q.entityType, entityId: q.entityId, deletedAt: null },
      include: { file: true, createdBy: { select: { displayName: true } } },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map(
      (a): AttachmentDto => ({
        id: a.id,
        entityType: a.entityType,
        entityId: a.entityId,
        url: `/api/files/${a.fileId}`,
        caption: a.caption,
        mimeType: a.file.mimeType,
        createdBy: a.createdBy?.displayName ?? null,
        createdAt: a.createdAt.toISOString(),
      }),
    );
  });

  app.post(
    '/api/v1/attachments',
    { config: { access: { session: 'any' } } },
    async (request, reply) => {
      const upload = await readImageUpload(request, env.MAX_UPLOAD_MB);
      const fields = uploadFields.parse(upload.fields);
      if (!allowed(request.auth!.permissions, MANAGE_PERMISSIONS[fields.entityType]))
        throw Errors.forbidden();
      if (!(await entityExists(prisma, fields.entityType, fields.entityId)))
        throw Errors.notFound('Registro');

      const fileId = randomUUID();
      const storageKey = `attachment/${fileId}`;
      await storage.put(storageKey, upload.data);
      try {
        const created = await prisma.$transaction(async (tx) => {
          const actor = actorFrom(request);
          await tx.storedFile.create({
            data: {
              id: fileId,
              storageKey,
              purpose: 'attachment',
              originalName: upload.filename,
              mimeType: upload.mime,
              sizeBytes: upload.data.length,
              sha256: sha256Hex(upload.data),
              uploadedById: actor.userId,
            },
          });
          const a = await tx.attachment.create({
            data: {
              fileId,
              entityType: fields.entityType,
              entityId: fields.entityId,
              caption: fields.caption || null,
              createdById: actor.userId,
            },
            include: { createdBy: { select: { displayName: true } } },
          });
          await audit(tx, actor, {
            action: 'attachment.added',
            entityType: fields.entityType.toLowerCase(),
            entityId: fields.entityId,
            summary: `Foto adicionada${fields.caption ? `: ${fields.caption}` : ''}.`,
          });
          await appendEvent(tx, actor, {
            type: EVENT_TYPES.ATTACHMENT_CHANGED,
            aggregateType: fields.entityType.toLowerCase(),
            aggregateId: fields.entityId,
            payload: {
              entityType: fields.entityType,
              entityId: fields.entityId,
              attachmentId: a.id,
            },
            audience: anyPermissionAudience(...VIEW_PERMISSIONS[fields.entityType]),
          });
          return a;
        });
        return reply.status(201).send({
          id: created.id,
          entityType: created.entityType,
          entityId: created.entityId,
          url: `/api/files/${fileId}`,
          caption: created.caption,
          mimeType: upload.mime,
          createdBy: created.createdBy?.displayName ?? null,
          createdAt: created.createdAt.toISOString(),
        } satisfies AttachmentDto);
      } catch (error) {
        await storage.remove(storageKey).catch(() => undefined);
        throw error;
      }
    },
  );

  app.delete(
    '/api/v1/attachments/:id',
    { config: { access: { session: 'any' } } },
    async (request, reply) => {
      const { id } = idParams.parse(request.params);
      const a = await prisma.attachment.findUnique({ where: { id }, include: { file: true } });
      if (!a || a.deletedAt) throw Errors.notFound('Foto');
      if (
        !allowed(request.auth!.permissions, MANAGE_PERMISSIONS[a.entityType as AttachmentEntity])
      ) {
        throw Errors.forbidden();
      }
      await prisma.$transaction(async (tx) => {
        const actor = actorFrom(request);
        await tx.attachment.update({ where: { id }, data: { deletedAt: new Date() } });
        await tx.storedFile.update({ where: { id: a.fileId }, data: { deletedAt: new Date() } });
        await audit(tx, actor, {
          action: 'attachment.removed',
          entityType: a.entityType.toLowerCase(),
          entityId: a.entityId,
          summary: 'Foto removida.',
        });
        await appendEvent(tx, actor, {
          type: EVENT_TYPES.ATTACHMENT_CHANGED,
          aggregateType: a.entityType.toLowerCase(),
          aggregateId: a.entityId,
          payload: {
            entityType: a.entityType,
            entityId: a.entityId,
            attachmentId: id,
            removed: true,
          },
          audience: anyPermissionAudience(...VIEW_PERMISSIONS[a.entityType as AttachmentEntity]),
        });
      });
      await storage.remove(a.file.storageKey).catch(() => undefined);
      return reply.status(204).send();
    },
  );
}
