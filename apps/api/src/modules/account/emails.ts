import type { PrismaClient, Tx } from '@cenario/db';
import type { Env } from '../../config/env';
import { enqueueEmail, simpleEmail } from '../../core/mailer';
import { randomToken } from '../../lib/crypto';

/** Links por e-mail: confirmar o e-mail (3 dias) e redefinir a senha (1 hora). Uso único. */
export const EMAIL_TOKEN_TTL_MS = {
  CONFIRMAR_EMAIL: 3 * 86_400_000,
  REDEFINIR_SENHA: 60 * 60_000,
} as const;
export type EmailTokenPurpose = keyof typeof EMAIL_TOKEN_TTL_MS;

export const webUrl = (env: Pick<Env, 'PUBLIC_WEB_URL' | 'ALLOWED_ORIGINS'>) =>
  env.PUBLIC_WEB_URL || env.ALLOWED_ORIGINS[0]!;

async function issueToken(
  tx: Tx | PrismaClient,
  hashToken: (t: string) => string,
  user: { id: string; companyId: number },
  purpose: EmailTokenPurpose,
) {
  // Um link válido por vez: os anteriores do mesmo tipo deixam de valer.
  await tx.emailToken.updateMany({
    where: { userId: user.id, purpose, usedAt: null },
    data: { usedAt: new Date() },
  });
  const token = randomToken();
  await tx.emailToken.create({
    data: {
      companyId: user.companyId,
      userId: user.id,
      purpose,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + EMAIL_TOKEN_TTL_MS[purpose]),
    },
  });
  return token;
}

export async function sendConfirmationEmail(
  tx: Tx | PrismaClient,
  env: Env,
  hashToken: (t: string) => string,
  user: { id: string; companyId: number; email: string },
  /** 26/11/2026: no cadastro, o mesmo e-mail dá as boas-vindas e os 3 primeiros passos. */
  welcome?: { name: string; companyName: string },
) {
  const token = await issueToken(tx, hashToken, user, 'CONFIRMAR_EMAIL');
  const url = `${webUrl(env)}/entrar/confirmar?token=${encodeURIComponent(token)}`;
  if (welcome) {
    const first = welcome.name.trim().split(/\s+/)[0] || '';
    await enqueueEmail(tx, {
      to: user.email,
      subject: `Boas-vindas ao Cenário Gestão, ${first || welcome.companyName}`,
      kind: 'boas-vindas',
      ...simpleEmail({
        title: `Boas-vindas, ${first || welcome.companyName}!`,
        paragraphs: [
          `A ${welcome.companyName} já está no Cenário Gestão. Para começar com o pé direito:`,
          '1. Responda as perguntas do começo (uns 3 minutos). Com elas o sistema monta os seus preços, o frete e o horário da oficina.',
          '2. Coloque o preço da sua mão de obra e faça o primeiro orçamento.',
          '3. Cadastre a sua equipe: você digita o nome e o celular, e a pessoa termina o cadastro pelo link.',
          'Antes, confirme que este e-mail é seu no botão abaixo. É por ele que você recupera a senha e recebe os avisos da assinatura.',
        ],
        button: { label: 'Confirmar e-mail e começar', url },
        footer: 'Se não foi você que criou a conta, ignore este e-mail.',
      }),
    });
    return;
  }
  const body = simpleEmail({
    title: 'Confirme o seu e-mail',
    paragraphs: [
      'Boas-vindas ao Cenário Gestão! Falta só confirmar que este e-mail é seu.',
      'É por ele que você recupera a senha e recebe os avisos da assinatura.',
    ],
    button: { label: 'Confirmar e-mail', url },
    footer: 'Se não foi você que criou a conta, ignore este e-mail.',
  });
  await enqueueEmail(tx, {
    to: user.email,
    subject: 'Confirme o seu e-mail — Cenário Gestão',
    kind: 'confirmar-email',
    ...body,
  });
}

export async function sendPasswordResetEmail(
  tx: Tx | PrismaClient,
  env: Env,
  hashToken: (t: string) => string,
  user: { id: string; companyId: number; email: string },
) {
  const token = await issueToken(tx, hashToken, user, 'REDEFINIR_SENHA');
  const url = `${webUrl(env)}/entrar/nova-senha?token=${encodeURIComponent(token)}`;
  const body = simpleEmail({
    title: 'Criar uma senha nova',
    paragraphs: [
      'Recebemos um pedido para trocar a senha da sua conta no Cenário Gestão.',
      'O link vale por 1 hora e só pode ser usado uma vez.',
    ],
    button: { label: 'Criar senha nova', url },
    footer: 'Se não foi você que pediu, ignore este e-mail: a senha atual continua valendo.',
  });
  await enqueueEmail(tx, {
    to: user.email,
    subject: 'Senha nova — Cenário Gestão',
    kind: 'redefinir-senha',
    ...body,
  });
}
