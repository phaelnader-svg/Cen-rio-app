/**
 * Dados do jogo guardados pelo Firma Viva por organização: plantas (com histórico), agentes e
 * metas. Funcionam sem o Cenário Gestão; quando há conexão, cada gravação passa pelo Cenário
 * (que valida os vínculos operacionais) e a cópia daqui é atualizada com o resultado.
 */
import {
  AGENT_TEMPLATES,
  suggestedOffice,
  suggestedWorkshop,
  type AgentDto,
  type GameSpaceDto,
  type LayoutContent,
} from '@cenario/shared';
import type { Prisma, PrismaClient, Space } from '@firma/db';
import { randomUUID } from 'node:crypto';

export function spaceDto(s: Space): GameSpaceDto {
  const c = s.content as unknown as LayoutContent;
  return {
    ...c,
    id: s.id,
    key: s.key,
    name: s.name,
    kind: s.kind as GameSpaceDto['kind'],
    position: s.position,
    version: s.version,
    updatedAt: s.updatedAt.toISOString(),
    updatedBy: s.updatedBy,
  };
}

export function contentOf(d: LayoutContent): LayoutContent {
  return {
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
  };
}

/** Tapeçaria e Escritório sugeridos na primeira entrada da organização. */
export async function ensureLocalSpaces(db: PrismaClient, orgId: string) {
  if (await db.space.count({ where: { orgId } })) return;
  const defs: [string, LayoutContent, number][] = [
    ['TAPECARIA', suggestedWorkshop([]), 0],
    ['ESCRITORIO', suggestedOffice(), 1],
  ];
  await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`firma:init:${orgId}`}, 0))`;
    if (await tx.space.count({ where: { orgId } })) return;
    for (const [key, c, position] of defs) {
      const s = await tx.space.create({
        data: {
          id: randomUUID(),
          orgId,
          key,
          name: c.name,
          kind: c.kind,
          position,
          content: c as unknown as Prisma.InputJsonValue,
        },
      });
      await tx.spaceRevision.create({
        data: {
          spaceId: s.id,
          version: 1,
          summary: 'Planta sugerida criada (medidas ilustrativas).',
          snapshot: c as unknown as Prisma.InputJsonValue,
        },
      });
    }
    // Gerente e Financeiro começam nas duas primeiras mesas do escritório (como no Cenário).
    const desks = defs[1]![1].stations.filter((st) => st.kind === 'MESA_ESCRITORIO');
    const agents = ['GERENTE', 'FINANCEIRO'].map((roleKey, i) => {
      const t = AGENT_TEMPLATES.find((x) => x.roleKey === roleKey)!;
      return localAgent({
        name: t.name,
        roleKey: t.roleKey,
        roleLabel: t.roleLabel,
        instructions: t.instructions,
        dataScopes: t.dataScopes,
        actionPolicies: t.actionPolicies,
        color: t.color,
        deskStationId: desks[i]?.id ?? null,
      });
    });
    await tx.orgSetting.upsert({
      where: { orgId_key: { orgId, key: 'agents' } },
      create: { orgId, key: 'agents', value: agents as unknown as Prisma.InputJsonValue },
      update: {},
    });
  });
}

export type LocalAgent = AgentDto & { localOnly?: boolean };

export function localAgent(
  input: Partial<AgentDto> & Pick<AgentDto, 'name' | 'roleKey' | 'roleLabel'>,
): LocalAgent {
  return {
    id: randomUUID(),
    instructions: '',
    dataScopes: [],
    actionPolicies: {},
    status: 'ATIVO',
    color: '#7c3aed',
    deskStationId: null,
    version: 1,
    pendingProposals: 0,
    channelPolicies: {},
    autoSendRules: [],
    engine: 'AGUARDANDO_INTEGRACAO',
    ...input,
    localOnly: true,
  } as LocalAgent;
}

export async function getSetting<T>(
  db: PrismaClient,
  orgId: string,
  key: string,
  fallback: T,
): Promise<T> {
  const r = await db.orgSetting.findUnique({ where: { orgId_key: { orgId, key } } });
  return r ? (r.value as unknown as T) : fallback;
}
export async function setSetting(db: PrismaClient, orgId: string, key: string, value: unknown) {
  await db.orgSetting.upsert({
    where: { orgId_key: { orgId, key } },
    create: { orgId, key, value: value as Prisma.InputJsonValue },
    update: { value: value as Prisma.InputJsonValue },
  });
}

/** Grava (ou atualiza) a cópia local de uma planta vinda do Cenário ou editada aqui. */
export async function storeSpace(
  db: PrismaClient,
  orgId: string,
  dto: GameSpaceDto,
  summary: string | null,
  by: string | null,
) {
  const existing = await db.space.findUnique({ where: { orgId_key: { orgId, key: dto.key } } });
  const data = {
    name: dto.name,
    kind: dto.kind,
    position: dto.position,
    content: contentOf(dto) as unknown as Prisma.InputJsonValue,
    version: dto.version,
    updatedBy: by ?? dto.updatedBy,
  };
  const s = existing
    ? await db.space.update({ where: { id: existing.id }, data })
    : await db.space.create({ data: { id: dto.id, orgId, key: dto.key, ...data } });
  if (summary && (!existing || existing.version !== dto.version)) {
    await db.spaceRevision.create({
      data: {
        spaceId: s.id,
        version: dto.version,
        summary: summary.slice(0, 1000),
        snapshot: contentOf(dto) as unknown as Prisma.InputJsonValue,
        createdBy: by,
      },
    });
  }
  return s;
}
