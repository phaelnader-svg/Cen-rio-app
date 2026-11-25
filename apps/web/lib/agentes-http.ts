/**
 * Respostas dos endereços públicos para agentes (/.well-known, /mcp, /a2a, /info/produto).
 * Só informação pública do produto: liberadas para qualquer origem (CORS), sem cookies.
 */
export const PUBLIC_CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
  'Access-Control-Allow-Headers':
    'Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, A2A-Version',
  'Access-Control-Expose-Headers': 'Mcp-Session-Id',
};

const CACHE = 'public, max-age=300';

export function publicJson(body: unknown, contentType = 'application/json', status = 200) {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: {
      ...PUBLIC_CORS,
      'Content-Type': `${contentType}; charset=utf-8`,
      'Cache-Control': CACHE,
    },
  });
}

export function publicText(body: string, contentType: string) {
  return new Response(body, {
    status: 200,
    headers: {
      ...PUBLIC_CORS,
      'Content-Type': `${contentType}; charset=utf-8`,
      'Cache-Control': CACHE,
    },
  });
}

export function preflight() {
  return new Response(null, {
    status: 204,
    headers: { ...PUBLIC_CORS, 'Access-Control-Max-Age': '86400' },
  });
}

/** JSON-RPC 2.0 (MCP e A2A). */
export type RpcId = string | number | null;
export const rpcResult = (id: RpcId, result: unknown) => publicJson({ jsonrpc: '2.0', id, result });
export const rpcError = (id: RpcId, code: number, message: string, status = 200) =>
  publicJson({ jsonrpc: '2.0', id, error: { code, message } }, 'application/json', status);

export async function readRpc(
  request: Request,
): Promise<
  | { ok: true; msg: { id?: RpcId; method?: unknown; params?: unknown } }
  | { ok: false; res: Response }
> {
  const len = Number(request.headers.get('content-length') ?? 0);
  if (len > 64_000) return { ok: false, res: rpcError(null, -32600, 'Pedido grande demais', 413) };
  let body: unknown;
  try {
    const raw = await request.text();
    if (raw.length > 64_000)
      return { ok: false, res: rpcError(null, -32600, 'Pedido grande demais', 413) };
    body = JSON.parse(raw);
  } catch {
    return { ok: false, res: rpcError(null, -32700, 'JSON inválido', 400) };
  }
  if (
    !body ||
    typeof body !== 'object' ||
    Array.isArray(body) ||
    (body as { jsonrpc?: unknown }).jsonrpc !== '2.0'
  )
    return { ok: false, res: rpcError(null, -32600, 'Pedido JSON-RPC inválido', 400) };
  return { ok: true, msg: body as { id?: RpcId; method?: unknown; params?: unknown } };
}
