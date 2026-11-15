import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { type GamePieceDto, type GameSnapshotDto, pieceWorkflow } from '@cenario/shared';
import type { App } from '../src/app';
import { setClock } from '../src/core/clock';
import { type Client, createTestApp, db, idemKey, loginAdmin, resetDatabase } from './helpers';
import { act, serviceOrderWith, tabletOf, today, userIdOf } from './production-helpers';
import { approvedNeeds, staples } from './purchasing-helpers';

/**
 * Correções operacionais do jogo, validadas contra as regras oficiais:
 * estados separados da peça, dependência de etapas e início pelo funcionário, quantidades que
 * explicam a próxima ação de material, disputa pela última unidade, reenvio após queda de
 * conexão, propostas antigas do Gerente e leitura do caixa.
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
const post = (c: Client, url: string, body: unknown, key = idemKey()) =>
  c.post(url, body, { 'idempotency-key': key });
const snap = async (c: Client) => (await c.get('/api/v1/game/snapshot')).body as GameSnapshotDto;

async function stockOf(admin: Client, onHand: number) {
  const item = await admin.post('/api/v1/stock-items', {
    kind: 'OUTRO',
    description: 'Grampos 80/10',
    unit: 'EMBALAGEM',
  });
  expect(item.status, JSON.stringify(item.body)).toBe(201);
  if (onHand > 0)
    expect(
      (
        await post(admin, `/api/v1/stock-items/${item.body.id}/adjust`, {
          quantity: onHand,
          reason: 'Inventário inicial',
        })
      ).status,
    ).toBe(200);
  return item.body as { id: string };
}

describe('estados da peça e dependência de etapas', () => {
  it('aguardando planejamento → publicada na fila → em execução só pelo tablet; montagem bloqueada com motivo', async () => {
    const admin = await loginAdmin(app);
    const { so } = await serviceOrderWith(admin, 'complete', 'Cliente Etapas');
    const sofaId = so.items[0].id;
    const piece = async () =>
      (await snap(admin)).pieces.find((p) => p.id === sofaId) as GamePieceDto;
    expect(pieceWorkflow(await piece()).phase).toBe('AGUARDANDO_PLANEJAMENTO');

    const ids = { joao: await userIdOf('João'), marcio: await userIdOf('Márcio') };
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
    expect(planned.status).toBe(201);
    const planId = planned.body.planned[0].planId;
    let w = pieceWorkflow(await piece());
    expect(w.phase).toBe('AGUARDANDO_PUBLICACAO');
    expect(w.next?.reason).toMatch(/não publicada/);

    const plan = (await admin.get(`/api/v1/production-plans/${planId}`)).body;
    expect(
      (await post(admin, `/api/v1/production-plans/${planId}/publish`, { version: plan.version }))
        .status,
    ).toBe(200);
    let p = await piece();
    w = pieceWorkflow(p);
    expect(w.phase).toBe('NA_FILA');
    const desm = p.tasks.find((t) => t.activity === 'DESMONTAGEM')!;
    const corte = p.tasks.find((t) => t.activity === 'CORTE_TECIDO')!;
    const mont = p.tasks.find((t) => t.activity === 'MONTAGEM')!;
    expect(desm.status).toBe('LIBERADA');
    expect(corte.status).toBe('LIBERADA'); // modelo oficial: corte e costura não depende do desmanche
    expect(mont.status).toBe('BLOQUEADA');
    expect(w.steps.find((s) => s.taskId === mont.id)!.reason).toMatch(
      /^aguarda preparação \(João\) e costura \(Márcio\)$/,
    );

    const marcio = await tabletOf(app, admin, 'Márcio', '736152');
    const joao = await tabletOf(app, admin, 'João', '121212');
    // Ninguém inicia a etapa de outra pessoa; o gestor não inicia pelo jogo.
    expect((await act(joao, corte.id, 'start')).status).toBe(403);
    expect((await act(admin, corte.id, 'start')).status).toBe(403);
    // Montagem: a API recusa e explica a dependência (o tablet mostra o mesmo motivo).
    const blocked = await act(marcio, mont.id, 'start');
    expect(blocked.status).toBe(422);
    expect(blocked.body.error.message).toMatch(/Aguardando etapas anteriores/);
    // Corte com o desmanche pendente: permitido pela regra oficial (etapas paralelas).
    const key = idemKey();
    expect((await act(marcio, corte.id, 'start', {}, key)).status).toBe(200);
    // Queda de conexão: o tablet reenvia o MESMO pedido ao reconectar → uma única atualização.
    expect((await act(marcio, corte.id, 'start', {}, key)).status).toBe(200);
    expect((await act(marcio, corte.id, 'start')).status).toBe(200); // repetição sem chave: nada muda
    const events = await db().productionTaskEvent.findMany({
      where: { taskId: corte.id, kind: 'INICIADA' },
    });
    expect(events).toHaveLength(1);
    p = await piece();
    w = pieceWorkflow(p);
    expect(w.phase).toBe('EM_EXECUCAO');
    expect(w.current).toMatchObject({ assignee: 'Márcio' });
    const emp = (await snap(admin)).employees.find((e) => e.name === 'Márcio')!;
    expect(emp.currentTask!.id).toBe(corte.id);
  });
});

describe('material: quantidades, compra do faltante e disputa pela última unidade', () => {
  it('2 necessárias, 1 livre: reservar 1 e comprar só 1; depois da compra nada falta', async () => {
    const admin = await loginAdmin(app);
    const { so, reqs } = await approvedNeeds(admin, 'Ana Estoque', () => [
      staples({ quantity: 2 }),
    ]);
    const stock = await stockOf(admin, 1);
    const group = (
      (await admin.get('/api/v1/purchasing/shortages')).body as {
        description: string;
        freeStock: number;
        suggestion: number;
        rows: { requirementId: string }[];
      }[]
    ).find((g) => g.rows.some((r) => r.requirementId === reqs[0]!.id))!;
    expect(group).toMatchObject({ freeStock: 1, suggestion: 1 });
    const r = await post(admin, '/api/v1/stock-reservations', {
      stockItemId: stock.id,
      serviceOrderId: so.id,
      materialRequirementId: reqs[0]!.id,
      quantity: 1,
    });
    expect(r.status).toBe(201);
    const line = (
      (await admin.get(`/api/v1/service-orders/${so.id}/material-readiness`)).body as {
        lines: { requirementId: string; reserved: number; shortfall: number }[];
      }
    ).lines.find((l) => l.requirementId === reqs[0]!.id)!;
    expect(line).toMatchObject({ reserved: 1, shortfall: 1 });
    const after = (
      (await admin.get('/api/v1/purchasing/shortages')).body as {
        suggestion: number;
        freeStock: number;
        rows: { requirementId: string }[];
      }[]
    ).find((g) => g.rows.some((x) => x.requirementId === reqs[0]!.id))!;
    expect(after).toMatchObject({ freeStock: 0, suggestion: 1 });
  });

  it('duas OS disputam a última unidade: só uma reserva, a outra recebe a explicação', async () => {
    const admin = await loginAdmin(app);
    const a = await approvedNeeds(admin, 'Ana Disputa', () => [staples({ quantity: 1 })]);
    const b = await approvedNeeds(admin, 'Bruno Disputa', () => [staples({ quantity: 1 })]);
    const stock = await stockOf(admin, 1);
    const [r1, r2] = await Promise.all([
      post(admin, '/api/v1/stock-reservations', {
        stockItemId: stock.id,
        serviceOrderId: a.so.id,
        materialRequirementId: a.reqs[0]!.id,
        quantity: 1,
      }),
      post(admin, '/api/v1/stock-reservations', {
        stockItemId: stock.id,
        serviceOrderId: b.so.id,
        materialRequirementId: b.reqs[0]!.id,
        quantity: 1,
      }),
    ]);
    const codes = [r1.status, r2.status].sort();
    expect(codes).toEqual([201, 409]);
    const loser = r1.status === 409 ? r1 : r2;
    expect(loser.body.error.message).toMatch(/Saldo disponível insuficiente: 0 disponível/);
    const it = await db().stockItem.findUniqueOrThrow({ where: { id: stock.id } });
    expect(Number(it.onHand)).toBe(1);
    expect(Number(it.reserved)).toBe(1);
    expect(
      await db().stockReservation.count({ where: { stockItemId: stock.id, status: 'ATIVA' } }),
    ).toBe(1);
  });
});

describe('Gerente: propostas antigas e caixa', () => {
  it('proposta "Planejar" vira desatualizada quando a OS é planejada; aprovar uma antiga é recusado', async () => {
    const admin = await loginAdmin(app);
    const { so } = await serviceOrderWith(admin, 'complete', 'Cliente Proposta');
    const agents = (await admin.get('/api/v1/game/agents')).body as {
      id: string;
      roleKey: string;
    }[];
    const g = agents.find((x) => x.roleKey === 'GERENTE')!;
    expect(
      (
        await post(admin, `/api/v1/game/agents/${g.id}/messages`, {
          content: 'Monte o plano semanal',
        })
      ).status,
    ).toBe(201);
    const prop = await db().aiAgentProposal.findFirstOrThrow({
      where: {
        agentId: g.id,
        kind: 'PLANEJAR_OS',
        payload: { path: ['serviceOrderId'], equals: so.id },
      },
    });

    const marcio = await userIdOf('Márcio');
    expect(
      (
        await post(admin, '/api/v1/production/plan-services', {
          entries: [
            {
              serviceOrderId: so.id,
              startDate: today(),
              pieces: so.items.map((i: { id: string }) => ({
                serviceOrderItemId: i.id,
                upholstererUserId: marcio,
              })),
            },
          ],
        })
      ).status,
    ).toBe(201);

    // Aprovação no momento em que os dados já mudaram: recusada e marcada como desatualizada.
    const dec = await post(admin, `/api/v1/game/proposals/${prop.id}/decide`, {
      decision: 'APROVAR',
    });
    expect(dec.status).toBe(409);
    expect(dec.body.error.message).toMatch(/Proposta desatualizada: OS-\d+ já está planejada/);
    const after = await db().aiAgentProposal.findUniqueOrThrow({ where: { id: prop.id } });
    expect(after.status).toBe('OBSOLETA');
    // A conversa não oferece mais "Planejar" para essa OS.
    const conv = (await admin.get(`/api/v1/game/agents/${g.id}/conversation`)).body as {
      proposals: { title: string; status: string }[];
    };
    const code = `OS-${String((await db().serviceOrder.findUniqueOrThrow({ where: { id: so.id } })).number).padStart(5, '0')}`;
    expect(
      conv.proposals.filter((p) => p.status === 'PENDENTE' && p.title === `Planejar ${code}`),
    ).toEqual([]);
    expect(conv.proposals.find((p) => p.title === `Planejar ${code}`)?.status).toBe('OBSOLETA');
  });

  it('caixa: sem saldo inicial, separa vencido, com data e condicionado à entrega', async () => {
    const admin = await loginAdmin(app);
    await post(admin, '/api/v1/finance/payables', {
      beneficiary: 'Espumas Vale',
      category: 'MATERIAL',
      description: 'Espuma D28',
      amountCents: 688000,
      dueDate: today(),
    });
    const agents = (await admin.get('/api/v1/game/agents')).body as {
      id: string;
      roleKey: string;
    }[];
    const g = agents.find((x) => x.roleKey === 'GERENTE')!;
    const m = await post(admin, `/api/v1/game/agents/${g.id}/messages`, {
      content: 'Quanto preciso receber para cobrir as contas da semana?',
    });
    const reply = (
      m.body as { author: string; content: string; references: { type: string; label: string }[] }[]
    ).find((x) => x.author === 'AGENTE')!;
    expect(reply.content).toMatch(/Saldo bancário inicial: não cadastrado/);
    expect(reply.content).toMatch(/A pagar: R\$\s?6\.880,00/);
    expect(reply.content).toMatch(/condicionado à entrega/);
    expect(reply.content).toMatch(/faltam R\$\s?6\.880,00/);
    expect(reply.references.some((r) => r.type === 'CONTA' && /Espuma D28/.test(r.label))).toBe(
      true,
    );
  });
});

describe('planta: mesa do agente transferida para mesa nova no mesmo salvamento', () => {
  it('remove a mesa do Gerente e cria outra: o agente vai para a nova sem erro', async () => {
    const admin = await loginAdmin(app);
    const office = (await admin.get('/api/v1/game/spaces/ESCRITORIO')).body;
    const agents = (await admin.get('/api/v1/game/agents')).body as {
      id: string;
      name: string;
      deskStationId: string | null;
    }[];
    const gerente = agents.find((a) => a.name === 'Gerente')!;
    const oldDesk = office.stations.find((s: { id: string }) => s.id === gerente.deskStationId);
    const newDesk = { ...oldDesk, id: crypto.randomUUID(), name: 'Mesa nova do Gerente' };
    const body = {
      ...office,
      stations: [...office.stations.filter((s: { id: string }) => s.id !== oldDesk.id), newDesk],
      transfers: { areas: {}, stations: { [oldDesk.id]: newDesk.id }, slots: {} },
    };
    const r = await admin.put('/api/v1/game/spaces/ESCRITORIO', body, {
      'idempotency-key': idemKey(),
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const after = (await admin.get('/api/v1/game/agents')).body as typeof agents;
    expect(after.find((a) => a.id === gerente.id)!.deskStationId).toBe(newDesk.id);
  });
});
