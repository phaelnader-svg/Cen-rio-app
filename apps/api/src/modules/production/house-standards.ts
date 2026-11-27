/**
 * Item 20 (lista de 53, 2026-11-27): padrão da casa no tablet. Para cada etapa da produção, a
 * oficina guarda um texto curto e uma foto ou um vídeo curto de como ela faz. O tapeceiro vê na
 * tarefa, e o novato aprende sem parar o mais experiente.
 */
import {
  PRODUCTION_ACTIVITIES,
  PRODUCTION_ACTIVITY_LABEL,
  houseStandardSchema,
  type HouseStandardDto,
  type ProductionActivity,
} from '@cenario/shared';
import type { PrismaClient, Tx } from '@cenario/db';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { actorFrom, audit } from '../../core/audit';
import { requireCompanyId } from '../../core/tenant';
import { processImage } from '../../core/storage/image';
import { sniffImageType } from '../../core/storage/storage';
import { sha256Hex } from '../../lib/crypto';
import { Errors } from '../../lib/errors';

type Db = Tx | PrismaClient;
const MANAGE = { session: 'WEB', anyPermissions: ['producao.planejar', 'os.gerenciar'] } as const;
const READ = {
  session: 'any',
  anyPermissions: ['producao.ver', 'producao.planejar', 'producao.executar'],
} as const;
/** O Caddy aceita até 10 MB por envio; o vídeo fica um pouco abaixo disso. */
const VIDEO_MAX_MB = 9;

const activityParam = z.object({
  activity: z.enum(
    PRODUCTION_ACTIVITIES as unknown as [ProductionActivity, ...ProductionActivity[]],
  ),
});

/** Vídeo curto do celular: MP4/MOV (caixa "ftyp") ou WebM. */
export function sniffVideoType(
  data: Buffer,
): 'video/mp4' | 'video/quicktime' | 'video/webm' | null {
  if (data.length >= 12 && data.subarray(4, 8).toString('ascii') === 'ftyp') {
    return data.subarray(8, 10).toString('ascii') === 'qt' ? 'video/quicktime' : 'video/mp4';
  }
  if (data.length >= 4 && data.readUInt32BE(0) === 0x1a45dfa3) return 'video/webm';
  return null;
}

async function list(db: Db): Promise<HouseStandardDto[]> {
  const rows = await db.houseStandard.findMany({
    include: {
      file: { select: { id: true, mimeType: true, deletedAt: true } },
      updatedBy: { select: { displayName: true } },
    },
  });
  return rows
    .filter((r) => (r.activity as ProductionActivity) in PRODUCTION_ACTIVITY_LABEL)
    .map((r) => {
      const file = r.file && !r.file.deletedAt ? r.file : null;
      return {
        activity: r.activity,
        label: PRODUCTION_ACTIVITY_LABEL[r.activity as ProductionActivity],
        text: r.text,
        fileId: file?.id ?? null,
        fileUrl: file ? `/api/files/${file.id}` : null,
        mime: file?.mimeType ?? null,
        updatedAt: r.updatedAt.toISOString(),
        updatedByName: r.updatedBy?.displayName ?? null,
      };
    })
    .sort(
      (a, b) =>
        PRODUCTION_ACTIVITIES.indexOf(a.activity as ProductionActivity) -
        PRODUCTION_ACTIVITIES.indexOf(b.activity as ProductionActivity),
    );
}

export async function houseStandardRoutes(app: FastifyInstance) {
  const { prisma, storage, env } = app.ctx;

  app.get('/api/v1/house-standards', { config: { access: READ } }, async () => ({
    items: await list(prisma),
  }));

  app.get('/api/v1/house-standards/:activity', { config: { access: READ } }, async (request) => {
    const { activity } = activityParam.parse(request.params);
    return { item: (await list(prisma)).find((i) => i.activity === activity) ?? null };
  });

  app.put('/api/v1/house-standards/:activity', { config: { access: MANAGE } }, async (request) => {
    const { activity } = activityParam.parse(request.params);
    const input = houseStandardSchema.omit({ activity: true }).strict().parse(request.body);
    const actor = actorFrom(request);
    await prisma.$transaction(async (tx) => {
      if (input.fileId) {
        const f = await tx.storedFile.findUnique({ where: { id: input.fileId } });
        if (!f || f.deletedAt || f.purpose !== 'house-standard')
          throw Errors.business('A foto ou o vídeo não foi encontrado. Envie de novo.');
      }
      const before = await tx.houseStandard.findUnique({
        where: { companyId_activity: { companyId: requireCompanyId(), activity } },
      });
      const fileId = input.fileId === undefined ? (before?.fileId ?? null) : input.fileId;
      if (!input.text.trim() && !fileId) {
        if (before)
          await tx.houseStandard.delete({
            where: { companyId_activity: { companyId: requireCompanyId(), activity } },
          });
      } else {
        await tx.houseStandard.upsert({
          where: { companyId_activity: { companyId: requireCompanyId(), activity } },
          create: { activity, text: input.text.trim(), fileId, updatedById: actor.userId },
          update: { text: input.text.trim(), fileId, updatedById: actor.userId },
        });
      }
      // A foto ou o vídeo trocado sai do armazenamento lógico (continua no histórico).
      if (before?.fileId && before.fileId !== fileId)
        await tx.storedFile.update({
          where: { id: before.fileId },
          data: { deletedAt: new Date() },
        });
      await audit(tx, actor, {
        action: 'house_standard.updated',
        entityType: 'HouseStandard',
        entityId: activity,
        summary: `Padrão da casa — ${PRODUCTION_ACTIVITY_LABEL[activity]} atualizado.`,
        changes: { texto: input.text.trim().length, arquivo: fileId ? 'sim' : 'não' },
      });
    });
    return { item: (await list(prisma)).find((i) => i.activity === activity) ?? null };
  });

  /** Foto (JPEG, PNG, WebP) ou vídeo curto (MP4, MOV, WebM) do padrão da casa. */
  app.post('/api/v1/house-standards/upload', { config: { access: MANAGE } }, async (request) => {
    if (!request.isMultipart())
      throw Errors.unsupportedMedia('Envie a foto ou o vídeo como multipart/form-data.');
    const maxMb = Math.max(env.MAX_UPLOAD_MB, VIDEO_MAX_MB);
    const file = await request.file({ limits: { fileSize: maxMb * 1024 * 1024, files: 1 } });
    if (!file) throw Errors.validation(undefined, 'Nenhum arquivo enviado.');
    const data = await file.toBuffer().catch((error: unknown) => {
      if ((error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE')
        throw Errors.payloadTooLarge(
          `O arquivo deve ter no máximo ${maxMb} MB. Para vídeo, grave uns 15 segundos.`,
        );
      throw error;
    });
    const imageMime = sniffImageType(data);
    const videoMime = imageMime ? null : sniffVideoType(data);
    if (!imageMime && !videoMime)
      throw Errors.unsupportedMedia('Envie uma foto (JPEG, PNG ou WebP) ou um vídeo (MP4 ou MOV).');
    if (imageMime && data.length > env.MAX_UPLOAD_MB * 1024 * 1024)
      throw Errors.payloadTooLarge(`A foto deve ter no máximo ${env.MAX_UPLOAD_MB} MB.`);
    const image = imageMime ? await processImage(data, imageMime, 1600) : null;
    const body = image ? image.data : data;
    const fileId = randomUUID();
    const storageKey = `house-standard/${fileId}`;
    await storage.put(storageKey, body);
    const actor = actorFrom(request);
    await prisma.storedFile.create({
      data: {
        id: fileId,
        storageKey,
        purpose: 'house-standard',
        originalName: (file.filename || (image ? 'foto' : 'video')).slice(0, 200),
        mimeType: image ? image.mime : videoMime!,
        sizeBytes: body.length,
        sha256: sha256Hex(body),
        uploadedById: actor.userId,
        processedAt: new Date(),
        width: image?.width ?? null,
        height: image?.height ?? null,
        originalSizeBytes: data.length,
      },
    });
    return { fileId, fileUrl: `/api/files/${fileId}`, mime: image ? image.mime : videoMime };
  });
}
