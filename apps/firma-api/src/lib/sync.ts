/**
 * Primeira conexão (ou reconexão) de uma organização ao Cenário Gestão.
 * - Se a empresa já tem planta configurada no Cenário (alguma versão > 1), ela é trazida para
 *   o Firma Viva (preserva vínculos com funcionários, localizações e materiais). A planta que a
 *   organização tinha antes fica no histórico.
 * - Se o Cenário só tem a planta sugerida e a organização já montou a sua no Firma Viva, a
 *   planta do Firma Viva é enviada ao Cenário.
 * - Agentes criados antes da conexão são cadastrados no Cenário; metas são copiadas para cá.
 */
import type { AgentDto, GameSpaceDto } from '@cenario/shared';
import type { FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { cenarioJson } from './cenario';
import { contentOf, getSetting, setSetting, spaceDto, storeSpace, type LocalAgent } from './local';

type Impact = { kind: 'AREA' | 'ESTACAO' | 'POSICAO'; id: string; targets: { id: string }[] };

export async function pushSpace(
  request: FastifyRequest,
  local: GameSpaceDto,
  remote: GameSpaceDto | undefined,
) {
  let target = remote;
  if (!target) {
    target = await cenarioJson<GameSpaceDto>(
      request,
      'POST',
      '/api/v1/game/spaces',
      {
        name: local.name,
        kind: local.kind,
        widthCm: local.widthCm,
        depthCm: local.depthCm,
        start: 'EM_BRANCO',
      },
      randomUUID(),
    );
  }
  const body = {
    ...contentOf(local),
    version: target.version,
    summary: 'Planta montada no Firma Viva antes da conexão.',
    transfers: { areas: {}, stations: {}, slots: {} } as Record<string, Record<string, string>>,
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await cenarioJson<GameSpaceDto>(
        request,
        'PUT',
        `/api/v1/game/spaces/${target.key}`,
        body,
        randomUUID(),
      );
    } catch (e) {
      const impacts = (e as { cenario?: { details?: { impacts?: Impact[] } } }).cenario?.details
        ?.impacts;
      if (!impacts?.length || attempt) throw e;
      // Objetos da planta sugerida do Cenário com vínculos: transfere para o primeiro destino.
      for (const i of impacts) {
        const bucket = i.kind === 'AREA' ? 'areas' : i.kind === 'ESTACAO' ? 'stations' : 'slots';
        if (i.targets[0]) body.transfers[bucket]![i.id] = i.targets[0].id;
      }
    }
  }
  throw new Error('Não foi possível enviar a planta.');
}

export async function syncOnConnect(request: FastifyRequest): Promise<string> {
  const { db } = request.server.firma;
  const orgId = request.org!.id;
  const by = request.user!.name;
  const remote = await cenarioJson<GameSpaceDto[]>(request, 'GET', '/api/v1/game/spaces');
  const local = (await db.space.findMany({ where: { orgId }, orderBy: { position: 'asc' } })).map(
    spaceDto,
  );
  const remoteEdited = remote.some((s) => s.version > 1);
  const localEdited =
    local.some((s) => s.version > 1) ||
    local.some((s) => !['TAPECARIA', 'ESCRITORIO'].includes(s.key));
  let summary: string;
  if (remoteEdited || !localEdited) {
    for (const r of remote) {
      const l = local.find((x) => x.key === r.key);
      if (l && localEdited) {
        // Guarda a versão que a organização tinha antes de trazer a do Cenário.
        await db.spaceRevision.create({
          data: {
            spaceId: (
              await db.space.findUniqueOrThrow({ where: { orgId_key: { orgId, key: l.key } } })
            ).id,
            version: l.version,
            summary: 'Planta do Firma Viva antes da conexão (guardada no histórico).',
            snapshot: contentOf(l) as object,
            createdBy: by,
          },
        });
      }
      await storeSpace(db, orgId, r, 'Planta trazida do Cenário Gestão na conexão.', by);
    }
    // Ambientes que só existiam no Firma Viva vão para o Cenário.
    for (const l of local.filter((x) => !remote.some((r) => r.key === x.key))) {
      const saved = await pushSpace(request, l, undefined);
      await storeSpace(db, orgId, saved, 'Enviada ao Cenário Gestão na conexão.', by);
    }
    summary = 'Planta da empresa trazida do Cenário Gestão.';
  } else {
    for (const l of local) {
      const saved = await pushSpace(
        request,
        l,
        remote.find((r) => r.key === l.key),
      );
      await db.space.deleteMany({ where: { orgId, key: l.key, NOT: { key: saved.key } } });
      await storeSpace(
        db,
        orgId,
        saved,
        'Planta do Firma Viva enviada ao Cenário Gestão na conexão.',
        by,
      );
    }
    summary = 'Planta montada no Firma Viva enviada ao Cenário Gestão.';
  }

  // Agentes: os criados antes da conexão passam a existir no Cenário.
  const localAgents = await getSetting<LocalAgent[]>(db, orgId, 'agents', []);
  let remoteAgents = await cenarioJson<AgentDto[]>(request, 'GET', '/api/v1/game/agents');
  const pending = localAgents.filter(
    (a) => a.localOnly && !remoteAgents.some((r) => r.name === a.name && r.roleKey === a.roleKey),
  );
  for (const a of pending) {
    await cenarioJson(
      request,
      'POST',
      '/api/v1/game/agents',
      {
        name: a.name,
        roleKey: a.roleKey,
        roleLabel: a.roleLabel,
        instructions: a.instructions,
        dataScopes: a.dataScopes,
        actionPolicies: a.actionPolicies,
        deskStationId: a.deskStationId,
        color: a.color,
        channelPolicies: a.channelPolicies,
        autoSendRules: a.autoSendRules,
      },
      randomUUID(),
    ).catch((e: Error) => request.log.warn(e, 'Agente não enviado'));
  }
  if (pending.length)
    remoteAgents = await cenarioJson<AgentDto[]>(request, 'GET', '/api/v1/game/agents');
  await setSetting(db, orgId, 'agents', remoteAgents);

  // Metas do Quadro: cópia guardada pelo jogo (quando a autorização inclui o financeiro).
  try {
    const cash = await cenarioJson<{ goals: unknown[] }>(request, 'GET', '/api/v1/office/cash');
    await setSetting(db, orgId, 'goals', cash.goals);
  } catch {
    // Sem permissão de financeiro: o Quadro fica indisponível, sem bloquear a conexão.
  }
  return `${summary} ${remoteAgents.length} agente(s).`;
}
