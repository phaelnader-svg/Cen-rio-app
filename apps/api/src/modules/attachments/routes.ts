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
import { processImage } from '../../core/storage/image';
import { readImageUpload } from '../../core/storage/upload';
import { sha256Hex } from '../../lib/crypto';
import { Errors } from '../../lib/errors';
import { idParams } from '../presenters';
import {
  MANAGE_PERMISSIONS,
  VIEW_PERMISSIONS,
  allowed,
  entityExists,
  uploadableAsTaskAssignee,
  viewableAsMeasurementAssignee,
} from './policy';

/** Melhoria 117: onde cabe recado por áudio. */
const AUDIO_ENTITIES: readonly AttachmentEntity[] = ['PRODUCTION_TASK', 'PRODUCTION_ISSUE'];

/** Formato pelo conteúdo (nunca pelo nome ou pelo tipo informado pelo navegador). */
export function sniffAudio(b: Buffer): string | null {
  if (b.length < 12) return null;
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return 'audio/webm';
  if (b.toString('latin1', 0, 4) === 'OggS') return 'audio/ogg';
  if (b.toString('latin1', 4, 8) === 'ftyp') return 'audio/mp4';
  if (b.toString('latin1', 0, 3) === 'ID3' || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0))
    return 'audio/mpeg';
  return null;
}

const listQuery = z.object({
  entityType: z.enum(ATTACHMENT_ENTITIES),
  entityId: z.guid(),
});
const uploadFields = z.object({
  entityType: z.enum(ATTACHMENT_ENTITIES),
  entityId: z.guid(),
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
        thumbUrl: a.file.mimeType.startsWith('audio/')
          ? `/api/files/${a.fileId}`
          : `/api/files/${a.fileId}/miniatura`,
        width: a.file.width,
        height: a.file.height,
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
      if (
        !allowed(request.auth!.permissions, MANAGE_PERMISSIONS[fields.entityType]) &&
        !(await uploadableAsTaskAssignee(
          prisma,
          request.auth!.userId,
          fields.entityType,
          fields.entityId,
        ))
      )
        throw Errors.forbidden();
      if (!(await entityExists(prisma, fields.entityType, fields.entityId)))
        throw Errors.notFound('Registro');

      // Fase 2: a foto é tratada ANTES de gravar (orientação, sem EXIF/GPS, reduzida, miniatura).
      const image = await processImage(upload.data, upload.mime);
      const fileId = randomUUID();
      const storageKey = `attachment/${fileId}`;
      const thumbKey = `attachment-thumb/${fileId}`;
      await storage.put(storageKey, image.data);
      await storage.put(thumbKey, image.thumb);
      try {
        const created = await prisma.$transaction(async (tx) => {
          const actor = actorFrom(request);
          await tx.storedFile.create({
            data: {
              id: fileId,
              storageKey,
              purpose: 'attachment',
              originalName: upload.filename,
              mimeType: image.mime,
              sizeBytes: image.data.length,
              sha256: sha256Hex(image.data),
              uploadedById: actor.userId,
              processedAt: new Date(),
              width: image.width,
              height: image.height,
              thumbKey,
              thumbSizeBytes: image.thumb.length,
              originalSizeBytes: upload.data.length,
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
            // Quem enviou (ex.: responsável pela tarefa no tablet) também atualiza a galeria.
            audience: `${anyPermissionAudience(...VIEW_PERMISSIONS[fields.entityType])}|user:${request.auth!.userId}`,
          });
          return a;
        });
        return reply.status(201).send({
          id: created.id,
          entityType: created.entityType,
          entityId: created.entityId,
          url: `/api/files/${fileId}`,
          thumbUrl: `/api/files/${fileId}/miniatura`,
          width: image.width,
          height: image.height,
          caption: created.caption,
          mimeType: image.mime,
          createdBy: created.createdBy?.displayName ?? null,
          createdAt: created.createdAt.toISOString(),
        } satisfies AttachmentDto);
      } catch (error) {
        await storage.remove(storageKey).catch(() => undefined);
        await storage.remove(thumbKey).catch(() => undefined);
        throw error;
      }
    },
  );

  /**
   * Melhoria 117: recado por áudio (gravado no tablet) numa tarefa ou ocorrência da produção.
   * O arquivo é guardado como veio (sem tratamento de imagem), só nos formatos de gravação do
   * navegador e com no máximo 5 MB (cerca de 5 minutos).
   */
  app.post(
    '/api/v1/attachments/audio',
    { config: { access: { session: 'any' } } },
    async (request, reply) => {
      if (!request.isMultipart())
        throw Errors.unsupportedMedia('Envie o áudio como multipart/form-data.');
      const file = await request.file({ limits: { fileSize: 5 * 1024 * 1024, files: 1 } });
      if (!file) throw Errors.validation(undefined, 'Nenhum áudio enviado.');
      const data = await file.toBuffer().catch((error: unknown) => {
        if ((error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE')
          throw Errors.payloadTooLarge('O áudio deve ter no máximo 5 minutos.');
        throw error;
      });
      const mime = sniffAudio(data);
      if (!mime) throw Errors.unsupportedMedia('Formato de áudio não suportado.');
      const raw: Record<string, string> = {};
      for (const [key, value] of Object.entries(file.fields)) {
        const v = Array.isArray(value) ? value[0] : value;
        if (v && 'value' in v && typeof v.value === 'string') raw[key] = v.value;
      }
      const fields = uploadFields.parse(raw);
      if (!AUDIO_ENTITIES.includes(fields.entityType))
        throw Errors.validation(undefined, 'Recado por áudio só em tarefas e ocorrências.');
      if (
        !allowed(request.auth!.permissions, MANAGE_PERMISSIONS[fields.entityType]) &&
        !(await uploadableAsTaskAssignee(
          prisma,
          request.auth!.userId,
          fields.entityType,
          fields.entityId,
        ))
      )
        throw Errors.forbidden();
      if (!(await entityExists(prisma, fields.entityType, fields.entityId)))
        throw Errors.notFound('Registro');
      const fileId = randomUUID();
      const storageKey = `attachment/${fileId}`;
      await storage.put(storageKey, data);
      try {
        const created = await prisma.$transaction(async (tx) => {
          const actor = actorFrom(request);
          await tx.storedFile.create({
            data: {
              id: fileId,
              storageKey,
              purpose: 'attachment',
              originalName: `recado.${mime.split('/')[1]}`,
              mimeType: mime,
              sizeBytes: data.length,
              sha256: sha256Hex(data),
              uploadedById: actor.userId,
              processedAt: new Date(),
              originalSizeBytes: data.length,
            },
          });
          const a = await tx.attachment.create({
            data: {
              fileId,
              entityType: fields.entityType,
              entityId: fields.entityId,
              caption: fields.caption || 'Recado por áudio',
              createdById: actor.userId,
            },
            include: { createdBy: { select: { displayName: true } } },
          });
          await audit(tx, actor, {
            action: 'attachment.added',
            entityType: fields.entityType.toLowerCase(),
            entityId: fields.entityId,
            summary: 'Recado por áudio adicionado.',
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
            audience: `${anyPermissionAudience(...VIEW_PERMISSIONS[fields.entityType])}|user:${request.auth!.userId}`,
          });
          return a;
        });
        return reply.status(201).send({
          id: created.id,
          entityType: created.entityType,
          entityId: created.entityId,
          url: `/api/files/${fileId}`,
          thumbUrl: `/api/files/${fileId}`,
          width: null,
          height: null,
          caption: created.caption,
          mimeType: mime,
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
      if (a.file.thumbKey) await storage.remove(a.file.thumbKey).catch(() => undefined);
      return reply.status(204).send();
    },
  );
}
