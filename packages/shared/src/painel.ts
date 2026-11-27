import { z } from 'zod';

/**
 * Painel da plataforma, etapa 2 da lista de 53 melhorias (2026-11-27): PIX com QR Code (40),
 * comprovante pela tela (41), avisos no celular (43), demonstrações do site (44), origem (45),
 * linha do tempo (46), mensagens editáveis (47), preço de lançamento (48), telas usadas (49),
 * sugestões agrupadas (50) e encerrar empresa (51).
 */

// ─────────────────────────── PIX com QR Code (item 40) ───────────────────────────

/** Tira acentos e o que o PIX não aceita (nome e cidade vão em maiúsculas, sem acento). */
function pixText(s: string, max: number): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase()
    .slice(0, max)
    .trim();
}

function emv(id: string, value: string): string {
  return `${id}${String(value.length).padStart(2, '0')}${value}`;
}

/** CRC16-CCITT (polinômio 0x1021, início 0xFFFF), como pede o padrão do PIX. */
export function pixCrc16(payload: string): string {
  let crc = 0xffff;
  for (let i = 0; i < payload.length; i++) {
    crc ^= payload.charCodeAt(i) << 8;
    for (let b = 0; b < 8; b++)
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

/**
 * Normaliza a chave como o PIX espera: celular com +55, CPF/CNPJ só números, e-mail e chave
 * aleatória como estão.
 */
export function normalizePixKey(key: string): string {
  const k = key.trim();
  if (k.includes('@')) return k.toLowerCase();
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(k))
    return k.toLowerCase();
  const digits = k.replace(/\D/g, '');
  if (k.startsWith('+')) return `+${digits}`;
  // Celular com DDD (11 dígitos começando com 9 no terceiro) vira +55; CPF também tem 11
  // dígitos, então só vira celular se vier escrito como telefone: (12) 9...., 12 9.... etc.
  if (digits.length === 11 && /[()\s-]/.test(k) && digits[2] === '9') return `+55${digits}`;
  if (digits.length === 13 && digits.startsWith('55')) return `+${digits}`;
  if (digits.length === 11 || digits.length === 14) return digits;
  return k;
}

/**
 * "PIX copia e cola" (BR Code estático) com o valor certo: o QR Code e o texto que o cliente
 * cola no app do banco. O valor já vem preenchido, então o cliente não erra.
 */
export function pixBrCode(input: {
  key: string;
  name: string;
  city: string;
  amountCents: number;
  /** Identificação da cobrança (até 25 letras e números). */
  txid?: string;
}): string {
  const account = emv('00', 'br.gov.bcb.pix') + emv('01', normalizePixKey(input.key));
  const txid = (input.txid ?? '').replace(/[^A-Za-z0-9]/g, '').slice(0, 25) || '***';
  let payload =
    emv('00', '01') +
    emv('26', account) +
    emv('52', '0000') +
    emv('53', '986') +
    (input.amountCents > 0 ? emv('54', (input.amountCents / 100).toFixed(2)) : '') +
    emv('58', 'BR') +
    emv('59', pixText(input.name, 25) || 'CENARIO GESTAO') +
    emv('60', pixText(input.city, 15) || 'SAO PAULO') +
    emv('62', emv('05', txid));
  payload += '6304';
  return payload + pixCrc16(payload);
}

// ─────────────────────────── Comprovante pela tela (item 41) ───────────────────────────

export const PAYMENT_PROOF_MIMES = ['image/jpeg', 'image/png', 'application/pdf'] as const;
/** Base64 de até ~1,5 MB (foto reduzida no aparelho ou PDF do banco). */
export const PAYMENT_PROOF_MAX_BASE64 = 2_000_000;

export const paymentProofCreateSchema = z
  .object({
    amountCents: z.number().int().min(100, { message: 'Informe o valor pago.' }).max(10_000_000),
    paidOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'Informe o dia do pagamento.' }),
    mime: z.enum(PAYMENT_PROOF_MIMES, { message: 'Mande uma foto (JPG ou PNG) ou um PDF.' }),
    data: z
      .string()
      .min(100, { message: 'Escolha a foto ou o PDF do comprovante.' })
      .max(PAYMENT_PROOF_MAX_BASE64, {
        message: 'O arquivo é grande demais. Mande uma foto ou um print do comprovante.',
      })
      .regex(/^[A-Za-z0-9+/=]+$/, { message: 'Arquivo inválido.' }),
    note: z.string().trim().max(300).optional(),
  })
  .strict();
export type PaymentProofCreateInput = z.infer<typeof paymentProofCreateSchema>;

export type PaymentProofStatus = 'PENDENTE' | 'CONFIRMADO' | 'RECUSADO';

/** O comprovante como a empresa vê na tela Assinatura. */
export interface CompanyPaymentProofDto {
  id: string;
  amountCents: number;
  paidOn: string;
  status: PaymentProofStatus;
  rejectReason: string | null;
  createdAt: string;
}

/** O comprovante como o dono da plataforma vê (Cobrança → Comprovantes para conferir). */
export interface PlatformPaymentProofDto extends CompanyPaymentProofDto {
  companyId: number;
  tradeName: string;
  mime: string;
  note: string | null;
  sentBy: string | null;
  /** O que a empresa paga por ciclo, para conferir com o valor do comprovante. */
  expectedCents: number;
}

export const paymentProofRejectSchema = z
  .object({ reason: z.string().trim().min(3, { message: 'Diga o motivo.' }).max(300) })
  .strict();

// ─────────────────────────── Demonstração pelo site (item 44) ───────────────────────────

export const demoRequestSchema = z.object({
  name: z.string().trim().min(2, { message: 'Informe o seu nome.' }).max(120),
  businessName: z.string().trim().max(120).optional(),
  city: z.string().trim().max(80).optional(),
  phone: z
    .string()
    .trim()
    .transform((v) => v.replace(/\D/g, ''))
    .refine((v) => v.length >= 10 && v.length <= 13, {
      message: 'Informe o celular com DDD.',
    }),
  preferredAt: z.string().datetime({ offset: true }),
  origem: z.string().trim().max(160).optional(),
  /** Campo-isca (só robô preenche). */
  website: z.string().max(200).optional(),
  captcha: z.string().max(4000).optional(),
});
export type DemoRequestInput = z.infer<typeof demoRequestSchema>;

/** Horários oferecidos (seg a sáb, 9h, 14h e 17h, horário de Brasília), a partir de amanhã. */
export function demoSlots(from: Date, count = 9): Date[] {
  const out: Date[] = [];
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(from);
  let t = Date.parse(`${day}T12:00:00Z`);
  while (out.length < count) {
    t += 86_400_000;
    const d = new Date(t);
    if (d.getUTCDay() === 0) continue;
    const ymd = d.toISOString().slice(0, 10);
    for (const h of [9, 14, 17]) {
      if (out.length >= count) break;
      out.push(new Date(`${ymd}T${String(h).padStart(2, '0')}:00:00-03:00`));
    }
  }
  return out;
}

export interface PlatformDemoDto {
  id: string;
  name: string;
  businessName: string | null;
  city: string | null;
  phone: string | null;
  preferredAt: string;
  note: string | null;
  status: 'PENDENTE' | 'FEITO' | 'CANCELADO';
  createdAt: string;
  whatsappUrl: string | null;
}

// ─────────────────────────── De onde veio (item 45) ───────────────────────────

export const SIGNUP_SOURCES = [
  'SITE',
  'BLOG',
  'INDICACAO',
  'ANUNCIO',
  'DEMONSTRACAO',
  'OUTRO',
] as const;
export type SignupSource = (typeof SIGNUP_SOURCES)[number];
export const SIGNUP_SOURCE_LABEL: Record<SignupSource, string> = {
  SITE: 'Site',
  BLOG: 'Blog',
  INDICACAO: 'Indicação',
  ANUNCIO: 'Anúncio',
  DEMONSTRACAO: 'Demonstração',
  OUTRO: 'Outro',
};

/**
 * Origem do cadastro a partir do que o site guardou da primeira visita: `?origem=` ou
 * `utm_source`, quem indicou (`?indicacao=`), vindo do blog, ou anúncio (`gclid`/`fbclid`).
 */
export function signupSourceFrom(raw: string | undefined | null): {
  source: SignupSource;
  detail: string | null;
} {
  const r = (raw ?? '').trim().slice(0, 300);
  if (!r) return { source: 'SITE', detail: null };
  const [kind, ...rest] = r.split(':');
  const detail = rest.join(':').trim().slice(0, 160) || null;
  const k = (kind ?? '').toLowerCase();
  if (k === 'blog') return { source: 'BLOG', detail };
  if (k === 'indicacao' || k === 'indicação') return { source: 'INDICACAO', detail };
  if (k === 'anuncio' || k === 'anúncio') return { source: 'ANUNCIO', detail };
  if (['google', 'facebook', 'instagram', 'meta', 'ads', 'cpc'].includes(k))
    return { source: 'ANUNCIO', detail: (detail ? `${kind}: ${detail}` : kind!).slice(0, 160) };
  if (k === 'demonstracao' || k === 'demo') return { source: 'DEMONSTRACAO', detail };
  if (k === 'site') return { source: 'SITE', detail };
  return { source: 'OUTRO', detail: r.slice(0, 160) };
}

// ─────────────────────────── Mensagens prontas (item 47) ───────────────────────────

export const MESSAGE_TEMPLATE_KEYS = [
  'contato',
  'contatoPasso',
  'cobrancaTeste',
  'cobranca',
  'comprovante',
] as const;
export type MessageTemplateKey = (typeof MESSAGE_TEMPLATE_KEYS)[number];

export const MESSAGE_TEMPLATE_LABEL: Record<MessageTemplateKey, { label: string; hint: string }> = {
  contato: {
    label: 'Boas-vindas (primeiro contato)',
    hint: 'Botão WhatsApp da aba Empresas, para quem fez tudo do começo ou ainda não começou.',
  },
  contatoPasso: {
    label: 'Parou no começo',
    hint: 'Botão WhatsApp da aba Empresas, para quem parou num passo do começo.',
  },
  cobrancaTeste: {
    label: 'Teste acabando',
    hint: 'Botão de cobrança, para quem está no teste grátis.',
  },
  cobranca: { label: 'Cobrança da mensalidade', hint: 'Botão de cobrança da aba Cobrança.' },
  comprovante: {
    label: 'Mensagem do cliente para você',
    hint: 'O texto que já vem pronto quando o cliente toca em falar com você pelo WhatsApp.',
  },
};

export const DEFAULT_MESSAGE_TEMPLATES: Record<MessageTemplateKey, string> = {
  contato:
    'Olá, {nome}! Aqui é do Cenário Gestão. Vi que a {empresa} criou uma conta no sistema. Posso ajudar a começar?',
  contatoPasso:
    'Olá, {nome}! Aqui é do Cenário Gestão. Vi que a {empresa} ainda não fez o passo "{passo}". Quer que eu te ajude agora? É rapidinho.',
  cobrancaTeste:
    'Olá, {nome}! Aqui é do Cenário Gestão. O teste grátis da {empresa} vai até {vencimento}. Para continuar, o valor é {valor}. O PIX já vem com o valor certo na tela Assinatura.',
  cobranca:
    'Olá, {nome}! Aqui é do Cenário Gestão. A mensalidade da {empresa} ({valor}) vence em {vencimento}. O PIX já vem com o valor certo na tela Assinatura. Qualquer dúvida, é só chamar.',
  comprovante:
    'Olá! Sou da {empresa} e quero continuar com o Cenário Gestão ({valor}). Tenho uma dúvida sobre o pagamento.',
};

export const MESSAGE_PLACEHOLDERS = ['{nome}', '{empresa}', '{valor}', '{vencimento}', '{passo}'];

/** Troca os marcadores pelos dados da empresa (marcador sem dado some, sem deixar sobra). */
export function fillTemplate(text: string, data: Partial<Record<string, string>>): string {
  return text
    .replace(/\{(nome|empresa|valor|vencimento|passo|pix)\}/g, (_m, k: string) => data[k] ?? '')
    .replace(/Olá, !/g, 'Olá!')
    .replace(/\s+([,.!?])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

const templateText = z
  .string()
  .trim()
  .max(600, { message: 'No máximo 600 caracteres.' })
  .transform((v) => (v === '' ? null : v))
  .nullable()
  .optional();
export const messageTemplatesSchema = z
  .object({
    contato: templateText,
    contatoPasso: templateText,
    cobrancaTeste: templateText,
    cobranca: templateText,
    comprovante: templateText,
  })
  .strict();

// ─────────────────────────── Linha do tempo (item 46) ───────────────────────────

export type TimelineKind =
  | 'cadastro'
  | 'conversa'
  | 'pagamento'
  | 'comprovante'
  | 'aviso'
  | 'mudanca'
  | 'ajuda'
  | 'sugestao';

export interface TimelineItemDto {
  at: string;
  kind: TimelineKind;
  text: string;
}

export const timelineNoteSchema = z
  .object({ text: z.string().trim().min(2, { message: 'Escreva a conversa.' }).max(280) })
  .strict();

// ─────────────────────────── Telas usadas (item 49) ───────────────────────────

/** Telas do menu do painel (para mostrar as que ninguém usa). */
export const SCREEN_LABELS: Record<string, string> = {
  painel: 'Início',
  'painel/escritorio': 'Escritório',
  'painel/atencao': 'Avisos e pendências',
  'painel/financeiro': 'Financeiro',
  'painel/orcamentos': 'Orçamentos',
  'painel/servicos/novo': 'Fechar serviço',
  'painel/pedidos': 'Pedidos',
  'painel/retiradas': 'Retiradas',
  'painel/roteiro': 'Roteiro do dia',
  'painel/os': 'Ordens de serviço',
  'painel/retrabalhos': 'Retrabalhos',
  'painel/qualidade': 'Qualidade',
  'painel/entregas': 'Expedição e entregas',
  'painel/clientes': 'Clientes',
  'painel/producao/hoje': 'Hoje na oficina',
  'painel/producao/programacao': 'Semana da oficina',
  'painel/producao': 'Quadro de produção',
  'painel/reprogramacao': 'Reprogramação',
  'painel/producao/mapa': 'Mapa da oficina',
  'painel/estoque-oficina': 'Estoque da oficina',
  'painel/funcionarios': 'Equipe',
  'painel/presenca': 'Presença da equipe',
  'painel/produtividade': 'Produtividade',
  'painel/funcoes': 'Funções e permissões',
  'painel/empresa': 'Empresa',
  'painel/dispositivos': 'Tablets e acessos',
  'painel/assinatura': 'Assinatura',
  'painel/auditoria': 'Histórico de alterações',
  'painel/aplicativos': 'Aplicativos conectados',
  'painel/sincronizacao': 'Sincronização',
  'painel/resumo': 'Resumo da semana',
  'painel/lixeira': 'Lixeira',
  'painel/conta': 'Minha conta',
  'painel/comecar': 'Perguntas do começo',
  'painel/producao/modelos': 'Modelos de serviço',
};

/** Chave da tela a partir do endereço do painel (sem números nem códigos de registro). */
export function screenKeyFor(pathname: string): string | null {
  const parts = pathname.toLowerCase().split('?')[0]!.split('/').filter(Boolean);
  if (parts[0] !== 'painel') return null;
  const three = parts.slice(0, 3).join('/');
  if (SCREEN_LABELS[three]) return three;
  const two = parts.slice(0, 2).join('/');
  return /^[a-z0-9/-]{2,60}$/.test(two) ? two : null;
}

export const screenViewSchema = z
  .object({
    screen: z
      .string()
      .regex(/^painel(\/[a-z0-9-]+){0,2}$/)
      .max(60),
  })
  .strict();

export interface ScreenUsageDto {
  /** Dias considerados (últimos 30). */
  days: number;
  companies: number;
  items: { screen: string; label: string; companies: number; views: number }[];
  /** Telas do menu que nenhuma empresa abriu no período. */
  unused: { screen: string; label: string }[];
}

// ─────────────────────────── Sugestões agrupadas (item 50) ───────────────────────────

export interface FeedbackGroupDto {
  key: string;
  title: string;
  companies: number;
  count: number;
  lastAt: string;
  items: { id: string; companyName: string; message: string; createdAt: string }[];
}

const STOP = new Set(
  'a o e de da do das dos em no na nos nas um uma para pra por com que se ser ter mais muito como quando onde sistema tela poder pode podia seria gostaria queria favor ao aos as os é eu meu minha nao não sim já tambem também isso esse essa este esta'.split(
    ' ',
  ),
);

/** Palavras que contam (sem acento, sem as comuns, no singular aproximado). */
export function feedbackWords(text: string): string[] {
  return [
    ...new Set(
      text
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9 ]+/g, ' ')
        .split(/\s+/)
        .filter((w) => w.length >= 3 && !STOP.has(w))
        .map((w) => (w.length > 4 && w.endsWith('s') ? w.slice(0, -1) : w)),
    ),
  ];
}

/**
 * Junta pedidos parecidos (mesmas palavras importantes, de empresas diferentes ou não): dois
 * pedidos entram no mesmo grupo quando dividem pelo menos metade das palavras do menor (e no
 * mínimo 2).
 */
export function groupFeedback<T extends { id: string; message: string }>(rows: T[]): T[][] {
  const words = rows.map((r) => feedbackWords(r.message));
  const parent = rows.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let i = 0; i < rows.length; i++)
    for (let j = i + 1; j < rows.length; j++) {
      const a = words[i]!;
      const b = new Set(words[j]!);
      const shared = a.filter((w) => b.has(w)).length;
      const min = Math.min(a.length, b.size);
      if (min > 0 && shared >= 2 && shared >= Math.ceil(min / 2)) parent[find(j)] = find(i);
    }
  const groups = new Map<number, T[]>();
  rows.forEach((r, i) => {
    const g = find(i);
    groups.set(g, [...(groups.get(g) ?? []), r]);
  });
  return [...groups.values()];
}

// ─────────────────────────── Encerrar empresa (item 51) ───────────────────────────

export const CLOSE_KEEP_DAYS = 90;

export const companyCloseSchema = z
  .object({
    reason: z.string().trim().min(3, { message: 'Diga o motivo.' }).max(300),
    /** O nome da empresa digitado, para confirmar. */
    confirmName: z.string().trim().max(120),
  })
  .strict();

export const companyPurgeSchema = z.object({ confirmName: z.string().trim().max(120) }).strict();

// ─────────────────────────── Avisos no celular (item 43) ───────────────────────────

export const platformPushSchema = z
  .object({
    endpoint: z.string().url().max(1000),
    keys: z.object({ p256dh: z.string().min(10).max(200), auth: z.string().min(4).max(100) }),
  })
  .strict();
