import { z } from 'zod';
import { pinSchema } from './schemas/auth';

/**
 * Primeiro dia de uma empresa nova (lista de 53 melhorias, 26/11/2026).
 *
 * Item 2: as perguntas do primeiro acesso, com respostas de tocar, montam a base do orçamento
 * (peças, tecidos, espumas, frete, maquininha, imposto), o horário da oficina, o prazo do
 * orçamento, a logo da proposta e a meta do mês. A mão de obra entra só com o nome das peças
 * marcadas, com o preço em branco (decisão do dono: o valor varia demais de oficina para oficina).
 *
 * Item 1: o começo guiado do Início, com cada passo marcado sozinho quando o sistema vê que foi
 * feito.
 */

// ─────────────────────────── Perguntas ───────────────────────────

/** Peças que a oficina faz: cada uma vira uma ou mais linhas da mão de obra do orçamento. */
export const SETUP_PIECES = [
  {
    key: 'SOFA',
    label: 'Sofá',
    labor: ['Sofá reto - 2 lugares', 'Sofá reto - 3 lugares', 'Sofá retrátil', 'Sofá de canto'],
  },
  { key: 'POLTRONA', label: 'Poltrona', labor: ['Poltrona'] },
  {
    key: 'CADEIRA',
    label: 'Cadeira',
    labor: ['Cadeira - só assento', 'Cadeira - assento e encosto'],
  },
  { key: 'BANQUETA', label: 'Banqueta e banco', labor: ['Banqueta', 'Banco'] },
  {
    key: 'CABECEIRA',
    label: 'Cabeceira',
    labor: ['Cabeceira de casal', 'Cabeceira de solteiro'],
  },
  { key: 'CAMA', label: 'Cama box', labor: ['Cama box'] },
  { key: 'PUFF', label: 'Puff', labor: ['Puff'] },
  { key: 'ALMOFADA', label: 'Almofada', labor: ['Almofada'] },
  { key: 'NAMORADEIRA', label: 'Namoradeira', labor: ['Namoradeira'] },
  { key: 'CHAISE', label: 'Chaise e divã', labor: ['Chaise longue', 'Divã'] },
  { key: 'CANTO_ALEMAO', label: 'Canto alemão', labor: ['Canto alemão'] },
  { key: 'CARRO', label: 'Banco de carro', labor: ['Banco de carro'] },
] as const;
export type SetupPieceKey = (typeof SETUP_PIECES)[number]['key'];
const PIECE_KEYS = SETUP_PIECES.map((p) => p.key) as [SetupPieceKey, ...SetupPieceKey[]];

/** Tecidos sugeridos, com o preço do metro que já aparece preenchido (a pessoa troca). */
export const SETUP_FABRICS = [
  { name: 'Suede', suggestedCents: 2200 },
  { name: 'Linho', suggestedCents: 3500 },
  { name: 'Veludo', suggestedCents: 4500 },
  { name: 'Couro sintético', suggestedCents: 4000 },
  { name: 'Impermeável', suggestedCents: 3500 },
  { name: 'Chenille', suggestedCents: 3800 },
] as const;

/** Espumas: preço do metro cúbico que já aparece preenchido. */
export const SETUP_FOAMS = [
  { name: 'D28', suggestedCents: 110_000 },
  { name: 'D33', suggestedCents: 138_000 },
] as const;

/** Insumos e madeiramento: entram com o nome, sem preço (a pessoa completa se quiser). */
export const SETUP_SUPPLIES = [
  { category: 'Insumos', name: 'Cola', unit: 'un' },
  { category: 'Insumos', name: 'Grampo', unit: 'un' },
  { category: 'Insumos', name: 'Percinta', unit: 'm' },
  { category: 'Insumos', name: 'Cordone', unit: 'm' },
  { category: 'Insumos', name: 'Linha', unit: 'un' },
  { category: 'Madeiramento', name: 'Sarrafo 5 cm', unit: 'm' },
  { category: 'Madeiramento', name: 'Compensado', unit: 'un' },
  { category: 'Madeiramento', name: 'MDF', unit: 'un' },
] as const;

/**
 * Taxa média da maquininha (pontos-base) por número de vezes: 1 = à vista. Valores médios do
 * mercado, avisados na tela como "confira com a sua maquininha".
 */
export const SETUP_CARD_FEES_BPS: Record<number, number> = {
  1: 320,
  2: 450,
  3: 580,
  4: 710,
  5: 840,
  6: 970,
  7: 1100,
  8: 1230,
  9: 1360,
  10: 1490,
  11: 1620,
  12: 1750,
};

/** Imposto do orçamento por regime: MEI não paga porcentagem; Simples começa em 6%. */
export const SETUP_TAX_BPS = { MEI: 0, SIMPLES: 600, NAO_SEI: null } as const;
export type SetupTaxRegime = keyof typeof SETUP_TAX_BPS;

/** Frete: valor por km rodado (ida e volta) que já aparece preenchido. */
export const SETUP_KM_SUGGESTED_CENTS = 250;

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Horário no formato HH:MM.');
const cents = z.number().int().min(0).max(100_000_000);
const cityName = z.string().trim().min(3).max(80);

export const setupAnswersSchema = z
  .object({
    pieces: z.array(z.enum(PIECE_KEYS)).min(1, 'Marque pelo menos uma peça.').max(20),
    fabrics: z
      .array(z.object({ name: z.string().trim().min(2).max(60), priceCents: cents.nullable() }))
      .max(20),
    foams: z
      .array(z.object({ name: z.string().trim().min(2).max(20), priceCents: cents.nullable() }))
      .max(5),
    logistics: z.object({
      mode: z.enum(['KM', 'FIXO', 'NAO']),
      /** KM: valor do km rodado. FIXO: valor do frete. NAO: ignorado. */
      valueCents: cents.nullable(),
    }),
    onSite: z.boolean(),
    city: cityName,
    servedCities: z.array(cityName).max(40),
    maxInstallments: z.number().int().min(1).max(12),
    taxRegime: z.enum(['MEI', 'SIMPLES', 'NAO_SEI']),
    workingDays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    workdayStart: hhmm,
    workdayEnd: hhmm,
    leadDays: z.number().int().min(1).max(180),
    teamSize: z.number().int().min(1).max(500),
    logoDataUrl: z
      .string()
      .max(400_000, 'A logo ficou grande demais. Use uma imagem menor.')
      .regex(/^data:image\/(png|jpeg|webp);base64,/, 'Envie a logo em PNG, JPG ou WebP.')
      .nullable(),
    monthlyGoalCents: cents.nullable(),
  })
  .strict()
  .refine((a) => a.workdayStart < a.workdayEnd, {
    message: 'A hora de sair precisa ser depois da hora de chegar.',
    path: ['workdayEnd'],
  });
export type SetupAnswers = z.infer<typeof setupAnswersSchema>;

// ─────────────────────────── Começo guiado ───────────────────────────

export const GETTING_STARTED_KEYS = [
  'perguntas',
  'precos',
  'equipe',
  'tablet',
  'orcamento',
  'celular',
] as const;
export type GettingStartedKey = (typeof GETTING_STARTED_KEYS)[number];

export interface GettingStartedFacts {
  setupDone: boolean;
  /** Linhas de mão de obra do orçamento, e quantas já têm preço. */
  laborItems: number;
  laborPriced: number;
  /** Funcionários ativos além de quem criou a conta. */
  otherEmployees: number;
  /** Respondeu que trabalha sozinho. */
  worksAlone: boolean;
  devices: number;
  /** Ligou "Oficina sem tablet". */
  noTablet: boolean;
  quotes: number;
  /** Alguém da empresa já instalou o app (avisos ligados no celular). */
  phoneApps: number;
}

export interface GettingStartedStep {
  key: GettingStartedKey;
  label: string;
  hint: string;
  href: string;
  done: boolean;
}

export const GETTING_STARTED_LABEL: Record<GettingStartedKey, string> = {
  perguntas: 'Responder as perguntas do começo',
  precos: 'Colocar o preço da sua mão de obra',
  equipe: 'Cadastrar a sua equipe',
  tablet: 'Ligar o tablet da oficina',
  orcamento: 'Fazer o primeiro orçamento',
  celular: 'Instalar o app no seu celular',
};

export function gettingStartedSteps(f: GettingStartedFacts): GettingStartedStep[] {
  const priced = f.laborItems > 0 && f.laborPriced === f.laborItems;
  return [
    {
      key: 'perguntas',
      label: GETTING_STARTED_LABEL.perguntas,
      hint: 'Uns 3 minutos. Com as respostas, o sistema monta os preços, o frete e o horário.',
      href: '/painel/comecar',
      done: f.setupDone,
    },
    {
      key: 'precos',
      label: GETTING_STARTED_LABEL.precos,
      hint:
        f.laborItems > 0
          ? `${f.laborPriced} de ${f.laborItems} peças com preço.`
          : 'As peças aparecem aqui depois das perguntas.',
      href: '/painel/orcamentos?tab=base',
      done: priced,
    },
    {
      key: 'equipe',
      label: GETTING_STARTED_LABEL.equipe,
      hint: 'Você digita o nome e o celular. A pessoa termina o cadastro pelo link.',
      href: '/painel/funcionarios',
      done: f.otherEmployees > 0 || f.worksAlone,
    },
    {
      key: 'tablet',
      label: GETTING_STARTED_LABEL.tablet,
      hint: 'A oficina marca o andamento de cada peça pelo tablet.',
      href: '/painel/dispositivos',
      done: f.devices > 0 || f.noTablet,
    },
    {
      key: 'orcamento',
      label: GETTING_STARTED_LABEL.orcamento,
      hint: 'Com os preços prontos, sai em 2 minutos.',
      href: '/painel/orcamentos',
      done: f.quotes > 0,
    },
    {
      key: 'celular',
      label: GETTING_STARTED_LABEL.celular,
      hint: 'Para receber os avisos e conversar com o sistema pelo celular.',
      href: '/painel/dispositivos?instalar=dono',
      done: f.phoneApps > 0,
    },
  ];
}

export interface GettingStartedDto {
  /** Mostrar o cartão no Início. */
  show: boolean;
  /** Mostrar as perguntas do primeiro acesso ao entrar. */
  askSetup: boolean;
  steps: GettingStartedStep[];
  /** Pedido de ajuda já feito e ainda não atendido. */
  helpRequestedFor: string | null;
}

/** "Quero ajuda para começar" (item 6): a pessoa escolhe o dia e o horário. */
export const helpRequestSchema = z
  .object({
    preferredAt: z.string().datetime({ offset: true }),
    note: z.string().trim().max(500).optional(),
  })
  .strict();
export type HelpRequestInput = z.infer<typeof helpRequestSchema>;

// ─────────────────────────── Convite do funcionário (item 4) ───────────────────────────

export interface EmployeeInviteDto {
  url: string;
  whatsappUrl: string | null;
  expiresAt: string;
}

export interface PublicInviteDto {
  companyName: string;
  employeeName: string;
  jobTitle: string;
  hasPhoto: boolean;
  /** Link já usado ou vencido. */
  valid: boolean;
}

export const acceptInviteSchema = z.object({ pin: pinSchema }).strict();

// ─────────────────────────── Explicação de cada tela (item 5) ───────────────────────────

export const tipKeySchema = z.string().regex(/^[a-z0-9-]{2,60}$/);
