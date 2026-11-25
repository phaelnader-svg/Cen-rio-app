import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Errors } from '../../lib/errors';
import { pushKeys } from './push';

/**
 * Só endereços dos serviços de aviso dos navegadores (Google/Android, Apple, Mozilla, Microsoft):
 * o servidor nunca manda nada para um endereço qualquer informado pelo aparelho.
 */
const PUSH_HOSTS = [
  /^fcm\.googleapis\.com$/,
  /^android\.googleapis\.com$/,
  /^web\.push\.apple\.com$/,
  /^[a-z0-9-]+\.push\.apple\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /^[a-z0-9-]+\.push\.services\.mozilla\.com$/,
  /^[a-z0-9-]+\.notify\.windows\.com$/,
];

export function allowedPushEndpoint(raw: string) {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && !u.port && PUSH_HOSTS.some((h) => h.test(u.hostname));
  } catch {
    return false;
  }
}

const subscribeSchema = z.object({
  endpoint: z.string().max(1000).refine(allowedPushEndpoint, 'Endereço de aviso inválido.'),
  keys: z.object({
    p256dh: z.string().min(20).max(200),
    auth: z.string().min(8).max(100),
  }),
});
const unsubscribeSchema = z.object({ endpoint: z.string().max(1000) });

/** Funcionário entrado no aparelho (tablet ou celular). */
const DEVICE = { session: 'DEVICE', surfaceExempt: true } as const;

export async function pushRoutes(app: FastifyInstance) {
  const { prisma, system } = app.ctx;

  /** Chave pública para o aparelho pedir a permissão de avisos ao navegador. */
  app.get('/api/tablet/push', { config: { access: DEVICE } }, async () => {
    const keys = await pushKeys(system);
    return { publicKey: keys.publicKey };
  });

  /**
   * O aparelho aceitou avisos (ou alguém entrou nele): guarda o endereço e de quem são os avisos.
   * Chamado a cada entrada; o mesmo endereço só troca de dono.
   */
  app.put('/api/tablet/push', { config: { access: DEVICE } }, async (request) => {
    const parsed = subscribeSchema.safeParse(request.body);
    if (!parsed.success) throw Errors.validation(parsed.error.issues);
    const auth = request.auth!;
    if (!auth.deviceId) throw Errors.deviceRequired();
    const { endpoint, keys } = parsed.data;
    // Mesmo navegador vinculado antes a outra empresa: o endereço antigo deixa de valer lá.
    await system.pushSubscription.deleteMany({
      where: { endpoint, companyId: { not: auth.companyId } },
    });
    await prisma.pushSubscription.upsert({
      where: { endpoint },
      create: {
        deviceId: auth.deviceId,
        userId: auth.userId,
        endpoint,
        p256dh: keys.p256dh,
        auth: keys.auth,
      },
      update: {
        deviceId: auth.deviceId,
        userId: auth.userId,
        p256dh: keys.p256dh,
        auth: keys.auth,
        lastError: null,
      },
    });
    return { ok: true };
  });

  /** O aparelho desligou os avisos. */
  app.delete('/api/tablet/push', { config: { access: DEVICE } }, async (request) => {
    const { endpoint } = unsubscribeSchema.parse(request.body);
    const deviceId = request.auth!.deviceId;
    if (!deviceId) throw Errors.deviceRequired();
    await prisma.pushSubscription.deleteMany({ where: { endpoint, deviceId } });
    return { ok: true };
  });
}
