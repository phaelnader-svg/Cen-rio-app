import { ERROR_CODES, type ApiErrorBody } from '@cenario/shared';
import { Prisma } from '@cenario/db';
import type { FastifyError, FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { ZodError } from 'zod';
import { AppError } from '../lib/errors';

function zodDetails(error: ZodError) {
  return error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }));
}

/**
 * Tratamento consistente de erros: toda resposta de erro segue o formato
 * `{ error: { code, message, requestId, details? } }`. Erros inesperados são
 * registrados com detalhes no log, mas o cliente recebe apenas mensagem genérica.
 */
export const errorHandlerPlugin = fp(async (app: FastifyInstance) => {
  app.setErrorHandler((error: FastifyError | Error, request, reply) => {
    const requestId = request.id;
    let status = 500;
    let body: ApiErrorBody['error'] = {
      code: ERROR_CODES.INTERNAL_ERROR,
      message:
        'Erro interno. A equipe técnica pode localizar o ocorrido pelo código da requisição.',
      requestId,
    };

    if (error instanceof AppError) {
      status = error.statusCode;
      body = { code: error.code, message: error.message, requestId, details: error.details };
      if (error.headers) void reply.headers(error.headers);
    } else if (error instanceof ZodError) {
      status = 400;
      body = {
        code: ERROR_CODES.VALIDATION_ERROR,
        message: error.issues[0]?.message ?? 'Dados inválidos.',
        requestId,
        details: zodDetails(error),
      };
    } else if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      status = 409;
      body = { code: ERROR_CODES.CONFLICT, message: 'Registro duplicado.', requestId };
    } else if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2025') {
      status = 404;
      body = { code: ERROR_CODES.NOT_FOUND, message: 'Registro não encontrado.', requestId };
    } else if (
      'statusCode' in error &&
      typeof error.statusCode === 'number' &&
      error.statusCode < 500
    ) {
      status = error.statusCode;
      const map: Record<number, (typeof ERROR_CODES)[keyof typeof ERROR_CODES]> = {
        400: ERROR_CODES.VALIDATION_ERROR,
        401: ERROR_CODES.UNAUTHENTICATED,
        403: ERROR_CODES.FORBIDDEN,
        404: ERROR_CODES.NOT_FOUND,
        413: ERROR_CODES.PAYLOAD_TOO_LARGE,
        415: ERROR_CODES.UNSUPPORTED_MEDIA_TYPE,
        429: ERROR_CODES.RATE_LIMITED,
      };
      body = {
        code: map[status] ?? ERROR_CODES.VALIDATION_ERROR,
        message:
          status === 429
            ? 'Muitas requisições. Aguarde alguns instantes.'
            : status === 413
              ? 'Conteúdo excede o tamanho permitido.'
              : status === 415
                ? 'Formato de conteúdo não suportado.'
                : 'Requisição inválida.',
        requestId,
      };
    }

    if (status >= 500) {
      request.log.error({ err: error }, 'Erro não tratado');
    } else {
      request.log.info({ code: body.code, status }, 'Requisição rejeitada');
    }
    return reply.status(status).send({ error: body } satisfies ApiErrorBody);
  });

  app.setNotFoundHandler((request, reply) => {
    return reply.status(404).send({
      error: {
        code: ERROR_CODES.NOT_FOUND,
        message: 'Rota não encontrada.',
        requestId: request.id,
      },
    } satisfies ApiErrorBody);
  });
});
