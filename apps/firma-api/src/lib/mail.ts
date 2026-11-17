import type { PrismaClient } from '@firma/db';
import type { FastifyBaseLogger } from 'fastify';
import type { Env } from '../env';

/**
 * E-mails transacionais (convite, recuperação de senha). Ficam registrados na caixa de saída e
 * são enviados pelo Resend (decisão do dono, 2026-11-17) em segundo plano, com novas tentativas.
 * Sem RESEND_API_KEY ficam só na caixa de saída; fora de produção o link também vai para o log.
 */
export async function sendMail(
  db: PrismaClient,
  env: Env,
  log: FastifyBaseLogger,
  mail: { to: string; subject: string; body: string; link: string },
) {
  await db.outboxMail.create({ data: mail });
  if (env.FIRMA_APP_ENV !== 'production') log.info({ to: mail.to, link: mail.link }, mail.subject);
  kickOutbox(db, env, log);
}

const RETRY_MINUTES = [1, 5, 15, 60, 180, 360, 720, 1440];
let running = false;

/** Envia o que estiver pendente na caixa de saída. Devolve quantos saíram. */
export async function drainOutbox(
  db: PrismaClient,
  env: Pick<Env, 'RESEND_API_KEY' | 'FIRMA_EMAIL_FROM'>,
  log: FastifyBaseLogger,
  fetchImpl: typeof fetch = fetch,
  now = new Date(),
): Promise<number> {
  if (!env.RESEND_API_KEY || running) return 0;
  running = true;
  let sent = 0;
  try {
    const batch = await db.outboxMail.findMany({
      where: { sentAt: null, nextTryAt: { lte: now }, attempts: { lt: RETRY_MINUTES.length } },
      orderBy: { createdAt: 'asc' },
      take: 20,
    });
    for (const m of batch) {
      try {
        const text = m.link ? `${m.body}\n\n${m.link}` : m.body;
        const res = await fetchImpl('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            authorization: `Bearer ${env.RESEND_API_KEY}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({
            from: env.FIRMA_EMAIL_FROM,
            to: [m.to],
            subject: m.subject,
            text,
          }),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok)
          throw new Error(`Resend respondeu ${res.status}: ${(await res.text()).slice(0, 300)}`);
        await db.outboxMail.update({
          where: { id: m.id },
          data: { sentAt: new Date(), attempts: { increment: 1 }, lastError: null },
        });
        sent++;
      } catch (err) {
        const attempts = m.attempts + 1;
        const wait = RETRY_MINUTES[Math.min(attempts, RETRY_MINUTES.length) - 1]!;
        await db.outboxMail.update({
          where: { id: m.id },
          data: {
            attempts,
            lastError: String((err as Error).message ?? err).slice(0, 500),
            nextTryAt: new Date(Date.now() + wait * 60_000),
          },
        });
        log.warn({ err, attempts }, 'Falha ao enviar e-mail');
      }
    }
  } finally {
    running = false;
  }
  return sent;
}

export function kickOutbox(db: PrismaClient, env: Env, log: FastifyBaseLogger) {
  void drainOutbox(db, env, log).catch((err: unknown) => log.warn({ err }, 'Caixa de saída'));
}
