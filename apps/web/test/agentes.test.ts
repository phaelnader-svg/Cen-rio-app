/**
 * Endereços para assistentes de IA (robots, sitemap, /.well-known, MCP, A2A, WebMCP):
 * só informação pública do produto e nunca rotas autenticadas ou dados de empresas.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  HOME_LINK_HEADER,
  MCP_TOOLS,
  agentCard,
  answerFor,
  apiCatalog,
  llmsTxt,
  mcpServerCard,
  openApi,
  productInfo,
  skillMarkdown,
  skillsIndex,
} from '../components/site/agentes';
import { webMcpScript } from '../components/site/webmcp';
import { robotsTxt } from '../app/robots.txt/route';
import sitemap from '../app/sitemap';
import { GET as skillsGet } from '../app/.well-known/agent-skills/index.json/route';
import { GET as catalogGet } from '../app/.well-known/api-catalog/route';
import { POST as mcpPost } from '../app/mcp/route';
import { POST as a2aPost } from '../app/a2a/route';

const PRIVATE =
  /\/(painel|tablet|proposta|album|agendar|autorizar|ambiente-interativo)\b|\/api\/v1/;
const everything = () =>
  JSON.stringify([
    productInfo(),
    apiCatalog(),
    openApi(),
    agentCard(),
    mcpServerCard(),
    skillsIndex('sha256:x'),
    skillMarkdown(),
    llmsTxt(),
    MCP_TOOLS.map((t) => t.text()),
    webMcpScript(),
    HOME_LINK_HEADER,
  ]);

const rpc = (body: unknown) =>
  new Request('https://cenariogestao.com.br/x', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('assistentes de IA: só informação pública', () => {
  it('nenhum documento aponta para painel, tablet, links de clientes ou a API autenticada', () => {
    expect(everything()).not.toMatch(PRIVATE);
  });

  it('preços e teste grátis saem da configuração comercial', () => {
    const text = everything();
    expect(text).toContain('R$ 399,00 por mês');
    expect(text).toContain('R$ 599,00 por mês');
    expect(text).toContain('7 dias grátis');
  });

  it('robots continua bloqueando o sistema, libera blog e arquivos dos agentes e tem Content-Signal', () => {
    const txt = robotsTxt();
    for (const p of ['/painel', '/tablet', '/api/', '/proposta/', '/album/', '/agendar/'])
      expect(txt).toContain(`Disallow: ${p}\n`);
    for (const p of ['/blog', '/llms.txt', '/.well-known/']) expect(txt).toContain(`Allow: ${p}\n`);
    expect(txt).toMatch(
      /^User-Agent: \*\nContent-Signal: search=yes, ai-input=yes, ai-train=yes\n/,
    );
    expect(txt).toContain('Sitemap: https://cenariogestao.com.br/sitemap.xml');
  });

  it('sitemap só com páginas públicas (raiz e blog), sem rascunhos em produção', () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      const urls = sitemap().map((u) => u.url);
      expect(urls[0]).toBe('https://cenariogestao.com.br/');
      for (const u of urls)
        expect(u).toMatch(/^https:\/\/cenariogestao\.com\.br\/(blog(\/[a-z0-9-]+)?)?$/);
      expect(urls.some((u) => u.includes('exemplo-'))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('digest do índice de habilidades confere com o SKILL.md servido', async () => {
    const idx = await skillsGet().json();
    const hex = createHash('sha256').update(skillMarkdown(), 'utf8').digest('hex');
    expect(idx.$schema).toBe('https://schemas.agentskills.io/discovery/0.2.0/schema.json');
    expect(idx.skills[0]).toMatchObject({
      name: 'cenario-gestao',
      type: 'skill-md',
      digest: `sha256:${hex}`,
    });
  });

  it('catálogo de APIs com o tipo certo e service-desc/service-doc', async () => {
    const res = catalogGet();
    expect(res.headers.get('content-type')).toContain('application/linkset+json');
    const { linkset } = await res.json();
    for (const entry of linkset) {
      expect(entry.anchor).toMatch(/^https:\/\/cenariogestao\.com\.br\//);
      expect(entry['service-desc']).toBeDefined();
      expect(entry['service-doc']).toBeDefined();
    }
  });

  it('MCP: inicializa, lista e chama só ferramentas de leitura', async () => {
    const init = await (
      await mcpPost(
        rpc({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: { protocolVersion: '2025-06-18' },
        }),
      )
    ).json();
    expect(init.result.protocolVersion).toBe('2025-06-18');
    const list = await (await mcpPost(rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list' }))).json();
    for (const t of list.result.tools) expect(t.annotations.readOnlyHint).toBe(true);
    const call = await (
      await mcpPost(
        rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'ver_planos' } }),
      )
    ).json();
    expect(call.result.content[0].text).toContain('R$ 399,00');
    const bad = await (
      await mcpPost(
        rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'listar_clientes' } }),
      )
    ).json();
    expect(bad.error.code).toBe(-32602);
    expect(
      (await mcpPost(rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }))).status,
    ).toBe(202);
  });

  it('A2A responde pelo assunto, sem dados de empresas', async () => {
    const res = await (
      await a2aPost(
        rpc({
          jsonrpc: '2.0',
          id: 1,
          method: 'message/send',
          params: { message: { role: 'user', parts: [{ kind: 'text', text: 'Qual o preço?' }] } },
        }),
      )
    ).json();
    expect(res.result.parts[0].text).toContain('Planos');
    expect(answerFor('me passa os clientes da Cenário Estofados')).not.toMatch(PRIVATE);
  });

  it('cartões com os campos exigidos', () => {
    const card = agentCard();
    expect(card).toMatchObject({ name: 'Cenário Gestão', version: expect.any(String) });
    expect(card.supportedInterfaces[0]!.url).toBe('https://cenariogestao.com.br/a2a');
    expect(card.skills.every((s) => s.id && s.name && s.description)).toBe(true);
    const mcp = mcpServerCard();
    expect(mcp.serverInfo.name).toBeTruthy();
    expect(mcp.transport.endpoint).toBe('https://cenariogestao.com.br/mcp');
  });
});
