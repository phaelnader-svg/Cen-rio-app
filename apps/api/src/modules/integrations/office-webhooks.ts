/**
 * Webhooks dos provedores do escritório (cobranças Asaas, assinatura Clicksign).
 * - Asaas: header `asaas-access-token` igual ao token cadastrado no painel do Asaas.
 * - Clicksign: header `Content-Hmac: sha256=<hex>` (HMAC-SHA256 do corpo com o segredo do webhook).
 * Cada evento é gravado uma única vez (provider + id do evento); repetir a mesma notificação
 * devolve 200 sem processar de novo — é isso que garante uma única baixa por pagamento.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { PrismaClient } from '@cenario/db';
import type { FastifyInstance } from 'fastify';
import { testModeAllowed } from './registry';

export type OfficeWebhookHandler = (
  prisma: PrismaClient,
  payload: Record<string, unknown>,
) => Promise<string>;
const handlers = new Map<string, OfficeWebhookHandler>();
/** Os módulos de cobrança/contratos registram aqui o processamento de cada provedor. */
export function onOfficeWebhook(provider: 'ASAAS' | 'CLICKSIGN', h: OfficeWebhookHandler) {
  handlers.set(provider, h);
}

const same = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
/** No modo de teste local (fora de produção) o segredo é derivado do segredo da aplicação. */
export function officeWebhookSecret(provider: 'ASAAS' | 'CLICKSIGN') {
  const env =
    provider === 'ASAAS' ? process.env.ASAAS_WEBHOOK_TOKEN : process.env.CLICKSIGN_WEBHOOK_SECRET;
  if (env) return env;
  if (testModeAllowed()) return `teste-local:${provider}:${process.env.TOKEN_HASH_SECRET ?? ''}`;
  return null;
}
export const clicksignSignature = (secret: string, raw: Buffer | string) =>
  `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;

const unauthorized = {
  error: { code: 'UNAUTHENTICATED', message: 'Notificação sem autenticação válida.' },
};

export async function officeWebhookRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;

  async function receive(
    provider: 'ASAAS' | 'CLICKSIGN',
    eventId: string,
    payload: Record<string, unknown>,
  ) {
    const created = await prisma.integrationWebhookEvent
      .create({
        data: { providerKey: provider, eventId: eventId.slice(0, 200), payload: payload as never },
      })
      .catch((e: { code?: string }) => {
        if (e.code === 'P2002') return null;
        throw e;
      });
    if (!created) return { received: true, duplicate: true };
    const h = handlers.get(provider);
    const result = h ? await h(prisma as PrismaClient, payload) : 'sem processamento';
    await prisma.integrationWebhookEvent.update({
      where: { id: created.id },
      data: { processedAt: new Date(), result: result.slice(0, 500) },
    });
    return { received: true, duplicate: false, result };
  }

  await app.register(async (sub) => {
    sub.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) =>
      done(null, body),
    );
    sub.post(
      '/api/webhooks/asaas',
      { config: { access: { webhook: true } } },
      async (request, reply) => {
        const secret = officeWebhookSecret('ASAAS');
        const got = request.headers['asaas-access-token'];
        if (!secret || typeof got !== 'string' || !same(got, secret))
          return reply.status(401).send(unauthorized);
        const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.from('{}');
        const payload = JSON.parse(raw.toString('utf8') || '{}') as Record<string, unknown>;
        const pay = (payload.payment ?? {}) as { id?: string };
        const eventId = String(payload.id ?? `${payload.event}:${pay.id}`);
        return receive('ASAAS', eventId, payload);
      },
    );
    sub.post(
      '/api/webhooks/clicksign',
      { config: { access: { webhook: true } } },
      async (request, reply) => {
        const secret = officeWebhookSecret('CLICKSIGN');
        const raw = Buffer.isBuffer(request.body) ? request.body : Buffer.from('{}');
        const got = request.headers['content-hmac'];
        if (!secret || typeof got !== 'string' || !same(got, clicksignSignature(secret, raw)))
          return reply.status(401).send(unauthorized);
        const payload = JSON.parse(raw.toString('utf8') || '{}') as Record<string, unknown>;
        const ev = (payload.event ?? {}) as { name?: string; occurred_at?: string };
        const eventId = createHash('sha256').update(raw).digest('hex');
        void ev;
        return receive('CLICKSIGN', eventId, payload);
      },
    );
  });
}
