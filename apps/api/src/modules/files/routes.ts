import type { AttachmentEntity } from '@cenario/shared';
import type { PrismaClient, StoredFile } from '@cenario/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Errors } from '../../lib/errors';
import { VIEW_PERMISSIONS, allowed } from '../attachments/policy';
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
  // Fotos do fluxo: mesma permissão de leitura do registro ao qual pertencem.
  attachment: async (request, file, prisma) => {
    const a = await prisma.attachment.findUnique({ where: { fileId: file.id } });
    if (!a || a.deletedAt || !request.auth) return false;
    return allowed(request.auth.permissions, VIEW_PERMISSIONS[a.entityType as AttachmentEntity]);
  },
};

export async function fileRoutes(app: FastifyInstance) {
  const { prisma, storage } = app.ctx;

  app.get('/api/files/:id', { config: { access: { session: 'any' } } }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const file = await prisma.storedFile.findUnique({ where: { id } });
    if (!file || file.deletedAt) throw Errors.notFound('Arquivo');
    const policy = READ_POLICIES[file.purpose];
    if (!policy || !(await policy(request, file, prisma))) throw Errors.forbidden();
    const { stream, size } = await storage.read(file.storageKey);
    return reply
      .header('content-type', file.mimeType)
      .header('content-length', size)
      .header('cache-control', 'private, max-age=86400, immutable')
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header(
        'content-disposition',
        `inline; filename="${encodeURIComponent(file.originalName).replace(/"/g, '')}"`,
      )
      .send(stream);
  });
}
