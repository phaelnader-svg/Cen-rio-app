import { randomUUID } from 'node:crypto';
import { agentCard, answerFor } from '@/components/site/agentes';
import { preflight, publicJson, readRpc, rpcError, rpcResult } from '@/lib/agentes-http';

/**
 * Agente A2A mínimo (JSON-RPC): responde perguntas sobre o produto com as informações públicas
 * da landing (sem IA, sem tarefas longas, sem acesso a dados de empresas).
 */
export const dynamic = 'force-dynamic';

function textOf(params: unknown): string {
  const msg = (params as { message?: { parts?: unknown[] } } | undefined)?.message;
  const parts = Array.isArray(msg?.parts) ? msg.parts : [];
  return parts
    .map((part) =>
      part && typeof (part as { text?: unknown }).text === 'string'
        ? (part as { text: string }).text
        : '',
    )
    .join(' ')
    .slice(0, 2000);
}

export async function POST(request: Request) {
  const read = await readRpc(request);
  if (!read.ok) return read.res;
  const { id = null, method, params } = read.msg;
  switch (method) {
    // 0.3 (message/send) e 1.0 (SendMessage)
    case 'message/send':
    case 'SendMessage': {
      const incoming = (params as { message?: { contextId?: unknown } } | undefined)?.message;
      const text = answerFor(textOf(params));
      return rpcResult(id, {
        kind: 'message',
        messageId: randomUUID(),
        role: 'agent',
        ...(typeof incoming?.contextId === 'string' ? { contextId: incoming.contextId } : {}),
        parts: [{ kind: 'text', text }],
      });
    }
    case 'agent/getAuthenticatedExtendedCard':
    case 'GetExtendedAgentCard':
      return rpcResult(id, agentCard());
    case 'tasks/get':
    case 'GetTask':
    case 'tasks/cancel':
    case 'CancelTask':
      return rpcError(id, -32001, 'Tarefa não encontrada');
    default:
      return rpcError(id, -32601, `Método não suportado: ${String(method)}`);
  }
}

/** GET devolve o cartão do agente (útil para quem abre o endereço direto). */
export const GET = () => publicJson(agentCard());
export const OPTIONS = preflight;
