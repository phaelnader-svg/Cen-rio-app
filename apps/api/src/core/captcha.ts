import type { Env } from '../config/env';
import { AppError } from '../lib/errors';
import { ERROR_CODES } from '@cenario/shared';

/**
 * Anti-robô do Criar conta e do "esqueci minha senha" (melhoria 5). Cloudflare Turnstile no modo
 * invisível: a pessoa não vê nada; um robô não consegue o token. Sem TURNSTILE_SECRET_KEY a
 * verificação fica desligada (desenvolvimento e testes) e valem só o campo-isca e os limites.
 */
export type CaptchaVerifier = (token: string | undefined, ip: string) => Promise<boolean>;

export function turnstileVerifier(
  env: Pick<Env, 'TURNSTILE_SECRET_KEY'>,
  fetchImpl: typeof fetch = fetch,
): CaptchaVerifier | null {
  if (!env.TURNSTILE_SECRET_KEY) return null;
  return async (token, ip) => {
    if (!token) return false;
    try {
      const res = await fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          secret: env.TURNSTILE_SECRET_KEY,
          response: token,
          remoteip: ip,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await res.json()) as { success?: boolean };
      return body.success === true;
    } catch {
      // Cloudflare fora do ar: falha fechada (o cadastro tenta de novo em instantes).
      return false;
    }
  };
}

export const captchaFailed = () =>
  new AppError(
    400,
    ERROR_CODES.CAPTCHA_FAILED,
    'Não conseguimos confirmar que você não é um robô. Recarregue a página e tente de novo.',
  );
