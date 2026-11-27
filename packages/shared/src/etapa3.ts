import { z } from 'zod';

/**
 * Etapa 3 da lista de 53 (2026-11-27): cuidados com a peça (23), "Como ficou?" depois da entrega
 * (22), padrão da casa no tablet (20), folgas com efeito nos prazos (19) e aviso de chuva (16).
 */

// ─────────────────────────── Cuidados com a peça (item 23) ───────────────────────────

/** Texto padrão por palavra do nome do tecido (a tapeçaria pode trocar na Base de dados). */
export const DEFAULT_CARE_TEXTS: readonly { keys: string[]; label: string; text: string }[] = [
  {
    keys: ['couro natural', 'couro legitimo', 'couro legítimo'],
    label: 'Couro natural',
    text: 'Limpe com pano macio levemente úmido e hidrate com produto próprio para couro a cada 3 meses. Evite sol direto e produtos com álcool.',
  },
  {
    keys: ['corino', 'courino', 'courvin', 'sintetico', 'sintético', 'couro eco', 'couro'],
    label: 'Corino (couro sintético)',
    text: 'Limpe com pano úmido e sabão neutro e seque em seguida. Não use álcool, solvente nem produto com silicone. Evite sol direto.',
  },
  {
    keys: ['veludo'],
    label: 'Veludo',
    text: 'Aspire com escova macia no sentido do pelo. Manchas: pano branco úmido, sem esfregar. Evite sol direto para não desbotar.',
  },
  {
    keys: ['suede', 'camurça', 'camurca', 'nobuck'],
    label: 'Suede',
    text: 'Aspire uma vez por semana. Manchas: pano úmido com pouco sabão neutro, batendo de leve, sem esfregar. Deixe secar à sombra.',
  },
  {
    keys: ['linho', 'algodao', 'algodão', 'sarja'],
    label: 'Linho e algodão',
    text: 'Aspire com frequência. Manchas: pano úmido com sabão neutro, de fora para dentro. Não use alvejante. Evite sol direto.',
  },
  {
    keys: ['chenille', 'jacquard', 'boucle', 'bouclê', 'tricô', 'trico'],
    label: 'Chenille, jacquard e bouclê',
    text: 'Aspire com escova macia. Não puxe fios soltos: corte com tesoura. Manchas: pano úmido, sem esfregar.',
  },
  {
    keys: ['impermeavel', 'impermeável', 'acquablock', 'aquablock', 'tecnologico', 'tecnológico'],
    label: 'Tecido impermeável',
    text: 'Líquidos: seque na hora com papel toalha, sem esfregar. Limpeza: pano úmido com sabão neutro. Não use produtos com solvente.',
  },
];
export const GENERAL_CARE_TEXT =
  'Aspire uma vez por semana e evite sol direto. Manchas: pano branco úmido com sabão neutro, sem esfregar. Espere 48 horas antes de usar produtos de limpeza mais fortes.';

const norm = (v: string) =>
  v.toLocaleLowerCase('pt-BR').normalize('NFD').replace(/[̀-ͯ]/g, '').trim();

/** Cuidados do tecido: o texto da tapeçaria (pelo nome) ou o padrão pela palavra do nome. */
export function careTextFor(
  fabricName: string | null | undefined,
  custom: Record<string, string> = {},
): string {
  const name = norm(fabricName ?? '');
  if (!name) return GENERAL_CARE_TEXT;
  for (const [k, v] of Object.entries(custom)) if (norm(k) === name && v.trim()) return v.trim();
  for (const d of DEFAULT_CARE_TEXTS) if (d.keys.some((k) => name.includes(norm(k)))) return d.text;
  return GENERAL_CARE_TEXT;
}

export const careTextsSchema = z
  .record(z.string().trim().min(1).max(120), z.string().trim().max(600))
  .refine((r) => Object.keys(r).length <= 200, { message: 'Tecidos demais.' });
export type CareTexts = z.infer<typeof careTextsSchema>;

// ─────────────────────────── "Como ficou?" (item 22) ───────────────────────────

export const publicReviewSchema = z
  .object({
    stars: z.number().int().min(1).max(5),
    comment: z.string().trim().max(500).optional(),
    /** Campo-isca: só robô preenche. */
    website: z.string().max(200).optional(),
  })
  .strict();

export interface PublicReviewDto {
  companyName: string;
  logoDataUrl: string | null;
  customerFirstName: string;
  deliveredOn: string | null;
  pieces: { description: string; fabric: string | null }[];
  care: { fabric: string; text: string }[];
  review: { stars: number; comment: string | null; at: string } | null;
}

export interface RatingsSummaryDto {
  days: number;
  count: number;
  average: number | null;
  /** Quantas notas 1, 2, 3, 4 e 5. */
  byStars: [number, number, number, number, number];
  /** Entregas concluídas no período (para ver quantos responderam). */
  delivered: number;
  low: {
    deliveryId: string;
    code: string;
    customerName: string;
    stars: number;
    comment: string | null;
    at: string;
  }[];
}

/** Nota igual ou abaixo disto vira alerta vermelho para o dono. */
export const LOW_RATING = 3;

// ─────────────────────────── Padrão da casa (item 20) ───────────────────────────

export const houseStandardSchema = z
  .object({
    activity: z.string().trim().min(2).max(30),
    text: z.string().trim().max(1500),
    /** Foto ou vídeo curto já enviado pelos anexos (vazio = só o texto). */
    fileId: z.guid().nullable().optional(),
  })
  .strict();

export interface HouseStandardDto {
  activity: string;
  label: string;
  text: string;
  fileId: string | null;
  fileUrl: string | null;
  mime: string | null;
  updatedAt: string;
  updatedByName: string | null;
}

// ─────────────────────────── Folgas e prazos (item 19) ───────────────────────────

export interface LeaveImpactDto {
  employeeName: string;
  start: string;
  end: string;
  /** OS com prazo na semana da folga e trabalho ainda com a pessoa. */
  tight: {
    serviceOrderId: string;
    code: string;
    customerName: string;
    promisedDate: string | null;
    openTasks: number;
  }[];
}

// ─────────────────────────── Chuva (item 16) ───────────────────────────

/** Chance de chuva (%) a partir da qual o sistema avisa na véspera. */
export const RAIN_ALERT_PCT = 60;
