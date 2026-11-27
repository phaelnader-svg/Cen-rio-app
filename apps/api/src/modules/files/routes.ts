import type { AttachmentEntity } from '@cenario/shared';
import type { PrismaClient, StoredFile } from '@cenario/db';
import type { Readable } from 'node:stream';
import { sanitizeLegacy, thumbnail, type ImageMime } from '../../core/storage/image';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Errors } from '../../lib/errors';
import { VIEW_PERMISSIONS, allowed, viewableAsMeasurementAssignee } from '../attachments/policy';
import { idParams } from '../presenters';

/**
 * Política de acesso a arquivos privados. Cada finalidade define quem pode ler.
 * Arquivos sem política conhecida são negados por padrão.
 */
const READ_POLICIES: Record<
  string,
  (request: FastifyRequest, file: StoredFile, prisma: PrismaClient) => boolean | Promise<boolean>
> = {
  // Fotos de identificação: visíveis a qualquer sessão autenticada (painel e tablets).
  'employee-photo': (request) => request.auth !== null,
  // Item 20 (lista de 53): padrão da casa (foto ou vídeo curto), visto no painel e nos tablets.
  'house-standard': (request) => request.auth !== null,
  // Documentos do escritório do jogo (contratos, notas, comprovantes): financeiro ou pedidos.
  'office-document': (request) =>
    Boolean(
      request.auth &&
        (request.auth.permissions.has('financeiro.ver') ||
          request.auth.permissions.has('pedidos.ver')),
    ),
  // Fotos do fluxo: mesma permissão de leitura do registro ao qual pertencem.
  attachment: async (request, file, prisma) => {
    const a = await prisma.attachment.findUnique({ where: { fileId: file.id } });
    if (!a || a.deletedAt || !request.auth) return false;
    const type = a.entityType as AttachmentEntity;
    return (
      allowed(request.auth.permissions, VIEW_PERMISSIONS[type]) ||
      viewableAsMeasurementAssignee(prisma, request.auth.userId, type, a.entityId)
    );
  },
};

const IMAGE_MIMES = new Set<string>(['image/jpeg', 'image/png', 'image/webp']);

async function toBuffer(stream: Readable) {
  const parts: Buffer[] = [];
  for await (const c of stream) parts.push(c as Buffer);
  return Buffer.concat(parts);
}

const secureHeaders = {
  'cache-control': 'private, max-age=86400, immutable',
  'x-content-type-options': 'nosniff',
  'content-security-policy': "default-src 'none'; sandbox",
};

export async function fileRoutes(app: FastifyInstance) {
  const { prisma, storage } = app.ctx;
  // B3: registro existente cujo arquivo físico sumiu → 404 (antes: 500 "Erro não tratado").
  // Só é chamado DEPOIS de readable(): autenticação e autorização continuam valendo primeiro.
  const ler = async (key: string) => {
    try {
      return await storage.read(key);
    } catch (e) {
      if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') throw Errors.notFound('Arquivo');
      throw e;
    }
  };

  /** Carrega o registro e aplica a política de leitura da finalidade (negado por padrão). */
  async function readable(request: FastifyRequest) {
    const { id } = idParams.parse(request.params);
    const file = await prisma.storedFile.findUnique({ where: { id } });
    if (!file || file.deletedAt) throw Errors.notFound('Arquivo');
    const policy = READ_POLICIES[file.purpose];
    if (!policy || !(await policy(request, file, prisma))) throw Errors.forbidden();
    return file;
  }

  app.get('/api/files/:id', { config: { access: { session: 'any' } } }, async (request, reply) => {
    const file = await readable(request);
    const disposition = `inline; filename="${encodeURIComponent(file.originalName).replace(/"/g, '')}"`;
    // Fase 2: foto anterior ao tratamento sai SEM metadados (EXIF/GPS), sem regravar o original.
    if (!file.processedAt && IMAGE_MIMES.has(file.mimeType)) {
      const { stream } = await ler(file.storageKey);
      const clean = await sanitizeLegacy(await toBuffer(stream), file.mimeType as ImageMime);
      return reply
        .headers(secureHeaders)
        .header('content-type', file.mimeType)
        .header('content-length', clean.length)
        .header('content-disposition', disposition)
        .send(clean);
    }
    // Vídeo do padrão da casa: o Safari do iPad só toca vídeo com pedidos por partes (Range).
    if (file.mimeType.startsWith('video/')) {
      const data = await toBuffer((await ler(file.storageKey)).stream);
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(request.headers.range ?? ''));
      reply
        .headers(secureHeaders)
        .header('content-type', file.mimeType)
        .header('accept-ranges', 'bytes')
        .header('content-disposition', disposition);
      if (m && (m[1] || m[2])) {
        const total = data.length;
        let start = m[1] ? Number(m[1]) : Math.max(0, total - Number(m[2]));
        let end = m[1] && m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
        if (start >= total || start > end) {
          return reply.code(416).header('content-range', `bytes */${total}`).send();
        }
        start = Math.max(0, start);
        end = Math.max(start, end);
        const part = data.subarray(start, end + 1);
        return reply
          .code(206)
          .header('content-range', `bytes ${start}-${end}/${total}`)
          .header('content-length', part.length)
          .send(part);
      }
      return reply.header('content-length', data.length).send(data);
    }
    const { stream, size } = await ler(file.storageKey);
    return reply
      .headers(secureHeaders)
      .header('content-type', file.mimeType)
      .header('content-length', size)
      .header('content-disposition', disposition)
      .send(stream);
  });

  /**
   * Fase 2: miniatura (WebP, sem metadados) para as galerias. Fotos novas: a gerada no envio.
   * Fotos antigas: gerada na leitura, sem gravar nada.
   */
  app.get(
    '/api/files/:id/miniatura',
    { config: { access: { session: 'any' } } },
    async (request, reply) => {
      const file = await readable(request);
      if (!IMAGE_MIMES.has(file.mimeType)) throw Errors.notFound('Miniatura');
      // Miniatura salva ausente mas original presente: gera da original (como nas fotos antigas).
      let salva: Buffer | null = null;
      if (file.thumbKey) {
        try {
          salva = await toBuffer((await ler(file.thumbKey)).stream);
        } catch (e) {
          if ((e as { statusCode?: number }).statusCode !== 404) throw e;
        }
      }
      const data = salva ?? (await thumbnail(await toBuffer((await ler(file.storageKey)).stream)));
      return reply
        .headers(secureHeaders)
        .header('content-type', 'image/webp')
        .header('content-length', data.length)
        .send(data);
    },
  );
}
