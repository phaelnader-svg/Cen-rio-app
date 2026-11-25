/**
 * Escritório trabalhando sozinho (2026-11-25, pedido do Raphael): cada agente tem tarefas reais
 * e cada tarefa tem um nível, que o dono muda quando quiser:
 *
 * 1. Só sugere — fica na lista do Escritório, sem aviso no celular.
 * 2. Pede aprovação — avisa no celular e espera o toque em Aprovar (padrão).
 * 3. Sozinho com limite — faz sozinho até o valor que o dono deu; acima disso, pede.
 * 4. Sozinho — faz e aparece no resumo do dia.
 *
 * Mensagem para fora só sai sozinha com o WhatsApp da empresa ligado (sem ele, quem aperta
 * "enviar" é sempre o dono). O "parar tudo" volta tudo para "pede aprovação" sem apagar os níveis.
 */
import { z } from 'zod';

export const OFFICE_LEVELS = [1, 2, 3, 4] as const;
export type OfficeLevel = (typeof OFFICE_LEVELS)[number];
export const OFFICE_LEVEL_LABEL: Record<OfficeLevel, string> = {
  1: 'Só sugere',
  2: 'Pede aprovação',
  3: 'Sozinho com limite',
  4: 'Sozinho',
};
export const OFFICE_LEVEL_HINT: Record<OfficeLevel, string> = {
  1: 'Fica na lista, sem aviso no celular.',
  2: 'Avisa no celular e espera você aprovar.',
  3: 'Faz sozinho até o valor que você der. Acima disso, pede.',
  4: 'Faz sozinho e aparece no resumo do dia.',
};
export const DEFAULT_OFFICE_LEVEL: OfficeLevel = 2;

/** Depois de tantas aprovações seguidas sem mudar nada, o Escritório sugere subir o nível. */
export const LEVEL_UP_STREAK = 30;

export const OFFICE_TASK_KEYS = [
  'PEDIR_FORNECEDOR',
  'COBRAR_CLIENTE',
  'RETORNO_ORCAMENTO',
  'AVISAR_PRONTO',
  'AGENDAR_ENTREGA',
  'CONFIRMAR_RETIRADA',
  'CONFIRMAR_ENTREGA',
  'PEDIR_AVALIACAO',
  'CLIENTE_ANTIGO',
  'PLANEJAR_OS',
] as const;
export type OfficeTaskKey = (typeof OFFICE_TASK_KEYS)[number];

export interface OfficeTask {
  key: OfficeTaskKey;
  /** Agentes que fazem a tarefa (o primeiro contratado faz). */
  roles: string[];
  label: string;
  /** O que o agente faz, em uma frase. */
  what: string;
  /** Sai mensagem pelo WhatsApp (sozinho só com o WhatsApp da empresa ligado). */
  message: boolean;
  /** Tem valor em dinheiro (o nível 3 usa o limite). */
  money: boolean;
  /** Nível mais alto possível nesta versão. */
  maxLevel: OfficeLevel;
  /** Por que não passa do nível máximo (quando o máximo é menor que 4). */
  maxReason?: string;
}

export const OFFICE_TASKS: OfficeTask[] = [
  {
    key: 'PEDIR_FORNECEDOR',
    roles: ['COMPRAS'],
    label: 'Pedir material ao fornecedor',
    what: 'Junta o que falta nas OS abertas, separa por fornecedor e manda o pedido.',
    message: true,
    money: false,
    maxLevel: 4,
  },
  {
    key: 'COBRAR_CLIENTE',
    roles: ['FINANCEIRO'],
    label: 'Cobrar cliente atrasado',
    what: 'Manda uma cobrança educada com o valor e o pedido.',
    message: true,
    money: true,
    maxLevel: 4,
  },
  {
    key: 'RETORNO_ORCAMENTO',
    roles: ['ORCAMENTOS'],
    label: 'Dar retorno de orçamento',
    what: 'Chama o cliente que recebeu orçamento há 2 dias e não respondeu.',
    message: true,
    money: false,
    maxLevel: 4,
  },
  {
    key: 'AVISAR_PRONTO',
    roles: ['ATENDIMENTO', 'WHATSAPP'],
    label: 'Avisar que ficou pronto',
    what: 'Avisa o cliente que a peça ficou pronta para combinar a entrega.',
    message: true,
    money: false,
    maxLevel: 4,
  },
  {
    key: 'AGENDAR_ENTREGA',
    roles: ['ATENDIMENTO', 'WHATSAPP'],
    label: 'Agendar a entrega da peça pronta',
    what: 'Peça pronta sem entrega marcada: propõe o dia, agenda a entrega e avisa o cliente.',
    message: true,
    money: false,
    maxLevel: 4,
  },
  {
    key: 'CONFIRMAR_RETIRADA',
    roles: ['ATENDIMENTO', 'WHATSAPP'],
    label: 'Confirmar retirada na véspera',
    what: 'Um dia antes, confirma com o cliente que vai ter alguém no local.',
    message: true,
    money: false,
    maxLevel: 4,
  },
  {
    key: 'CONFIRMAR_ENTREGA',
    roles: ['ATENDIMENTO', 'WHATSAPP'],
    label: 'Confirmar entrega na véspera',
    what: 'Um dia antes, confirma a entrega e lembra o saldo a pagar.',
    message: true,
    money: false,
    maxLevel: 4,
  },
  {
    key: 'PEDIR_AVALIACAO',
    roles: ['ATENDIMENTO', 'WHATSAPP'],
    label: 'Pedir avaliação depois da entrega',
    what: 'Dois dias depois da entrega, agradece e pede a avaliação no Google.',
    message: true,
    money: false,
    maxLevel: 4,
  },
  {
    key: 'CLIENTE_ANTIGO',
    roles: ['ATENDIMENTO', 'WHATSAPP'],
    label: 'Chamar cliente que não volta há 1 ano',
    what: 'Oferece limpeza ou revisão para quem fez serviço há mais de um ano.',
    message: true,
    money: false,
    maxLevel: 4,
  },
  {
    key: 'PLANEJAR_OS',
    roles: ['GERENTE'],
    label: 'Planejar OS na semana',
    what: 'Avisa a OS sem planejamento e quem é o tapeceiro de cada peça.',
    message: false,
    money: false,
    maxLevel: 2,
    maxReason: 'Encaixar a OS na semana sozinho vem na próxima etapa.',
  },
];

export const officeTask = (key: string) => OFFICE_TASKS.find((t) => t.key === key) ?? null;

/** Tarefa de uma proposta (as antigas, sem a marca, pelo tipo e pelo que a proposta cita). */
export function officeTaskOf(p: { kind: string; payload: unknown }): OfficeTaskKey | null {
  const pl = (p.payload ?? {}) as Record<string, unknown>;
  if (typeof pl.task === 'string' && (OFFICE_TASK_KEYS as readonly string[]).includes(pl.task))
    return pl.task as OfficeTaskKey;
  if (p.kind === 'PEDIR_FORNECEDOR') return 'PEDIR_FORNECEDOR';
  if (p.kind === 'COBRAR_CLIENTE') return 'COBRAR_CLIENTE';
  if (p.kind === 'PLANEJAR_OS') return 'PLANEJAR_OS';
  if (p.kind === 'ENVIAR_MENSAGEM' && pl.quoteId) return 'RETORNO_ORCAMENTO';
  if (p.kind === 'ENVIAR_MENSAGEM' && pl.serviceOrderId) return 'AVISAR_PRONTO';
  return null;
}

export interface OfficeTaskSetting {
  nivel: OfficeLevel;
  /** Nível 3: até quanto o agente faz sozinho (centavos). */
  limiteCents?: number | null;
}

export const officeTaskSettingSchema = z.object({
  nivel: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  limiteCents: z.number().int().min(0).max(100_000_000).nullable().optional(),
});

export const updateOfficeTaskSchema = z.object({
  agentId: z.string().uuid(),
  task: z.enum(OFFICE_TASK_KEYS),
  setting: officeTaskSettingSchema,
});

export const officeSettingsSchema = z.object({
  /** true = parar tudo (todos voltam a pedir aprovação). */
  paused: z.boolean().optional(),
  googleReviewUrl: z
    .string()
    .trim()
    .max(500)
    .regex(/^https:\/\//, 'Use o link completo, começando com https://')
    .nullable()
    .optional(),
});

/** Linha de uma tarefa no Escritório (com o nível e o histórico de acertos). */
export interface OfficeTaskDto {
  key: OfficeTaskKey;
  label: string;
  what: string;
  level: OfficeLevel;
  limitCents: number | null;
  /** Nível mais alto possível agora (mensagem sem WhatsApp da empresa = 2). */
  maxLevel: OfficeLevel;
  /** Por que não passa do máximo agora, em português simples. */
  maxReason: string | null;
  money: boolean;
  approved: number;
  rejected: number;
  /** Aprovações seguidas sem mudar o texto (as mais recentes). */
  streak: number;
  /** Sugestão de subir de nível (aparece depois de LEVEL_UP_STREAK aprovações seguidas). */
  suggestLevelUp: boolean;
  /** Feitas pelo agente sozinho nos últimos 30 dias. */
  doneAlone: number;
}

export interface OfficeAgentDto {
  roleKey: string;
  name: string;
  roleLabel: string;
  /** Null = ainda não contratado (o dono contrata pelo Escritório ou no jogo). */
  agentId: string | null;
  status: 'ATIVO' | 'PAUSADO' | 'DESATIVADO' | null;
  color: string;
  tasks: OfficeTaskDto[];
  /** O que o agente já fazia antes (avisos do sistema que ele acompanha). */
  alsoDoes: string[];
}

export interface OfficeProposalDto {
  id: string;
  agentId: string;
  agentName: string;
  agentColor: string;
  task: OfficeTaskKey | null;
  kind: string;
  title: string;
  detail: string;
  payload: Record<string, unknown>;
  status: string;
  /** Nível 1: só sugestão (sem aviso no celular). */
  suggestion: boolean;
  createdAt: string;
  decidedAt: string | null;
  decisionNote: string | null;
  decidedByAgent: boolean;
}

export interface OfficeOverviewDto {
  paused: boolean;
  pausedAt: string | null;
  whatsappConnected: boolean;
  googleReviewUrl: string | null;
  agents: OfficeAgentDto[];
  pending: OfficeProposalDto[];
  /** Últimas decisões (do dono e do próprio agente). */
  recent: OfficeProposalDto[];
  /** Resumo de hoje, em linhas curtas. */
  today: { done: number; doneAlone: number; waiting: number; rejected: number };
}

/** Agentes do Escritório, na ordem do plano (Gerente primeiro). */
export const OFFICE_ROLES = [
  'GERENTE',
  'FINANCEIRO',
  'COMPRAS',
  'ORCAMENTOS',
  'ATENDIMENTO',
  'MARKETING',
] as const;

/** O que cada agente já acompanhava (avisos do sininho que já existem no sistema). */
export const OFFICE_ALSO_DOES: Record<string, string[]> = {
  GERENTE: ['Avisa a entrega com prazo perto (1 semana antes).'],
  FINANCEIRO: ['Avisa a conta a pagar 1 dia antes e a conta vencida.'],
  COMPRAS: ['Mostra a lista Comprar com o que falta nas OS.'],
  ORCAMENTOS: [],
  ATENDIMENTO: [],
  MARKETING: ['Na próxima etapa: posts com o antes e depois das OS e os artigos do blog.'],
};

const first = (name: string | null | undefined) => (name ?? '').trim().split(/\s+/)[0] ?? '';

/** Pedido de avaliação depois da entrega (com o link do Google quando a empresa cadastrou). */
export function reviewRequestMessage(i: {
  customerName: string | null;
  companyName: string;
  reviewUrl: string | null;
}) {
  const hi = `Olá${first(i.customerName) ? `, ${first(i.customerName)}` : ''}!`;
  return [
    `${hi} Aqui é da ${i.companyName}. Obrigado por confiar o seu serviço à nossa oficina!`,
    i.reviewUrl
      ? `Se gostou do resultado, uma avaliação sua no Google ajuda muito o nosso trabalho: ${i.reviewUrl}`
      : 'Se gostou do resultado, conta pra gente? Sua opinião ajuda muito o nosso trabalho.',
    'Qualquer coisa que precisar, é só chamar por aqui.',
  ].join('\n\n');
}

/** Cliente que não volta há mais de um ano: oferta de limpeza ou revisão. */
export function returningCustomerMessage(i: {
  customerName: string | null;
  companyName: string;
  piece: string | null;
}) {
  const hi = `Olá${first(i.customerName) ? `, ${first(i.customerName)}` : ''}!`;
  const what = i.piece?.trim() ? `o ${i.piece.trim().toLowerCase()}` : 'o serviço';
  return [
    `${hi} Aqui é da ${i.companyName}. Já faz um ano que fizemos ${what} para você. Como está?`,
    'Se precisar de uma limpeza, uma revisão ou de reformar outra peça, é só responder aqui que passamos o orçamento sem compromisso.',
  ].join('\n\n');
}
