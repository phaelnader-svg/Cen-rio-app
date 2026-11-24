import { safeEqual } from '../lib/crypto';

/**
 * Links públicos para o cliente da tapeçaria (melhorias 79, 82 e 130): proposta para aprovar,
 * álbum de fotos e a retirada (só para ver; desde 2026-11-24 o cliente não escolhe o dia).
 *
 * O link leva o id do registro e uma assinatura (HMAC com o segredo do servidor). Nada é gravado:
 * o mesmo link pode ser copiado de novo a qualquer momento, e quem não tem o link certo não chega
 * a nada (96 bits de assinatura). O tipo entra na assinatura, então o link de um álbum nunca abre
 * uma proposta com o mesmo id.
 */
export type PublicLinkKind = 'proposta' | 'album' | 'agendar';

export function publicLinkSignature(
  hashToken: (token: string) => string,
  kind: PublicLinkKind,
  id: string,
): string {
  return hashToken(`link-publico:${kind}:${id}`).slice(0, 24);
}

export function validPublicLink(
  hashToken: (token: string) => string,
  kind: PublicLinkKind,
  id: string,
  signature: string | undefined,
): boolean {
  if (!signature || !/^[0-9a-f]{24}$/.test(signature)) return false;
  return safeEqual(publicLinkSignature(hashToken, kind, id), signature);
}

/** Endereço público do sistema (o domínio que o cliente abre). */
export function publicWebUrl(env: { PUBLIC_WEB_URL: string; ALLOWED_ORIGINS: string[] }): string {
  return (env.PUBLIC_WEB_URL || env.ALLOWED_ORIGINS[0] || '').replace(/\/$/, '');
}

export function publicLink(
  env: { PUBLIC_WEB_URL: string; ALLOWED_ORIGINS: string[] },
  hashToken: (token: string) => string,
  kind: PublicLinkKind,
  id: string,
): string {
  return `${publicWebUrl(env)}/${kind}/${id}?t=${publicLinkSignature(hashToken, kind, id)}`;
}
