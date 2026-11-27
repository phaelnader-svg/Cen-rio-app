import { EVENT_TYPES, hiddenNotificationKinds } from '@cenario/shared';
import type { DomainEvent, PrismaClient, Tx } from '@cenario/db';
import type { FastifyBaseLogger } from 'fastify';
import webpush from 'web-push';
import { shortCustomerName } from '../../core/device-privacy';
import type { EventConsumer } from '../../core/events/processor';
import { moduleState } from '../../core/modules';

/**
 * App instalado (2026-11-25): avisos no celular e no tablet mesmo com o app fechado (Web Push).
 *
 * - As chaves (VAPID) são criadas sozinhas na primeira vez e valem para todas as empresas:
 *   nenhuma empresa nova precisa de passo manual.
 * - Todo aviso gravado por `notify()` publica `notification.created` para o destinatário; o
 *   consumidor abaixo manda o mesmo texto para os aparelhos em que essa pessoa aceitou avisos.
 * - Efeito externo "pelo menos uma vez": uma falha de envio NÃO trava a fila (o aviso continua
 *   na caixa do app); endereço que o navegador desativou (404/410) é apagado.
 */

export interface PushKeys {
  publicKey: string;
  privateKey: string;
}

export interface PushTarget {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushMessage {
  title: string;
  body: string;
  url: string;
  tag: string;
}

/** Envio real (trocado nos testes). */
export const pushSender = {
  async send(target: PushTarget, message: PushMessage, keys: PushKeys, subject: string) {
    await webpush.sendNotification(target, JSON.stringify(message), {
      vapidDetails: { subject, publicKey: keys.publicKey, privateKey: keys.privateKey },
      TTL: 12 * 60 * 60,
      timeout: 5_000,
      urgency: 'high',
    });
  },
};

let cached: PushKeys | null = null;

/** Chaves dos avisos: lidas do banco ou criadas na primeira vez (seguro com várias instâncias). */
export async function pushKeys(system: PrismaClient | Tx): Promise<PushKeys> {
  if (cached) return cached;
  let row = await system.pushKey.findUnique({ where: { id: 1 } });
  if (!row) {
    const fresh = webpush.generateVAPIDKeys();
    await system.pushKey.createMany({
      data: [{ id: 1, publicKey: fresh.publicKey, privateKey: fresh.privateKey }],
      skipDuplicates: true,
    });
    row = await system.pushKey.findUniqueOrThrow({ where: { id: 1 } });
  }
  cached = { publicKey: row.publicKey, privateKey: row.privateKey };
  return cached;
}

/** Só para testes. */
export function resetPushKeyCache() {
  cached = null;
}

export function pushSubject(publicWebUrl: string) {
  return publicWebUrl.startsWith('https://') ? publicWebUrl : 'https://cenariogestao.com.br';
}

const statusOf = (err: unknown) =>
  typeof err === 'object' && err && 'statusCode' in err
    ? Number((err as { statusCode: unknown }).statusCode)
    : 0;

export function pushConsumer(
  system: PrismaClient,
  log: FastifyBaseLogger,
  publicWebUrl: string,
): EventConsumer {
  return {
    name: 'avisos-no-aparelho',
    types: [EVENT_TYPES.NOTIFICATION_CREATED],
    async handle(event: DomainEvent, tx: Tx) {
      const userId = event.aggregateId;
      // App da equipe: só aparelho ainda vinculado. App do dono: o celular do dono (sem aparelho).
      const subs = await tx.pushSubscription.findMany({
        where: { userId, OR: [{ deviceId: null }, { device: { status: 'ACTIVE' } }] },
      });
      if (!subs.length) return;
      const kind = (event.payload as { kind?: string } | null)?.kind;
      const hidden = hiddenNotificationKinds(await moduleState(tx)) as string[];
      if (kind && hidden.includes(kind)) return;
      const n = await tx.notification.findFirst({
        where: { userId, ...(kind ? { kind } : {}), resolvedAt: null },
        orderBy: { createdAt: 'desc' },
        include: { serviceOrder: { select: { customer: { select: { name: true } } } } },
      });
      if (!n) return;
      // Aparelho da equipe: o cliente aparece pela forma reduzida ("Maria F."), igual à caixa do
      // tablet. O dono vê o nome completo, igual ao painel.
      const name = n.serviceOrder?.customer.name;
      const short = name ? n.body.split(name).join(shortCustomerName(name)) : n.body;
      const keys = await pushKeys(system);
      const subject = pushSubject(publicWebUrl);
      for (const s of subs) {
        const owner = s.app === 'DONO';
        const message: PushMessage = {
          title: n.title,
          body: owner ? n.body : short,
          url: owner ? '/dono' : '/tablet',
          tag: n.id,
        };
        try {
          await pushSender.send(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            message,
            keys,
            subject,
          );
          if (s.lastError)
            await tx.pushSubscription.update({ where: { id: s.id }, data: { lastError: null } });
        } catch (err) {
          const status = statusOf(err);
          if (status === 404 || status === 410) {
            await tx.pushSubscription.delete({ where: { id: s.id } });
            continue;
          }
          const text = `${status || ''} ${err instanceof Error ? err.message : String(err)}`;
          log.warn({ err, deviceId: s.deviceId }, 'Aviso no aparelho não foi enviado');
          await tx.pushSubscription.update({
            where: { id: s.id },
            data: { lastError: text.trim().slice(0, 300) },
          });
        }
      }
    },
  };
}

/**
 * Item 43: aviso no celular do dono da plataforma (Web Push), para cada aparelho em que ele ligou
 * os avisos do painel. Falha de envio não trava nada (o e-mail e o painel continuam valendo).
 */
export async function pushPlatformAdmins(
  system: PrismaClient,
  publicWebUrl: string,
  m: { title: string; body: string; url: string; tag: string },
  log?: { warn: (o: unknown, msg: string) => void },
): Promise<number> {
  const subs = await system.platformPushSubscription.findMany({
    where: { admin: { active: true } },
  });
  if (subs.length === 0) return 0;
  const keys = await pushKeys(system);
  let sent = 0;
  for (const s of subs) {
    try {
      await pushSender.send(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        m,
        keys,
        pushSubject(publicWebUrl),
      );
      sent++;
      await system.platformPushSubscription.update({
        where: { id: s.id },
        data: { lastUsedAt: new Date() },
      });
    } catch (err) {
      const status =
        typeof err === 'object' && err && 'statusCode' in err
          ? Number((err as { statusCode: unknown }).statusCode)
          : 0;
      if (status === 404 || status === 410)
        await system.platformPushSubscription
          .delete({ where: { id: s.id } })
          .catch(() => undefined);
      else log?.warn({ err }, 'Aviso no celular do painel não foi enviado');
    }
  }
  return sent;
}
