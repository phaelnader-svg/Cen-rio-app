import type { PrismaClient } from '@firma/db';
import type { FastifyBaseLogger } from 'fastify';
import type { Env } from '../env';

/**
 * E-mails transacionais (convite, recuperação de senha). Ficam registrados na caixa de saída;
 * fora de produção o link também vai para o log e para a consulta de desenvolvimento.
 * Em produção, um provedor de e-mail precisa ler a caixa de saída (ver docs/FIRMA-VIVA.md).
 */
export async function sendMail(
  db: PrismaClient,
  env: Env,
  log: FastifyBaseLogger,
  mail: { to: string; subject: string; body: string; link: string },
) {
  await db.outboxMail.create({ data: mail });
  if (env.FIRMA_APP_ENV !== 'production') log.info({ to: mail.to, link: mail.link }, mail.subject);
}
