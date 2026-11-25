import {
  AGENT_DOCS_VERSION,
  MCP_PROTOCOL_VERSIONS,
  MCP_TOOLS,
  mcpToolList,
  productInfo,
} from '@/components/site/agentes';
import { SITE_URL } from '@/components/site/config';
import { PUBLIC_CORS, preflight, readRpc, rpcError, rpcResult } from '@/lib/agentes-http';

/**
 * Servidor MCP mínimo (Streamable HTTP, sem sessão, respostas em JSON). Só ferramentas de
 * leitura com informação pública do produto: não há login, nem acesso a dados de empresas.
 */
export const dynamic = 'force-dynamic';

const PRODUCT_URI = `${SITE_URL}/info/produto`;

export async function POST(request: Request) {
  const read = await readRpc(request);
  if (!read.ok) return read.res;
  const { id = null, method, params } = read.msg;
  const p = (params ?? {}) as Record<string, unknown>;

  // Notificações (sem id) não têm resposta.
  if (read.msg.id === undefined) return new Response(null, { status: 202, headers: PUBLIC_CORS });

  switch (method) {
    case 'initialize': {
      const asked = typeof p.protocolVersion === 'string' ? p.protocolVersion : '';
      return rpcResult(id, {
        protocolVersion: MCP_PROTOCOL_VERSIONS.includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0],
        capabilities: {
          tools: { listChanged: false },
          resources: { subscribe: false, listChanged: false },
          prompts: { listChanged: false },
        },
        serverInfo: {
          name: 'cenario-gestao',
          title: 'Cenário Gestão',
          version: AGENT_DOCS_VERSION,
        },
        instructions:
          'Informações públicas do Cenário Gestão, sistema de gestão para tapeçarias. Somente leitura; não acessa dados de empresas.',
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: mcpToolList() });
    case 'tools/call': {
      const tool = MCP_TOOLS.find((t) => t.name === p.name);
      if (!tool) return rpcError(id, -32602, `Ferramenta desconhecida: ${String(p.name)}`);
      return rpcResult(id, { content: [{ type: 'text', text: tool.text() }], isError: false });
    }
    case 'resources/list':
      return rpcResult(id, {
        resources: [
          {
            uri: PRODUCT_URI,
            name: 'produto',
            title: 'Ficha pública do produto',
            mimeType: 'application/json',
          },
        ],
      });
    case 'resources/read':
      if (p.uri !== PRODUCT_URI) return rpcError(id, -32002, 'Recurso não encontrado');
      return rpcResult(id, {
        contents: [
          {
            uri: PRODUCT_URI,
            mimeType: 'application/json',
            text: JSON.stringify(productInfo(), null, 2),
          },
        ],
      });
    case 'resources/templates/list':
      return rpcResult(id, { resourceTemplates: [] });
    case 'prompts/list':
      return rpcResult(id, { prompts: [] });
    default:
      return rpcError(id, -32601, `Método não suportado: ${String(method)}`);
  }
}

/** Sem fluxo de eventos do servidor (SSE): cada pedido tem uma resposta JSON. */
export function GET() {
  return new Response('Use POST (MCP Streamable HTTP).', {
    status: 405,
    headers: { ...PUBLIC_CORS, Allow: 'POST, OPTIONS' },
  });
}
export const DELETE = GET;
export const OPTIONS = preflight;
