/**
 * Item 17 (lista de 53, 2026-11-27): o sistema aprende o tempo de cada etapa. Com o tempo real
 * registrado no tablet (início e fim de cada tarefa), calcula o tempo típico de cada etapa por
 * tipo de peça. As tarefas novas já nascem com esse tempo previsto (a programação e a fila usam o
 * número real, não um chute), e a tela mostra o tempo real de cada peça para o dono conferir o
 * preço da mão de obra.
 */
import {
  PIECE_TYPE_LABEL,
  PRODUCTION_ACTIVITY_LABEL,
  type PieceType,
  type ProductionActivity,
  type StageTimesDto,
} from '@cenario/shared';
import type { PrismaClient, Tx } from '@cenario/db';
import type { FastifyInstance } from 'fastify';
import { VIEW } from './common';

type Db = Tx | PrismaClient;
const DAY_MS = 86_400_000;
/** Janela de histórico. */
const HISTORY_DAYS = 120;
/** Amostras mínimas para confiar no número. */
const MIN_SAMPLES = 3;
/** Tarefas mais curtas ou mais longas que isso (num mesmo dia) não entram: foram registradas fora de hora. */
const MIN_MINUTES = 5;
const MAX_MINUTES = 10 * 60;

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

interface Sample {
  activity: ProductionActivity;
  pieceType: PieceType | null;
  minutes: number;
}

async function samples(db: Db): Promise<Sample[]> {
  const rows = await db.productionTask.findMany({
    where: {
      status: 'CONCLUIDA',
      startedAt: { not: null },
      completedAt: { gte: new Date(Date.now() - HISTORY_DAYS * DAY_MS) },
      pauseReason: null,
    },
    select: {
      activity: true,
      startedAt: true,
      completedAt: true,
      serviceOrderItem: { select: { pieceType: true, quantity: true } },
    },
    take: 5000,
    orderBy: { completedAt: 'desc' },
  });
  const out: Sample[] = [];
  for (const r of rows) {
    const total = (r.completedAt!.getTime() - r.startedAt!.getTime()) / 60_000;
    const per = total / Math.max(1, r.serviceOrderItem?.quantity ?? 1);
    if (per < MIN_MINUTES || total > MAX_MINUTES) continue;
    out.push({
      activity: r.activity,
      pieceType: r.serviceOrderItem?.pieceType ?? null,
      minutes: per,
    });
  }
  return out;
}

/**
 * Tempo típico (mediana, em minutos por peça) de cada etapa: por tipo de peça quando há amostras
 * suficientes, senão o da etapa em geral. Usado ao criar as tarefas novas.
 */
export async function learnedStageMinutes(db: Db) {
  const all = await samples(db);
  const byKey = new Map<string, number[]>();
  for (const s of all) {
    for (const k of [`${s.activity}|${s.pieceType ?? ''}`, `${s.activity}|*`]) {
      const list = byKey.get(k) ?? [];
      list.push(s.minutes);
      byKey.set(k, list);
    }
  }
  const learned = new Map<string, number>();
  for (const [k, xs] of byKey) if (xs.length >= MIN_SAMPLES) learned.set(k, Math.round(median(xs)));
  return (activity: ProductionActivity, pieceType: PieceType | null, quantity = 1) => {
    const m = learned.get(`${activity}|${pieceType ?? ''}`) ?? learned.get(`${activity}|*`);
    return m === undefined ? null : Math.max(MIN_MINUTES, Math.round(m * Math.max(1, quantity)));
  };
}

export async function stageTimeRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;
  app.get('/api/v1/production/stage-times', { config: { access: VIEW } }, async () => {
    const all = await samples(prisma);
    const groups = new Map<string, number[]>();
    for (const s of all) {
      if (!s.pieceType) continue;
      const k = `${s.pieceType}|${s.activity}`;
      const list = groups.get(k) ?? [];
      list.push(s.minutes);
      groups.set(k, list);
    }
    const pieces = new Map<PieceType, StageTimesDto['pieces'][number]>();
    for (const [k, xs] of groups) {
      if (xs.length < MIN_SAMPLES) continue;
      const [pieceType, activity] = k.split('|') as [PieceType, ProductionActivity];
      const p = pieces.get(pieceType) ?? {
        pieceType,
        label: PIECE_TYPE_LABEL[pieceType],
        totalMinutes: 0,
        stages: [],
      };
      const minutes = Math.round(median(xs));
      p.stages.push({
        activity,
        label: PRODUCTION_ACTIVITY_LABEL[activity],
        minutes,
        samples: xs.length,
      });
      p.totalMinutes += minutes;
      pieces.set(pieceType, p);
    }
    const out: StageTimesDto = {
      days: HISTORY_DAYS,
      samples: all.length,
      pieces: [...pieces.values()]
        .map((p) => ({ ...p, stages: p.stages.sort((a, b) => b.minutes - a.minutes) }))
        .sort((a, b) => b.totalMinutes - a.totalMinutes),
    };
    return out;
  });
}
