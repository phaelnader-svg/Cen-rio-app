import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { PAIRING_ALPHABET } from '@cenario/shared';

/** Parâmetros argon2id recomendados pela OWASP (19 MiB, 2 iterações). */
const ARGON2_OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export function hashSecret(plain: string): Promise<string> {
  return hash(plain, ARGON2_OPTIONS);
}

export async function verifySecret(hashed: string, plain: string): Promise<boolean> {
  try {
    return await verify(hashed, plain);
  } catch {
    return false;
  }
}

/**
 * Hash fictício usado para equalizar o tempo de resposta quando o usuário não
 * existe (evita enumeração de contas por tempo de resposta).
 */
let dummyHash: Promise<string> | null = null;
export async function burnVerification(plain: string): Promise<void> {
  dummyHash ??= hash('cenario-dummy-password-0', ARGON2_OPTIONS);
  await verifySecret(await dummyHash, plain);
}

/** Token opaco de 256 bits, em base64url. */
export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Cria a função de hash de tokens (HMAC-SHA256 com segredo do servidor). */
export function createTokenHasher(secret: string) {
  return (token: string) => createHmac('sha256', secret).update(token).digest('hex');
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

export function generatePairingCode(): string {
  let code = '';
  for (let i = 0; i < 8; i++) code += PAIRING_ALPHABET[randomInt(PAIRING_ALPHABET.length)];
  return code;
}

export function formatPairingCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}
