import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';

const ARGON2 = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (plain: string) => hash(plain, ARGON2);
export async function verifyPassword(hashed: string | null, plain: string) {
  if (!hashed) {
    await hash(plain, ARGON2); // tempo equivalente (evita enumeração de contas)
    return false;
  }
  try {
    return await verify(hashed, plain);
  } catch {
    return false;
  }
}

export const randomToken = (bytes = 32) => randomBytes(bytes).toString('base64url');
export const createHasher = (secret: string) => (t: string) =>
  createHmac('sha256', secret).update(t).digest('hex');
export const pkceChallenge = (verifier: string) =>
  createHash('sha256').update(verifier).digest('base64url');

export function safeEqual(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Selagem AES-256-GCM: tokens da conexão nunca ficam legíveis no banco. */
export function createSealer(keyB64: string) {
  const key = Buffer.from(keyB64, 'base64');
  return {
    seal(plain: string) {
      const iv = randomBytes(12);
      const c = createCipheriv('aes-256-gcm', key, iv);
      const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
      return `v1.${iv.toString('base64url')}.${c.getAuthTag().toString('base64url')}.${ct.toString('base64url')}`;
    },
    open(sealed: string) {
      const [v, iv, tag, ct] = sealed.split('.');
      if (v !== 'v1' || !iv || !tag || !ct) throw new Error('Selo inválido.');
      const d = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
      d.setAuthTag(Buffer.from(tag, 'base64url'));
      return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
    },
  };
}
