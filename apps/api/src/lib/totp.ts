import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { safeEqual } from './crypto';

/**
 * Melhoria 98: verificação em duas etapas por código no celular (TOTP, RFC 6238), compatível com
 * Google Authenticator, Microsoft Authenticator e semelhantes. Sem dependência externa.
 *
 * O segredo de cada pessoa é guardado cifrado (AES-256-GCM) com uma chave derivada do segredo do
 * servidor: uma cópia do banco sozinha não permite gerar códigos.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=]/g, '').toUpperCase();
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error('base32 inválido');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

export function hotp(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac('sha1', secret).update(msg).digest();
  const offset = h[h.length - 1]! & 0xf;
  const code = (h.readUInt32BE(offset) & 0x7fffffff) % 1_000_000;
  return String(code).padStart(6, '0');
}

/** Confere o código aceitando 30 s de diferença no relógio do celular (janela ±1). */
export function verifyTotp(secretBase32: string, code: string, now = Date.now()): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const secret = base32Decode(secretBase32);
  const step = Math.floor(now / 30_000);
  return [-1, 0, 1].some((d) => safeEqual(hotp(secret, step + d), code));
}

export function newTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function otpauthUrl(secretBase32: string, account: string, issuer = 'Cenário Gestão') {
  const label = encodeURIComponent(`${issuer}:${account}`);
  return `otpauth://totp/${label}?secret=${secretBase32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

const keyOf = (serverSecret: string) =>
  createHash('sha256').update(`totp-chave:${serverSecret}`).digest();

export function sealSecret(serverSecret: string, plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', keyOf(serverSecret), iv);
  const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `v1.${iv.toString('base64url')}.${data.toString('base64url')}.${c.getAuthTag().toString('base64url')}`;
}

export function openSecret(serverSecret: string, sealed: string): string {
  const [v, iv, data, tag] = sealed.split('.');
  if (v !== 'v1' || !iv || !data || !tag) throw new Error('segredo inválido');
  const d = createDecipheriv('aes-256-gcm', keyOf(serverSecret), Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
}

/** Códigos de recuperação: 8 códigos "XXXX-XXXX", cada um vale uma vez. */
export function newRecoveryCodes(): string[] {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: 8 }, () => {
    const b = randomBytes(8);
    const s = [...b].map((x) => chars[x % chars.length]).join('');
    return `${s.slice(0, 4)}-${s.slice(4)}`;
  });
}

export const normalizeRecovery = (code: string) => code.trim().toUpperCase();
