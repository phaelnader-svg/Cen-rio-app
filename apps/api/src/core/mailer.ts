import type { PrismaClient, Tx } from '@cenario/db';
import type { FastifyBaseLogger } from 'fastify';
import type { Env } from '../config/env';

/**
 * E-mails do sistema (confirmar e-mail, redefinir senha, assinatura). Melhorias 3 e 4.
 *
 * Todo e-mail entra primeiro numa fila no banco (`outbound_emails`), na mesma transação que o
 * originou: se a transação desfaz, nada é enviado; se o envio falha, ele é tentado de novo depois
 * (1, 5, 15, 60 minutos… até 8 vezes). O envio é pelo Resend (decisão do dono, 2026-11-17).
 * Sem RESEND_API_KEY, os e-mails ficam na fila (desenvolvimento e testes).
 */
export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  kind: string;
}

export async function enqueueEmail(tx: Tx | PrismaClient, msg: EmailMessage) {
  await tx.outboundEmail.create({
    data: {
      to: msg.to,
      subject: msg.subject.slice(0, 200),
      text: msg.text,
      html: msg.html ?? null,
      kind: msg.kind,
    },
  });
}

const RETRY_MINUTES = [1, 5, 15, 60, 180, 360, 720, 1440];
export const MAX_EMAIL_ATTEMPTS = RETRY_MINUTES.length;
const STALE_MS = 24 * 3_600_000;

export type EmailTransport = (msg: {
  from: string;
  to: string;
  subject: string;
  text: string;
  html?: string;
}) => Promise<void>;

/** Resend (https://resend.com/docs/api-reference/emails/send-email). */
export function resendTransport(apiKey: string, fetchImpl: typeof fetch = fetch): EmailTransport {
  return async (msg) => {
    const res = await fetchImpl('https://api.resend.com/emails', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        from: msg.from,
        to: [msg.to],
        subject: msg.subject,
        text: msg.text,
        ...(msg.html ? { html: msg.html } : {}),
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`Resend respondeu ${res.status}: ${body.slice(0, 300)}`);
    }
  };
}

export class EmailSender {
  private running = false;
  private again = false;
  constructor(
    private readonly system: PrismaClient,
    private readonly env: Pick<Env, 'RESEND_API_KEY' | 'EMAIL_FROM'>,
    private readonly log: FastifyBaseLogger,
    private transport: EmailTransport | null = env.RESEND_API_KEY
      ? resendTransport(env.RESEND_API_KEY)
      : null,
  ) {}

  get configured() {
    return this.transport !== null;
  }

  /** Para testes: troca o envio real por um falso. */
  useTransport(t: EmailTransport | null) {
    this.transport = t;
  }

  /** Envia o que estiver na fila (uma execução por vez; pedidos durante a execução repetem). */
  async drain(now = new Date()): Promise<number> {
    if (!this.transport) return 0;
    if (this.running) {
      this.again = true;
      return 0;
    }
    this.running = true;
    let sent = 0;
    try {
      do {
        this.again = false;
        // E-mail que ficou na fila mais de um dia sem nenhuma tentativa (por exemplo, gravado antes
        // de existir a chave do Resend) não sai mais: o link dele já venceu ou perdeu o sentido.
        await this.system.outboundEmail.updateMany({
          where: {
            sentAt: null,
            attempts: 0,
            createdAt: { lt: new Date(now.getTime() - STALE_MS) },
          },
          data: {
            attempts: MAX_EMAIL_ATTEMPTS,
            lastError: 'Descartado: ficou mais de um dia na fila sem envio.',
          },
        });
        const batch = await this.system.outboundEmail.findMany({
          where: { sentAt: null, nextTryAt: { lte: now }, attempts: { lt: MAX_EMAIL_ATTEMPTS } },
          orderBy: { createdAt: 'asc' },
          take: 20,
        });
        for (const m of batch) {
          try {
            await this.transport({
              from: this.env.EMAIL_FROM,
              to: m.to,
              subject: m.subject,
              text: m.text,
              html: m.html ?? undefined,
            });
            await this.system.outboundEmail.update({
              where: { id: m.id },
              data: { sentAt: new Date(), attempts: { increment: 1 }, lastError: null },
            });
            sent++;
          } catch (err) {
            const attempts = m.attempts + 1;
            const wait = RETRY_MINUTES[Math.min(attempts, RETRY_MINUTES.length) - 1]!;
            await this.system.outboundEmail.update({
              where: { id: m.id },
              data: {
                attempts,
                lastError: String((err as Error).message ?? err).slice(0, 500),
                nextTryAt: new Date(Date.now() + wait * 60_000),
              },
            });
            this.log.warn({ err, kind: m.kind, attempts }, 'Falha ao enviar e-mail');
          }
        }
        if (batch.length === 20) this.again = true;
      } while (this.again);
    } finally {
      this.running = false;
    }
    return sent;
  }

  /** Dispara um envio sem esperar (depois de gravar um e-mail na fila). */
  kick() {
    void this.drain().catch((err: unknown) => this.log.warn({ err }, 'Falha na fila de e-mails'));
  }
}

const esc = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
  );

/** Modelo simples de e-mail: título, parágrafos e um botão. Versão texto junto. */
export function simpleEmail(opts: {
  title: string;
  paragraphs: string[];
  button?: { label: string; url: string };
  footer?: string;
}): { text: string; html: string } {
  const text = [
    opts.title,
    '',
    ...opts.paragraphs,
    ...(opts.button ? ['', `${opts.button.label}: ${opts.button.url}`] : []),
    '',
    opts.footer ?? 'Cenário Gestão',
  ].join('\n');
  // Melhoria 142: e-mail com a cara do sistema (logo do sofá, verde da marca, fundo do painel).
  // A logo vem do próprio site (o mesmo endereço do botão); sem botão, só o nome.
  let logo = '';
  try {
    if (opts.button) logo = `${new URL(opts.button.url).origin}/icon-192.png`;
  } catch {
    logo = '';
  }
  const brand = `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 20px"><tr>${
    logo
      ? `<td style="padding-right:10px"><img src="${esc(logo)}" width="36" height="36" alt="" style="display:block;border-radius:9px"></td>`
      : ''
  }<td style="font-size:15px;font-weight:600;color:#064a4b">Cenário Gestão</td></tr></table>`;
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f5f2;font-family:Inter,'Segoe UI',Roboto,Arial,sans-serif;color:#1d2523">
<div style="max-width:520px;margin:0 auto">
${brand}
<div style="background:#fff;border:1px solid #e4e1da;border-radius:14px;padding:28px">
<h1 style="font-size:20px;line-height:1.3;margin:0 0 16px;color:#1d2523">${esc(opts.title)}</h1>
${opts.paragraphs.map((p) => `<p style="font-size:15px;line-height:1.55;margin:0 0 12px;color:#4a5552">${esc(p)}</p>`).join('\n')}
${opts.button ? `<p style="margin:24px 0"><a href="${esc(opts.button.url)}" style="background:#064a4b;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:600;display:inline-block">${esc(opts.button.label)}</a></p><p style="font-size:12px;color:#7a8481;word-break:break-all">Se o botão não abrir, copie este endereço: ${esc(opts.button.url)}</p>` : ''}
</div>
<p style="font-size:12px;color:#7a8481;margin:16px 4px 0">${esc(opts.footer ?? 'Cenário Gestão')}</p>
</div></body></html>`;
  return { text, html };
}
