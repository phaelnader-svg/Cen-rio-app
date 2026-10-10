import type { FastifyInstance } from 'fastify';

/**
 * Evolução, Fase 8 — exposição mínima do cliente nos tablets da produção.
 *
 * Executar uma tarefa exige OS, peça e etapa; o nome completo do cliente (dado pessoal) não é
 * necessário no tablet. Em sessões DEVICE, todo campo `customerName` das respostas deste escopo
 * vira "Primeiro I." (ex.: "Maria Aparecida Fictícia" → "Maria F."), o suficiente para a equipe
 * reconhecer a peça na oficina. O formato do contrato não muda (continua string). O painel (WEB)
 * recebe o nome completo. Aplicado no servidor — não depende da interface.
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
      out[k] = k === 'customerName' && typeof x === 'string' ? shortCustomerName(x) : minimize(x);
    }
    return out;
  }
  return v;
}

/** Registra o filtro no escopo (plugin) das rotas de produção/ajuda. */
export function minimizeCustomerForDevices(app: FastifyInstance) {
  app.addHook('preSerialization', async (request, _reply, payload) =>
    request.auth?.kind === 'DEVICE' ? minimize(payload) : payload,
  );
}
