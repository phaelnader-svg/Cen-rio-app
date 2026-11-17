/**
 * Progresso do jogo guardado no servidor (por organização): nível, missões pagas e placar da
 * semana. Antes ficava só no navegador e trocar de computador zerava tudo.
 *
 * O navegador calcula o que é novo a partir do trabalho real (etapas concluídas, peças prontas no
 * prazo, missões do dia) e manda só as novidades. Aqui cada chave entra UMA vez (a mesma etapa
 * vinda de dois computadores não conta duas vezes) e o XP de cada item tem teto, então ninguém
 * infla o nível mandando valores à mão.
 *
 * Também guarda a aparência do boneco de cada pessoa ("Você" no mapa).
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getSetting, setSetting } from '../lib/local';

export interface ProgressStore {
  xp: number;
  /** Etapas concluídas já contadas: id → [usuário, dia]. */
  tasks: Record<string, [string | null, string]>;
  /** Missões do dia já pagas ("AAAA-MM-DD:missão"). */
  paid: string[];
  /** Peças que ficaram prontas (já contadas). */
  onTime: string[];
  /** Já recebeu o progresso que estava guardado num navegador (só uma vez). */
  imported?: boolean;
  updatedAt?: string;
}

const EMPTY: ProgressStore = { xp: 0, tasks: {}, paid: [], onTime: [] };
const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const id = z.string().min(1).max(80);

const progressDelta = z.object({
  tasks: z
    .array(z.object({ id, user: z.string().max(80).nullable(), day, xp: z.number().int().min(0) }))
    .max(3000)
    .default([]),
  onTime: z
    .array(z.object({ id, xp: z.number().int().min(0) }))
    .max(1000)
    .default([]),
  paid: z
    .array(
      z.object({
        key: z.string().regex(/^\d{4}-\d{2}-\d{2}:[a-z0-9_-]{1,30}$/),
        xp: z.number().int().min(0),
      }),
    )
    .max(200)
    .default([]),
  /** Progresso que estava só neste navegador: aceito uma vez, se o servidor ainda está vazio. */
  importXp: z.number().int().min(0).max(20_000).optional(),
});

/** Teto de XP por item (iguais aos valores do jogo). */
const CAP = { task: 10, onTime: 30, paid: 100 };

export const avatarLookSchema = z.object({
  skin: z.number().int().min(0).max(3),
  hairStyle: z.number().int().min(0).max(4),
  hairColor: z.string().regex(/^#[0-9a-f]{6}$/i),
  shirt: z.string().regex(/^#[0-9a-f]{6}$/i),
  pants: z.string().regex(/^#[0-9a-f]{6}$/i),
});
export type AvatarLook = z.infer<typeof avatarLookSchema>;

function prune(s: ProgressStore) {
  // Guarda só as últimas 8 semanas de detalhes (o XP acumulado fica).
  const cut = new Date(Date.now() - 56 * 864e5).toISOString().slice(0, 10);
  for (const [k, v] of Object.entries(s.tasks)) if (v[1] < cut) delete s.tasks[k];
  s.paid = s.paid.filter((p) => p.slice(0, 10) >= cut);
  s.onTime = s.onTime.slice(-800);
}

export async function progressRoutes(app: FastifyInstance) {
  const { db } = app.firma;

  app.get('/api/v1/game/progress', { config: { rule: { org: 'MEMBRO' } } }, async (request) => ({
    ...EMPTY,
    ...(await getSetting<ProgressStore>(db, request.org!.id, 'progress', EMPTY)),
  }));

  app.post('/api/v1/game/progress', { config: { rule: { org: 'MEMBRO' } } }, async (request) => {
    const input = progressDelta.parse(request.body ?? {});
    const orgId = request.org!.id;
    return db.$transaction(async (tx) => {
      // Dois computadores mandando ao mesmo tempo: um de cada vez.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`firma:progress:${orgId}`}, 0))`;
      const row = await tx.orgSetting.findUnique({
        where: { orgId_key: { orgId, key: 'progress' } },
      });
      const s: ProgressStore = { ...EMPTY, ...((row?.value as unknown as ProgressStore) ?? {}) };
      s.tasks = { ...s.tasks };
      const paid = new Set(s.paid);
      const onTime = new Set(s.onTime);
      let gained = 0;
      const empty = s.xp === 0 && !Object.keys(s.tasks).length && !s.paid.length;
      if (input.importXp && empty && !s.imported) {
        gained += input.importXp;
        s.imported = true;
      }
      for (const t of input.tasks) {
        if (s.tasks[t.id]) continue;
        s.tasks[t.id] = [t.user, t.day];
        gained += Math.min(CAP.task, t.xp);
      }
      for (const o of input.onTime) {
        if (onTime.has(o.id)) continue;
        onTime.add(o.id);
        gained += Math.min(CAP.onTime, o.xp);
      }
      for (const p of input.paid) {
        if (paid.has(p.key)) continue;
        paid.add(p.key);
        gained += Math.min(CAP.paid, p.xp);
      }
      s.paid = [...paid];
      s.onTime = [...onTime];
      s.xp += gained;
      s.updatedAt = new Date().toISOString();
      prune(s);
      await setSetting(tx as unknown as typeof db, orgId, 'progress', s);
      return s;
    });
  });

  // ───────────── Boneco ("Você") de cada pessoa ─────────────
  app.get('/api/v1/game/avatar', { config: { rule: { org: 'MEMBRO' } } }, async (request) => {
    const all = await getSetting<Record<string, AvatarLook>>(db, request.org!.id, 'avatars', {});
    return { look: all[request.user!.id] ?? null };
  });

  app.put('/api/v1/game/avatar', { config: { rule: { org: 'MEMBRO' } } }, async (request) => {
    const look = avatarLookSchema.parse(request.body);
    const orgId = request.org!.id;
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`firma:avatars:${orgId}`}, 0))`;
      const row = await tx.orgSetting.findUnique({
        where: { orgId_key: { orgId, key: 'avatars' } },
      });
      const all = { ...((row?.value as unknown as Record<string, AvatarLook>) ?? {}) };
      all[request.user!.id] = look;
      await setSetting(tx as unknown as typeof db, orgId, 'avatars', all);
    });
    return { look };
  });
}
