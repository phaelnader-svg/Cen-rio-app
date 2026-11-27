import { z } from 'zod';

/**
 * Melhorias da segunda rodada (2026-11-17): tipos compartilhados entre a API e o painel para
 * álbum de fotos, links públicos do cliente, busca rápida, sugestões, avisos de manutenção,
 * página de status, lixeira e acesso de suporte.
 */

// ─────────────────────────── Álbum de antes e depois (82) ───────────────────────────

export interface OsAlbumPhoto {
  fileId: string;
  url: string;
  thumbUrl: string;
  caption: string | null;
  width: number | null;
  height: number | null;
  createdAt: string;
}

export interface OsAlbumDto {
  serviceOrderId: string;
  code: string;
  customerName: string;
  companyName: string;
  pieces: string[];
  before: OsAlbumPhoto[];
  during: OsAlbumPhoto[];
  after: OsAlbumPhoto[];
}

// ─────────────────────────── Retirada pelo link (130), só para ver ───────────────────────────

export const PICKUP_SHIFTS = ['MANHA', 'TARDE'] as const;
export type PickupShift = (typeof PICKUP_SHIFTS)[number];
export const PICKUP_SHIFT_LABEL: Record<PickupShift, string> = {
  MANHA: 'Manhã (8h às 12h)',
  TARDE: 'Tarde (13h às 18h)',
};

export interface PublicPickupDto {
  code: string;
  companyName: string;
  customerName: string;
  /** Endereço da retirada (rua, número e bairro; sem o resto do cadastro). */
  address: string | null;
  pieces: string[];
  /** Dia já escolhido/agendado (AAAA-MM-DD) e o turno. */
  scheduledDate: string | null;
  shift: PickupShift | null;
  /** A retirada ainda não saiu nem foi feita (o dia é sempre combinado pela oficina). */
  open: boolean;
  /** 2026-11-25: serviço feito na casa do cliente ("No local"), não retirada. */
  onSite?: boolean;
}

// ─────────────────────────── Busca rápida (83) ───────────────────────────

export const SEARCH_RESULT_KINDS = ['CLIENTE', 'PEDIDO', 'OS', 'ORCAMENTO', 'RETIRADA'] as const;
export type SearchResultKind = (typeof SEARCH_RESULT_KINDS)[number];
export const SEARCH_RESULT_LABEL: Record<SearchResultKind, string> = {
  CLIENTE: 'Cliente',
  PEDIDO: 'Pedido',
  OS: 'Ordem de serviço',
  ORCAMENTO: 'Orçamento',
  RETIRADA: 'Retirada',
};

export interface SearchResultDto {
  kind: SearchResultKind;
  id: string;
  title: string;
  subtitle: string | null;
  href: string;
}

// ─────────────────────────── Sugestão ou problema (112) ───────────────────────────

export const FEEDBACK_KINDS = ['SUGESTAO', 'PROBLEMA'] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];
export const FEEDBACK_KIND_LABEL: Record<FeedbackKind, string> = {
  SUGESTAO: 'Sugestão',
  PROBLEMA: 'Problema',
};
export const FEEDBACK_STATUSES = ['NOVO', 'VISTO', 'RESOLVIDO'] as const;
export type FeedbackStatus = (typeof FEEDBACK_STATUSES)[number];
export const FEEDBACK_STATUS_LABEL: Record<FeedbackStatus, string> = {
  NOVO: 'Novo',
  VISTO: 'Visto',
  RESOLVIDO: 'Resolvido',
};

export const feedbackCreateSchema = z.object({
  kind: z.enum(FEEDBACK_KINDS),
  message: z
    .string()
    .trim()
    .min(3, { message: 'Conte em poucas palavras o que aconteceu ou o que sugere.' })
    .max(4000),
  pageUrl: z.string().max(500).optional(),
  /** Print da tela (JPEG em data URL, reduzido pela tela). */
  screenshot: z
    .string()
    .max(1_500_000, { message: 'Print muito grande.' })
    .regex(/^data:image\/(png|jpeg);base64,[A-Za-z0-9+/=]+$/, { message: 'Print inválido.' })
    .nullable()
    .optional(),
});

export interface FeedbackDto {
  id: string;
  companyId: number;
  companyName: string;
  userName: string | null;
  userEmail: string | null;
  kind: FeedbackKind;
  message: string;
  pageUrl: string | null;
  hasScreenshot: boolean;
  status: FeedbackStatus;
  createdAt: string;
}

// ─────────────────────────── Aviso de manutenção (131) ───────────────────────────

export interface SystemNoticeDto {
  id: string;
  message: string;
  showFrom: string;
  showUntil: string;
}

export const systemNoticeSchema = z
  .object({
    message: z.string().trim().min(5, { message: 'Escreva o aviso.' }).max(300),
    showFrom: z.string().datetime({ offset: true }),
    showUntil: z.string().datetime({ offset: true }),
  })
  .refine((v) => new Date(v.showUntil) > new Date(v.showFrom), {
    message: 'O fim precisa ser depois do início.',
    path: ['showUntil'],
  });

// ─────────────────────────── Página de status (100) ───────────────────────────

export interface StatusDayDto {
  /** AAAA-MM-DD (fuso de São Paulo). */
  day: string;
  /** Percentual de amostras com o sistema no ar (null = sem amostras no dia). */
  uptimeBps: number | null;
}

export interface PublicStatusDto {
  ok: boolean;
  checkedAt: string;
  latencyMs: number | null;
  notice: SystemNoticeDto | null;
  days: StatusDayDto[];
}

// ─────────────────────────── Lixeira (86) ───────────────────────────

export const TRASH_KINDS = ['ORCAMENTO', 'FOTO', 'CLIENTE'] as const;
export type TrashKind = (typeof TRASH_KINDS)[number];
export const TRASH_KIND_LABEL: Record<TrashKind, string> = {
  ORCAMENTO: 'Orçamento',
  FOTO: 'Foto',
  CLIENTE: 'Cliente arquivado',
};
/** Itens apagados ficam na lixeira por este número de dias. */
export const TRASH_DAYS = 30;

export interface TrashItemDto {
  kind: TrashKind;
  id: string;
  title: string;
  detail: string | null;
  deletedAt: string;
  deletedBy: string | null;
  /** Dias até sair da lixeira. */
  daysLeft: number;
  thumbUrl: string | null;
}

// ─────────────────────────── Acesso de suporte (114) ───────────────────────────

export const SUPPORT_ACCESS_HOURS = [2, 8, 24, 72] as const;
export const supportAccessSchema = z.object({
  hours: z.union([z.literal(0), ...SUPPORT_ACCESS_HOURS.map((h) => z.literal(h))]),
});

// ─────────────────────────── Cancelar ou pausar a assinatura (113) ───────────────────────────

export const CANCEL_REASONS = [
  'Ficou caro',
  'Não tive tempo de usar',
  'Faltou alguma função',
  'Achei difícil de usar',
  'Vou usar outro sistema',
  'A empresa parou ou fechou',
  'Outro motivo',
] as const;

export const subscriptionCancelSchema = z.object({
  action: z.enum(['CANCELAR', 'PAUSAR']),
  reason: z.enum(CANCEL_REASONS),
  details: z.string().trim().max(400).optional(),
});

// ─────────────────────────── Números do negócio (116) ───────────────────────────

export interface BusinessNumbersDto {
  /** Receita recorrente por mês (anual dividido por 12), em centavos. */
  mrrCents: number;
  paying: number;
  trial: number;
  courtesy: number;
  overdue: number;
  canceled: number;
  paused: number;
  /** Empresas sem ninguém entrando há 7 dias ou mais (fora as de cortesia e demonstração). */
  atRisk: { companyId: number; tradeName: string; lastActivityAt: string | null }[];
  cancelReasons: { reason: string; count: number }[];
  newLast30Days: number;
}

// ─────────────────────────── Verificação em duas etapas (98) ───────────────────────────

export const totpCodeSchema = z.object({
  code: z
    .string()
    .trim()
    .regex(/^(\d{6}|[A-Za-z0-9]{4}-[A-Za-z0-9]{4})$/, {
      message: 'Informe o código de 6 números.',
    }),
});

export const loginSecondStepSchema = z.object({
  challenge: z.string().min(10).max(400),
  code: totpCodeSchema.shape.code,
});
