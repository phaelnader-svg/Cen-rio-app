/**
 * Jogo: o que é do Firma Viva (plantas, agentes, metas) é servido daqui e funciona sem o
 * Cenário Gestão. Tudo que é operacional (OS, produção, estoque, compras, financeiro) é
 * repassado ao Cenário com a autorização da PRÓPRIA organização da sessão — uma organização
 * nunca usa a conexão de outra, mesmo informando IDs de outra empresa.
 */
import {
  AGENT_TEMPLATES,
  agentSchema,
  blankLayout,
  createSpaceSchema,
  furnitureModel,
  placePiece,
  resetSpaceSchema,
  saveLayoutSchema,
  suggestedOffice,
  suggestedWorkshop,
  updateAgentSchema,
  type AgentDto,
  type GamePieceDto,
  type GameSnapshotDto,
  type GameSpaceDto,
  type LayoutContent,
} from '@cenario/shared';
import type { Prisma } from '@firma/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { atLeast } from '../context';
import { audit } from '../lib/audit';
import { cenarioCall, cenarioJson, isActive, isReadOnly } from '../lib/cenario';
import { E } from '../lib/errors';
import {
  ensureLocalSpaces,
  getSetting,
  localAgent,
  setSetting,
  spaceDto,
  storeSpace,
  type LocalAgent,
} from '../lib/local';
import { connectionView } from './connection';

const keyParams = z.object({ key: z.string().min(1).max(40) });

function slugKey(name: string) {
  return (
    name
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 30) || 'AMBIENTE'
  );
}

export async function gameRoutes(app: FastifyInstance) {
  const { db } = app.firma;

  /** Conexão ativa em modo COMPLETO (o jogo grava planta/agentes no Cenário). */
  async function connected(request: FastifyRequest) {
    const c = await db.cenarioConnection.findUnique({ where: { orgId: request.org!.id } });
    return isActive(c) && !isReadOnly(c) ? c : null;
  }
  /** Conexão ativa em modo CONSULTA (somente leitura). */
  async function readOnlyConnection(request: FastifyRequest) {
    const c = await db.cenarioConnection.findUnique({ where: { orgId: request.org!.id } });
    return isActive(c) && isReadOnly(c) ? c : null;
  }
  const idem = (request: FastifyRequest) =>
    (request.headers['idempotency-key'] as string | undefined) ?? randomUUID();

  /** Copia as plantas do Cenário para cá (fonte das validações operacionais quando conectado). */
  async function mirrorSpaces(request: FastifyRequest) {
    const remote = await cenarioJson<GameSpaceDto[]>(request, 'GET', '/api/v1/game/spaces');
    for (const r of remote) await storeSpace(db, request.org!.id, r, null, null);
    return remote;
  }

  // ───────────── Plantas ─────────────
  app.get('/api/v1/game/spaces', { config: { rule: { org: 'MEMBRO' } } }, async (request) => {
    const orgId = request.org!.id;
    if (await connected(request)) {
      try {
        return await mirrorSpaces(request);
      } catch (e) {
        request.log.warn(e, 'Cenário indisponível: usando a planta guardada no Firma Viva');
      }
    }
    await ensureLocalSpaces(db, orgId);
    const rows = await db.space.findMany({
      where: { orgId },
      orderBy: [{ position: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map(spaceDto);
  });

  app.get(
    '/api/v1/game/spaces-summary',
    { config: { rule: { org: 'MEMBRO' } } },
    async (request) => {
      await ensureLocalSpaces(db, request.org!.id);
      const rows = await db.space.findMany({
        where: { orgId: request.org!.id },
        orderBy: { position: 'asc' },
      });
      return rows.map((r) => {
        const d = spaceDto(r);
        return {
          id: d.id,
          key: d.key,
          name: d.name,
          kind: d.kind,
          widthCm: d.widthCm,
          depthCm: d.depthCm,
          version: d.version,
          illustrative: d.illustrative,
        };
      });
    },
  );

  app.get('/api/v1/game/spaces/:key', { config: { rule: { org: 'MEMBRO' } } }, async (request) => {
    const { key } = keyParams.parse(request.params);
    if (await connected(request))
      return cenarioJson<GameSpaceDto>(
        request,
        'GET',
        `/api/v1/game/spaces/${encodeURIComponent(key)}`,
      );
    await ensureLocalSpaces(db, request.org!.id);
    const s = await db.space.findUnique({ where: { orgId_key: { orgId: request.org!.id, key } } });
    if (!s) throw E.notFound('Ambiente');
    return spaceDto(s);
  });

  app.get(
    '/api/v1/game/spaces/:key/revisions',
    { config: { rule: { org: 'MEMBRO' } } },
    async (request) => {
      const { key } = keyParams.parse(request.params);
      const s = await db.space.findUnique({
        where: { orgId_key: { orgId: request.org!.id, key } },
      });
      if (!s) throw E.notFound('Ambiente');
      const rows = await db.spaceRevision.findMany({
        where: { spaceId: s.id },
        orderBy: { createdAt: 'desc' },
        take: 50,
      });
      return rows.map((r) => ({
        version: r.version,
        summary: r.summary,
        createdAt: r.createdAt.toISOString(),
        createdBy: r.createdBy,
      }));
    },
  );

  app.put('/api/v1/game/spaces/:key', { config: { rule: { org: 'GESTOR' } } }, async (request) => {
    const { key } = keyParams.parse(request.params);
    const input = saveLayoutSchema.parse(request.body);
    const orgId = request.org!.id;
    const by = request.user!.name;
    if (await connected(request)) {
      const saved = await cenarioJson<GameSpaceDto>(
        request,
        'PUT',
        `/api/v1/game/spaces/${encodeURIComponent(key)}`,
        request.body,
        idem(request),
      );
      await storeSpace(
        db,
        orgId,
        saved,
        input.summary?.trim() || 'Planta salva (sincronizada com o Cenário Gestão).',
        by,
      );
      return saved;
    }
    const ids = [
      ...input.areas.map((a) => a.id),
      ...input.stations.map((s) => s.id),
      ...input.storageUnits.map((u) => u.id),
      ...input.storageUnits.flatMap((u) => u.slots.map((s) => s.id)),
    ];
    if (new Set(ids).size !== ids.length)
      throw E.validation('Há dois objetos com o mesmo identificador.');
    const out = await db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`firma:space:${orgId}:${key}`}, 0))`;
      const s = await tx.space.findUnique({ where: { orgId_key: { orgId, key } } });
      if (!s) throw E.notFound('Ambiente');
      if (s.version !== input.version) throw E.versionConflict(s.version);
      const current = spaceDto(s);
      const content: LayoutContent = {
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
        stations: input.stations.map((st) => ({ ...st, areaId: st.areaId ?? null })),
        storageUnits: input.storageUnits.map((u) => ({ ...u, areaId: u.areaId ?? null })),
      };
      const updated = await tx.space.update({
        where: { id: s.id },
        data: {
          name: content.name,
          content: content as unknown as Prisma.InputJsonValue,
          version: { increment: 1 },
          updatedBy: by,
        },
      });
      await tx.spaceRevision.create({
        data: {
          spaceId: s.id,
          version: updated.version,
          summary: (input.summary?.trim() || 'Planta salva no Firma Viva.').slice(0, 1000),
          snapshot: content as unknown as Prisma.InputJsonValue,
          createdBy: by,
        },
      });
      return spaceDto(updated);
    });
    await audit(request, {
      action: 'planta.salva',
      summary: `Planta "${out.name}" salva (versão ${out.version}).`,
    });
    return out;
  });

  app.post(
    '/api/v1/game/spaces',
    { config: { rule: { org: 'GESTOR' } } },
    async (request, reply) => {
      const input = createSpaceSchema.parse(request.body);
      const orgId = request.org!.id;
      if (await connected(request)) {
        const created = await cenarioJson<GameSpaceDto>(
          request,
          'POST',
          '/api/v1/game/spaces',
          request.body,
          idem(request),
        );
        await storeSpace(db, orgId, created, 'Ambiente criado.', request.user!.name);
        return reply.status(201).send(created);
      }
      let key = slugKey(input.name);
      for (let i = 2; await db.space.findUnique({ where: { orgId_key: { orgId, key } } }); i++)
        key = `${slugKey(input.name).slice(0, 26)}_${i}`;
      const content =
        input.start === 'SUGERIDA'
          ? input.kind === 'ESCRITORIO'
            ? suggestedOffice()
            : suggestedWorkshop([])
          : blankLayout(input.name, input.kind, input.widthCm, input.depthCm);
      content.name = input.name;
      const position = await db.space.count({ where: { orgId } });
      const dto: GameSpaceDto = {
        ...content,
        id: randomUUID(),
        key,
        position,
        version: 1,
        updatedAt: new Date().toISOString(),
        updatedBy: request.user!.name,
      };
      await storeSpace(db, orgId, dto, 'Ambiente criado.', request.user!.name);
      return reply.status(201).send(dto);
    },
  );

  app.post(
    '/api/v1/game/spaces/:key/reset',
    { config: { rule: { org: 'GESTOR' } } },
    async (request) => {
      const { key } = keyParams.parse(request.params);
      const input = resetSpaceSchema.parse(request.body);
      const orgId = request.org!.id;
      if (await connected(request)) {
        const saved = await cenarioJson<GameSpaceDto>(
          request,
          'POST',
          `/api/v1/game/spaces/${encodeURIComponent(key)}/reset`,
          request.body,
          idem(request),
        );
        await storeSpace(db, orgId, saved, 'Planta recomeçada.', request.user!.name);
        return saved;
      }
      const s = await db.space.findUnique({ where: { orgId_key: { orgId, key } } });
      if (!s) throw E.notFound('Ambiente');
      if (s.version !== input.version) throw E.versionConflict(s.version);
      const cur = spaceDto(s);
      const content =
        input.start === 'SUGERIDA'
          ? cur.kind === 'ESCRITORIO'
            ? suggestedOffice()
            : suggestedWorkshop([])
          : blankLayout(cur.name, cur.kind, cur.widthCm, cur.depthCm);
      content.name = cur.name;
      const dto: GameSpaceDto = {
        ...cur,
        ...content,
        version: s.version + 1,
        updatedAt: new Date().toISOString(),
        updatedBy: request.user!.name,
      };
      await storeSpace(
        db,
        orgId,
        dto,
        input.start === 'SUGERIDA' ? 'Recomeçou da planta sugerida.' : 'Recomeçou do zero.',
        request.user!.name,
      );
      return dto;
    },
  );

  // ───────────── Agentes (configuração guardada pelo jogo) ─────────────
  app.get(
    '/api/v1/game/agent-templates',
    { config: { rule: { org: 'MEMBRO' } } },
    async () => AGENT_TEMPLATES,
  );

  app.get('/api/v1/game/agents', { config: { rule: { org: 'MEMBRO' } } }, async (request) => {
    const orgId = request.org!.id;
    if (await connected(request)) {
      try {
        const remote = await cenarioJson<AgentDto[]>(request, 'GET', '/api/v1/game/agents');
        await setSetting(db, orgId, 'agents', remote);
        return remote;
      } catch (e) {
        request.log.warn(e, 'Cenário indisponível: agentes guardados no Firma Viva');
      }
    }
    await ensureLocalSpaces(db, orgId);
    return getSetting<LocalAgent[]>(db, orgId, 'agents', []);
  });

  app.post(
    '/api/v1/game/agents',
    { config: { rule: { org: 'GESTOR' } } },
    async (request, reply) => {
      const input = agentSchema.parse(request.body);
      const orgId = request.org!.id;
      if (await connected(request)) {
        const created = await cenarioJson<AgentDto>(
          request,
          'POST',
          '/api/v1/game/agents',
          request.body,
          idem(request),
        );
        const list = await cenarioJson<AgentDto[]>(request, 'GET', '/api/v1/game/agents');
        await setSetting(db, orgId, 'agents', list);
        return reply.status(201).send(created);
      }
      const list = await getSetting<LocalAgent[]>(db, orgId, 'agents', []);
      const a = localAgent({
        ...input,
        deskStationId: input.deskStationId ?? null,
      } as Partial<AgentDto> & Pick<AgentDto, 'name' | 'roleKey' | 'roleLabel'>);
      await setSetting(db, orgId, 'agents', [...list, a]);
      await audit(request, {
        action: 'agente.criado',
        summary: `Agente ${a.name} configurado (antes da conexão).`,
      });
      return reply.status(201).send(a);
    },
  );

  app.put('/api/v1/game/agents/:id', { config: { rule: { org: 'GESTOR' } } }, async (request) => {
    const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
    const input = updateAgentSchema.parse(request.body);
    const orgId = request.org!.id;
    if (await connected(request)) {
      const saved = await cenarioJson<AgentDto>(
        request,
        'PUT',
        `/api/v1/game/agents/${id}`,
        request.body,
        idem(request),
      );
      const list = await cenarioJson<AgentDto[]>(request, 'GET', '/api/v1/game/agents');
      await setSetting(db, orgId, 'agents', list);
      return saved;
    }
    const list = await getSetting<LocalAgent[]>(db, orgId, 'agents', []);
    const i = list.findIndex((a) => a.id === id);
    if (i < 0) throw E.notFound('Agente');
    if (list[i]!.version !== input.version) throw E.versionConflict(list[i]!.version);
    const { version: _v, ...rest } = input;
    list[i] = { ...list[i]!, ...rest, version: list[i]!.version + 1 } as LocalAgent;
    await setSetting(db, orgId, 'agents', list);
    return list[i];
  });

  // ───────────── Retrato e listas sem conexão (a planta abre mesmo sem empresa) ─────────────
  const offlineSnapshot = (): GameSnapshotDto => ({
    generatedAt: new Date().toISOString(),
    lastSeq: null,
    pieces: [],
    employees: [],
    slotAlerts: {},
    canPlan: false,
    canExecuteStock: false,
  });
  const offline: Record<string, () => unknown> = {
    '/api/v1/game/snapshot': offlineSnapshot,
    '/api/v1/game/people': () => [],
    '/api/v1/game/item-locations': () => [],
    '/api/v1/game/integrations': () => [],
  };

  // ───────────── Modo consulta: retrato a partir do mapa da oficina do Cenário ─────────────
  interface WorkshopPiece {
    id: string;
    code: string;
    description: string;
    pieceType: string;
    quantity: number;
    serviceOrderId: string;
    serviceOrderCode: string;
    customerName: string;
    stage: string;
    receiptLocations: string[];
    movedAt: string | null;
    movedBy: string | null;
  }
  interface WorkshopMap {
    areas: { id: string; key: string; label: string; pieces: WorkshopPiece[] }[];
    unplaced: WorkshopPiece[];
  }
  /** Localização física do Cenário → área da planta do jogo (mesma tabela do Cenário). */
  const AREA_OF_LOCATION: Record<string, string> = {
    RECEBIMENTO: 'RECEBIMENTO',
    AGUARDANDO_PRODUCAO: 'ESPERA',
    MESA_PRODUCAO: 'MONTAGEM',
    AREA_TESTES: 'QUALIDADE',
    EMBALAGEM: 'EMBALAGEM',
    EXPEDICAO: 'EXPEDICAO',
  };

  async function consultaSnapshot(request: FastifyRequest): Promise<GameSnapshotDto> {
    const orgId = request.org!.id;
    await ensureLocalSpaces(db, orgId);
    const shop =
      (await db.space.findUnique({ where: { orgId_key: { orgId, key: 'TAPECARIA' } } })) ??
      (await db.space.findFirst({ where: { orgId, kind: 'OFICINA' } }));
    const layout = shop ? spaceDto(shop) : { areas: [], stations: [] };
    const map = await cenarioJson<WorkshopMap>(request, 'GET', '/api/v1/workshop-map');
    const pieces: GamePieceDto[] = [];
    const push = (w: WorkshopPiece, area: WorkshopMap['areas'][number] | null) => {
      const fn = area ? AREA_OF_LOCATION[area.key] : undefined;
      const target = fn ? layout.areas.find((a) => a.function === fn) : undefined;
      const placement = target
        ? {
            kind: 'AREA' as const,
            stationId: null,
            areaId: target.id,
            areaFunction: target.function,
            userId: null,
            taskId: null,
            label: area!.label,
          }
        : (() => {
            // Sem movimentação registrada no Cenário: fica na espera, com o texto do recebimento.
            const base = placePiece(layout, { stage: w.stage, tasks: [] });
            const hold =
              layout.areas.find((a) => a.function === 'ESPERA') ??
              layout.areas.find((a) => a.function === 'RECEBIMENTO');
            return {
              ...base,
              kind: 'AREA' as const,
              areaId: hold?.id ?? base.areaId,
              areaFunction: hold?.function ?? base.areaFunction,
              label: w.receiptLocations.length
                ? `Sem localização registrada (recebida: ${w.receiptLocations.join(', ')})`
                : 'Sem localização registrada',
            };
          })();
      const n = Number(/(\d+)/.exec(w.serviceOrderCode)?.[1] ?? 0);
      pieces.push({
        id: w.id,
        itemCode: w.code,
        serviceOrderId: w.serviceOrderId,
        osCode: w.serviceOrderCode,
        osNumber: n,
        osVersion: 0,
        customerName: w.customerName,
        description: w.description,
        pieceType: w.pieceType,
        model: furnitureModel(w.pieceType, w.description),
        quantity: w.quantity,
        serviceType: '',
        fabric: null,
        priority: 'NORMAL',
        promisedDate: null,
        stage: w.stage,
        readiness: 'SEM_LEVANTAMENTO',
        tone: 'A_CONFERIR',
        upholstererUserId: null,
        upholstererName: null,
        planned: true,
        planItemId: null,
        tasks: [],
        placement,
        currentTask: null,
        nextTask: null,
        confirmedLocation: area
          ? { label: area.label, areaId: target?.id ?? null, at: w.movedAt ?? '', by: w.movedBy }
          : null,
        photoCount: 0,
        consulta: true,
      } as GamePieceDto);
    };
    for (const a of map.areas) for (const w of a.pieces) push(w, a);
    for (const w of map.unplaced) push(w, null);
    return {
      generatedAt: new Date().toISOString(),
      lastSeq: null,
      pieces,
      employees: [],
      slotAlerts: {},
      canPlan: false,
      canExecuteStock: false,
      mode: 'CONSULTA',
    };
  }

  app.get(
    '/api/v1/game/snapshot',
    { config: { rule: { org: 'MEMBRO' } } },
    async (request, reply) => {
      if (await readOnlyConnection(request)) return consultaSnapshot(request);
      return forward(request, reply);
    },
  );

  // ───────────── Central de Conexões: cartão "Cenário Gestão" do Firma Viva ─────────────
  app.get('/api/v1/connections', { config: { rule: { org: 'MEMBRO' } } }, async (request) => {
    const c = await db.cenarioConnection.findUnique({ where: { orgId: request.org!.id } });
    const view = connectionView(c);
    const status = view.status === 'NAO_CONECTADA' ? 'DESCONECTADA' : view.status;
    const cenarioCard = {
      key: 'CENARIO',
      label: 'Cenário Gestão',
      group: 'SISTEMA',
      provider: 'Cenário Gestão',
      auth: 'SESSAO',
      capabilities: isReadOnly(c)
        ? [
            'Modo consulta (somente leitura): OS abertas e onde cada peça está na oficina',
            'Nada é alterado no Cenário a partir do jogo (OS, estoque e financeiro intactos)',
          ]
        : [
            'OS, etapas, funcionários, materiais e estoque da empresa no mapa',
            'Atribuir etapas (o funcionário confirma o início no tablet oficial)',
            'Reservas e compras pelo fluxo oficial',
            'Caixa, cobranças, contratos e notas no Escritório',
          ],
      scopes: view.scopes,
      status,
      mode: c && status === 'CONECTADA' ? 'PRODUCAO' : null,
      verified: { tested: ['Autorização oficial com PKCE, renovação e revogação'], pending: [] },
      realIntegration: status === 'CONECTADA' ? 'sim' : 'nao',
      accountLabel: view.company?.name ?? null,
      lastSyncAt: view.lastSyncAt,
      lastError: view.lastError,
      missing: [],
      external: [],
      docsUrl: '',
      testModeAvailable: false,
      pendingAccounts: null,
      company: view.company,
      user: view.cenarioUser
        ? { displayName: view.cenarioUser.name, email: view.cenarioUser.email ?? '' }
        : undefined,
      permissions: view.permissions.length,
      firma: { ...view, canManage: atLeast(request.org!.role, 'ADMIN') },
    };
    if (!isActive(c) || isReadOnly(c)) return [cenarioCard];
    try {
      const r = await cenarioJson<{ key: string }[]>(request, 'GET', '/api/v1/connections');
      return [cenarioCard, ...r.filter((x) => x.key !== 'CENARIO')];
    } catch {
      return [cenarioCard];
    }
  });

  // ───────────── Repasse ao Cenário Gestão ─────────────
  async function forward(request: FastifyRequest, reply: FastifyReply) {
    const path = request.url; // inclui a consulta
    const bare = path.split('?')[0]!;
    const c = await db.cenarioConnection.findUnique({ where: { orgId: request.org!.id } });
    const consulta = isActive(c) && isReadOnly(c);
    if ((!isActive(c) || consulta) && request.method === 'GET' && offline[bare])
      return offline[bare]!();
    // Modo consulta: o jogo nunca envia alterações ao Cenário Gestão.
    if (consulta && request.method !== 'GET') throw E.readOnly();
    // Membros só acompanham: nada que altere a empresa.
    if (request.method !== 'GET' && !atLeast(request.org!.role, 'GESTOR'))
      throw E.forbidden('Seu papel nesta organização só permite acompanhar.');
    const body =
      request.body === undefined || request.method === 'GET'
        ? undefined
        : Buffer.isBuffer(request.body)
          ? request.body
          : JSON.stringify(request.body);
    const r = await cenarioCall(request, request.method, path, {
      ...(body !== undefined
        ? { body, contentType: request.headers['content-type'] ?? 'application/json' }
        : {}),
      ...(request.headers['idempotency-key']
        ? { idempotencyKey: String(request.headers['idempotency-key']) }
        : {}),
      accept: String(request.headers.accept ?? 'application/json'),
    });
    if (request.method !== 'GET' && r.status < 400) {
      await audit(request, {
        action: 'cenario.acao',
        summary: `${request.method} ${bare}`,
        company: c?.companyName ?? null,
      });
    }
    for (const h of ['content-type', 'content-disposition', 'cache-control']) {
      const v = r.headers.get(h);
      if (v) void reply.header(h, v);
    }
    return reply.status(r.status).send(r.body);
  }

  // Fotos da peça e dos funcionários (itens 35 e 36 da lista de 53): o arquivo vem do Cenário
  // com a autorização da organização, pelo mesmo endereço que a rota de fotos devolve.
  app.get('/api/files/*', { config: { rule: { org: 'MEMBRO' } } }, forward);

  for (const prefix of ['/api/v1/*', '/api/sync/*']) {
    app.route({
      method: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
      url: prefix,
      config: { rule: { org: 'MEMBRO' } },
      handler: forward,
    });
  }
}
