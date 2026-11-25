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
  'LANCAR_DESPESA',
  'MONTAR_ORCAMENTO',
  'ENVIAR_CONTRATO',
  'PESQUISA_SATISFACAO',
  'ANIVERSARIO',
  'INDICACAO',
  'AGRADECER_INDICACAO',
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
    key: 'PESQUISA_SATISFACAO',
    roles: ['ATENDIMENTO', 'WHATSAPP'],
    label: 'Perguntar se ficou tudo certo',
    what: 'No dia seguinte à entrega, pergunta se ficou do jeito que o cliente queria.',
    message: true,
    money: false,
    maxLevel: 4,
  },
  {
    key: 'ANIVERSARIO',
    roles: ['ATENDIMENTO', 'WHATSAPP'],
    label: 'Parabéns de aniversário com desconto',
    what: 'No aniversário do cliente, manda os parabéns com o desconto da empresa.',
    message: true,
    money: false,
    maxLevel: 4,
  },
  {
    key: 'INDICACAO',
    roles: ['ATENDIMENTO', 'WHATSAPP'],
    label: 'Pedir indicação com desconto',
    what: 'Duas semanas depois da entrega, convida a indicar alguém: os dois ganham o desconto.',
    message: true,
    money: false,
    maxLevel: 4,
  },
  {
    key: 'AGRADECER_INDICACAO',
    roles: ['ATENDIMENTO', 'WHATSAPP'],
    label: 'Agradecer quem indicou',
    what: 'Quando o cliente indicado fecha o serviço, agradece quem indicou e guarda o desconto.',
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
    label: 'Encaixar OS na semana',
    what: 'OS com material comprado e sem planejamento: escolhe o início e o tapeceiro de cada peça e coloca na semana (em rascunho).',
    message: false,
    money: false,
    maxLevel: 4,
  },
  {
    key: 'MONTAR_ORCAMENTO',
    roles: ['ORCAMENTOS'],
    label: 'Montar orçamento pelo pedido',
    what: 'Você conta o pedido do cliente (texto e fotos); ele monta o orçamento com a sua tabela e manda o link.',
    message: true,
    money: true,
    maxLevel: 4,
  },
  {
    key: 'ENVIAR_CONTRATO',
    roles: ['ORCAMENTOS'],
    label: 'Mandar o contrato do serviço fechado',
    what: 'Serviço fechado sem contrato: preenche o contrato com os dados do pedido e manda o link para o cliente ler.',
    message: true,
    money: false,
    maxLevel: 4,
  },
  {
    key: 'LANCAR_DESPESA',
    roles: ['FINANCEIRO'],
    label: 'Lançar despesa pela foto',
    what: 'Você manda a foto do comprovante; ele lê o valor, a data e quem recebeu e lança a despesa.',
    message: false,
    money: true,
    maxLevel: 4,
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
  if (p.kind === 'LANCAR_DESPESA') return 'LANCAR_DESPESA';
  if (p.kind === 'MONTAR_ORCAMENTO') return 'MONTAR_ORCAMENTO';
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

/** Pedido de orçamento contado ao agente de Orçamentos (texto e até 3 fotos já reduzidas). */
export const officeQuoteRequestSchema = z.object({
  customerName: z.string().trim().min(2, 'Informe o nome do cliente.').max(160),
  phone: z.string().trim().max(20).default(''),
  city: z.string().trim().max(120).default(''),
  request: z.string().trim().min(5, 'Conte o pedido do cliente.').max(3000),
  photos: z
    .array(z.string().regex(/^data:image\/(jpeg|png|webp);base64,/, 'Foto inválida.'))
    .max(3)
    .default([]),
});
export type OfficeQuoteRequest = z.infer<typeof officeQuoteRequestSchema>;

/** Texto do envio do orçamento; {link} vira o link da proposta quando o orçamento é salvo. */
export function quoteSendMessage(i: {
  customerName: string;
  service: string;
  totalCents: number;
  installments?: { count: number; totalCents: number } | null;
  companyName: string;
}): string {
  const brl = (c: number) =>
    (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const name = first(i.customerName);
  const parc =
    i.installments && i.installments.count > 1
      ? ` ou ${i.installments.count}x de ${brl(Math.ceil(i.installments.totalCents / i.installments.count))}`
      : '';
  return `Olá${name ? `, ${name}` : ''}! Segue o orçamento de ${i.service.toLowerCase()}: {link}\n\nO valor é ${brl(i.totalCents)} à vista${parc}. Qualquer dúvida sobre tecido, prazo ou pagamento, é só chamar.\n\n${i.companyName}`;
}

export const officeSettingsSchema = z.object({
  /** true = parar tudo (todos voltam a pedir aprovação). */
  paused: z.boolean().optional(),
  /** Desconto do aniversário e da indicação (%). */
  customerDiscountPct: z.number().int().min(0).max(50).optional(),
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
  /** IA ligada no servidor (ler foto de comprovante, montar orçamento). */
  aiReady: boolean;
  googleReviewUrl: string | null;
  customerDiscountPct: number;
  agents: OfficeAgentDto[];
  pending: OfficeProposalDto[];
  /** Últimas decisões (do dono e do próprio agente). */
  recent: OfficeProposalDto[];
  /** Resumo de hoje, em linhas curtas. */
  today: { done: number; doneAlone: number; waiting: number; rejected: number };
}

/** Relatório da semana (Gerente): os últimos 7 dias, para o dono ler no domingo. */
export interface OfficeWeekDto {
  from: string;
  to: string;
  /** Fechado em (contratado) e quantos pedidos. */
  contractedCents: number;
  contractedOrders: number;
  /** Mesmo período do ano passado (null sem dados). */
  lastYearContractedCents: number | null;
  receivedCents: number;
  paidCents: number;
  cashNetCents: number;
  completedOrders: number;
  marginCents: number;
  /** Lucro por serviço (OS concluídas no período), do maior para o menor. */
  services: { label: string; orders: number; revenueCents: number; marginCents: number }[];
  quotesSent: number;
  quotesApproved: number;
  receivableOverdueCents: number;
  nextWeek: { billsCount: number; billsCents: number; deliveries: number };
  reworks: number;
  /** O mês até hoje: fechado, o mesmo período do ano passado e o mês inteiro do ano passado (a meta). */
  month: {
    contractedCents: number;
    lastYearSoFarCents: number | null;
    lastYearMonthCents: number | null;
  };
}

/** Previsão do caixa (Financeiro): o que entra e sai em cada uma das próximas semanas. */
export interface OfficeForecastDto {
  today: string;
  /** A receber vencido (cliente atrasado) e a pagar vencido, fora das semanas. */
  overdueInCents: number;
  overdueOutCents: number;
  weeks: {
    from: string;
    to: string;
    inCents: number;
    outCents: number;
    /** Maiores valores da semana (até 4 de cada lado). */
    ins: { label: string; amountCents: number; date: string }[];
    outs: { label: string; amountCents: number; date: string }[];
  }[];
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
  FINANCEIRO: [
    'Avisa a conta a pagar 1 dia antes e a conta vencida.',
    'Mostra o que entra e sai do caixa nas próximas 4 semanas.',
    'Lembra o DAS do mês (vence dia 20) se ainda não estiver lançado.',
    'No começo do mês, avisa que o pacote do contador está pronto.',
  ],
  COMPRAS: [
    'Mostra a lista Comprar com o que falta nas OS.',
    'Avisa quando o estoque não dá para as OS abertas (material acabando).',
  ],
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

/** Contrato do serviço fechado: o link do PDF entra no lugar de {link} ao aprovar. */
export function contractMessage(i: {
  customerName: string | null;
  companyName: string;
  orderCode: string;
}) {
  const hi = `Olá${first(i.customerName) ? `, ${first(i.customerName)}` : ''}!`;
  return [
    `${hi} Aqui é da ${i.companyName}. Segue o contrato do seu serviço (${i.orderCode}) para você ler com calma: {link}`,
    'Se estiver tudo certo, é só responder "de acordo" aqui. Qualquer dúvida, me chama.',
  ].join('\n\n');
}

/** Dia seguinte à entrega: ficou tudo certo? (a reclamação volta para o dono resolver). */
export function satisfactionMessage(i: { customerName: string | null; companyName: string }) {
  const hi = `Olá${first(i.customerName) ? `, ${first(i.customerName)}` : ''}!`;
  return [
    `${hi} Aqui é da ${i.companyName}. Passando para saber: ficou tudo do jeito que você queria?`,
    'Se alguma coisa não ficou boa, me conta aqui que a gente resolve.',
  ].join('\n\n');
}

/** Aniversário do cliente: parabéns com o desconto da empresa. */
export function birthdayMessage(i: {
  customerName: string | null;
  companyName: string;
  discountPct: number;
}) {
  const hi = `Olá${first(i.customerName) ? `, ${first(i.customerName)}` : ''}!`;
  return [
    `${hi} Aqui é da ${i.companyName}. Feliz aniversário! Muita saúde e alegria para você.`,
    i.discountPct > 0
      ? `De presente, você tem ${i.discountPct}% de desconto em qualquer serviço fechado até o fim do mês que vem. É só falar aqui.`
      : 'Qualquer coisa que precisar, é só chamar por aqui.',
  ].join('\n\n');
}

/** Duas semanas depois da entrega: convite para indicar (os dois ganham o desconto). */
export function referralMessage(i: {
  customerName: string | null;
  companyName: string;
  discountPct: number;
}) {
  const hi = `Olá${first(i.customerName) ? `, ${first(i.customerName)}` : ''}!`;
  return [
    `${hi} Aqui é da ${i.companyName}. Espero que esteja aproveitando o serviço!`,
    i.discountPct > 0
      ? `Se você indicar alguém, quem você indicar ganha ${i.discountPct}% de desconto e você também ganha ${i.discountPct}% no seu próximo serviço. É só a pessoa falar o seu nome quando chamar a gente.`
      : 'Se conhecer alguém que precise reformar uma peça, ficamos felizes com a sua indicação. É só a pessoa falar o seu nome quando chamar a gente.',
  ].join('\n\n');
}

/** O indicado fechou: agradece quem indicou. */
export function referralThanksMessage(i: {
  customerName: string | null;
  companyName: string;
  referredName: string;
  discountPct: number;
}) {
  const hi = `Olá${first(i.customerName) ? `, ${first(i.customerName)}` : ''}!`;
  return [
    `${hi} Aqui é da ${i.companyName}. Muito obrigado por indicar ${first(i.referredName) || i.referredName}, já fechamos o serviço!`,
    i.discountPct > 0
      ? `Seu desconto de ${i.discountPct}% está guardado para o próximo serviço.`
      : 'Ficamos muito felizes com a confiança.',
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
