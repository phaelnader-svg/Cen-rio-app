/**
 * Plantas do jogo: listar, abrir, salvar (com versão e impacto de remoções), criar ambientes,
 * recomeçar do zero ou da sugestão, histórico de versões.
 */
import { requireCompanyId } from '../../core/tenant';
import {
  EVENT_TYPES,
  type GameLayoutRevisionDto,
  type GameSpaceSummaryDto,
  type LayoutContent,
  type RemovalImpact,
  blankLayout,
  createSpaceSchema,
  removalImpacts,
  resetSpaceSchema,
  saveLayoutSchema,
  slotAddress,
  suggestedOffice,
  suggestedWorkshop,
  withMoreDesks,
} from '@cenario/shared';
import type { Prisma, PrismaClient, Tx } from '@cenario/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorFrom, audit } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import type { ActorContext } from '../../core/types';
import { Errors } from '../../lib/errors';
import {
  GAME_ACCESS,
  GAME_AUDIENCE,
  GAME_BUILD,
  contentOf,
  ensureDefaultSpaces,
  insertContent,
  linkLocations,
  loadAllSpaces,
  loadSpace,
  slugKey,
  teamHints,
} from './common';

const keyParams = z.object({ key: z.string().regex(/^[A-Z0-9_]{1,40}$/, 'Ambiente inválido.') });

/** Prefixo que identifica a localização textual gravada pelo jogo no cadastro do material. */
const LOCATION_MARK = '▦ ';

async function lockSpace(tx: Tx, key: string) {
  const rows = await tx.$queryRaw<{ id: string; version: number }[]>`
    SELECT id, version FROM game_spaces WHERE key = ${key} FOR UPDATE`;
  if (!rows[0]) throw Errors.notFound('Ambiente');
  return rows[0];
}

function duplicates(ids: string[]) {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) return id;
    seen.add(id);
  }
  return null;
}

/**
 * Aplica a nova planta sobre a salva: atualiza por id, cria os novos e desativa os removidos,
 * transferindo os vínculos dos removidos para o destino escolhido.
 */
async function applyLayout(
  tx: Tx,
  actor: ActorContext,
  spaceId: string,
  before: LayoutContent,
  after: LayoutContent,
  transfers: {
    areas: Record<string, string>;
    stations: Record<string, string>;
    slots: Record<string, string>;
  },
) {
  const now = new Date();
  // Vínculos que mudam de dono antes de comparar.
  for (const s of after.stations)
    if (s.areaId && !after.areas.some((a) => a.id === s.areaId))
      s.areaId = transfers.areas[s.areaId] ?? null;
  for (const u of after.storageUnits)
    if (u.areaId && !after.areas.some((a) => a.id === u.areaId))
      u.areaId = transfers.areas[u.areaId] ?? null;
  for (const a of before.areas)
    if (!after.areas.some((x) => x.id === a.id) && a.itemLocationId) {
      const target = after.areas.find((x) => x.id === transfers.areas[a.id]);
      if (target && !target.itemLocationId) target.itemLocationId = a.itemLocationId;
    }
  // Agentes cuja mesa sai da planta: a mudança de mesa é aplicada depois que as estações novas
  // existirem (o destino pode ser uma mesa criada neste mesmo salvamento).
  const agentMoves: { from: string; to: string | null }[] = [];
  for (const s of before.stations) {
    if (after.stations.some((x) => x.id === s.id)) continue;
    const target = after.stations.find((x) => x.id === transfers.stations[s.id]);
    if (target)
      target.assigneeUserIds = [...new Set([...target.assigneeUserIds, ...s.assigneeUserIds])];
    agentMoves.push({ from: s.id, to: target?.id ?? null });
  }
  const afterSlots = new Map(
    after.storageUnits.flatMap((u) => u.slots.map((sl) => [sl.id, sl] as const)),
  );
  for (const u of before.storageUnits)
    for (const sl of u.slots) {
      if (afterSlots.has(sl.id)) continue;
      const target = afterSlots.get(transfers.slots[sl.id] ?? '');
      if (target) target.stockItemIds = [...new Set([...target.stockItemIds, ...sl.stockItemIds])];
    }

  // Ids não podem pertencer a outro ambiente.
  const foreign = async (model: 'gameArea' | 'gameStation' | 'gameStorageUnit', ids: string[]) => {
    if (!ids.length) return false;
    const rows = await (
      tx[model] as unknown as {
        findMany: (a: unknown) => Promise<{ id: string; spaceId: string }[]>;
      }
    ).findMany({ where: { id: { in: ids } }, select: { id: true, spaceId: true } });
    return rows.some((r) => r.spaceId !== spaceId);
  };
  if (
    (await foreign(
      'gameArea',
      after.areas.map((a) => a.id),
    )) ||
    (await foreign(
      'gameStation',
      after.stations.map((s) => s.id),
    )) ||
    (await foreign(
      'gameStorageUnit',
      after.storageUnits.map((u) => u.id),
    ))
  )
    throw Errors.validation(undefined, 'Há objetos de outro ambiente nesta planta. Recarregue.');

  // Áreas
  const keepAreas = new Set(after.areas.map((a) => a.id));
  await tx.gameArea.updateMany({
    where: { spaceId, active: true, id: { notIn: [...keepAreas] } },
    data: { active: false, itemLocationId: null },
  });
  // Libera localizações físicas antes de reatribuir (índice único das áreas ativas).
  await tx.gameArea.updateMany({
    where: { spaceId, id: { in: [...keepAreas] } },
    data: { itemLocationId: null },
  });
  for (const a of after.areas) {
    const data = {
      function: a.function,
      name: a.name,
      xCm: a.xCm,
      yCm: a.yCm,
      wCm: a.wCm,
      dCm: a.dCm,
      color: a.color ?? null,
      itemLocationId: a.itemLocationId ?? null,
      active: true,
    };
    await tx.gameArea.upsert({
      where: { id: a.id },
      create: { id: a.id, spaceId, ...data },
      update: data,
    });
  }
  // Estações
  const keepStations = new Set(after.stations.map((s) => s.id));
  const removedStations = await tx.gameStation.findMany({
    where: { spaceId, active: true, id: { notIn: [...keepStations] } },
    select: { id: true },
  });
  await tx.gameStationAssignee.deleteMany({
    where: { stationId: { in: removedStations.map((s) => s.id) } },
  });
  await tx.gameStation.updateMany({
    where: { id: { in: removedStations.map((s) => s.id) } },
    data: { active: false },
  });
  for (const s of after.stations) {
    const data = {
      areaId: s.areaId ?? null,
      kind: s.kind,
      name: s.name,
      xCm: s.xCm,
      yCm: s.yCm,
      wCm: s.wCm,
      dCm: s.dCm,
      rotation: s.rotation,
      activities: s.activities,
      shared: s.shared,
      active: true,
    };
    await tx.gameStation.upsert({
      where: { id: s.id },
      create: { id: s.id, spaceId, ...data },
      update: data,
    });
    await tx.gameStationAssignee.deleteMany({ where: { stationId: s.id } });
    if (s.assigneeUserIds.length)
      await tx.gameStationAssignee.createMany({
        data: [...new Set(s.assigneeUserIds)].map((userId) => ({ stationId: s.id, userId })),
      });
  }
  for (const m of agentMoves)
    await tx.aiAgent.updateMany({
      where: { deskStationId: m.from },
      data: { deskStationId: m.to, version: { increment: 1 } },
    });
  // Armazenagem e posições
  const keepUnits = new Set(after.storageUnits.map((u) => u.id));
  const removedUnits = await tx.gameStorageUnit.findMany({
    where: { spaceId, active: true, id: { notIn: [...keepUnits] } },
    select: { id: true },
  });
  const ru = removedUnits.map((u) => u.id);
  const removedSlotRows = await tx.gameStorageSlot.findMany({
    where: { unitId: { in: ru } },
    select: { id: true },
  });
  await tx.gameSlotMaterial.deleteMany({
    where: { slotId: { in: removedSlotRows.map((s) => s.id) } },
  });
  await tx.gameStorageSlot.updateMany({ where: { unitId: { in: ru } }, data: { active: false } });
  await tx.gameStorageUnit.updateMany({ where: { id: { in: ru } }, data: { active: false } });
  for (const u of after.storageUnits) {
    const data = {
      areaId: u.areaId ?? null,
      kind: u.kind,
      label: u.label,
      xCm: u.xCm,
      yCm: u.yCm,
      wCm: u.wCm,
      dCm: u.dCm,
      rotation: u.rotation,
      active: true,
    };
    await tx.gameStorageUnit.upsert({
      where: { id: u.id },
      create: { id: u.id, spaceId, ...data },
      update: data,
    });
    const keepSlots = u.slots.map((s) => s.id);
    const gone = await tx.gameStorageSlot.findMany({
      where: { unitId: u.id, active: true, id: { notIn: keepSlots } },
      select: { id: true },
    });
    await tx.gameSlotMaterial.deleteMany({ where: { slotId: { in: gone.map((g) => g.id) } } });
    await tx.gameStorageSlot.updateMany({
      where: { id: { in: gone.map((g) => g.id) } },
      data: { active: false },
    });
    for (const sl of u.slots) {
      const other = await tx.gameStorageSlot.findUnique({
        where: { id: sl.id },
        select: { unitId: true },
      });
      if (other && other.unitId !== u.id)
        throw Errors.validation(
          undefined,
          'Posição de estoque pertence a outro móvel. Recarregue.',
        );
      await tx.gameStorageSlot.upsert({
        where: { id: sl.id },
        create: { id: sl.id, unitId: u.id, label: sl.label, level: sl.level },
        update: { label: sl.label, level: sl.level, active: true },
      });
      await tx.gameSlotMaterial.deleteMany({ where: { slotId: sl.id } });
      if (sl.stockItemIds.length)
        await tx.gameSlotMaterial.createMany({
          data: [...new Set(sl.stockItemIds)].map((stockItemId) => ({
            slotId: sl.id,
            stockItemId,
          })),
        });
    }
  }
  void now;
  void actor;
}

/**
 * Integra o endereçamento ao cadastro oficial: `stock_items.location` passa a mostrar o
 * endereço do mapa (ex.: "▦ Tapeçaria → Estoque → Estante A → Prateleira 2"). Textos digitados à
 * mão no cadastro (sem a marca) não são sobrescritos quando o material sai do mapa.
 */
export async function syncStockLocations(tx: Tx, actor: ActorContext, touched: Set<string>) {
  if (!touched.size) return 0;
  const rows = await tx.gameSlotMaterial.findMany({
    where: {
      stockItemId: { in: [...touched] },
      slot: { active: true, unit: { active: true, space: { active: true } } },
    },
    include: { slot: { include: { unit: { include: { area: true, space: true } } } } },
    orderBy: { createdAt: 'asc' },
  });
  const byItem = new Map<string, string[]>();
  for (const r of rows) {
    const u = r.slot.unit;
    const addr = slotAddress(u.space.name, u.area?.name ?? null, u.label, r.slot.label);
    byItem.set(r.stockItemId, [...(byItem.get(r.stockItemId) ?? []), addr]);
  }
  let changed = 0;
  const items = await tx.stockItem.findMany({ where: { id: { in: [...touched] } } });
  for (const it of items) {
    const addrs = byItem.get(it.id);
    const next = addrs?.length ? `${LOCATION_MARK}${addrs.join('; ')}`.slice(0, 120) : null;
    const managed = !it.location || it.location.startsWith(LOCATION_MARK);
    if (!addrs?.length && !managed) continue;
    if ((it.location ?? null) === next) continue;
    await tx.stockItem.update({
      where: { id: it.id },
      data: { location: next, version: { increment: 1 } },
    });
    await audit(tx, actor, {
      action: 'stock.location_mapped',
      entityType: 'stock_item',
      entityId: it.id,
      summary: `Localização física do material pelo mapa: ${next ?? 'removida do mapa'}.`,
      changes: { before: it.location, after: next },
    });
    changed++;
  }
  return changed;
}

/**
 * Agente contratado pelo Escritório do Cenário (ou que ficou sem mesa) senta numa mesa livre do
 * escritório do jogo; sem mesa livre, a planta ganha mesas novas. O Firma Viva só desenha agente
 * que tem mesa: sem isso, quem foi contratado no Cenário não aparecia no jogo.
 * Devolve quantos agentes ganharam mesa.
 */
export async function seatAgentsWithoutDesk(
  prisma: PrismaClient,
  actor: ActorContext,
): Promise<number> {
  // Atalho sem trava: quase sempre todo agente já tem mesa.
  const loose = await prisma.aiAgent.count({
    where: {
      status: { not: 'DESATIVADO' },
      OR: [{ deskStationId: null }, { desk: { active: false } }],
    },
  });
  if (!loose) return 0;
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string; version: number }[]>`
      SELECT id, version FROM game_spaces WHERE key = 'ESCRITORIO' AND active FOR UPDATE`;
    if (!rows[0]) return 0;
    const agents = await tx.aiAgent.findMany({
      where: { status: { not: 'DESATIVADO' } },
      select: { id: true, name: true, deskStationId: true },
      orderBy: { createdAt: 'asc' },
    });
    const desks = await tx.gameStation.findMany({
      where: { kind: 'MESA_ESCRITORIO', active: true },
      select: { id: true },
    });
    const deskIds = new Set(desks.map((d) => d.id));
    const taken = new Set(
      agents.map((a) => a.deskStationId).filter((d): d is string => !!d && deskIds.has(d)),
    );
    const standing = agents.filter((a) => !a.deskStationId || !deskIds.has(a.deskStationId));
    if (!standing.length) return 0;
    const current = await loadSpace(tx, 'ESCRITORIO');
    if (!current) return 0;
    const before = contentOf(current);
    const free = before.stations
      .filter((st) => st.kind === 'MESA_ESCRITORIO' && !taken.has(st.id))
      .map((st) => st.id);
    const { layout: after, added } = withMoreDesks(
      before,
      Math.max(0, standing.length - free.length),
    );
    free.push(...added.map((st) => st.id));
    if (added.length) {
      await applyLayout(tx, actor, rows[0].id, before, structuredClone(after), {
        areas: {},
        stations: {},
        slots: {},
      });
      const s = await tx.gameSpace.update({
        where: { id: rows[0].id },
        data: {
          widthCm: after.widthCm,
          depthCm: after.depthCm,
          version: { increment: 1 },
          updatedById: actor.userId,
        },
      });
      const saved = await loadSpace(tx, 'ESCRITORIO');
      const summary = `${added.length === 1 ? 'Mesa nova' : `${added.length} mesas novas`} para agente contratado pelo Escritório.`;
      await tx.gameLayoutRevision.create({
        data: {
          spaceId: rows[0].id,
          version: s.version,
          summary,
          snapshot: contentOf(saved!) as unknown as Prisma.InputJsonValue,
          createdById: actor.userId,
        },
      });
      await audit(tx, actor, {
        action: 'game.layout_saved',
        entityType: 'game_space',
        entityId: rows[0].id,
        summary: `Planta "${after.name}" salva (versão ${s.version}): ${summary}`,
      });
      await appendEvent(tx, actor, {
        type: EVENT_TYPES.GAME_LAYOUT_SAVED,
        aggregateType: 'game_space',
        aggregateId: rows[0].id,
        payload: { key: 'ESCRITORIO', version: s.version },
        audience: GAME_AUDIENCE,
      });
    }
    let seated = 0;
    for (const a of standing) {
      const desk = free.shift();
      if (!desk) break;
      await tx.aiAgent.update({
        where: { id: a.id },
        data: { deskStationId: desk, version: { increment: 1 } },
      });
      await appendEvent(tx, actor, {
        type: EVENT_TYPES.GAME_AGENT_CHANGED,
        aggregateType: 'ai_agent',
        aggregateId: a.id,
        payload: { id: a.id },
        audience: 'permission:agentes.usar|permission:agentes.gerenciar',
      });
      seated++;
    }
    return seated;
  });
}

function describeChange(before: LayoutContent, after: LayoutContent) {
  const parts: string[] = [];
  if (before.widthCm !== after.widthCm || before.depthCm !== after.depthCm)
    parts.push(
      `medidas ${before.widthCm}×${before.depthCm} → ${after.widthCm}×${after.depthCm} cm`,
    );
  const diff = ([one, many]: [string, string], a: { id: string }[], b: { id: string }[]) => {
    const add = b.filter((x) => !a.some((y) => y.id === x.id)).length;
    const del = a.filter((x) => !b.some((y) => y.id === x.id)).length;
    if (add) parts.push(`+${add} ${add === 1 ? one : many}`);
    if (del) parts.push(`−${del} ${del === 1 ? one : many}`);
  };
  diff(['área', 'áreas'], before.areas, after.areas);
  diff(['estação', 'estações'], before.stations, after.stations);
  diff(['móvel de estoque', 'móveis de estoque'], before.storageUnits, after.storageUnits);
  if (before.doc.doors.length !== after.doc.doors.length)
    parts.push(`portas ${before.doc.doors.length} → ${after.doc.doors.length}`);
  return parts.join(', ') || 'ajustes de posição e nomes';
}

export async function gameSpaceRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;

  app.get('/api/v1/game/spaces', { config: { access: GAME_ACCESS } }, async () => {
    await ensureDefaultSpaces(prisma);
    const spaces = await loadAllSpaces(prisma);
    return spaces;
  });

  app.get('/api/v1/game/spaces/:key', { config: { access: GAME_ACCESS } }, async (request) => {
    await ensureDefaultSpaces(prisma);
    const { key } = keyParams.parse(request.params);
    const s = await loadSpace(prisma, key);
    if (!s) throw Errors.notFound('Ambiente');
    return s;
  });

  app.get(
    '/api/v1/game/spaces/:key/revisions',
    { config: { access: GAME_ACCESS } },
    async (request) => {
      const { key } = keyParams.parse(request.params);
      const space = await prisma.gameSpace.findUnique({
        where: { companyId_key: { companyId: requireCompanyId(), key } },
      });
      if (!space) throw Errors.notFound('Ambiente');
      const rows = await prisma.gameLayoutRevision.findMany({
        where: { spaceId: space.id },
        orderBy: { version: 'desc' },
        take: 50,
      });
      const users = await prisma.user.findMany({
        where: {
          id: { in: rows.map((r) => r.createdById).filter((x): x is string => Boolean(x)) },
        },
        select: { id: true, displayName: true },
      });
      return rows.map(
        (r): GameLayoutRevisionDto => ({
          version: r.version,
          summary: r.summary,
          createdAt: r.createdAt.toISOString(),
          createdBy: users.find((u) => u.id === r.createdById)?.displayName ?? null,
        }),
      );
    },
  );

  /** Salva a planta. 409 VERSION_CONFLICT se outra pessoa salvou antes; 409 CONFLICT com
   * `details.impacts` quando uma remoção tem vínculos e falta escolher o destino. */
  app.put(
    '/api/v1/game/spaces/:key',
    { config: { access: GAME_BUILD, idempotent: true } },
    async (request) => {
      const { key } = keyParams.parse(request.params);
      const input = saveLayoutSchema.parse(request.body);
      const actor = actorFrom(request);
      const dup =
        duplicates(input.areas.map((a) => a.id)) ??
        duplicates(input.stations.map((s) => s.id)) ??
        duplicates(input.storageUnits.map((u) => u.id)) ??
        duplicates(input.storageUnits.flatMap((u) => u.slots.map((s) => s.id)));
      if (dup) throw Errors.validation(undefined, 'Há dois objetos com o mesmo identificador.');
      const result = await prisma.$transaction(async (tx) => {
        const head = await lockSpace(tx, key);
        if (head.version !== input.version) throw Errors.versionConflict(head.version);
        const current = await loadSpace(tx, key);
        if (!current) throw Errors.notFound('Ambiente');
        const before = contentOf(current);
        const after: LayoutContent = {
          name: input.name,
          kind: current.kind,
          widthCm: input.widthCm,
          depthCm: input.depthCm,
          gridCm: input.gridCm,
          illustrative: input.illustrative,
          doc: {
            walls: input.doc.walls,
            doors: input.doc.doors,
            decor: input.doc.decor,
            windows: input.doc.windows,
            notes: input.doc.notes ?? null,
          },
          areas: input.areas.map((a) => ({
            ...a,
            color: a.color ?? null,
            itemLocationId: a.itemLocationId ?? null,
          })),
          stations: input.stations.map((s) => ({ ...s, areaId: s.areaId ?? null })),
          storageUnits: input.storageUnits.map((u) => ({ ...u, areaId: u.areaId ?? null })),
        };
        // Referências válidas.
        const users = [...new Set(after.stations.flatMap((s) => s.assigneeUserIds))];
        if (users.length) {
          const ok = await tx.user.count({
            where: { id: { in: users }, active: true, employee: { isNot: null } },
          });
          if (ok !== users.length)
            throw Errors.validation(
              undefined,
              'Há estação vinculada a funcionário inexistente ou desativado.',
            );
        }
        const items = [
          ...new Set(after.storageUnits.flatMap((u) => u.slots.flatMap((s) => s.stockItemIds))),
        ];
        if (
          items.length &&
          (await tx.stockItem.count({ where: { id: { in: items } } })) !== items.length
        )
          throw Errors.validation(undefined, 'Há posição de estoque com material inexistente.');
        const locs = after.areas
          .map((a) => a.itemLocationId)
          .filter((x): x is string => Boolean(x));
        if (new Set(locs).size !== locs.length)
          throw Errors.validation(
            undefined,
            'Cada localização física só pode ser representada por uma área.',
          );

        // Impacto das remoções com vínculos.
        const agents = await tx.aiAgent.findMany({
          where: {
            deskStationId: { in: before.stations.map((s) => s.id) },
            status: { not: 'DESATIVADO' },
          },
          select: { deskStationId: true, name: true },
        });
        const impacts = removalImpacts(before, after, {
          agentByDesk: Object.fromEntries(agents.map((a) => [a.deskStationId!, a.name])),
        });
        const t = input.transfers ?? { areas: {}, stations: {}, slots: {} };
        const missing: RemovalImpact[] = impacts.filter((i) => {
          const chosen =
            i.kind === 'AREA'
              ? t.areas[i.id]
              : i.kind === 'ESTACAO'
                ? t.stations[i.id]
                : t.slots[i.id];
          return !chosen || !i.targets.some((x) => x.id === chosen);
        });
        if (missing.length)
          throw Errors.conflict(
            'Há objetos removidos com vínculos. Escolha para onde transferir antes de salvar.',
            { impacts: missing },
          );
        const touchedItems = new Set([
          ...before.storageUnits.flatMap((u) => u.slots.flatMap((s) => s.stockItemIds)),
          ...items,
        ]);
        await applyLayout(tx, actor, head.id, before, after, t);
        const s = await tx.gameSpace.update({
          where: { id: head.id },
          data: {
            name: after.name,
            widthCm: after.widthCm,
            depthCm: after.depthCm,
            gridCm: after.gridCm,
            illustrative: after.illustrative,
            doc: after.doc as unknown as Prisma.InputJsonValue,
            version: { increment: 1 },
            updatedById: actor.userId,
          },
        });
        // Releitura (com as transferências aplicadas) para o histórico.
        const saved = await loadSpace(tx, key);
        await syncStockLocations(tx, actor, touchedItems);
        const summary = (input.summary?.trim() || describeChange(before, after)).slice(0, 1000);
        await tx.gameLayoutRevision.create({
          data: {
            spaceId: head.id,
            version: s.version,
            summary,
            snapshot: contentOf(saved!) as unknown as Prisma.InputJsonValue,
            createdById: actor.userId,
          },
        });
        await audit(tx, actor, {
          action: 'game.layout_saved',
          entityType: 'game_space',
          entityId: head.id,
          summary: `Planta "${after.name}" salva (versão ${s.version}): ${summary}`,
          changes: {
            version: s.version,
            impacts: impacts.map((i) => ({ kind: i.kind, id: i.id, name: i.name })),
            transfers: t,
          },
        });
        await appendEvent(tx, actor, {
          type: EVENT_TYPES.GAME_LAYOUT_SAVED,
          aggregateType: 'game_space',
          aggregateId: head.id,
          payload: { key, version: s.version },
          audience: GAME_AUDIENCE,
        });
        return saved!;
      });
      return result;
    },
  );

  app.post(
    '/api/v1/game/spaces',
    { config: { access: GAME_BUILD, idempotent: true } },
    async (request, reply) => {
      const input = createSpaceSchema.parse(request.body);
      const actor = actorFrom(request);
      const out = await prisma.$transaction(async (tx) => {
        let key = slugKey(input.name);
        for (
          let i = 2;
          await tx.gameSpace.findUnique({
            where: { companyId_key: { companyId: requireCompanyId(), key } },
          });
          i++
        )
          key = `${slugKey(input.name).slice(0, 26)}_${i}`;
        const content =
          input.start === 'SUGERIDA'
            ? input.kind === 'ESCRITORIO'
              ? suggestedOffice()
              : suggestedWorkshop(await teamHints(tx))
            : blankLayout(input.name, input.kind, input.widthCm, input.depthCm);
        content.name = input.name;
        if (input.start === 'EM_BRANCO') {
          content.widthCm = input.widthCm;
          content.depthCm = input.depthCm;
        }
        const position = (await tx.gameSpace.count()) + 1;
        const s = await tx.gameSpace.create({
          data: {
            key,
            name: content.name,
            kind: input.kind,
            widthCm: content.widthCm,
            depthCm: content.depthCm,
            gridCm: content.gridCm,
            illustrative: content.illustrative,
            doc: content.doc as unknown as Prisma.InputJsonValue,
            position,
            updatedById: actor.userId,
          },
        });
        await insertContent(tx, s.id, content);
        await tx.gameLayoutRevision.create({
          data: {
            spaceId: s.id,
            version: 1,
            summary: 'Ambiente criado.',
            snapshot: content as unknown as Prisma.InputJsonValue,
            createdById: actor.userId,
          },
        });
        await audit(tx, actor, {
          action: 'game.space_created',
          entityType: 'game_space',
          entityId: s.id,
          summary: `Ambiente "${content.name}" criado no jogo (${content.widthCm}×${content.depthCm} cm).`,
        });
        await appendEvent(tx, actor, {
          type: EVENT_TYPES.GAME_LAYOUT_SAVED,
          aggregateType: 'game_space',
          aggregateId: s.id,
          payload: { key, version: 1 },
          audience: GAME_AUDIENCE,
        });
        return loadSpace(tx, key);
      });
      return reply.status(201).send(out);
    },
  );

  /** Recomeça um ambiente do zero ou da planta sugerida (o histórico anterior é mantido).
   * Vínculos existentes (funcionários, materiais, agentes) precisam ser refeitos. */
  app.post(
    '/api/v1/game/spaces/:key/reset',
    { config: { access: GAME_BUILD, idempotent: true } },
    async (request) => {
      const { key } = keyParams.parse(request.params);
      const input = resetSpaceSchema.parse(request.body);
      const actor = actorFrom(request);
      return prisma.$transaction(async (tx) => {
        const head = await lockSpace(tx, key);
        if (head.version !== input.version) throw Errors.versionConflict(head.version);
        const current = (await loadSpace(tx, key))!;
        const content =
          input.start === 'SUGERIDA'
            ? current.kind === 'ESCRITORIO'
              ? suggestedOffice()
              : suggestedWorkshop(await teamHints(tx))
            : blankLayout(current.name, current.kind, current.widthCm, current.depthCm);
        content.name = current.name;
        await linkLocations(tx, content.areas);
        const touched = new Set(
          current.storageUnits.flatMap((u) => u.slots.flatMap((s) => s.stockItemIds)),
        );
        const transfers = { areas: {}, stations: {}, slots: {} };
        // Recomeçar desfaz vínculos: agentes ficam sem mesa, materiais saem do mapa.
        await tx.aiAgent.updateMany({
          where: { deskStationId: { in: current.stations.map((s) => s.id) } },
          data: { deskStationId: null, version: { increment: 1 } },
        });
        // Desativa tudo e cria o conteúdo novo (ids novos).
        await applyLayout(
          tx,
          actor,
          head.id,
          contentOf(current),
          { ...content, areas: [], stations: [], storageUnits: [] },
          transfers,
        );
        await insertContent(tx, head.id, content);
        const s = await tx.gameSpace.update({
          where: { id: head.id },
          data: {
            widthCm: content.widthCm,
            depthCm: content.depthCm,
            gridCm: content.gridCm,
            illustrative: content.illustrative,
            doc: content.doc as unknown as Prisma.InputJsonValue,
            version: { increment: 1 },
            updatedById: actor.userId,
          },
        });
        await syncStockLocations(tx, actor, touched);
        const saved = (await loadSpace(tx, key))!;
        await tx.gameLayoutRevision.create({
          data: {
            spaceId: head.id,
            version: s.version,
            summary:
              input.start === 'SUGERIDA' ? 'Recomeçou da planta sugerida.' : 'Recomeçou do zero.',
            snapshot: contentOf(saved) as unknown as Prisma.InputJsonValue,
            createdById: actor.userId,
          },
        });
        await audit(tx, actor, {
          action: 'game.layout_reset',
          entityType: 'game_space',
          entityId: head.id,
          summary: `Planta "${current.name}" recomeçada (${input.start === 'SUGERIDA' ? 'sugerida' : 'em branco'}).`,
        });
        await appendEvent(tx, actor, {
          type: EVENT_TYPES.GAME_LAYOUT_SAVED,
          aggregateType: 'game_space',
          aggregateId: head.id,
          payload: { key, version: s.version },
          audience: GAME_AUDIENCE,
        });
        return saved;
      });
    },
  );

  app.get('/api/v1/game/people', { config: { access: GAME_ACCESS } }, async () => {
    const rows = await prisma.employee.findMany({
      where: { active: true, user: { active: true } },
      include: { user: { include: { roles: { include: { role: true } } } } },
      orderBy: { displayName: 'asc' },
    });
    return rows.map((e) => ({
      userId: e.userId,
      employeeId: e.id,
      name: e.displayName,
      color: e.color,
      jobTitle: e.jobTitle,
      roles: e.user.roles.map((r) => r.role.name),
      // Item 35 (lista de 53): a foto de Funcionários vai para o crachá no jogo.
      photoUrl: e.photoFileId ? `/api/files/${e.photoFileId}/miniatura` : null,
    }));
  });

  app.get('/api/v1/game/item-locations', { config: { access: GAME_ACCESS } }, async () =>
    prisma.itemLocation.findMany({
      where: { active: true },
      orderBy: { position: 'asc' },
      select: { id: true, key: true, label: true },
    }),
  );

  app.get('/api/v1/game/spaces-summary', { config: { access: GAME_ACCESS } }, async () => {
    await ensureDefaultSpaces(prisma);
    const rows = await prisma.gameSpace.findMany({
      where: { active: true },
      orderBy: [{ position: 'asc' }],
    });
    return rows.map(
      (r): GameSpaceSummaryDto => ({
        id: r.id,
        key: r.key,
        name: r.name,
        kind: r.kind as GameSpaceSummaryDto['kind'],
        widthCm: r.widthCm,
        depthCm: r.depthCm,
        version: r.version,
        illustrative: r.illustrative,
      }),
    );
  });
}
