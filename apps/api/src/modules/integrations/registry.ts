/**
 * Catálogo da Central de Conexões. Cada conexão declara o que permite fazer, como autoriza
 * (sessão, OAuth oficial da Meta, chave de API do provedor ou importação de arquivo) e o que
 * precisa estar configurado no servidor. O estado mostrado é sempre o real: variáveis presentes,
 * conexão gravada, último teste e última sincronização.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

export type AuthKind = 'SESSAO' | 'META_OAUTH' | 'API_KEY' | 'IMPORTACAO' | 'PLANEJADA';

export interface ProviderDef {
  key: string;
  label: string;
  group: 'SISTEMA' | 'META' | 'DOCUMENTOS' | 'FINANCEIRO' | 'OPERACAO' | 'GOOGLE';
  provider: string;
  auth: AuthKind;
  /** O que a conexão permite (mostrado no cartão). */
  capabilities: string[];
  /** Permissões/escopos pedidos na autorização oficial. */
  scopes: string[];
  /** Variáveis do servidor exigidas (nunca vão ao navegador). */
  env: { name: string; what: string }[];
  /** Passos externos que dependem da conta da Cenário. */
  external: string[];
  docsUrl: string;
  /** Pode ser simulada em desenvolvimento/homologação (modo de teste local). */
  testMode: boolean;
}

const META_ENV = [
  { name: 'META_APP_ID', what: 'ID do app da Cenário no Meta for Developers' },
  {
    name: 'META_APP_SECRET',
    what: 'Chave secreta do app (assina webhooks e troca o código OAuth)',
  },
  {
    name: 'META_REDIRECT_URI',
    what: 'Endereço de retorno do OAuth (…/api/v1/connections/meta/callback) cadastrado no app',
  },
  { name: 'META_WEBHOOK_VERIFY_TOKEN', what: 'Token de verificação do webhook cadastrado no app' },
];

export const PROVIDERS: ProviderDef[] = [
  {
    key: 'CENARIO',
    label: 'Cenário Gestão',
    group: 'SISTEMA',
    provider: 'Cenário Gestão',
    auth: 'SESSAO',
    capabilities: [
      'OS, produção, estoque, compras, financeiro e expedição com as permissões do usuário logado',
    ],
    scopes: [],
    env: [],
    external: [],
    docsUrl: '/painel/empresa',
    testMode: false,
  },
  {
    key: 'WHATSAPP',
    label: 'WhatsApp Business',
    group: 'META',
    provider: 'Meta — WhatsApp Cloud API',
    auth: 'META_OAUTH',
    capabilities: [
      'Receber e responder mensagens',
      'Fotos, áudios e documentos',
      'Modelos de mensagem fora da janela de 24 h',
      'Coexistência com o app WhatsApp Business',
    ],
    scopes: ['whatsapp_business_management', 'whatsapp_business_messaging', 'business_management'],
    env: [
      ...META_ENV,
      {
        name: 'META_WA_CONFIG_ID',
        what: 'ID da configuração do Cadastro Incorporado (Embedded Signup) com coexistência',
      },
    ],
    external: [
      'App da Meta com o produto WhatsApp e acesso avançado (Revisão do App) às permissões acima',
      'Empresa verificada no Gerenciador de Negócios para sair dos limites de teste',
      'Número comercial: confirmar elegibilidade à coexistência (app WhatsApp Business atualizado, país suportado) antes de migrar',
    ],
    docsUrl: 'https://developers.facebook.com/docs/whatsapp/embedded-signup',
    testMode: true,
  },
  {
    key: 'INSTAGRAM',
    label: 'Instagram profissional',
    group: 'META',
    provider: 'Meta — Instagram Graph API',
    auth: 'META_OAUTH',
    capabilities: [
      'Directs (receber e responder)',
      'Comentários',
      'Publicar fotos com legenda',
      'Calendário de conteúdo',
    ],
    scopes: [
      'instagram_basic',
      'instagram_manage_messages',
      'instagram_manage_comments',
      'instagram_content_publish',
      'pages_show_list',
      'pages_read_engagement',
      'business_management',
    ],
    env: META_ENV,
    external: [
      'Conta profissional do Instagram ligada a uma Página do Facebook',
      'Revisão do App para instagram_manage_messages e instagram_content_publish',
    ],
    docsUrl: 'https://developers.facebook.com/docs/instagram-platform',
    testMode: true,
  },
  {
    key: 'MESSENGER',
    label: 'Página do Facebook e Messenger',
    group: 'META',
    provider: 'Meta — Messenger Platform',
    auth: 'META_OAUTH',
    capabilities: ['Mensagens da Página (receber e responder em 24 h)', 'Comentários da Página'],
    scopes: [
      'pages_messaging',
      'pages_manage_metadata',
      'pages_show_list',
      'pages_read_engagement',
    ],
    env: META_ENV,
    external: ['Ser administrador da Página da Cenário', 'Revisão do App para pages_messaging'],
    docsUrl: 'https://developers.facebook.com/docs/messenger-platform',
    testMode: true,
  },
  {
    key: 'META_ADS',
    label: 'Meta Business e Anúncios',
    group: 'META',
    provider: 'Meta — Marketing API',
    auth: 'META_OAUTH',
    capabilities: [
      'Campanhas, gastos e resultados',
      'Propor mudança de orçamento (executa só com aprovação)',
    ],
    scopes: ['ads_read', 'ads_management', 'business_management'],
    env: META_ENV,
    external: [
      'Conta de anúncios da Cenário no Gerenciador de Negócios',
      'Acesso padrão/avançado à Marketing API',
    ],
    docsUrl: 'https://developers.facebook.com/docs/marketing-apis',
    testMode: true,
  },
  {
    key: 'ASSINATURA',
    label: 'Assinatura digital',
    group: 'DOCUMENTOS',
    provider: 'Clicksign (API v3)',
    auth: 'API_KEY',
    capabilities: [
      'Enviar contrato para assinatura',
      'Acompanhar assinatura pelo retorno do provedor',
      'Arquivar o documento assinado na OS',
    ],
    scopes: [],
    env: [
      { name: 'CLICKSIGN_ACCESS_TOKEN', what: 'Token de API da conta Clicksign da Cenário' },
      {
        name: 'CLICKSIGN_BASE_URL',
        what: 'https://sandbox.clicksign.com (testes) ou https://app.clicksign.com',
      },
      { name: 'CLICKSIGN_WEBHOOK_SECRET', what: 'Segredo HMAC do webhook cadastrado na Clicksign' },
    ],
    external: ['Conta Clicksign (plano com API) e webhook apontando para /api/webhooks/clicksign'],
    docsUrl: 'https://developers.clicksign.com',
    testMode: true,
  },
  {
    key: 'FISCAL',
    label: 'Emissão fiscal',
    group: 'DOCUMENTOS',
    provider: 'Emissor Nacional de NFS-e (via provedor com API)',
    auth: 'API_KEY',
    capabilities: [
      'Preparar e emitir NFS-e pelo padrão nacional',
      'Acompanhar autorização ou rejeição',
      'Guardar número, status e arquivos na OS',
    ],
    scopes: [],
    env: [
      {
        name: 'FISCAL_PROVIDER',
        what: 'Provedor escolhido (compatível com o Emissor Nacional para São José dos Campos)',
      },
      { name: 'FISCAL_API_TOKEN', what: 'Token de API do provedor' },
    ],
    external: [
      'São José dos Campos emite NFS-e pelo Emissor Nacional desde 01/10/2026: confirmar o cadastro da Cenário no gov.br/nfse',
      'Certificado digital A1 da empresa cadastrado no provedor',
      'Perfis fiscais (reforma × fabricação) validados com a contabilidade: código de tributação nacional, alíquota, CNAE; NF-e de produto se a fabricação exigir',
    ],
    docsUrl: 'https://www.gov.br/nfse',
    testMode: true,
  },
  {
    key: 'COBRANCAS',
    label: 'Cobranças',
    group: 'FINANCEIRO',
    provider: 'Asaas (Pix, boleto e cartão)',
    auth: 'API_KEY',
    capabilities: [
      'Gerar Pix, boleto ou link de cartão por parcela',
      'Baixa automática pelo retorno do provedor, sem duplicidade',
    ],
    scopes: [],
    env: [
      { name: 'ASAAS_API_KEY', what: 'Chave de API (sandbox ou produção)' },
      {
        name: 'ASAAS_BASE_URL',
        what: 'https://api-sandbox.asaas.com/v3 (testes) ou https://api.asaas.com/v3',
      },
      {
        name: 'ASAAS_WEBHOOK_TOKEN',
        what: 'Token do webhook (cabeçalho asaas-access-token), 32 a 255 caracteres',
      },
    ],
    external: [
      'Conta Asaas da Cenário com chave Pix cadastrada',
      'Webhook de cobranças apontando para /api/webhooks/asaas',
    ],
    docsUrl: 'https://docs.asaas.com',
    testMode: true,
  },
  {
    key: 'BANCO_PJ',
    label: 'Banco PJ',
    group: 'FINANCEIRO',
    provider: 'Importação de extrato (OFX/CSV); API do banco quando houver',
    auth: 'IMPORTACAO',
    capabilities: [
      'Importar extrato',
      'Conciliar com contas a receber e a pagar',
      'Pagamentos preparados com confirmação',
    ],
    scopes: [],
    env: [],
    external: ['Informar o banco da conta PJ para avaliar API de pagamentos/Open Finance'],
    docsUrl: '/painel/financeiro',
    testMode: true,
  },
  {
    key: 'MAQUININHA',
    label: 'Maquininha e recebíveis',
    group: 'FINANCEIRO',
    provider: 'Importação do relatório de vendas (CSV)',
    auth: 'IMPORTACAO',
    capabilities: [
      'Bruto, taxas, líquido e previsão de depósito',
      'Quanto vendi, recebi e deve cair na semana',
    ],
    scopes: [],
    env: [],
    external: [
      'Informar a adquirente da maquininha (Stone, Cielo, Rede, PagSeguro…) para avaliar API',
    ],
    docsUrl: '/painel/financeiro',
    testMode: false,
  },
  {
    key: 'CONTABILIDADE',
    label: 'Contabilidade e documentos',
    group: 'FINANCEIRO',
    provider: 'Pacote mensal para o escritório contábil',
    auth: 'IMPORTACAO',
    capabilities: ['Fechamento mensal: notas, comprovantes e extratos', 'Baixar o pacote do mês'],
    scopes: [],
    env: [
      {
        name: 'CONTABILIDADE_EMAIL',
        what: 'E-mail do escritório contábil (envio pelo e-mail conectado)',
      },
    ],
    external: ['Conexão de e-mail para enviar o pacote automaticamente'],
    docsUrl: '/painel/financeiro',
    testMode: false,
  },
  {
    key: 'AGENDA_ENTREGAS',
    label: 'Agenda e entregas',
    group: 'OPERACAO',
    provider: 'Agenda interna do Cenário Gestão (Google Agenda planejado)',
    auth: 'SESSAO',
    capabilities: [
      'Retiradas e entregas do dia com paradas',
      'Fotos e comprovante de entrega',
      'Saldo a receber antes da entrega',
    ],
    scopes: [],
    env: [],
    external: ['Para sincronizar com o Google Agenda: conectar a conta Google (planejado)'],
    docsUrl: '/painel/entregas',
    testMode: false,
  },
  ...(
    [
      ['GOOGLE_ADS', 'Google Ads', 'Campanhas e gastos do Google Ads'],
      ['GOOGLE_PERFIL', 'Perfil da Empresa no Google', 'Avaliações, fotos e mensagens do Perfil'],
      ['EMAIL', 'E-mail', 'Enviar pacote contábil, contratos e cobranças por e-mail'],
    ] as const
  ).map(
    ([key, label, cap]): ProviderDef => ({
      key,
      label,
      group: 'GOOGLE',
      provider: 'Planejada',
      auth: 'PLANEJADA',
      capabilities: [cap],
      scopes: [],
      env: [],
      external: [
        'Conexão ainda não implementada: depende da conta e do provedor usados pela Cenário',
      ],
      docsUrl: '',
      testMode: false,
    }),
  ),
];

export const providerDef = (key: string) => PROVIDERS.find((p) => p.key === key) ?? null;
export const missingEnv = (p: ProviderDef) => p.env.filter((e) => !process.env[e.name]?.trim());
export const testModeAllowed = () => process.env.APP_ENV !== 'production';

// ───────────────────────────── Cofre (segredos cifrados) ─────────────────────────────

function key() {
  const base = process.env.INTEGRATIONS_SECRET_KEY || process.env.TOKEN_HASH_SECRET || '';
  if (base.length < 32) throw new Error('Defina INTEGRATIONS_SECRET_KEY (mínimo 32 caracteres).');
  return createHash('sha256').update(`cenario-integracoes:${base}`).digest();
}

/** AES-256-GCM; o texto cifrado nunca sai do servidor. */
export function sealSecret(plain: Record<string, unknown>) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([c.update(JSON.stringify(plain), 'utf8'), c.final()]);
  return `v1.${iv.toString('base64')}.${c.getAuthTag().toString('base64')}.${enc.toString('base64')}`;
}

export function openSecret<T = Record<string, unknown>>(
  sealed: string | null | undefined,
): T | null {
  if (!sealed) return null;
  const [v, iv, tag, data] = sealed.split('.');
  if (v !== 'v1' || !iv || !tag || !data) return null;
  const d = createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return JSON.parse(
    Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8'),
  ) as T;
}
