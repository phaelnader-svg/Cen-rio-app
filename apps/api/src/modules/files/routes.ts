import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { StoredFile } from '@cenario/db';
import { Errors } from '../../lib/errors';
import { idParams } from '../presenters';

/**
 * Política de acesso a arquivos privados. Cada finalidade define quem pode ler.
 * Arquivos sem política conhecida são negados por padrão.
 */
const READ_POLICIES: Record<string, (request: FastifyRequest, file: StoredFile) => boolean> = {
  // Fotos de identificação: visíveis a qualquer sessão autenticada (painel e tablets).
  'employee-photo': (request) => request.auth !== null,
};

export async function fileRoutes(app: FastifyInstance) {
  const { prisma, storage } = app.ctx;

  app.get('/api/files/:id', { config: { access: { session: 'any' } } }, async (request, reply) => {
    const { id } = idParams.parse(request.params);
    const file = await prisma.storedFile.findUnique({ where: { id } });
    if (!file || file.deletedAt) throw Errors.notFound('Arquivo');
    const policy = READ_POLICIES[file.purpose];
    if (!policy || !policy(request, file)) throw Errors.forbidden();
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
