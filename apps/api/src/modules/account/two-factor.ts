import { totpCodeSchema } from '@cenario/shared';
import type { FastifyInstance } from 'fastify';
import { actorFrom, audit } from '../../core/audit';
import { revokeSessions } from '../../core/sessions';
import { AuthThrottle, POLICIES } from '../../core/throttle';
import { Errors } from '../../lib/errors';
import {
  newRecoveryCodes,
  newTotpSecret,
  normalizeRecovery,
  openSecret,
  otpauthUrl,
  sealSecret,
  verifyTotp,
} from '../../lib/totp';

/**
 * Melhoria 98: verificação em duas etapas opcional (tela Minha conta). Ligar: o sistema gera o
 * segredo, a pessoa lê o QR Code no aplicativo do celular e confirma com um código; recebe 8
 * códigos de recuperação. Desligar exige um código válido. Ligar ou desligar encerra as outras
 * sessões da pessoa.
 */
export async function twoFactorRoutes(app: FastifyInstance) {
  const { prisma, env, hashToken } = app.ctx;
  const throttle = new AuthThrottle(prisma);
  const access = { session: 'WEB' } as const;

  app.post('/api/v1/account/2fa/setup', { config: { access } }, async (request) => {
    const auth = request.auth!;
    if (auth.app) throw Errors.forbidden();
    const user = await prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
    if (user.supportAgent) throw Errors.forbidden('O suporte não altera a verificação da empresa.');
    if (user.totpEnabledAt) throw Errors.business('A verificação em duas etapas já está ligada.');
    const secret = newTotpSecret();
    await prisma.user.update({
      where: { id: user.id },
      data: { totpSecret: sealSecret(env.TOKEN_HASH_SECRET, secret) },
    });
    return {
      secret,
      otpauthUrl: otpauthUrl(secret, user.email ?? user.displayName),
    };
  });

  app.post('/api/v1/account/2fa/enable', { config: { access } }, async (request) => {
    const auth = request.auth!;
    const { code } = totpCodeSchema.parse(request.body);
    const key = `2fa-setup:${auth.userId}`;
    await throttle.assertAllowed([key]);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
    if (user.totpEnabledAt) throw Errors.business('A verificação em duas etapas já está ligada.');
    if (!user.totpSecret) throw Errors.business('Comece de novo pelo botão "Ligar".');
    if (!verifyTotp(openSecret(env.TOKEN_HASH_SECRET, user.totpSecret), code)) {
      await throttle.registerFailure(key, POLICIES.account);
      throw Errors.business('Código incorreto. Confira o horário do celular e tente de novo.');
    }
    await throttle.reset(key);
    const codes = newRecoveryCodes();
    await prisma.$transaction(async (tx) => {
      const actor = actorFrom(request);
      await tx.user.update({
        where: { id: user.id },
        data: {
          totpEnabledAt: new Date(),
          totpRecoveryHashes: codes.map((c) => hashToken(`recuperacao:${normalizeRecovery(c)}`)),
          credentialsChangedAt: new Date(),
        },
      });
      await revokeSessions(
        tx,
        actor,
        { userId: user.id, kind: 'WEB', id: { not: auth.sessionId } },
        'credentials_changed',
      );
      await audit(tx, actor, {
        action: 'auth.2fa_enabled',
        entityType: 'user',
        entityId: user.id,
        summary: `${user.displayName} ligou a verificação em duas etapas.`,
      });
    });
    return { recoveryCodes: codes };
  });

  app.post('/api/v1/account/2fa/disable', { config: { access } }, async (request, reply) => {
    const auth = request.auth!;
    const { code } = totpCodeSchema.parse(request.body);
    const key = `2fa-setup:${auth.userId}`;
    await throttle.assertAllowed([key]);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: auth.userId } });
    if (!user.totpEnabledAt || !user.totpSecret)
      throw Errors.business('A verificação em duas etapas não está ligada.');
    const ok =
      verifyTotp(openSecret(env.TOKEN_HASH_SECRET, user.totpSecret), code) ||
      user.totpRecoveryHashes.includes(hashToken(`recuperacao:${normalizeRecovery(code)}`));
    if (!ok) {
      await throttle.registerFailure(key, POLICIES.account);
      throw Errors.business('Código incorreto.');
    }
    await throttle.reset(key);
    await prisma.$transaction(async (tx) => {
      await tx.user.update({
        where: { id: user.id },
        data: { totpEnabledAt: null, totpSecret: null, totpRecoveryHashes: [] },
      });
      await audit(tx, actorFrom(request), {
        action: 'auth.2fa_disabled',
        entityType: 'user',
        entityId: user.id,
        summary: `${user.displayName} desligou a verificação em duas etapas.`,
      });
    });
    return reply.status(204).send();
  });
}
