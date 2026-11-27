import type { Tx } from '@cenario/db';
import { enqueueEmail, simpleEmail } from './mailer';

/**
 * E-mails de segurança (aprovados pelo dono em 26/11/2026): senha trocada e entrada num aparelho
 * novo. Vão para a própria pessoa, com o que fazer se não foi ela.
 */

/** "Chrome no Android", "Safari no iPhone"… (só para a pessoa reconhecer o aparelho). */
export function describeDevice(ua: string | null | undefined): string {
  const u = ua ?? '';
  const browser = /Edg\//.test(u)
    ? 'Edge'
    : /OPR\//.test(u)
      ? 'Opera'
      : /SamsungBrowser/.test(u)
        ? 'Samsung Internet'
        : /Firefox\//.test(u)
          ? 'Firefox'
          : /Chrome\//.test(u)
            ? 'Chrome'
            : /Safari\//.test(u)
              ? 'Safari'
              : 'navegador';
  const system = /iPhone/.test(u)
    ? 'iPhone'
    : /iPad/.test(u)
      ? 'iPad'
      : /Android/.test(u)
        ? 'Android'
        : /Windows/.test(u)
          ? 'Windows'
          : /Mac OS X|Macintosh/.test(u)
            ? 'Mac'
            : /Linux/.test(u)
              ? 'Linux'
              : 'aparelho';
  return `${browser} no ${system}`;
}

const when = (d: Date) =>
  d.toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    dateStyle: 'short',
    timeStyle: 'short',
  });

export async function sendPasswordChangedEmail(
  tx: Tx,
  user: { email: string | null; displayName: string },
  webUrl: string,
) {
  if (!user.email) return;
  const first = user.displayName.split(/\s+/)[0] ?? '';
  const body = simpleEmail({
    title: 'Sua senha foi trocada',
    paragraphs: [
      `Oi${first ? `, ${first}` : ''}! A senha da sua conta no Cenário Gestão foi trocada em ${when(new Date())}.`,
      'Se foi você, está tudo certo. Se não foi, crie uma senha nova agora pelo "Esqueci minha senha" e avise a gente.',
    ],
    button: { label: 'Entrar no sistema', url: `${webUrl}/entrar` },
  });
  await enqueueEmail(tx, {
    to: user.email,
    subject: 'Sua senha do Cenário Gestão foi trocada',
    kind: 'seguranca-senha',
    ...body,
  });
}

/**
 * Entrada num aparelho novo: avisa quando a pessoa já entrou antes e nunca deste navegador.
 * Chamar ANTES de criar a sessão nova.
 */
export async function maybeSendNewDeviceEmail(
  tx: Tx,
  user: { id: string; email: string | null; displayName: string },
  userAgent: string | null | undefined,
  webUrl: string,
) {
  if (!user.email || !userAgent) return false;
  const before = await tx.session.count({ where: { userId: user.id, kind: 'WEB' } });
  if (before === 0) return false;
  const same = await tx.session.count({
    where: { userId: user.id, kind: 'WEB', userAgent: userAgent.slice(0, 300) },
  });
  if (same > 0) return false;
  const first = user.displayName.split(/\s+/)[0] ?? '';
  const device = describeDevice(userAgent);
  const body = simpleEmail({
    title: 'Entrada num aparelho novo',
    paragraphs: [
      `Oi${first ? `, ${first}` : ''}! Alguém entrou na sua conta do Cenário Gestão pelo ${device} em ${when(new Date())}.`,
      'Se foi você, pode ignorar este e-mail. Se não foi, troque a senha agora em Minha conta (ou pelo "Esqueci minha senha"): os outros aparelhos saem na hora.',
    ],
    button: { label: 'Abrir Minha conta', url: `${webUrl}/painel/conta` },
  });
  await enqueueEmail(tx, {
    to: user.email,
    subject: `Entrada nova na sua conta: ${device}`,
    kind: 'seguranca-aparelho',
    ...body,
  });
  return true;
}
