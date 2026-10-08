import type { FastifyInstance } from 'fastify';

/**
 * Canal WebSocket de tempo real. A autenticação (cookie de sessão + dispositivo)
 * e a verificação de origem acontecem no hook global antes do upgrade.
 */
export async function realtimeRoutes(app: FastifyInstance) {
  const { hub } = app.ctx;

  app.get(
    '/api/realtime',
    { websocket: true, config: { access: { session: 'any' } } },
    (socket, request) => {
      const auth = request.auth!;
      hub.attach(socket, {
        sessionId: auth.sessionId,
        userId: auth.userId,
        kind: auth.kind,
        deviceId: auth.deviceId,
        permissions: auth.permissions,
      });
    },
  );
}
