import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type {
  CommandResultDto,
  GamePieceDto,
  GameSnapshotDto,
  GameSpaceDto,
} from '@cenario/shared';
import type { App } from '../src/app';
import { setClock } from '../src/core/clock';
import { type Client, createTestApp, db, idemKey, loginAdmin, resetDatabase } from './helpers';
import { act, serviceOrderWith, tabletOf, today, userIdOf } from './production-helpers';
import { openServiceOrder } from './measurement-helpers';
import { confirmedFabricPurchase, createSupplier, ok, receive } from './purchasing-helpers';

/**
 * Jogo de gestão: planta persistente com vínculos estáveis, representação da produção pelos
 * registros (sofá muda de estação quando cada funcionário inicia no tablet), estoque no mapa e
 * agentes Gerente/Compras sobre os dados do Cenário. Dados fictícios.
 */
let app: App;
beforeAll(async () => {
  app = await createTestApp();
});
afterAll(() => app.close());
beforeEach(async () => {
  await resetDatabase();
  setClock();
});

const post = (c: Client, url: string, body: unknown) =>
  c.post(url, body, { 'idempotency-key': idemKey() });
const put = (c: Client, url: string, body: unknown) =>
  c.req('PUT', url, body, { 'idempotency-key': idemKey() });
const space = async (c: Client, key: string) =>
  (await c.get(`/api/v1/game/spaces/${key}`)).body as GameSpaceDto;
const snapshot = async (c: Client) => {
  const r = await c.get('/api/v1/game/snapshot');
  expect(r.status).toBe(200);
  return r.body as GameSnapshotDto;
};

describe('jogo — planta persistente (expandir a empresa)', () => {
  it('aumenta o escritório, adiciona mesa, cria agente, muda bancada, salva e reabre com os vínculos', async () => {
    const admin = await loginAdmin(app);
    const office = await space(admin, 'ESCRITORIO');
    const shop = await space(admin, 'TAPECARIA');
    expect(shop.widthCm * shop.depthCm).toBe(1_800_000); // 180 m², ilustrativa
    expect(shop.illustrative).toBe(true);

    // Escritório maior + uma mesa nova.
    const deskId = crypto.randomUUID();
    const bigger = {
      ...office,
      depthCm: office.depthCm + 300,
      stations: [
        ...office.stations,
        {
          id: deskId,
          kind: 'MESA_ESCRITORIO',
          name: 'Mesa 5',
          areaId: office.areas[0]!.id,
          xCm: 60,
          yCm: 650,
          wCm: 140,
          dCm: 70,
          rotation: 0,
          activities: [],
          shared: false,
          assigneeUserIds: [],
        },
      ],
    };
    const savedOffice = await put(admin, '/api/v1/game/spaces/ESCRITORIO', bigger);
    expect(savedOffice.status, JSON.stringify(savedOffice.body)).toBe(200);
    expect(savedOffice.body.version).toBe(office.version + 1);

    // Agente novo (função nova criada pela interface) sentado na mesa nova.
    const agent = await post(admin, '/api/v1/game/agents', {
      name: 'Pós-venda',
      roleKey: 'PERSONALIZADA',
      roleLabel: 'Pós-venda',
      instructions: 'Acompanhe entregas e pergunte ao cliente como ficou.',
      dataScopes: ['os'],
      actionPolicies: { enviar_mensagem: 'PROPOR' },
      deskStationId: deskId,
    });
    expect(agent.status, JSON.stringify(agent.body)).toBe(201);
    // Mesa ocupada não recebe outro agente.
    const dup = await post(admin, '/api/v1/game/agents', {
      name: 'X',
      roleKey: 'PERSONALIZADA',
      roleLabel: 'X',
      instructions: '',
      dataScopes: [],
      deskStationId: deskId,
    });
    expect(dup.status).toBe(409);

    // Muda a bancada do Ricardo de lugar (mesmo id, mesmo vínculo).
    const ricardo = await userIdOf('Ricardo');
    const bench = shop.stations.find((s) => s.name === 'Bancada do Ricardo')!;
    expect(bench.assigneeUserIds).toEqual([ricardo]);
    const moved = {
      ...shop,
      stations: shop.stations.map((s) =>
        s.id === bench.id ? { ...s, xCm: s.xCm + 50, rotation: 180 } : s,
      ),
    };
    expect((await put(admin, '/api/v1/game/spaces/TAPECARIA', moved)).status).toBe(200);
    // Salvar com versão velha: conflito, nada muda.
    expect((await put(admin, '/api/v1/game/spaces/TAPECARIA', moved)).body.error.code).toBe(
      'VERSION_CONFLICT',
    );

    // "Reabrir o jogo": outra sessão lê tudo no lugar.
    const again = await loginAdmin(app);
    const shop2 = await space(again, 'TAPECARIA');
    const bench2 = shop2.stations.find((s) => s.id === bench.id)!;
    expect(bench2).toMatchObject({
      xCm: bench.xCm + 50,
      rotation: 180,
      assigneeUserIds: [ricardo],
    });
    const office2 = await space(again, 'ESCRITORIO');
    expect(office2.depthCm).toBe(office.depthCm + 300);
    expect(office2.stations.some((s) => s.id === deskId)).toBe(true);
    const agents = (await again.get('/api/v1/game/agents')).body as {
      name: string;
      deskStationId: string;
    }[];
    expect(agents.find((a) => a.name === 'Pós-venda')!.deskStationId).toBe(deskId);
    expect(agents.map((a) => a.name)).toEqual(expect.arrayContaining(['Gerente', 'Compras']));
    // Histórico e auditoria.
    const revs = (await again.get('/api/v1/game/spaces/TAPECARIA/revisions')).body as {
      version: number;
    }[];
    expect(revs[0]!.version).toBe(shop2.version);
    expect(await db().auditLog.count({ where: { action: 'game.layout_saved' } })).toBe(2);
  });

  it('remover estação/área/posição com vínculos exige escolher o destino', async () => {
    const admin = await loginAdmin(app);
    const shop = await space(admin, 'TAPECARIA');
    const ricardoBench = shop.stations.find((s) => s.name === 'Bancada do Ricardo')!;
    const marcioBench = shop.stations.find((s) => s.name === 'Bancada do Márcio')!;
    const without = { ...shop, stations: shop.stations.filter((s) => s.id !== ricardoBench.id) };
    const r = await put(admin, '/api/v1/game/spaces/TAPECARIA', without);
    expect(r.status).toBe(409);
    expect(r.body.error.details.impacts[0]).toMatchObject({ kind: 'ESTACAO', id: ricardoBench.id });
    const ok2 = await put(admin, '/api/v1/game/spaces/TAPECARIA', {
      ...without,
      transfers: { stations: { [ricardoBench.id]: marcioBench.id } },
    });
    expect(ok2.status, JSON.stringify(ok2.body)).toBe(200);
    const after = ok2.body as GameSpaceDto;
    expect(after.stations.find((s) => s.id === marcioBench.id)!.assigneeUserIds).toHaveLength(2);
    // A estação removida fica desativada (histórico preservado), não apagada.
    expect((await db().gameStation.findUnique({ where: { id: ricardoBench.id } }))!.active).toBe(
      false,
    );
  });
});

describe('jogo — estoque no mapa', () => {
  it('endereça material na prateleira, integra ao cadastro e mostra saldo, reservas e OS aguardando', async () => {
    const admin = await loginAdmin(app);
    const item = (
      await post(admin, '/api/v1/stock-items', {
        kind: 'OUTRO',
        description: 'Grampos 80/10',
        unit: 'EMBALAGEM',
        minQuantity: 2,
      })
    ).body;
    await post(admin, `/api/v1/stock-items/${item.id}/adjust`, {
      quantity: 5,
      reason: 'Saldo inicial',
    });
    const shop = await space(admin, 'TAPECARIA');
    const estante = shop.storageUnits.find((u) => u.label === 'Estante A')!;
    const slot = estante.slots.find((s) => s.level === 2)!;
    slot.stockItemIds = [item.id];
    expect((await put(admin, '/api/v1/game/spaces/TAPECARIA', shop)).status).toBe(200);
    const stock = await db().stockItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(stock.location).toBe('▦ Tapeçaria → Estoque → Estante A → Prateleira 2');

    const found = (await admin.get('/api/v1/game/materials?q=grampo')).body;
    expect(found[0].locations[0].slotId).toBe(slot.id);
    const detail = (await admin.get(`/api/v1/game/slots/${slot.id}`)).body;
    expect(detail.address).toBe('Tapeçaria → Estoque → Estante A → Prateleira 2');
    expect(detail.materials[0]).toMatchObject({
      onHand: 5,
      reserved: 0,
      available: 5,
      unit: 'EMBALAGEM',
    });
    expect(detail.materials[0].movements[0]).toMatchObject({ type: 'AJUSTE_ENTRADA', quantity: 5 });
  });
});

describe('jogo — produzir um sofá (representação pelos registros)', () => {
  it('falta de material → atribuição → cada início no tablet move o sofá → expedição', async () => {
    const admin = await loginAdmin(app);
    const { so, reqs } = await serviceOrderWith(admin, 'missing', 'Cliente Fictício Jogo');
    const sofaId = so.items[0].id;
    const piece = async () =>
      (await snapshot(admin)).pieces.find((p) => p.id === sofaId) as GamePieceDto;
    expect(await piece()).toMatchObject({
      tone: 'FALTA',
      model: 'SOFA',
      placement: { kind: 'SEM_PLANEJAMENTO' },
    });

    const shop = await space(admin, 'TAPECARIA');
    const ids = { joao: await userIdOf('João'), marcio: await userIdOf('Márcio') };
    const stationOf = (id: string | null) => shop.stations.find((s) => s.id === id)?.name;

    // Atribuição pelo fluxo oficial (planejar + publicar).
    const planned = await post(admin, '/api/v1/production/plan-services', {
      entries: [
        {
          serviceOrderId: so.id,
          startDate: today(),
          pieces: so.items.map((i: { id: string }) => ({
            serviceOrderItemId: i.id,
            upholstererUserId: ids.marcio,
          })),
        },
      ],
    });
    expect(planned.status, JSON.stringify(planned.body)).toBe(201);
    const planId = planned.body.planned[0].planId;
    const plan = (await admin.get(`/api/v1/production-plans/${planId}`)).body;
    expect(
      (await post(admin, `/api/v1/production-plans/${planId}/publish`, { version: plan.version }))
        .status,
    ).toBe(200);

    let p = await piece();
    expect(p.planned).toBe(true);
    expect(p.placement).toMatchObject({ kind: 'FILA', userId: ids.joao });
    expect(stationOf(p.placement.stationId)).toBe('Bancada do desmanche');
    expect(
      (await snapshot(admin)).employees.find((e) => e.name === 'João')!.queue.length,
    ).toBeGreaterThan(0);

    const tablets: Record<string, Client> = {
      [ids.joao]: await tabletOf(app, admin, 'João', '121212'),
      [ids.marcio]: await tabletOf(app, admin, 'Márcio', '736152'),
    };
    // O gestor não inicia pelo jogo: o início é do funcionário.
    expect((await act(admin, p.placement.taskId!, 'start')).status).toBe(403);
    expect((await act(tablets[ids.joao]!, p.placement.taskId!, 'start')).status).toBe(200);
    p = await piece();
    expect(p.placement).toMatchObject({ kind: 'ESTACAO', userId: ids.joao });
    expect(stationOf(p.placement.stationId)).toBe('Bancada do desmanche');
    const joao = (await snapshot(admin)).employees.find((e) => e.name === 'João')!;
    expect(joao.currentTask!.id).toBe(p.placement.taskId);
    expect(joao.stationId).toBe(p.placement.stationId);

    expect(
      (await act(tablets[ids.joao]!, p.placement.taskId!, 'complete', { note: 'ok' })).status,
    ).toBe(200);
    p = await piece();
    expect(['AGUARDANDO_ETAPA', 'FILA']).toContain(p.placement.kind);

    // Resolve a falta pelo fluxo oficial (compra confirmada + recebimento conferido).
    const supplier = await createSupplier(admin, 'Tecidos Fictícios do Jogo');
    const po = await confirmedFabricPurchase(admin, supplier.id, reqs[0]!);
    expect((await receive(admin, po.id, [ok(po.items[0].id, 12)])).status).toBe(201);
    expect((await piece()).tone).toBe('DISPONIVEL');

    // Cada etapa seguinte: quem é o responsável inicia no tablet → o sofá vai para a estação dele.
    const seen: string[] = [];
    for (let guard = 0; guard < 12; guard++) {
      p = await piece();
      const next = p.tasks.find((t) => t.status === 'LIBERADA');
      if (!next) break;
      const tablet = tablets[next.assigneeUserId!];
      expect(tablet, `tablet de ${next.assigneeName}`).toBeTruthy();
      expect((await act(tablet!, next.id, 'start')).status).toBe(200);
      p = await piece();
      expect(p.placement).toMatchObject({
        kind: 'ESTACAO',
        taskId: next.id,
        userId: next.assigneeUserId,
      });
      seen.push(`${next.activity}@${stationOf(p.placement.stationId)}`);
      expect((await act(tablet!, next.id, 'complete', { note: 'ok' })).status).toBe(200);
    }
    expect(seen.some((s) => s.startsWith('CORTE') && s.endsWith('Mesa de corte'))).toBe(true);
    expect(seen.some((s) => s.startsWith('COSTURA') && s.endsWith('Máquina de costura 1'))).toBe(
      true,
    );

    // Produção concluída → qualidade → embalagem → expedição.
    p = await piece();
    expect(p.placement.areaFunction).toBe('QUALIDADE');
    const thiago = await tabletOf(app, admin, 'Thiago', '271828');
    const insp = await db().qualityInspection.findFirstOrThrow({
      where: { serviceOrderItemId: sofaId, status: { in: ['PENDENTE', 'EM_ANDAMENTO'] } },
    });
    const full = (await thiago.get(`/api/v1/quality/inspections/${insp.id}`)).body;
    for (const it of full.items)
      await thiago.req('PUT', `/api/v1/quality/inspections/${insp.id}/items/${it.id}`, {
        result: 'OK',
        note: null,
      });
    const fresh = (await thiago.get(`/api/v1/quality/inspections/${insp.id}`)).body;
    expect(
      (
        await post(thiago, `/api/v1/quality/inspections/${insp.id}/approve`, {
          version: fresh.version,
        })
      ).status,
    ).toBe(200);
    expect((await piece()).placement.areaFunction).toBe('EMBALAGEM');
    const pack = await db().packagingRecord.findFirstOrThrow({
      where: { serviceOrderItemId: sofaId },
    });
    const loc = await db().itemLocation.findUniqueOrThrow({ where: { key: 'EXPEDICAO' } });
    expect(
      (
        await post(admin, `/api/v1/packaging/${pack.id}/complete`, {
          protection: 'PLASTICO_BOLHA',
          locationId: loc.id,
          version: pack.version,
        })
      ).status,
    ).toBe(200);
    p = await piece();
    expect(p.stage).toBe('PRONTA_ENTREGA');
    expect(p.placement.areaFunction).toBe('EXPEDICAO');
    // Posição física confirmada aparece separada, com horário.
    expect(p.confirmedLocation).toMatchObject({ label: 'Expedição' });
    expect(p.confirmedLocation!.areaId).toBe(
      shop.areas.find((a) => a.function === 'EXPEDICAO')!.id,
    );
  });
});

describe('jogo — decisões com os agentes', () => {
  it('Gerente monta o plano citando registros; Compras propõe e a aprovação leva ao fluxo oficial', async () => {
    const admin = await loginAdmin(app);
    const { so } = await serviceOrderWith(admin, 'missing', 'Cliente Fictício Agente');
    const agents = (await admin.get('/api/v1/game/agents')).body as {
      id: string;
      roleKey: string;
    }[];
    const gerente = agents.find((a) => a.roleKey === 'GERENTE')!;
    const compras = agents.find((a) => a.roleKey === 'COMPRAS')!;
    const g = await post(admin, `/api/v1/game/agents/${gerente.id}/messages`, {
      content: 'Monte o plano semanal',
    });
    expect(g.status).toBe(201);
    expect(g.body[1].content).toMatch(/Equipe agora/);
    expect(g.body[1].content).toMatch(/Materiais que faltam/);
    expect(g.body[1].references.some((r: { id: string }) => r.id === so.id)).toBe(true);
    const c = await post(admin, `/api/v1/game/agents/${compras.id}/messages`, {
      content: 'O que preciso comprar?',
    });
    expect(c.body[1].content).toMatch(/Linho/);
    const conv = (await admin.get(`/api/v1/game/agents/${compras.id}/conversation`)).body;
    const prop = conv.proposals.find((x: { kind: string }) => x.kind === 'CRIAR_COMPRA');
    expect(prop.payload.href).toMatch(/^\/painel\/compras\/novo\?req=/);
    const d = await post(admin, `/api/v1/game/proposals/${prop.id}/decide`, {
      decision: 'APROVAR',
    });
    expect(d.body.status).toBe('APROVADA');
    // Nenhuma compra foi criada pelo agente: só o fluxo oficial cria (pelo gestor).
    expect(await db().purchaseOrder.count()).toBe(0);
    // Pausado não analisa.
    const cur = (await admin.get('/api/v1/game/agents')).body.find(
      (a: { id: string }) => a.id === compras.id,
    );
    expect(
      (
        await put(admin, `/api/v1/game/agents/${compras.id}`, {
          status: 'PAUSADO',
          version: cur.version,
        })
      ).status,
    ).toBe(200);
    const paused = await post(admin, `/api/v1/game/agents/${compras.id}/messages`, {
      content: 'E agora?',
    });
    expect(paused.body[1].content).toMatch(/pausado/);
  });

  it('tablet (sessão de dispositivo) não entra no jogo', async () => {
    const admin = await loginAdmin(app);
    const t = await tabletOf(app, admin, 'João', '121212');
    expect((await t.get('/api/v1/game/spaces')).status).toBe(403);
    expect((await t.get('/api/v1/game/snapshot')).status).toBe(403);
  });
});

describe('jogo — Falar com a Cenário', () => {
  const say = async (c: Client, text: string, spaceKey = 'TAPECARIA') => {
    const r = await c.post('/api/v1/game/command', { text, spaceKey });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    return r.body as CommandResultDto;
  };

  it('encontra OS por nome (único e com mais de um resultado), por número e sem posição', async () => {
    const admin = await loginAdmin(app);
    const a = await openServiceOrder(admin, 'Hadassa Lima');
    await openServiceOrder(admin, 'Hadassa Souza');
    const many = await say(admin, 'Cadê o sofá da Hadassa?');
    expect(many.effect.kind).toBe('ESCOLHER');
    if (many.effect.kind !== 'ESCOLHER') return;
    expect(many.effect.options).toHaveLength(2);
    expect(many.effect.options.map((o) => o.label).join(' ')).toMatch(
      /Hadassa Lima.*|Hadassa Souza/,
    );
    expect(many.effect.options.every((o) => o.effect.kind === 'ABRIR_PECA')).toBe(true);
    const one = await say(admin, 'Cadê o sofá da Hadassa Lima?');
    expect(one.effect).toMatchObject({
      kind: 'ABRIR_PECA',
      pieceId: a.items[0].id,
      serviceOrderId: a.id,
    });
    expect(one.interpretedBy).toBe('REGRAS');
    const so = (await admin.get(`/api/v1/service-orders/${a.id}`)).body;
    const byNumber = await say(admin, `Abre a OS ${so.number}`);
    expect(byNumber.effect).toMatchObject({ kind: 'ABRIR_PECA', serviceOrderId: a.id });
    expect(
      (
        await post(admin, `/api/v1/service-orders/${a.id}/cancel`, {
          reason: 'Teste do jogo',
          version: so.version,
        })
      ).status,
    ).toBe(200);
    const gone = await say(admin, `Abre a OS ${so.number}`);
    expect(gone.effect).toMatchObject({ kind: 'ABRIR_OS_SEM_POSICAO', serviceOrderId: a.id });
    expect(gone.reply).toMatch(/sem posição no mapa/);
    expect((await say(admin, 'Abre a OS 99999')).effect.kind).toBe('NADA');
  });

  it('localiza material com endereço (todas as posições) e sem endereço; tecido fica com a OS', async () => {
    const admin = await loginAdmin(app);
    const grampo = (
      await post(admin, '/api/v1/stock-items', {
        kind: 'OUTRO',
        description: 'Grampos 80/10',
        unit: 'EMBALAGEM',
      })
    ).body;
    await post(admin, '/api/v1/stock-items', {
      kind: 'OUTRO',
      description: 'Percinta elástica',
      unit: 'METRO',
    });
    await post(admin, `/api/v1/stock-items/${grampo.id}/adjust`, {
      quantity: 7,
      reason: 'Saldo inicial',
    });
    const shop = await space(admin, 'TAPECARIA');
    shop.storageUnits.find((u) => u.label === 'Estante A')!.slots[0]!.stockItemIds = [grampo.id];
    shop.storageUnits.find((u) => u.label === 'Estante B')!.slots[2]!.stockItemIds = [grampo.id];
    expect((await put(admin, '/api/v1/game/spaces/TAPECARIA', shop)).status).toBe(200);
    const r = await say(admin, 'Onde fica o grampo?');
    expect(r.effect.kind).toBe('MATERIAL');
    if (r.effect.kind !== 'MATERIAL') return;
    expect(r.effect.items[0]!.locations.map((l) => l.address)).toEqual(
      expect.arrayContaining([
        'Tapeçaria → Estoque → Estante A → Prateleira 1',
        'Tapeçaria → Estoque → Estante B → Prateleira 3',
      ]),
    );
    expect(r.effect.items[0]).toMatchObject({ onHand: 7, available: 7 });
    expect(r.reply).toMatch(/Saldo 7/);
    const noAddr = await say(admin, 'Onde fica a percinta?');
    expect(noAddr.effect.kind === 'MATERIAL' && noAddr.effect.items[0]!.locations.length).toBe(0);
    expect(noAddr.reply).toMatch(/ainda não tem endereço/);
    await serviceOrderWith(admin, 'missing', 'Cliente Linho');
    const fabric = await say(admin, 'Onde fica o linho bege?');
    expect(fabric.effect.kind === 'MATERIAL' && fabric.effect.exclusive.length).toBe(1);
  });

  it('move a mesa de corte para perto da costura (prévia válida) e para um lugar ocupado', async () => {
    const admin = await loginAdmin(app);
    const shop = await space(admin, 'TAPECARIA');
    const mesa = shop.stations.find((s) => s.kind === 'MESA_CORTE')!;
    const r = await say(admin, 'Joga a mesa de corte pra perto da costura');
    expect(r.effect.kind).toBe('MOVER_PREVIA');
    if (r.effect.kind !== 'MOVER_PREVIA') return;
    expect(r.effect.objectId).toBe(mesa.id);
    expect(r.effect.from).toMatchObject({ xCm: mesa.xCm, yCm: mesa.yCm });
    const { clearanceAround, footprint, contentOfSpace } = await import('./jogo-helpers');
    const after = contentOfSpace(shop);
    const m = after.stations.find((s) => s.id === mesa.id)!;
    Object.assign(m, {
      xCm: r.effect.to.xCm,
      yCm: r.effect.to.yCm,
      rotation: r.effect.to.rotation,
    });
    expect(
      clearanceAround(after, m.id, footprint(m), 80, m.rotation).filter(
        (p) => p.severity === 'erro',
      ),
    ).toEqual([]);
    // Nada mudou no servidor: é só prévia.
    expect((await space(admin, 'TAPECARIA')).version).toBe(shop.version);
    const busy = await say(admin, 'Joga a mesa de corte em cima da bancada do Márcio');
    expect(busy.effect).toMatchObject({
      kind: 'MOVER_PREVIA',
      occupied: true,
      targetLabel: 'Bancada do Márcio',
    });
    expect(busy.reply).toMatch(/já ocupa esse lugar/);
  });

  it('atribuição só vira prévia; planta chama o Mestre; sem permissão de construir não move', async () => {
    const admin = await loginAdmin(app);
    const { so } = await serviceOrderWith(admin, 'none', 'Cliente Atribuição');
    const num = (await admin.get(`/api/v1/service-orders/${so.id}`)).body.number;
    const r = await say(admin, `Passa o desmanche da OS ${num} pro João amanhã`);
    expect(r.effect).toMatchObject({
      kind: 'ATRIBUIR_PREVIA',
      mode: 'PLANEJAR',
      funcionario: 'João',
      serviceOrderId: so.id,
    });
    expect(await db().productionTask.count({ where: { serviceOrderId: so.id } })).toBe(0);
    expect(
      (await say(admin, 'aumenta o escritório dois metros', 'ESCRITORIO')).effect,
    ).toMatchObject({ kind: 'PLANTA', spaceKey: 'ESCRITORIO' });
    const t = await tabletOf(app, admin, 'João', '121212');
    expect((await t.post('/api/v1/game/command', { text: 'Cadê o sofá da Ana?' })).status).toBe(
      403,
    );
  });
});
