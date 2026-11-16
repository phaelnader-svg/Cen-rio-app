/**
 * Jogo de gestão — leitura/gravação da planta e plantas iniciais.
 *
 * A planta é persistida em tabelas próprias (áreas, estações, armazenagem com ids estáveis) e um
 * documento JSON para paredes, portas e decoração. Remover algo nunca apaga: o objeto é
 * desativado (os vínculos históricos continuam resolvíveis).
 */
import {
  type AreaDef,
  type GameSpaceDto,
  type LayoutContent,
  type LayoutDoc,
  type StationDef,
  type StorageUnitDef,
  anyPermissionAudience,
  suggestedOffice,
  suggestedWorkshop,
} from '@cenario/shared';
import type { Prisma, PrismaClient, Tx } from '@cenario/db';
import { AGENT_TEMPLATES } from './agent-templates';

export const GAME_ACCESS = { session: 'WEB', permissions: ['jogo.acessar'] } as const;
export const GAME_BUILD = {
  session: 'WEB',
  permissions: ['jogo.acessar', 'jogo.construir'],
} as const;
export const AGENT_USE = { session: 'WEB', permissions: ['jogo.acessar', 'agentes.usar'] } as const;
export const AGENT_MANAGE = {
  session: 'WEB',
  permissions: ['jogo.acessar', 'agentes.gerenciar'],
} as const;
export const GAME_AUDIENCE = anyPermissionAudience('jogo.acessar');

type Db = Tx | PrismaClient;

const spaceInclude = {
  areas: { where: { active: true }, orderBy: { createdAt: 'asc' } },
  stations: {
    where: { active: true },
    orderBy: { createdAt: 'asc' },
    include: { assignees: { orderBy: { createdAt: 'asc' } } },
  },
  storageUnits: {
    where: { active: true },
    orderBy: { createdAt: 'asc' },
    include: {
      slots: {
        where: { active: true },
        orderBy: [{ level: 'asc' }, { createdAt: 'asc' }],
        include: { materials: { orderBy: { createdAt: 'asc' } } },
      },
    },
  },
} satisfies Prisma.GameSpaceInclude;

type SpaceRow = Prisma.GameSpaceGetPayload<{ include: typeof spaceInclude }>;

const asDoc = (v: unknown): LayoutDoc => {
  const d = (v ?? {}) as Partial<LayoutDoc>;
  return {
    walls: d.walls ?? [],
    doors: d.doors ?? [],
    decor: d.decor ?? [],
    windows: d.windows ?? [],
    notes: d.notes ?? null,
  };
};

export function toSpaceDto(s: SpaceRow, updatedBy: string | null = null): GameSpaceDto {
  return {
    id: s.id,
    key: s.key,
    name: s.name,
    kind: s.kind as GameSpaceDto['kind'],
    position: s.position,
    widthCm: s.widthCm,
    depthCm: s.depthCm,
    gridCm: s.gridCm,
    illustrative: s.illustrative,
    version: s.version,
    updatedAt: s.updatedAt.toISOString(),
    updatedBy,
    doc: asDoc(s.doc),
    areas: s.areas.map(
      (a): AreaDef => ({
        id: a.id,
        function: a.function as AreaDef['function'],
        name: a.name,
        xCm: a.xCm,
        yCm: a.yCm,
        wCm: a.wCm,
        dCm: a.dCm,
        color: a.color,
        itemLocationId: a.itemLocationId,
      }),
    ),
    stations: s.stations.map(
      (st): StationDef => ({
        id: st.id,
        kind: st.kind as StationDef['kind'],
        name: st.name,
        areaId: st.areaId,
        xCm: st.xCm,
        yCm: st.yCm,
        wCm: st.wCm,
        dCm: st.dCm,
        rotation: st.rotation as StationDef['rotation'],
        activities: st.activities,
        shared: st.shared,
        assigneeUserIds: st.assignees.map((a) => a.userId),
      }),
    ),
    storageUnits: s.storageUnits.map(
      (u): StorageUnitDef => ({
        id: u.id,
        kind: u.kind as StorageUnitDef['kind'],
        label: u.label,
        areaId: u.areaId,
        xCm: u.xCm,
        yCm: u.yCm,
        wCm: u.wCm,
        dCm: u.dCm,
        rotation: u.rotation as StorageUnitDef['rotation'],
        slots: u.slots.map((sl) => ({
          id: sl.id,
          label: sl.label,
          level: sl.level,
          stockItemIds: sl.materials.map((m) => m.stockItemId),
        })),
      }),
    ),
  };
}

export async function loadSpace(db: Db, key: string) {
  const s = await db.gameSpace.findUnique({ where: { key }, include: spaceInclude });
  if (!s) return null;
  const by = s.updatedById
    ? await db.user.findUnique({ where: { id: s.updatedById }, select: { displayName: true } })
    : null;
  return toSpaceDto(s, by?.displayName ?? null);
}

export async function loadAllSpaces(db: Db) {
  const rows = await db.gameSpace.findMany({
    where: { active: true },
    include: spaceInclude,
    orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
  });
  return rows.map((r) => toSpaceDto(r));
}

/** Áreas do jogo ↔ localizações físicas já usadas pela qualidade/expedição (Fase 10). */
const LOCATION_FOR: Record<string, string> = {
  RECEBIMENTO: 'RECEBIMENTO',
  ESPERA: 'AGUARDANDO_PRODUCAO',
  MONTAGEM: 'MESA_PRODUCAO',
  QUALIDADE: 'AREA_TESTES',
  EMBALAGEM: 'EMBALAGEM',
  EXPEDICAO: 'EXPEDICAO',
};

/** Grava o conteúdo completo de uma planta nova (sem diferenças: só criação). */
export async function insertContent(tx: Tx, spaceId: string, c: LayoutContent) {
  for (const a of c.areas)
    await tx.gameArea.create({
      data: {
        id: a.id,
        spaceId,
        function: a.function,
        name: a.name,
        xCm: a.xCm,
        yCm: a.yCm,
        wCm: a.wCm,
        dCm: a.dCm,
        color: a.color ?? null,
        itemLocationId: a.itemLocationId ?? null,
      },
    });
  for (const s of c.stations)
    await tx.gameStation.create({
      data: {
        id: s.id,
        spaceId,
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
        assignees: { create: s.assigneeUserIds.map((userId) => ({ userId })) },
      },
    });
  for (const u of c.storageUnits)
    await tx.gameStorageUnit.create({
      data: {
        id: u.id,
        spaceId,
        areaId: u.areaId ?? null,
        kind: u.kind,
        label: u.label,
        xCm: u.xCm,
        yCm: u.yCm,
        wCm: u.wCm,
        dCm: u.dCm,
        rotation: u.rotation,
        slots: {
          create: u.slots.map((sl) => ({
            id: sl.id,
            label: sl.label,
            level: sl.level,
            materials: { create: sl.stockItemIds.map((stockItemId) => ({ stockItemId })) },
          })),
        },
      },
    });
}

export async function linkLocations(tx: Tx, areas: AreaDef[]) {
  const locs = await tx.itemLocation.findMany({ where: { active: true } });
  const taken = new Set<string>();
  for (const a of areas) {
    if (a.itemLocationId) continue;
    const loc = locs.find((l) => l.key === LOCATION_FOR[a.function] && !taken.has(l.id));
    if (loc) {
      a.itemLocationId = loc.id;
      taken.add(loc.id);
    }
  }
}

export async function teamHints(db: Db) {
  const rows = await db.employee.findMany({
    where: { active: true, user: { active: true } },
    select: { userId: true, displayName: true },
  });
  return rows;
}

/** Cria Tapeçaria e Escritório na primeira entrada (plantas sugeridas, ilustrativas). */
export async function ensureDefaultSpaces(prisma: PrismaClient) {
  if (await prisma.gameSpace.count()) return;
  const team = await teamHints(prisma);
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended('game:init', 0))`;
    if (await tx.gameSpace.count()) return;
    const defs: [string, LayoutContent, number][] = [
      ['TAPECARIA', suggestedWorkshop(team), 0],
      ['ESCRITORIO', suggestedOffice(), 1],
    ];
    for (const [key, c, position] of defs) {
      await linkLocations(tx, c.areas);
      const s = await tx.gameSpace.create({
        data: {
          key,
          name: c.name,
          kind: c.kind,
          widthCm: c.widthCm,
          depthCm: c.depthCm,
          gridCm: c.gridCm,
          illustrative: c.illustrative,
          doc: c.doc as unknown as Prisma.InputJsonValue,
          position,
        },
      });
      await insertContent(tx, s.id, c);
      await tx.gameLayoutRevision.create({
        data: {
          spaceId: s.id,
          version: 1,
          summary: 'Planta sugerida criada (medidas ilustrativas).',
          snapshot: c as unknown as Prisma.InputJsonValue,
        },
      });
      // Gerente e Compras começam nas duas primeiras mesas do escritório sugerido.
      if (key === 'ESCRITORIO' && !(await tx.aiAgent.count())) {
        const desks = c.stations.filter((st) => st.kind === 'MESA_ESCRITORIO');
        for (const [i, roleKey] of ['GERENTE', 'COMPRAS'].entries()) {
          const t = AGENT_TEMPLATES.find((x) => x.roleKey === roleKey)!;
          await tx.aiAgent.create({
            data: {
              name: t.name,
              roleKey: t.roleKey,
              roleLabel: t.roleLabel,
              instructions: t.instructions,
              dataScopes: t.dataScopes,
              actionPolicies: t.actionPolicies,
              color: t.color,
              deskStationId: desks[i]?.id ?? null,
            },
          });
        }
      }
    }
  });
}

export const slugKey = (name: string) =>
  name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 30) || 'AMBIENTE';

export const contentOf = (d: GameSpaceDto): LayoutContent => ({
  name: d.name,
  kind: d.kind,
  widthCm: d.widthCm,
  depthCm: d.depthCm,
  gridCm: d.gridCm,
  illustrative: d.illustrative,
  doc: d.doc,
  areas: d.areas,
  stations: d.stations,
  storageUnits: d.storageUnits,
});

export const num = (v: Prisma.Decimal | number | null | undefined) =>
  v === null || v === undefined ? 0 : Number(v);
