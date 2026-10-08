import type { PrismaClient } from '@cenario/db';
import type { FastifyRequest } from 'fastify';
import { Errors } from '../lib/errors';

/**
 * Proteção persistente contra força bruta. Cada chave (ex.: e-mail, IP,
 * funcionário+dispositivo) acumula falhas numa janela; ao atingir o limite,
 * fica bloqueada por um período que dobra a cada novo bloqueio (até 1 hora).
 * Persistir no banco faz o bloqueio valer entre reinícios e entre instâncias.
 */
export interface ThrottlePolicy {
  maxFailures: number;
  windowSeconds: number;
  baseLockSeconds: number;
  maxLockSeconds: number;
}

export const POLICIES = {
  /** Por conta (e-mail do painel). */
  account: { maxFailures: 5, windowSeconds: 900, baseLockSeconds: 60, maxLockSeconds: 3600 },
  /** Por funcionário no tablet (PIN de 6 dígitos exige limite mais rígido). */
  pin: { maxFailures: 5, windowSeconds: 900, baseLockSeconds: 120, maxLockSeconds: 3600 },
  /** Por IP, somando todas as tentativas de autenticação. */
  ip: { maxFailures: 30, windowSeconds: 900, baseLockSeconds: 300, maxLockSeconds: 3600 },
  /** Vinculação de dispositivos por IP. */
  pairing: { maxFailures: 10, windowSeconds: 900, baseLockSeconds: 300, maxLockSeconds: 3600 },
  /** Vinculação quando o IP real é desconhecido (limite global mais tolerante). */
  pairingGlobal: { maxFailures: 50, windowSeconds: 900, baseLockSeconds: 60, maxLockSeconds: 900 },
} as const satisfies Record<string, ThrottlePolicy>;

const LOOPBACK = /^(127\.|::1$|::ffff:127\.)/;

/**
 * Chave de IP para limitação. Retorna null quando o IP visto é o de um proxy
 * local não declarado como confiável (ex.: servidor Next.js encaminhando /api):
 * nesse caso todos os clientes compartilhariam o mesmo IP e um bloqueio por IP
 * afetaria todos os tablets. Em produção, o proxy reverso deve ser declarado em
 * TRUST_PROXY para que o IP real seja usado.
 */
export function clientIpKey(request: FastifyRequest, prefix: string): string | null {
  const ip = request.ip ?? '';
  if (!ip || LOOPBACK.test(ip)) return null;
  return `${prefix}:${ip}`;
}

export class AuthThrottle {
  constructor(private readonly prisma: PrismaClient) {}

  /** Lança erro 429 se alguma das chaves estiver bloqueada. */
  async assertAllowed(rawKeys: (string | null)[]): Promise<void> {
    const keys = rawKeys.filter((k): k is string => k !== null);
    if (keys.length === 0) return;
    const rows = await this.prisma.authThrottle.findMany({ where: { key: { in: keys } } });
    const now = Date.now();
    const lockedUntil = Math.max(0, ...rows.map((r) => r.lockedUntil?.getTime() ?? 0));
    if (lockedUntil > now) {
      throw Errors.locked(Math.ceil((lockedUntil - now) / 1000));
    }
  }

  async registerFailure(key: string | null, policy: ThrottlePolicy): Promise<void> {
    if (key === null) return;
    const now = new Date();
    // Operação atômica no banco para suportar tentativas concorrentes.
    await this.prisma.$executeRaw`
      INSERT INTO auth_throttle (key, failures, window_start, locked_until, updated_at)
      VALUES (${key}, 1, ${now}, NULL, ${now})
      ON CONFLICT (key) DO UPDATE SET
        failures = CASE
          WHEN auth_throttle.window_start < ${now}::timestamptz - make_interval(secs => ${policy.windowSeconds})
            AND (auth_throttle.locked_until IS NULL OR auth_throttle.locked_until < ${now})
          THEN 1 ELSE auth_throttle.failures + 1 END,
        window_start = CASE
          WHEN auth_throttle.window_start < ${now}::timestamptz - make_interval(secs => ${policy.windowSeconds})
            AND (auth_throttle.locked_until IS NULL OR auth_throttle.locked_until < ${now})
          THEN ${now} ELSE auth_throttle.window_start END,
        updated_at = ${now}`;
    const row = await this.prisma.authThrottle.findUnique({ where: { key } });
    if (row && row.failures >= policy.maxFailures && row.failures % policy.maxFailures === 0) {
      const level = row.failures / policy.maxFailures - 1;
      const lockSeconds = Math.min(policy.maxLockSeconds, policy.baseLockSeconds * 2 ** level);
      await this.prisma.authThrottle.update({
        where: { key },
        data: { lockedUntil: new Date(now.getTime() + lockSeconds * 1000) },
      });
    }
  }

  async reset(key: string): Promise<void> {
    await this.prisma.authThrottle.deleteMany({ where: { key } });
  }
}
