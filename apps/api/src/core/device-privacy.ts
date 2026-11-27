import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { AccessRule } from './types';

/**
 * Evolução, Fase 8 — exposição mínima do cliente nos tablets da produção.
 *
 * Executar uma tarefa exige OS, peça e etapa; o nome completo do cliente (dado pessoal) não é
 * necessário no tablet. Em sessões DEVICE, o nome do cliente das respostas vira "Primeiro I."
 * (ex.: "Maria Aparecida Fictícia" → "Maria F."), o suficiente para a equipe reconhecer a peça na
 * oficina. O formato do contrato não muda (continua string). O painel (WEB) recebe o nome completo.
 * Aplicado no servidor — não depende da interface.
 *
 * Reformulação, Fase 0: o filtro deixou de ser opt-in por módulo (qualidade, medições e outras
 * rotas de tablet ficavam de fora) e passou a valer para TODA resposta a uma sessão DEVICE. Campos
 * reduzidos: `customerName` e `customer` (texto, ou objeto com `name`). Única exceção: quem executa
 * a logística (`logistica.executar`) numa rota de logística — o motorista precisa do nome de quem
 * recebe; o servidor já limita essas rotas às paradas da própria pessoa.
 */
export function shortCustomerName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return parts[0] ?? '';
  const last = parts[parts.length - 1]!;
  return `${parts[0]} ${last.charAt(0).toLocaleUpperCase('pt-BR')}.`;
}

function minimize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(minimize);
  if (v && typeof v === 'object' && !(v instanceof Date) && !Buffer.isBuffer(v)) {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) {
      if (k === 'customerName' && typeof x === 'string') out[k] = shortCustomerName(x);
      else if (k === 'customer' && typeof x === 'string') out[k] = shortCustomerName(x);
      else if (k === 'customer' && x && typeof x === 'object' && !Array.isArray(x)) {
        const c = minimize(x) as Record<string, unknown>;
        out[k] = typeof c.name === 'string' ? { ...c, name: shortCustomerName(c.name) } : c;
      } else out[k] = minimize(x);
    }
    return out;
  }
  return v;
}

/** Rota cuja regra de acesso é de quem executa a logística. */
function logisticsRoute(access: AccessRule | undefined) {
  if (!access || !('session' in access)) return false;
  return [...(access.permissions ?? []), ...(access.anyPermissions ?? [])].includes(
    'logistica.executar',
  );
}

export function needsCustomerMinimization(request: FastifyRequest): boolean {
  if (request.auth?.kind !== 'DEVICE') return false;
  const access = request.routeOptions.config?.access as AccessRule | undefined;
  return !(request.auth.permissions.has('logistica.executar') && logisticsRoute(access));
}

/** Registrado UMA vez na raiz: vale para todas as rotas, inclusive as que ainda serão criadas. */
export function deviceCustomerPrivacy(app: FastifyInstance) {
  app.addHook('preSerialization', async (request, _reply, payload) =>
    needsCustomerMinimization(request) ? minimize(payload) : payload,
  );
}
