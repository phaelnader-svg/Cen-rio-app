import rateLimit from '@fastify/rate-limit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { Errors } from '../lib/errors';
import { knownClientIp } from './client-ip';

/**
 * Limites de requisições (auditoria P3/C3), em duas camadas:
 *
 * 1. ANTES da autenticação (`onRequest`), teto por IP real: protege o banco das consultas de
 *    sessão/dispositivo feitas a cada requisição. Comporta a oficina inteira atrás de um único
 *    IP público (NAT). Com IP desconhecido (sem proxy confiável), um contador GLOBAL com teto
 *    alto — conservador contra abuso, mas acima do tráfego legítimo da empresa.
 * 2. DEPOIS da autenticação (`preHandler`), por credencial VALIDADA: sessão (`s:`) ou
 *    dispositivo vinculado (`d:`). Sem credencial válida, o contador é o anônimo do IP (ou o
 *    anônimo global, com IP desconhecido). Cookies inventados nunca viram chave: só o id de uma
 *    sessão/dispositivo que o plugin de autenticação acabou de conferir no banco.
 *
 * WebSocket (`/api/realtime`): isento da camada 2 — reconexões após queda de Wi-Fi não podem ser
 * barradas pelo limite da sessão, e a conexão aberta não gera novas requisições. Continua
 * contando no teto por IP da camada 1, para que tentativas de upgrade sem sessão válida
 * (cada uma consulta o banco antes do 401) não fiquem ilimitadas.
 */
export interface RateLimitSettings {
  /** Teto por IP real conhecido, todas as requisições. */
  ipPerMinute: number;
  /** Teto global quando o IP real é desconhecido. */
  unknownIpPerMinute: number;
  /** Por sessão ou dispositivo validado. */
  sessionPerMinute: number;
  /** Sem credencial válida, por IP real conhecido. */
  anonymousPerMinute: number;
  /** Sem credencial válida e IP desconhecido (contador global). */
  unknownAnonymousPerMinute: number;
}

const MINUTE = 60_000;
const REALTIME = '/api/realtime';

const isRealtime = (request: FastifyRequest) => request.routeOptions.url === REALTIME;

/** Chave da camada 1. Prefixo `ip:` (IP conhecido) ou o contador global `ip:?`. */
export function ipKey(request: FastifyRequest): string {
  const ip = knownClientIp(request);
  return ip ? `ip:${ip}` : 'ip:?';
}

/** Chave da camada 2: credencial validada ou, sem ela, anônimo do IP / anônimo global. */
export function credentialKey(request: FastifyRequest): string {
  if (request.auth) return `s:${request.auth.sessionId}`;
  if (request.device) return `d:${request.device.id}`;
  const ip = knownClientIp(request);
  return ip ? `a:${ip}` : 'a:?';
}

export async function registerRateLimits(app: FastifyInstance, settings: RateLimitSettings) {
  // Só a infraestrutura do plugin (contadores em memória); os ganchos são os daqui.
  await app.register(rateLimit, { global: false, cache: 20_000 });

  const beforeAuth = app.createRateLimit({
    timeWindow: MINUTE,
    keyGenerator: ipKey,
    max: (_req, key) => (key === 'ip:?' ? settings.unknownIpPerMinute : settings.ipPerMinute),
  });
  const afterAuth = app.createRateLimit({
    timeWindow: MINUTE,
    keyGenerator: credentialKey,
    max: (_req, key) =>
      key.startsWith('s:') || key.startsWith('d:')
        ? settings.sessionPerMinute
        : key === 'a:?'
          ? settings.unknownAnonymousPerMinute
          : settings.anonymousPerMinute,
  });

  const check = async (limiter: typeof beforeAuth, request: FastifyRequest) => {
    const r = await limiter(request);
    if (!r.isAllowed && r.isExceeded) {
      request.log.warn({ chave: r.key.split(':')[0] }, 'Limite de requisições atingido');
      throw Errors.rateLimited(r.ttlInSeconds);
    }
  };

  app.addHook('onRequest', async (request) => check(beforeAuth, request));
  app.addHook('preHandler', async (request) => {
    if (isRealtime(request)) return;
    await check(afterAuth, request);
  });
}
