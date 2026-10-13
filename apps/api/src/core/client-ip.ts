import { BlockList, isIP } from 'node:net';
import type { FastifyRequest } from 'fastify';
import type { Env } from '../config/env';

/**
 * Identificação do IP real do cliente atrás do proxy reverso (auditoria P3/C3).
 *
 * Regras:
 * - Só o proxy declarado em `TRUST_PROXY` é confiável, e só como o salto IMEDIATO (a conexão
 *   que chega à API). O `X-Forwarded-For` é lido apenas um salto: o endereço que esse proxy
 *   informou. Valores anteriores do cabeçalho (enviados pelo cliente) nunca são usados.
 * - `TRUST_PROXY=true` (confiar em qualquer origem) é recusado em homologação e produção.
 * - Sem proxy confiável configurado, ou quando a conexão vem de loopback (proxy do Next em
 *   desenvolvimento), o IP real é DESCONHECIDO: limites por IP passam a usar um contador
 *   global, nunca o IP de quem encaminhou.
 */
export interface ClientIpConfig {
  /** Função entregue ao Fastify (`trustProxy`): confia só no salto 0 vindo do proxy. */
  trust: ((address: string, hop: number) => boolean) | false;
  /** Avisos para registrar na partida (configuração ausente ou permissiva demais). */
  warnings: string[];
}

const LOOPBACK = new BlockList();
LOOPBACK.addSubnet('127.0.0.0', 8, 'ipv4');
LOOPBACK.addAddress('::1', 'ipv6');

/** Normaliza IPv4 mapeado em IPv6 (`::ffff:1.2.3.4` → `1.2.3.4`). */
export function normalizeIp(ip: string): string {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  return m ? m[1]! : ip;
}

function inList(list: BlockList, ip: string): boolean {
  const n = normalizeIp(ip);
  const family = isIP(n);
  if (family === 0) return false;
  return list.check(n, family === 6 ? 'ipv6' : 'ipv4');
}

export function isLoopback(ip: string): boolean {
  return inList(LOOPBACK, ip);
}

export function buildClientIpConfig(env: Pick<Env, 'APP_ENV' | 'TRUST_PROXY'>): ClientIpConfig {
  const strict = env.APP_ENV === 'staging' || env.APP_ENV === 'production';
  const warnings: string[] = [];
  const raw = env.TRUST_PROXY;

  if (raw === false) {
    if (strict)
      warnings.push(
        'TRUST_PROXY não configurado: o IP real dos clientes é desconhecido. Os limites por IP ' +
          'usam um contador global (mais tolerante) e não isolam clientes entre si. Defina ' +
          'TRUST_PROXY com o endereço exato do proxy reverso.',
      );
    return { trust: false, warnings };
  }
  if (raw === true) {
    if (strict) {
      warnings.push(
        'TRUST_PROXY=true foi IGNORADO: confiar em qualquer origem permitiria forjar o IP pelo ' +
          'cabeçalho X-Forwarded-For. O IP real é tratado como desconhecido. Defina o endereço ' +
          'exato do proxy reverso.',
      );
      return { trust: false, warnings };
    }
    // Desenvolvimento/teste: mantém o comportamento explícito pedido, mas só um salto.
    return { trust: (_addr, hop) => hop === 0, warnings };
  }

  const list = new BlockList();
  const entries = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const entry of entries) {
    if (entry === 'loopback') {
      list.addSubnet('127.0.0.0', 8, 'ipv4');
      list.addAddress('::1', 'ipv6');
      continue;
    }
    const [addr, prefixRaw] = entry.split('/');
    const ip = normalizeIp(addr ?? '');
    const family = isIP(ip);
    if (family === 0) throw new Error(`TRUST_PROXY: endereço inválido "${entry}".`);
    const type = family === 6 ? 'ipv6' : 'ipv4';
    const full = family === 6 ? 128 : 32;
    const prefix = prefixRaw === undefined ? full : Number(prefixRaw);
    if (!Number.isInteger(prefix) || prefix < 0 || prefix > full)
      throw new Error(`TRUST_PROXY: prefixo inválido em "${entry}".`);
    if (prefix === full) list.addAddress(ip, type);
    else {
      list.addSubnet(ip, prefix, type);
      if (strict)
        warnings.push(
          `TRUST_PROXY confia numa FAIXA inteira (${entry}). Qualquer máquina dessa faixa poderia ` +
            'informar um IP falso. Prefira o endereço exato do proxy reverso.',
        );
    }
  }
  if (entries.length === 0) {
    if (strict) warnings.push('TRUST_PROXY vazio: o IP real dos clientes é desconhecido.');
    return { trust: false, warnings };
  }
  return { trust: (address, hop) => hop === 0 && inList(list, address), warnings };
}

/**
 * IP real do cliente, ou `null` quando desconhecido: conexão de loopback (proxy local não
 * declarado, ex.: Next em desenvolvimento) ou requisição que veio do proxy confiável sem
 * informar o cliente (o `request.ip` seria o do próprio proxy).
 */
export function knownClientIp(request: FastifyRequest): string | null {
  const ip = normalizeIp(request.ip ?? '');
  if (!ip || isIP(ip) === 0 || isLoopback(ip)) return null;
  const socketIp = request.socket?.remoteAddress;
  // Veio do proxy confiável, mas sem X-Forwarded-For: o IP visto é o do proxy, não o do cliente.
  if (socketIp && normalizeIp(socketIp) === ip && request.ips && request.ips.length === 1) {
    const trust = request.server.ctx.clientIp.trust;
    if (trust && trust(socketIp, 0)) return null;
  }
  return ip;
}
