import { z } from 'zod';
import type { PieceType, ServiceType } from './domain';

/**
 * Módulo Orçamentos — proposta comercial com materiais automáticos.
 *
 * A "base de dados" do orçamento (materiais com preço, cidades da logística, serviços do tapeceiro
 * e do ajudante, taxas da máquina e tapeceiros responsáveis) é própria do módulo e não depende de
 * compras, medições, fornecedores nem do estoque. O cálculo fica aqui (fonte única): a tela mostra
 * o mesmo número que a API grava.
 */

export const QUOTE_CATALOG_KINDS = [
  'MATERIAL',
  'LOGISTICA',
  'MAO_TAPECEIRO',
  'MAO_AJUDANTE',
  'TAXA_MAQUINA',
  'TAPECEIRO',
] as const;
export type QuoteCatalogKind = (typeof QUOTE_CATALOG_KINDS)[number];

export const QUOTE_MATERIAL_CATEGORIES = ['Tecidos', 'Espumas', 'Insumos', 'Madeiramento'] as const;
export type QuoteMaterialCategory = (typeof QUOTE_MATERIAL_CATEGORIES)[number];

export const QUOTE_UNITS = [
  'un',
  'm',
  'm²',
  'm³',
  'kg',
  'L',
  'cx',
  'pct',
  'rolo',
  'chapa',
] as const;
export const QUOTE_UNIT_LABEL: Record<(typeof QUOTE_UNITS)[number], string> = {
  un: 'Unidade',
  m: 'Metro',
  'm²': 'Metro quadrado',
  'm³': 'Metro cúbico',
  kg: 'Quilograma',
  L: 'Litro',
  cx: 'Caixa',
  pct: 'Pacote',
  rolo: 'Rolo',
  chapa: 'Chapa',
};

export const QUOTE_OTHER_SERVICE = 'Outro serviço';
export const QUOTE_SERVICES = [
  'Reforma de Sofá',
  'Reforma de Poltrona',
  'Reforma de Cadeiras',
  'Reforma de Banquetas',
  'Reforma de Bancos',
  'Reforma de Namoradeira',
  'Reforma de Chaise Longue',
  'Reforma de Recamier',
  'Reforma de Divã',
  'Reforma de Puff',
  'Reforma de Cabeceira',
  'Reforma de Cama Box',
  'Reforma de Almofadas',
  'Reforma de Colchonetes',
  'Reparo de Assentos',
  'Reparo de Encostos',
  'Reparo de Estruturas',
  'Reparo de Molas',
  'Troca de Espumas',
  'Troca de Tecidos',
  'Troca de Revestimentos',
  'Estruturação de Estofados',
  'Fabricação de Sofás',
  'Fabricação de Poltronas',
  'Fabricação de Puffs',
  'Fabricação de Cabeceiras',
  'Fabricação de Bancos',
  'Fabricação de Almofadas',
  'Fabricação de Estofados Sob Medida',
  'Revestimento de Estofados',
  'Confecção de Capas',
  'Impermeabilização de Estofados',
  'Higienização de Estofados',
  'Tapeçaria Automotiva',
  'Reforma de Bancos Automotivos',
  'Reforma de Estofados Náuticos',
  'Reforma de Estofados Comerciais',
  QUOTE_OTHER_SERVICE,
] as const;

export const QUOTE_DELIVERY_DAYS = [10, 15, 20] as const;

export const QUOTE_DEFAULT_PAYMENT =
  'Valor à vista: 50% na entrada e 50% na entrega do serviço.\nValor parcelado: em até 12 vezes, com taxa da máquina.';
export const QUOTE_DEFAULT_NOTES =
  '• Nossos serviços são especializados em tapeçaria e estofados, não contemplando serviços de marcenaria, serralheria ou outros serviços estruturais não relacionados à tapeçaria.\n• Após a aprovação e aceite da proposta comercial, será elaborado o contrato de prestação de serviços.\n• Os serviços serão executados conforme as especificações, materiais e condições descritas na proposta aprovada.\n• Alterações ou serviços adicionais solicitados após a aprovação poderão gerar custos extras.\n• A execução será iniciada após a formalização da contratação e alinhamento das condições comerciais.';

/** Cláusulas do contrato de garantia que acompanha a proposta salva (texto do dono). */
export const QUOTE_CONTRACT_CLAUSES: readonly [string, string][] = [
  [
    '1. Prazo de garantia',
    'A CONTRATADA oferece garantia contratual de 03 (três) meses, contados a partir da data de entrega do serviço, cobrindo falhas comprovadamente relacionadas à execução dos serviços de tapeçaria, como descosturas, pontos soltos, resíduos de cola e danos ao tecido ocasionados durante o transporte realizado pela CONTRATADA.',
  ],
  [
    '2. Exclusões da garantia',
    'A garantia não cobre danos decorrentes de mau uso, animais domésticos, acidentes, desgaste natural, produtos de limpeza inadequados, umidade, exposição excessiva ao sol, intervenções de terceiros ou problemas estruturais preexistentes, desde que não sejam decorrentes de falha de responsabilidade da CONTRATADA.',
  ],
  [
    '3. Conservação dos estofados',
    'O CONTRATANTE deverá seguir as orientações de conservação e limpeza dos tecidos, evitando produtos químicos inadequados, alvejantes, atritos excessivos, objetos cortantes, umidade e exposição solar prolongada.',
  ],
  [
    '4. Serviços adicionais e terceiros',
    'Serviços não previstos na contratação original, alterações de escopo e reparos adicionais dependerão de orçamento complementar e aprovação prévia do CONTRATANTE. A CONTRATADA não se responsabiliza por danos comprovadamente causados por serviços realizados por terceiros.',
  ],
  [
    '5. Condições preexistentes',
    'A CONTRATADA não se responsabiliza por problemas estruturais, desgastes ou defeitos anteriores à reforma que não façam parte dos serviços contratados e não tenham sido causados ou agravados por sua atuação. Caso sejam identificadas necessidades adicionais durante a execução, o CONTRATANTE será informado previamente, podendo ser apresentado orçamento complementar.',
  ],
  [
    '6. Entrega e conferência do serviço',
    'O CONTRATANTE poderá conferir visualmente o serviço no momento da entrega, verificando revestimento, acabamento e costuras. Eventuais problemas deverão ser comunicados à CONTRATADA para avaliação. O recebimento do produto não representa renúncia aos direitos relativos a vícios ocultos ou demais direitos previstos em lei.',
  ],
  [
    '7. Assistência técnica',
    'Toda solicitação de assistência técnica deverá ser comunicada diretamente à CONTRATADA, preferencialmente acompanhada de fotos ou vídeos. A CONTRATADA poderá solicitar a apresentação do produto para avaliação e identificação da origem do problema.',
  ],
  [
    '8. Após o prazo de garantia',
    'Após os 03 (três) meses de garantia contratual, eventuais reparos, ajustes ou manutenções estarão sujeitos à avaliação técnica e à apresentação de novo orçamento, incluindo custos de mão de obra e materiais, mediante aprovação prévia do CONTRATANTE, respeitadas as garantias e obrigações previstas em lei.',
  ],
  [
    '9. Disposições finais',
    'A garantia contratual complementa a garantia legal, não excluindo nem restringindo os direitos assegurados ao CONTRATANTE pelo Código de Defesa do Consumidor e demais legislações aplicáveis.',
  ],
];

// ─────────────────────────── DTOs ───────────────────────────

export interface QuoteCatalogItemDto {
  id: string;
  kind: QuoteCatalogKind;
  /** Só materiais: Tecidos, Espumas, Insumos ou Madeiramento. */
  category: QuoteMaterialCategory | null;
  name: string;
  /** Preço do material, valor da logística ou custo do serviço. Vazio = ainda não cadastrado. */
  priceCents: number | null;
  unit: string | null;
  /** Logística: distância de ida e volta. */
  km: number | null;
  /** Taxa da máquina (pontos-base: 250 = 2,5%). Vazio = não cadastrada. */
  rateBps: number | null;
  /** Tapeceiro responsável: telefone. */
  phone: string | null;
  /** Serviço do ajudante criado a partir de um serviço do tapeceiro (mesmo nome). */
  linkedItemId: string | null;
  position: number;
}

export interface QuoteSettingsDto {
  /** Alíquota do serviço/imposto em pontos-base (600 = 6%). Vazio = não cadastrada. */
  taxRateBps: number | null;
  /** Nome exibido na proposta (o definido aqui ou, vazio, o nome da Empresa). */
  companyName: string;
  companyNameOverride: string | null;
  logoDataUrl: string | null;
  /** Melhoria 141: textos da proposta como a empresa escreveu (nulo = padrão do sistema). */
  proposalTitle: string | null;
  proposalIntro: string | null;
  proposalThanks: string | null;
  /** Número que o próximo orçamento salvo vai receber (a empresa pode adiantar a numeração). */
  nextNumber: number;
  version: number;
}

export interface QuoteSummaryDto {
  id: string;
  number: number;
  createdAt: string;
  customerName: string;
  phone: string | null;
  service: string;
  totalCents: number;
  hasWorkOrder: boolean;
  /** Melhoria 77: situação do orçamento. */
  status: QuoteStatus;
  statusChangedAt: string | null;
  /** Quando cobrar o cliente (só para orçamentos enviados). */
  followUpAt: string | null;
  /** O lembrete já venceu: hora de cobrar o cliente. */
  followUpDue: boolean;
  lostReason: string | null;
  /** Melhoria 79: aceite (pelo link do cliente ou marcado no painel). */
  approvedAt: string | null;
  approvedVia: 'LINK' | 'PAINEL' | null;
  /** O cliente já abriu o link da proposta. */
  linkViewedAt: string | null;
  /** Melhoria 78: pedido criado a partir do orçamento. */
  orderId: string | null;
}

// ─────────────────────────── Situação e funil (melhorias 77 a 81) ───────────────────────────

export const QUOTE_STATUSES = ['ENVIADO', 'APROVADO', 'RECUSADO', 'SEM_RESPOSTA'] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];
export const QUOTE_STATUS_LABEL: Record<QuoteStatus, string> = {
  ENVIADO: 'Enviado',
  APROVADO: 'Aprovado',
  RECUSADO: 'Recusado',
  SEM_RESPOSTA: 'Sem resposta',
};
export const isQuoteStatus = (v: string): v is QuoteStatus =>
  (QUOTE_STATUSES as readonly string[]).includes(v);

/** Dias até o lembrete de cobrar o cliente, contados de quando o orçamento é salvo. */
export const QUOTE_FOLLOW_UP_DAYS = 3;

/** Motivos de recusa mais comuns (a tela oferece estes e aceita texto livre). */
export const QUOTE_LOST_REASONS = [
  'Preço',
  'Prazo',
  'Fechou com outra tapeçaria',
  'Desistiu do serviço',
  'Sem retorno do cliente',
] as const;

export const quoteStatusSchema = z
  .object({
    version: z.number().int().min(1),
    status: z.enum(QUOTE_STATUSES),
    lostReason: z.string().trim().max(300).nullable().optional(),
    /** Nova data do lembrete (AAAA-MM-DD); vazio = sem lembrete. */
    followUpDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'Data inválida.' })
      .nullable()
      .optional(),
  })
  .refine((v) => v.status !== 'RECUSADO' || Boolean(v.lostReason), {
    message: 'Informe o motivo da recusa.',
    path: ['lostReason'],
  });
export type QuoteStatusInput = z.infer<typeof quoteStatusSchema>;

/** Funil de vendas do período (melhoria 81). */
export interface QuoteFunnelDto {
  from: string;
  to: string;
  total: { count: number; cents: number };
  byStatus: Record<QuoteStatus, { count: number; cents: number }>;
  /** Orçamentos aprovados que já viraram pedido (serviço fechado). */
  converted: { count: number; cents: number };
  /** Percentual aprovado sobre os já respondidos (aprovado + recusado + sem resposta). */
  approvalRateBps: number | null;
  lostReasons: { reason: string; count: number; cents: number }[];
  /** Orçamentos enviados com o lembrete vencido (cobrar o cliente). */
  followUpDue: number;
}

/** Proposta vista pelo cliente no link (melhoria 79). Só o que está na proposta impressa. */
export interface PublicQuoteDto {
  number: number;
  companyName: string;
  logoDataUrl: string | null;
  issuedAt: string;
  customerName: string;
  /** Telefone do próprio cliente, como na proposta impressa. */
  customerPhone: string;
  city: string;
  service: string;
  fabrics: string[];
  foamChange: boolean;
  fabricChange: boolean;
  sofaCount: number;
  totalCents: number;
  installmentTotalCents: number | null;
  /** Nome da opção de pagamento a prazo (ex.: "Cartão de crédito"), como na proposta impressa. */
  paymentOptionName: string | null;
  installments: number | null;
  deliveryDays: number | null;
  validityDays: number | null;
  /** Fim da validade (AAAA-MM-DD) ou nulo. */
  validUntil: string | null;
  expired: boolean;
  paymentTerms: string;
  notes: string;
  status: QuoteStatus;
  approvedAt: string | null;
  /** Telefone de contato da empresa (WhatsApp), quando cadastrado. */
  companyPhone: string | null;
  /** Melhoria 141: textos da proposta gravados no orçamento (nulo nos antigos = padrões). */
  texts: ProposalTexts | null;
}

export interface QuoteSnapshotLine {
  category: QuoteMaterialCategory;
  name: string;
  unit: string;
  qty: number;
  heightCm: number;
  widthCm: number;
  lengthCm: number;
  unitPriceCents: number;
  costCents: number;
}

/**
 * Melhoria 141: textos fixos da proposta, mais diretos (a empresa pode trocar na Base de dados).
 * `{nome}` no texto de abertura vira o primeiro nome do cliente.
 */
export const DEFAULT_PROPOSAL_TEXTS = {
  title: 'Proposta para o seu estofado',
  intro: 'Olá, {nome}! Segue o orçamento do serviço que conversamos, com o valor e as condições.',
  thanks:
    'Obrigado pela preferência. Qualquer dúvida sobre o serviço, o tecido ou o prazo, é só chamar.',
} as const;
export type ProposalTexts = { title: string; intro: string; thanks: string };

export function proposalTexts(
  s: Partial<Pick<QuoteSettingsDto, 'proposalTitle' | 'proposalIntro' | 'proposalThanks'>>,
): ProposalTexts {
  return {
    title: s.proposalTitle || DEFAULT_PROPOSAL_TEXTS.title,
    intro: s.proposalIntro || DEFAULT_PROPOSAL_TEXTS.intro,
    thanks: s.proposalThanks || DEFAULT_PROPOSAL_TEXTS.thanks,
  };
}

/** Cópia completa do orçamento no momento em que foi salvo (a proposta nunca muda depois). */
export interface QuoteSnapshot {
  companyName: string;
  logoDataUrl: string | null;
  /** Textos da proposta no momento em que foi salva (ausente nos orçamentos antigos). */
  texts?: ProposalTexts;
  issuedAt: string;
  customerName: string;
  phone: string;
  city: string;
  service: string;
  foamChange: boolean;
  fabricChange: boolean;
  fabrics: string[];
  lines: QuoteSnapshotLine[];
  logistics: { name: string; km: number; priceCents: number } | null;
  upholstery: { name: string; priceCents: number } | null;
  helper: { name: string; priceCents: number } | null;
  sofaCount: number;
  fee: { name: string; rateBps: number; installments: number } | null;
  totals: {
    materialsCents: number;
    logisticsCents: number;
    upholsteryCents: number;
    helperCents: number;
    laborCents: number;
    costCents: number;
    profitCents: number;
    taxRateBps: number;
    taxCents: number;
    totalCents: number;
    installmentTotalCents: number | null;
  };
  deliveryDays: number | null;
  validityDays: number | null;
  paymentTerms: string;
  notes: string;
}

export const WORK_ORDER_CHOICES = ['Sim', 'Não'] as const;
export const WORK_ORDER_REPAIR_CHOICES = ['Sim', 'Não', 'Avaliar'] as const;

export const workOrderItemSchema = z.object({
  category: z.enum(QUOTE_MATERIAL_CATEGORIES),
  name: z.string().max(160),
  unit: z.string().max(20),
  qty: z.number().min(0),
  heightCm: z.number().min(0),
  widthCm: z.number().min(0),
  lengthCm: z.number().min(0),
  budgetPriceCents: z.number().int().min(0).nullable(),
  realQty: z.number().min(0).max(1_000_000),
  costCents: z.number().int().min(0).max(10_000_000_000),
});

/** Até ~1,5 MB de imagem (a tela reduz para 1100 px em JPEG antes de enviar). */
const photoSchema = z
  .string()
  .max(2_000_000, { message: 'Foto muito grande.' })
  .regex(/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/, { message: 'Foto inválida.' })
  .nullable();

/** Ordem de serviço do orçamento: custos reais e dados da execução (documento interno). */
export const workOrderSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, { message: 'Data inválida.' }),
  upholsteryCents: z.number().int().min(0).max(10_000_000_000),
  responsibleId: z.guid({ message: 'Selecione o tapeceiro responsável.' }),
  responsibleName: z.string().max(120).optional(),
  fabricName: z.string().trim().max(160),
  fabricMeters: z.number().min(0).max(100_000).nullable(),
  keepOriginal: z.enum(WORK_ORDER_CHOICES),
  changeFoam: z.enum(WORK_ORDER_CHOICES),
  changeFabric: z.enum(WORK_ORDER_CHOICES),
  repairStructure: z.enum(WORK_ORDER_REPAIR_CHOICES),
  notes: z.string().max(4000),
  photoDataUrl: photoSchema,
  items: z.array(workOrderItemSchema).max(500),
});
export type QuoteWorkOrder = z.infer<typeof workOrderSchema>;

export interface QuoteDto extends QuoteSummaryDto {
  snapshot: QuoteSnapshot;
  workOrder: QuoteWorkOrder | null;
  version: number;
}

// ─────────────────────────── Entradas ───────────────────────────

const cents = z.number().int().min(0).max(10_000_000_000);
const bps = z
  .number()
  .int()
  .min(0)
  .max(9_999, { message: 'Informe um percentual abaixo de 100%.' });
const nameText = z.string().trim().min(1, { message: 'Informe o nome.' }).max(160);

export const quoteCatalogCreateSchema = z
  .object({
    kind: z.enum(QUOTE_CATALOG_KINDS),
    category: z.enum(QUOTE_MATERIAL_CATEGORIES).nullable().optional(),
    name: nameText,
    priceCents: cents.nullable().optional(),
    unit: z.enum(QUOTE_UNITS).nullable().optional(),
    km: z.number().min(0).max(100_000).nullable().optional(),
    rateBps: bps.nullable().optional(),
    phone: z.string().trim().max(40).nullable().optional(),
  })
  .refine((v) => v.kind !== 'MATERIAL' || Boolean(v.category), {
    message: 'Informe a categoria do material.',
    path: ['category'],
  });
export type QuoteCatalogCreateInput = z.infer<typeof quoteCatalogCreateSchema>;

export const quoteCatalogUpdateSchema = z.object({
  name: nameText.optional(),
  priceCents: cents.nullable().optional(),
  unit: z.enum(QUOTE_UNITS).nullable().optional(),
  km: z.number().min(0).max(100_000).nullable().optional(),
  rateBps: bps.nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
});
export type QuoteCatalogUpdateInput = z.infer<typeof quoteCatalogUpdateSchema>;

export const quoteSettingsUpdateSchema = z.object({
  version: z.number().int().min(1),
  taxRateBps: bps.nullable().optional(),
  companyNameOverride: z.string().trim().max(90).nullable().optional(),
  proposalTitle: z.string().trim().max(120).nullable().optional(),
  proposalIntro: z.string().trim().max(400).nullable().optional(),
  proposalThanks: z.string().trim().max(600).nullable().optional(),
  nextNumber: z
    .number({ message: 'Informe o número do próximo orçamento.' })
    .int({ message: 'Informe um número inteiro.' })
    .min(1, { message: 'Informe um número a partir de 1.' })
    .max(999_999_999, { message: 'Número muito grande.' })
    .optional(),
  logoDataUrl: z
    .string()
    .max(1_500_000, { message: 'Logotipo muito grande. Use um arquivo menor.' })
    .regex(/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/, { message: 'Logotipo inválido.' })
    .nullable()
    .optional(),
});

/** Backup da base de dados do orçamento (exportar/importar). */
export const quoteBackupSchema = z.object({
  items: z
    .array(
      z.object({
        kind: z.enum(QUOTE_CATALOG_KINDS),
        category: z.enum(QUOTE_MATERIAL_CATEGORIES).nullable(),
        name: nameText,
        priceCents: cents.nullable(),
        unit: z.string().max(20).nullable(),
        km: z.number().min(0).max(100_000).nullable(),
        rateBps: bps.nullable(),
        phone: z.string().trim().max(40).nullable(),
        /** Posição (na lista exportada) do serviço do tapeceiro ao qual o ajudante pertence. */
        linkedIndex: z.number().int().min(0).nullable().optional(),
      }),
    )
    .max(2000),
  taxRateBps: bps.nullable().optional(),
});
export type QuoteBackup = z.infer<typeof quoteBackupSchema>;

export const quoteDraftItemSchema = z.object({
  id: z.string().max(64),
  catalogItemId: z.guid(),
  qty: z.number().min(0).max(1_000_000),
  heightCm: z.number().min(0).max(100_000),
  widthCm: z.number().min(0).max(100_000),
  lengthCm: z.number().min(0).max(100_000),
});
export type QuoteDraftItem = z.infer<typeof quoteDraftItemSchema>;

/** Orçamento em elaboração (fica no navegador até ser salvo; a API recalcula tudo ao salvar). */
export const quoteDraftSchema = z.object({
  customerName: z.string().trim().max(160),
  phone: z.string().trim().max(20),
  city: z.string().trim().max(120),
  service: z.string().trim().max(120),
  serviceOther: z.string().trim().max(120),
  fabricChange: z.boolean(),
  foamChange: z.boolean(),
  items: z.array(quoteDraftItemSchema).max(500),
  logisticsId: z.guid().nullable(),
  upholsteryServiceId: z.guid().nullable(),
  helperServiceId: z.guid().nullable(),
  sofaCount: z.number().int().min(1).max(1000),
  profitCents: cents,
  feeId: z.guid().nullable(),
  deliveryDays: z.number().int().min(1).max(365).nullable(),
  validityDays: z.number().int().min(0).max(3650).nullable(),
  paymentTerms: z.string().max(4000),
  notes: z.string().max(8000),
});
export type QuoteDraft = z.infer<typeof quoteDraftSchema>;

export function emptyQuoteDraft(): QuoteDraft {
  return {
    customerName: '',
    phone: '',
    city: '',
    service: '',
    serviceOther: '',
    fabricChange: false,
    foamChange: false,
    items: [],
    logisticsId: null,
    upholsteryServiceId: null,
    helperServiceId: null,
    sofaCount: 1,
    profitCents: 0,
    feeId: null,
    deliveryDays: null,
    validityDays: 15,
    paymentTerms: QUOTE_DEFAULT_PAYMENT,
    notes: QUOTE_DEFAULT_NOTES,
  };
}

// ─────────────────────────── Cálculo ───────────────────────────

/** Categoria liberada pelas escolhas "Troca de tecido?" e "Troca de espuma?". */
export function quoteCategoryEnabled(
  category: string | null | undefined,
  d: Pick<QuoteDraft, 'fabricChange' | 'foamChange'>,
): boolean {
  if (category === 'Tecidos') return d.fabricChange;
  if (category === 'Espumas') return d.foamChange;
  return true;
}

/** Volume da espuma em m³ (medidas em cm). */
export const foamVolumeM3 = (h: number, w: number, l: number, qty = 1) =>
  (Math.max(0, h) / 100) * (Math.max(0, w) / 100) * (Math.max(0, l) / 100) * Math.max(0, qty);

/** Custo de um material (em reais, sem arredondar). `null` = material sem preço cadastrado. */
export function quoteItemCost(
  item: Pick<QuoteDraftItem, 'qty' | 'heightCm' | 'widthCm' | 'lengthCm'>,
  material: Pick<QuoteCatalogItemDto, 'category' | 'priceCents'> | undefined,
): number | null {
  if (!material || material.priceCents === null) return null;
  const price = material.priceCents / 100;
  return material.category === 'Espumas'
    ? foamVolumeM3(item.heightCm, item.widthCm, item.lengthCm, item.qty) * price
    : Math.max(0, item.qty) * price;
}

/** Número de parcelas no nome da modalidade ("12X" → 12; "À vista" → 0). */
export const installmentsOf = (name: string | null | undefined) =>
  Number(/^(\d+)\s*x/i.exec(String(name ?? '').trim())?.[1] ?? 0);

export const quoteServiceName = (d: Pick<QuoteDraft, 'service' | 'serviceOther'>) =>
  d.service === QUOTE_OTHER_SERVICE ? d.serviceOther.trim() : d.service.trim();

export interface QuoteTotals {
  materials: number;
  logistics: number;
  upholstery: number;
  helper: number;
  labor: number;
  cost: number;
  profit: number;
  taxPct: number;
  /** Alíquota inválida (≥ 100%) → null. */
  tax: number | null;
  total: number | null;
  profitPct: number | null;
  feePct: number | null;
  installmentTotal: number | null;
  installments: number;
  /** Algum preço, valor ou alíquota sem cadastro: o total é provisório. */
  pending: boolean;
}

/**
 * Totais do orçamento (valores em reais), exatamente como no modelo do dono:
 * custo = materiais + logística + (tapeceiro + ajudante) × sofás; o lucro é somado ao custo; o
 * imposto é embutido no preço à vista (arredondado para cima, em reais inteiros); o parcelado
 * embute a taxa da máquina: à vista ÷ (1 − taxa).
 */
export function calcQuote(
  d: QuoteDraft,
  catalog: readonly QuoteCatalogItemDto[],
  taxRateBps: number | null,
): QuoteTotals {
  const byId = new Map(catalog.map((c) => [c.id, c]));
  const vals = d.items
    .filter((i) => {
      const m = byId.get(i.catalogItemId);
      return !m || quoteCategoryEnabled(m.category, d);
    })
    .map((i) => quoteItemCost(i, byId.get(i.catalogItemId)));
  const materials = vals.reduce<number>((a, b) => a + (b ?? 0), 0);
  const route = d.logisticsId ? byId.get(d.logisticsId) : undefined;
  const ups = d.upholsteryServiceId ? byId.get(d.upholsteryServiceId) : undefined;
  const help = d.helperServiceId ? byId.get(d.helperServiceId) : undefined;
  const fee = d.feeId ? byId.get(d.feeId) : undefined;
  const sofas = Math.max(1, Math.floor(d.sofaCount || 1));
  const logistics = (route?.priceCents ?? 0) / 100;
  const upholstery = ((ups?.priceCents ?? 0) / 100) * sofas;
  const helper = ((help?.priceCents ?? 0) / 100) * sofas;
  const labor = upholstery + helper;
  const cost = materials + logistics + labor;
  const profit = Math.max(0, d.profitCents) / 100;
  const taxPct = (taxRateBps ?? 0) / 100;
  const total = taxPct < 100 ? Math.ceil((cost + profit) / (1 - taxPct / 100) - 1e-9) : null;
  const tax = total === null ? null : (total * taxPct) / 100;
  const feePct = fee ? (fee.rateBps === null ? null : fee.rateBps / 100) : null;
  const installmentTotal =
    feePct !== null && feePct < 100 && total !== null ? total / (1 - feePct / 100) : null;
  const pending =
    vals.some((v) => v === null) ||
    Boolean(d.logisticsId && (!route || route.priceCents === null)) ||
    Boolean(d.upholsteryServiceId && (!ups || ups.priceCents === null)) ||
    Boolean(d.helperServiceId && (!help || help.priceCents === null)) ||
    Boolean(d.feeId && (!fee || fee.rateBps === null)) ||
    taxRateBps === null;
  return {
    materials,
    logistics,
    upholstery,
    helper,
    labor,
    cost,
    profit,
    taxPct,
    tax,
    total,
    profitPct: cost > 0 ? (profit / cost) * 100 : null,
    feePct,
    installmentTotal,
    installments: fee ? installmentsOf(fee.name) : 0,
    pending,
  };
}

/** Motivo que impede salvar (ou null): mesmas regras do modelo original. */
export function quoteSaveBlocker(d: QuoteDraft, t: QuoteTotals): string | null {
  if (t.total === null || t.pending || (t.feePct !== null && t.installmentTotal === null))
    return 'Complete os preços pendentes e corrija as taxas antes de salvar.';
  if (!d.customerName.trim()) return 'Informe o nome do cliente antes de salvar.';
  return null;
}

const toCents = (reais: number) => Math.round(reais * 100);

/** Monta a cópia que será gravada (a API chama com a base de dados atual). */
export function buildQuoteSnapshot(
  d: QuoteDraft,
  catalog: readonly QuoteCatalogItemDto[],
  settings: Pick<QuoteSettingsDto, 'taxRateBps' | 'companyName' | 'logoDataUrl'> &
    Partial<Pick<QuoteSettingsDto, 'proposalTitle' | 'proposalIntro' | 'proposalThanks'>>,
  issuedAt: Date,
): QuoteSnapshot {
  const t = calcQuote(d, catalog, settings.taxRateBps);
  const byId = new Map(catalog.map((c) => [c.id, c]));
  const lines: QuoteSnapshotLine[] = [];
  for (const i of d.items) {
    const m = byId.get(i.catalogItemId);
    if (!m || m.kind !== 'MATERIAL' || !m.category || !quoteCategoryEnabled(m.category, d))
      continue;
    const foam = m.category === 'Espumas';
    lines.push({
      category: m.category,
      name: m.name,
      unit: m.unit ?? 'un',
      qty: i.qty,
      heightCm: foam ? i.heightCm : 0,
      widthCm: foam ? i.widthCm : 0,
      lengthCm: foam ? i.lengthCm : 0,
      unitPriceCents: m.priceCents ?? 0,
      costCents: toCents(quoteItemCost(i, m) ?? 0),
    });
  }
  const pick = (id: string | null) => (id ? byId.get(id) : undefined);
  const route = pick(d.logisticsId);
  const ups = pick(d.upholsteryServiceId);
  const help = pick(d.helperServiceId);
  const fee = pick(d.feeId);
  return {
    companyName: settings.companyName,
    logoDataUrl: settings.logoDataUrl,
    texts: proposalTexts(settings),
    issuedAt: issuedAt.toISOString(),
    customerName: d.customerName.trim(),
    phone: d.phone.trim(),
    city: d.city.trim(),
    service: quoteServiceName(d),
    foamChange: d.foamChange,
    fabricChange: d.fabricChange,
    fabrics: [...new Set(lines.filter((l) => l.category === 'Tecidos').map((l) => l.name))],
    lines,
    logistics: route
      ? { name: route.name, km: route.km ?? 0, priceCents: route.priceCents ?? 0 }
      : null,
    upholstery: ups ? { name: ups.name, priceCents: ups.priceCents ?? 0 } : null,
    helper: help ? { name: help.name, priceCents: help.priceCents ?? 0 } : null,
    sofaCount: Math.max(1, Math.floor(d.sofaCount || 1)),
    fee: fee
      ? { name: fee.name, rateBps: fee.rateBps ?? 0, installments: installmentsOf(fee.name) }
      : null,
    totals: {
      materialsCents: toCents(t.materials),
      logisticsCents: toCents(t.logistics),
      upholsteryCents: toCents(t.upholstery),
      helperCents: toCents(t.helper),
      laborCents: toCents(t.labor),
      costCents: toCents(t.cost),
      profitCents: toCents(t.profit),
      taxRateBps: settings.taxRateBps ?? 0,
      taxCents: toCents(t.tax ?? 0),
      totalCents: toCents(t.total ?? 0),
      installmentTotalCents: t.installmentTotal === null ? null : toCents(t.installmentTotal),
    },
    deliveryDays: d.deliveryDays,
    validityDays: d.validityDays,
    paymentTerms: d.paymentTerms,
    notes: d.notes,
  };
}

/** O.S. inicial a partir do orçamento salvo: quantidades e custos previstos. */
export function defaultWorkOrder(s: QuoteSnapshot, today: string): QuoteWorkOrder {
  return {
    date: today,
    upholsteryCents: s.totals.upholsteryCents,
    responsibleId: '',
    responsibleName: '',
    fabricName: '',
    fabricMeters: null,
    keepOriginal: 'Sim',
    changeFoam: 'Não',
    changeFabric: 'Não',
    repairStructure: 'Avaliar',
    notes: '',
    photoDataUrl: null,
    items: s.lines.map((l) => ({
      category: l.category,
      name: l.name,
      unit: l.unit,
      qty: l.qty,
      heightCm: l.heightCm,
      widthCm: l.widthCm,
      lengthCm: l.lengthCm,
      budgetPriceCents: l.unitPriceCents,
      realQty: l.qty,
      costCents: l.costCents,
    })),
  };
}

/** Telefone no formato (12) 99999-9999 enquanto digita. */
export function formatPhoneBr(v: string): string {
  const d = String(v || '')
    .replace(/\D/g, '')
    .slice(0, 11);
  if (!d) return '';
  if (d.length <= 2) return '(' + d;
  if (d.length <= 6) return '(' + d.slice(0, 2) + ') ' + d.slice(2);
  if (d.length <= 10) return '(' + d.slice(0, 2) + ') ' + d.slice(2, 6) + '-' + d.slice(6);
  return '(' + d.slice(0, 2) + ') ' + d.slice(2, 7) + '-' + d.slice(7);
}

/** Nome comparável (sem acento, maiúsculas e pontuação): liga tapeceiro e ajudante pelo serviço. */
export const normalizeQuoteName = (v: string) =>
  String(v || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

// ─────────────────────────── Editar um orçamento salvo ───────────────────────────

export const quoteUpdateSchema = z.object({
  version: z.number().int().min(1),
  draft: quoteDraftSchema,
});
export type QuoteUpdateInput = z.infer<typeof quoteUpdateSchema>;

/**
 * Reabre um orçamento salvo no "Elaborar": a cópia gravada guarda os nomes (não os cadastros),
 * então cada linha volta a apontar para o cadastro de mesmo nome na base de dados atual.
 * `missing` lista o que não existe mais na base (fica de fora e a pessoa escolhe de novo).
 */
export function quoteDraftFromSnapshot(
  s: QuoteSnapshot,
  catalog: readonly QuoteCatalogItemDto[],
): { draft: QuoteDraft; missing: string[] } {
  const missing: string[] = [];
  const norm = (v: string) => v.trim().toLocaleLowerCase('pt-BR');
  const find = (kind: QuoteCatalogKind, name: string, category?: string | null) =>
    catalog.find(
      (c) =>
        c.kind === kind &&
        norm(c.name) === norm(name) &&
        (category === undefined || c.category === category),
    ) ?? null;
  const ref = (kind: QuoteCatalogKind, v: { name: string } | null, label: string) => {
    if (!v) return null;
    const m = find(kind, v.name);
    if (!m) missing.push(`${label} "${v.name}"`);
    return m?.id ?? null;
  };
  const items: QuoteDraftItem[] = [];
  s.lines.forEach((l, i) => {
    const m = find('MATERIAL', l.name, l.category);
    if (!m) return void missing.push(`material "${l.name}"`);
    items.push({
      id: `e${i}`,
      catalogItemId: m.id,
      qty: l.qty,
      heightCm: l.heightCm,
      widthCm: l.widthCm,
      lengthCm: l.lengthCm,
    });
  });
  const known = (QUOTE_SERVICES as readonly string[]).includes(s.service);
  const draft: QuoteDraft = {
    customerName: s.customerName,
    phone: s.phone,
    city: s.city,
    service: known ? s.service : QUOTE_OTHER_SERVICE,
    serviceOther: known ? '' : s.service,
    fabricChange: s.fabricChange,
    foamChange: s.foamChange,
    items,
    logisticsId: ref('LOGISTICA', s.logistics, 'rota'),
    upholsteryServiceId: ref('MAO_TAPECEIRO', s.upholstery, 'serviço do tapeceiro'),
    helperServiceId: ref('MAO_AJUDANTE', s.helper, 'serviço do ajudante'),
    sofaCount: Math.max(1, s.sofaCount),
    profitCents: s.totals.profitCents,
    feeId: ref('TAXA_MAQUINA', s.fee, 'taxa'),
    deliveryDays: s.deliveryDays,
    validityDays: s.validityDays,
    paymentTerms: s.paymentTerms,
    notes: s.notes,
  };
  return { draft, missing };
}

// ─────────────────────────── Fechar serviço a partir do orçamento ───────────────────────────

/** Peça e tipo de serviço do pedido deduzidos do serviço escolhido no orçamento. */
export function quoteServiceToPiece(service: string): {
  pieceType: PieceType;
  serviceType: ServiceType;
} {
  const s = service.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const has = (...w: string[]) => w.some((x) => s.includes(x));
  const pieceType: PieceType = has('sofa', 'namoradeira', 'chaise', 'diva', 'recamier')
    ? 'SOFA'
    : has('poltrona')
      ? 'POLTRONA'
      : has('cadeira')
        ? 'CADEIRA'
        : has('cabeceira')
          ? 'CABECEIRA'
          : has('puff', 'pufe')
            ? 'PUFE'
            : has('banco', 'banqueta')
              ? 'BANCO'
              : has('colchonete', 'cama box', 'assento', 'almofada')
                ? 'COLCHAO'
                : 'OUTRO';
  const serviceType: ServiceType = has('troca de espuma')
    ? 'TROCA_DE_ESPUMA'
    : has('troca de tecido', 'troca de revestimento', 'revestimento de')
      ? 'TROCA_DE_TECIDO'
      : has('reparo')
        ? 'REPARO'
        : has('fabricacao', 'confeccao', 'estruturacao')
          ? 'FABRICACAO'
          : has('reforma')
            ? 'REFORMA_COMPLETA'
            : 'OUTRO';
  return { pieceType, serviceType };
}

/** Data prometida (AAAA-MM-DD) a partir do prazo do orçamento, contado de hoje. */
export function quotePromisedDate(deliveryDays: number | null, today: string): string {
  if (!deliveryDays) return '';
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + deliveryDays);
  return d.toISOString().slice(0, 10);
}
