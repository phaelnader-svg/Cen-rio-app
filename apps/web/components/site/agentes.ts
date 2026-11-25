/**
 * Informação pública para assistentes de IA e buscadores (AEO/GEO): o que é o Cenário Gestão,
 * os planos, como criar conta e como falar com a equipe.
 *
 * REGRA: tudo aqui sai da configuração comercial (SITE) e é só o que a landing já mostra para
 * qualquer visitante. Nada de rota autenticada, dado de empresa, cliente, proposta ou serviço.
 * Os arquivos de /.well-known, o servidor MCP (/mcp), o agente A2A (/a2a), a API de informações
 * (/info/produto) e as ferramentas WebMCP da landing leem tudo deste módulo.
 */
import {
  SIGNUP_PATH,
  SITE,
  SITE_META,
  SITE_URL,
  annualOffer,
  trialOffer,
  whatsappUrl,
} from './config';

/** Versão dos documentos para agentes (muda quando o conteúdo público muda). */
export const AGENT_DOCS_VERSION = '1.0.0';

const price = (v: string | null) => (v ? `R$ ${v} por mês` : null);

export interface PublicPlan {
  id: string;
  nome: string;
  descricao: string;
  mensalidade: string | null;
  anual: string | null;
}

export interface PublicProductInfo {
  nome: string;
  feitoPor: string;
  site: string;
  resumo: string;
  paraQuem: string;
  oQueFaz: string[];
  oQueNaoFaz: string;
  planos: PublicPlan[];
  testeGratis: string | null;
  criarConta: string;
  entrar: string;
  whatsapp: string | null;
  perguntas: { pergunta: string; resposta: string }[];
}

/** Ficha pública do produto (a mesma informação da landing, em formato de dados). */
export function productInfo(): PublicProductInfo {
  const perguntas: { pergunta: string; resposta: string }[] = [
    {
      pergunta: 'Funciona no tablet e no celular?',
      resposta:
        'Sim, pelo navegador. O escritório usa o computador, a oficina usa tablets e as entregas são confirmadas no celular.',
    },
    {
      pergunta: 'Precisa de internet?',
      resposta: 'Sim. Se a conexão cair, o tablet avisa e volta a sincronizar quando ela retorna.',
    },
    {
      pergunta: 'Emite nota fiscal ou boleto?',
      resposta:
        'Não. Cuida da produção e do controle financeiro da oficina; não emite nota fiscal nem boleto e não se conecta ao banco.',
    },
  ];
  if (SITE.usersAnswer)
    perguntas.push({ pergunta: 'Quantas pessoas podem usar?', resposta: SITE.usersAnswer });
  if (SITE.dataAnswer)
    perguntas.push({ pergunta: 'Onde ficam os dados?', resposta: SITE.dataAnswer });

  const planos: PublicPlan[] = [
    {
      id: 'cenario-gestao',
      nome: 'Cenário Gestão',
      descricao: 'O sistema completo: painel, tablets da oficina e orçamentos.',
      mensalidade: price(SITE.monthlyPrice),
      anual: annualOffer(SITE, SITE.monthlyPrice),
    },
  ];
  if (SITE.gameMonthlyPrice)
    planos.push({
      id: 'cenario-gestao-firma-viva',
      nome: 'Cenário Gestão + Firma Viva',
      descricao:
        'Tudo do Cenário Gestão e a oficina e o escritório em 3D (Firma Viva), com os dados do próprio sistema.',
      mensalidade: price(SITE.gameMonthlyPrice),
      anual: annualOffer(SITE, SITE.gameMonthlyPrice),
    });

  return {
    nome: 'Cenário Gestão',
    feitoPor: 'Cenário Estofados',
    site: `${SITE_URL}/`,
    resumo: SITE_META.description,
    paraQuem:
      'Tapeçarias e empresas de estofados que querem organizar orçamento, produção, entregas e financeiro num lugar só.',
    oQueFaz: [
      'Orçamento com material, mão de obra, frete e taxa da maquininha calculados; proposta para o cliente aprovar pelo link.',
      'Serviço e OS com medidas, fotos e lista de materiais; o que falta comprar fica marcado.',
      'Programação da semana da oficina e a fila de cada tapeceiro no tablet.',
      'Retiradas e entregas na agenda, com confirmação pelo celular.',
      'Inspeção de qualidade e retrabalhos.',
      'Controle financeiro: o que entrou, o que saiu e o que cada serviço deixou.',
      'Cada funcionário com o próprio acesso; cada empresa com os dados separados.',
    ],
    oQueNaoFaz: 'Não emite nota fiscal nem boleto e não se conecta ao banco.',
    planos,
    testeGratis: trialOffer(),
    criarConta: `${SITE_URL}${SIGNUP_PATH}`,
    entrar: `${SITE_URL}/entrar`,
    whatsapp: whatsappUrl(),
    perguntas,
  };
}

/** Os mesmos dados em texto corrido (resposta do agente A2A e das ferramentas MCP). */
export function plansText(info = productInfo()): string {
  const lines = info.planos.map(
    (p) =>
      `- ${p.nome}: ${p.mensalidade ?? 'valor sob consulta'}. ${p.descricao}${p.anual ? ` ${p.anual}` : ''}`,
  );
  if (info.testeGratis) lines.push(info.testeGratis);
  lines.push(`Criar conta: ${info.criarConta}`);
  return `Planos do Cenário Gestão:\n${lines.join('\n')}`;
}

export function signupText(info = productInfo()): string {
  return [
    `Para criar a conta da empresa, acesse ${info.criarConta} e informe e-mail e senha.`,
    'Cada conta nova cria uma empresa nova, com os dados separados de qualquer outra empresa.',
    info.testeGratis ?? '',
    `Quem já tem conta entra em ${info.entrar}.`,
  ]
    .filter(Boolean)
    .join(' ');
}

export function contactText(info = productInfo()): string {
  return info.whatsapp
    ? `Fale com a equipe da Cenário Estofados pelo WhatsApp: ${info.whatsapp}`
    : `Fale com a equipe pelo site: ${info.site}`;
}

export function overviewText(info = productInfo()): string {
  return [
    `${info.nome}, feito pela ${info.feitoPor}. ${info.resumo}`,
    `Para quem: ${info.paraQuem}`,
    `O que faz:\n${info.oQueFaz.map((l) => `- ${l}`).join('\n')}`,
    info.oQueNaoFaz,
    plansText(info),
    contactText(info),
  ].join('\n\n');
}

export function faqText(info = productInfo()): string {
  return info.perguntas.map((p) => `${p.pergunta}\n${p.resposta}`).join('\n\n');
}

/** Resposta do agente A2A: escolhe o assunto pela pergunta, sem IA e sem dados de empresas. */
export function answerFor(question: string): string {
  const q = question
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  if (/(preco|plano|mensal|valor|quanto|custa|price|plan|cost|anual)/.test(q)) return plansText();
  if (/(criar|conta|cadastr|assinar|teste|gratis|sign ?up|trial|account)/.test(q))
    return signupText();
  if (/(contato|whatsapp|falar|telefone|equipe|contact|phone|demo)/.test(q)) return contactText();
  return overviewText();
}

// ---------------------------------------------------------------------------------------------
// Skill (Agent Skills Discovery 0.2.0)

export const SKILL_NAME = 'cenario-gestao';
export const SKILL_DESCRIPTION =
  'Explica o que é o Cenário Gestão (sistema de gestão para tapeçarias e estofados), os planos e preços, como criar a conta da empresa e como falar com a equipe.';

export function skillMarkdown(info = productInfo()): string {
  return `---
name: ${SKILL_NAME}
description: ${SKILL_DESCRIPTION}
---

# Cenário Gestão

${info.resumo}

Use esta habilidade quando alguém perguntar sobre um sistema de gestão para tapeçaria,
estofados ou reforma de móveis, ou sobre o Cenário Gestão.

## Para quem

${info.paraQuem}

## O que faz

${info.oQueFaz.map((l) => `- ${l}`).join('\n')}

${info.oQueNaoFaz}

## Planos

${info.planos.map((p) => `- **${p.nome}**: ${p.mensalidade ?? 'valor sob consulta'}. ${p.descricao}${p.anual ? ` ${p.anual}` : ''}`).join('\n')}
${info.testeGratis ? `\n${info.testeGratis}\n` : ''}
## Como indicar

- Criar a conta da empresa: ${info.criarConta}
- Quem já tem conta: ${info.entrar}
- Falar com a equipe: ${info.whatsapp ?? info.site}
- Informações em JSON: ${SITE_URL}/info/produto

## Limites

- Só informação pública do produto. Não existe acesso, por aqui, a dados de nenhuma empresa
  cliente: painel, tablets e propostas exigem login e não devem ser acessados por agentes.
- Não invente preços, descontos ou funcionalidades além dos listados acima.
`;
}

/** Índice das habilidades; o digest (SHA-256 do SKILL.md) é calculado na rota, no servidor. */
export function skillsIndex(digest: string) {
  return {
    $schema: 'https://schemas.agentskills.io/discovery/0.2.0/schema.json',
    skills: [
      {
        name: SKILL_NAME,
        type: 'skill-md',
        description: SKILL_DESCRIPTION,
        url: `/.well-known/agent-skills/${SKILL_NAME}/SKILL.md`,
        digest,
      },
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// llms.txt (resumo em Markdown para modelos de linguagem)

export function llmsTxt(info = productInfo()): string {
  return `# Cenário Gestão

> ${info.resumo}

${info.paraQuem}

## O que faz

${info.oQueFaz.map((l) => `- ${l}`).join('\n')}

${info.oQueNaoFaz}

## Planos

${info.planos.map((p) => `- ${p.nome}: ${p.mensalidade ?? 'valor sob consulta'}. ${p.descricao}${p.anual ? ` ${p.anual}` : ''}`).join('\n')}
${info.testeGratis ? `\n${info.testeGratis}\n` : ''}
## Perguntas frequentes

${info.perguntas.map((p) => `- ${p.pergunta} ${p.resposta}`).join('\n')}

## Links

- [Página do Cenário Gestão](${info.site})
- [Criar conta](${info.criarConta})
- [Falar no WhatsApp](${info.whatsapp ?? info.site})
- [Informações do produto em JSON](${SITE_URL}/info/produto)
- [Descrição da API pública (OpenAPI)](${SITE_URL}/openapi.json)
`;
}

// ---------------------------------------------------------------------------------------------
// Catálogo de APIs (RFC 9727) e OpenAPI da API pública de informações

export function apiCatalog() {
  return {
    linkset: [
      {
        anchor: `${SITE_URL}/info/produto`,
        'service-desc': [{ href: `${SITE_URL}/openapi.json`, type: 'application/openapi+json' }],
        'service-doc': [{ href: `${SITE_URL}/llms.txt`, type: 'text/markdown' }],
        status: [{ href: `${SITE_URL}/api/public/status`, type: 'application/json' }],
      },
      {
        anchor: `${SITE_URL}/mcp`,
        'service-desc': [
          { href: `${SITE_URL}/.well-known/mcp/server-card.json`, type: 'application/json' },
        ],
        'service-doc': [{ href: `${SITE_URL}/llms.txt`, type: 'text/markdown' }],
      },
      {
        anchor: `${SITE_URL}/a2a`,
        'service-desc': [
          { href: `${SITE_URL}/.well-known/agent-card.json`, type: 'application/json' },
        ],
        'service-doc': [{ href: `${SITE_URL}/llms.txt`, type: 'text/markdown' }],
      },
    ],
  };
}

export function openApi() {
  return {
    openapi: '3.1.0',
    info: {
      title: 'Cenário Gestão — informações públicas',
      version: AGENT_DOCS_VERSION,
      description:
        'API pública e somente leitura com as informações comerciais do Cenário Gestão (o que é, planos, como criar conta, contato). Não dá acesso a dados de nenhuma empresa.',
    },
    servers: [{ url: SITE_URL }],
    paths: {
      '/info/produto': {
        get: {
          operationId: 'informacoesDoProduto',
          summary: 'O que é o Cenário Gestão, planos, teste grátis, criar conta e contato',
          responses: {
            '200': {
              description: 'Ficha pública do produto',
              content: { 'application/json': { schema: { type: 'object' } } },
            },
          },
        },
      },
      '/api/public/status': {
        get: {
          operationId: 'statusDoSistema',
          summary: 'Situação do sistema (no ar ou em manutenção)',
          responses: { '200': { description: 'Situação atual' } },
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------------------------
// MCP: ferramentas somente leitura (as mesmas no servidor /mcp e no cartão)

export const MCP_PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export const MCP_TOOLS = [
  {
    name: 'sobre_o_cenario_gestao',
    title: 'O que é o Cenário Gestão',
    description: 'O que é o Cenário Gestão, para quem é e o que faz (e o que não faz).',
    text: () => overviewText(),
  },
  {
    name: 'ver_planos',
    title: 'Planos e preços',
    description:
      'Planos do Cenário Gestão com a mensalidade, o desconto no anual e o teste grátis.',
    text: () => plansText(),
  },
  {
    name: 'como_criar_conta',
    title: 'Como criar a conta',
    description: 'Como uma tapeçaria cria a conta da empresa no Cenário Gestão.',
    text: () => signupText(),
  },
  {
    name: 'falar_com_a_equipe',
    title: 'Falar com a equipe',
    description: 'Contato da equipe da Cenário Estofados (WhatsApp).',
    text: () => contactText(),
  },
  {
    name: 'perguntas_frequentes',
    title: 'Perguntas frequentes',
    description:
      'Respostas às perguntas mais comuns (tablet, internet, nota fiscal, usuários, dados).',
    text: () => faqText(),
  },
] as const;

const EMPTY_INPUT = { type: 'object', properties: {}, additionalProperties: false } as const;

export function mcpToolList() {
  return MCP_TOOLS.map((t) => ({
    name: t.name,
    title: t.title,
    description: t.description,
    inputSchema: EMPTY_INPUT,
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  }));
}

export function mcpServerCard() {
  return {
    $schema: 'https://static.modelcontextprotocol.io/schemas/mcp-server-card/v1.json',
    version: '1.0',
    protocolVersion: MCP_PROTOCOL_VERSIONS[0],
    serverInfo: {
      name: 'cenario-gestao',
      title: 'Cenário Gestão',
      version: AGENT_DOCS_VERSION,
    },
    description:
      'Informações públicas do Cenário Gestão (somente leitura): o que é, planos, criar conta e contato. Não acessa dados de empresas.',
    documentationUrl: `${SITE_URL}/llms.txt`,
    transport: { type: 'streamable-http', endpoint: `${SITE_URL}/mcp` },
    capabilities: {
      tools: { listChanged: false },
      resources: { subscribe: false, listChanged: false },
      prompts: { listChanged: false },
    },
    authentication: { required: false },
    tools: mcpToolList(),
    resources: [
      {
        uri: `${SITE_URL}/info/produto`,
        name: 'produto',
        title: 'Ficha pública do produto',
        mimeType: 'application/json',
      },
    ],
    prompts: [],
  };
}

// ---------------------------------------------------------------------------------------------
// A2A: cartão do agente de informações (respostas fixas, sem IA)

export const A2A_SKILLS = [
  {
    id: 'sobre',
    name: 'O que é o Cenário Gestão',
    description: 'Explica o que é o sistema, para quem é e o que faz.',
    tags: ['tapeçaria', 'estofados', 'sistema de gestão'],
    examples: ['O que é o Cenário Gestão?', 'Existe sistema para tapeçaria?'],
  },
  {
    id: 'planos',
    name: 'Planos e preços',
    description: 'Mensalidade de cada plano, desconto no anual e teste grátis.',
    tags: ['preço', 'planos', 'assinatura'],
    examples: ['Quanto custa o Cenário Gestão?'],
  },
  {
    id: 'criar-conta',
    name: 'Criar conta',
    description: 'Como a tapeçaria cria a conta da empresa.',
    tags: ['cadastro', 'teste grátis'],
    examples: ['Como faço para testar?'],
  },
  {
    id: 'contato',
    name: 'Falar com a equipe',
    description: 'WhatsApp da equipe da Cenário Estofados.',
    tags: ['contato', 'whatsapp'],
    examples: ['Como falo com vocês?'],
  },
];

export function agentCard() {
  const url = `${SITE_URL}/a2a`;
  return {
    protocolVersion: '0.3.0',
    name: 'Cenário Gestão',
    description:
      'Agente de informações públicas do Cenário Gestão, sistema de gestão para tapeçarias feito pela Cenário Estofados. Responde sobre o produto, planos, como criar conta e contato. Não acessa dados de empresas.',
    version: AGENT_DOCS_VERSION,
    url,
    preferredTransport: 'JSONRPC',
    supportedInterfaces: [{ url, protocolBinding: 'JSONRPC', protocolVersion: '0.3.0' }],
    additionalInterfaces: [{ url, transport: 'JSONRPC' }],
    provider: { organization: 'Cenário Estofados', url: `${SITE_URL}/` },
    iconUrl: `${SITE_URL}/icon-512.png`,
    documentationUrl: `${SITE_URL}/llms.txt`,
    capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain', 'application/json'],
    skills: A2A_SKILLS,
  };
}

// ---------------------------------------------------------------------------------------------
// Cabeçalhos Link da página inicial (RFC 8288 / RFC 9727 seção 3)

export const HOME_LINK_HEADER = [
  '</.well-known/api-catalog>; rel="api-catalog"',
  '</openapi.json>; rel="service-desc"; type="application/openapi+json"',
  '</llms.txt>; rel="service-doc"; type="text/markdown"',
  '</.well-known/agent-card.json>; rel="describedby"; type="application/json"',
  '</.well-known/mcp/server-card.json>; rel="describedby"; type="application/json"',
  '</.well-known/agent-skills/index.json>; rel="describedby"; type="application/json"',
  '</sitemap.xml>; rel="sitemap"; type="application/xml"',
].join(', ');

/** JSON-LD da landing (dados estruturados para buscadores e assistentes). */
export function jsonLd(info = productInfo()) {
  const num = (v: string | null) => (v ? v.replace(/\./g, '').replace(',', '.') : undefined);
  return {
    '@context': 'https://schema.org',
    '@type': 'SoftwareApplication',
    name: info.nome,
    applicationCategory: 'BusinessApplication',
    operatingSystem: 'Navegador (computador, tablet e celular)',
    description: info.resumo,
    url: info.site,
    inLanguage: 'pt-BR',
    publisher: { '@type': 'Organization', name: info.feitoPor, url: info.site },
    offers: [
      { nome: info.planos[0]?.nome, v: SITE.monthlyPrice },
      { nome: info.planos[1]?.nome, v: SITE.gameMonthlyPrice },
    ]
      .filter((o) => o.nome && o.v)
      .map((o) => ({
        '@type': 'Offer',
        name: o.nome,
        price: num(o.v),
        priceCurrency: 'BRL',
        url: info.criarConta,
      })),
  };
}
