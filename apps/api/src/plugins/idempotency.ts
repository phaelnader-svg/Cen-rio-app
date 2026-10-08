import { ERROR_CODES } from '@cenario/shared';
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { isUniqueViolation } from '@cenario/db';
import { sha256Hex } from '../lib/crypto';
import { AppError, Errors } from '../lib/errors';

const KEY_PATTERN = /^[A-Za-z0-9_-]{16,100}$/;
const TTL_MS = 24 * 3_600_000;
/** Registro "em andamento" mais antigo que isto é considerado abandonado (ex.: queda do servidor). */
const STALE_IN_PROGRESS_MS = 2 * 60_000;

/**
 * Idempotência para operações sensíveis (rotas com `config.idempotent`).
 *
 * O cliente envia `Idempotency-Key` (gerado uma vez por intenção do usuário).
 * - Repetição com mesma chave e mesmo conteúdo: devolve a resposta original
 *   sem executar de novo (ex.: duplo clique, reenvio após queda de rede).
 * - Mesma chave com conteúdo diferente: 422.
 * - Requisição original ainda em andamento: 409.
 * Respostas de erro liberam a chave para nova tentativa.
 */
export const idempotencyPlugin = fp(async (app: FastifyInstance) => {
  const { prisma } = app.ctx;

  app.addHook('preHandler', async (request, reply) => {
    if (!request.routeOptions.config?.idempotent) return;
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !KEY_PATTERN.test(key)) {
      throw Errors.validation(undefined, 'Cabeçalho Idempotency-Key ausente ou inválido.');
    }
    const userId = request.auth?.userId;
    if (!userId) throw Errors.unauthenticated();
    const scope = `${request.method} ${request.routeOptions.url}`;
    const requestHash = sha256Hex(
      JSON.stringify({ scope, params: request.params, body: request.body ?? null }),
    );

    await prisma.idempotencyKey.deleteMany({
      where: {
        userId,
        key,
        OR: [
          { expiresAt: { lt: new Date() } },
          { responseStatus: null, createdAt: { lt: new Date(Date.now() - STALE_IN_PROGRESS_MS) } },
        ],
      },
    });
    try {
      const created = await prisma.idempotencyKey.create({
        data: { userId, key, scope, requestHash, expiresAt: new Date(Date.now() + TTL_MS) },
      });
      (request as { idempotencyRecordId?: string }).idempotencyRecordId = created.id;
      return;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }

    const existing = await prisma.idempotencyKey.findUnique({
      where: { userId_key: { userId, key } },
    });
    if (!existing) throw Errors.conflict('Requisição em processamento. Tente novamente.');
    if (existing.scope !== scope || existing.requestHash !== requestHash) {
      throw new AppError(
        422,
        ERROR_CODES.IDEMPOTENCY_CONFLICT,
        'Esta chave de idempotência já foi usada com outro conteúdo.',
      );
    }
    if (existing.responseStatus === null) {
      throw Errors.conflict('Requisição idêntica ainda em processamento.');
    }
    void reply.header('idempotent-replayed', 'true');
    return reply.status(existing.responseStatus).send(existing.responseBody);
  });

  app.addHook('onSend', async (request, reply, payload) => {
    const recordId = (request as { idempotencyRecordId?: string }).idempotencyRecordId;
    if (!recordId) return payload;
    if (reply.statusCode >= 200 && reply.statusCode < 300) {
      let body: unknown = null;
      try {
        body = typeof payload === 'string' && payload.length > 0 ? JSON.parse(payload) : null;
      } catch {
        body = null;
      }
      await prisma.idempotencyKey.update({
        where: { id: recordId },
        data: { responseStatus: reply.statusCode, responseBody: body as never },
      });
    } else {
      await prisma.idempotencyKey.delete({ where: { id: recordId } }).catch(() => undefined);
    }
    return payload;
  });
});
