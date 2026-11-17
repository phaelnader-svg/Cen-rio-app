import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AgentConversationDto, AgentDto } from '@cenario/shared';
import type { App } from '../src/app';
import { setClock } from '../src/core/clock';
import { type Client, createTestApp, db, idemKey, loginAdmin, resetDatabase } from './helpers';
import { openServiceOrder } from './measurement-helpers';

/**
 * Agentes do escritório sem conta na Meta: Compras (lista de materiais da OS → pedido ao
 * fornecedor pelo WhatsApp, com aprovação), Financeiro, Orçamentos, WhatsApp e o agente criado pelo
 * dono. Dados fictícios.
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

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type J = any;
const send = (c: Client, method: 'POST' | 'PUT' | 'PATCH', url: string, body: unknown) =>
  c.req(method, url, body, { 'idempotency-key': idemKey() });
const ok = <T = J>(r: { status: number; body: J }, status = 200): T => {
  expect(r.status, JSON.stringify(r.body)).toBe(status);
  return r.body as T;
};

async function createAgent(admin: Client, roleKey: string, extra: Record<string, unknown> = {}) {
  const t = (ok(await admin.get('/api/v1/game/agent-templates')) as J[]).find(
    (x) => x.roleKey === roleKey,
  );
  return ok<AgentDto>(
    await send(admin, 'POST', '/api/v1/game/agents', {
      name: t?.name ?? roleKey,
      roleKey,
      roleLabel: t?.roleLabel ?? roleKey,
      instructions: t?.instructions ?? 'Teste',
      dataScopes: t?.dataScopes ?? ['os'],
      actionPolicies: t?.actionPolicies ?? {},
      ...extra,
    }),
    201,
  );
}
const ask = async (admin: Client, agentId: string, content: string) => {
  ok(await send(admin, 'POST', `/api/v1/game/agents/${agentId}/messages`, { content }), 201);
  return ok<AgentConversationDto>(await admin.get(`/api/v1/game/agents/${agentId}/conversation`));
};

describe('agente de Compras', () => {
  it('junta os materiais não comprados por fornecedor e, ao aprovar, marca como comprado e devolve o WhatsApp com o texto', async () => {
    const admin = await loginAdmin(app);
    await db().companySettings.update({ where: { id: 1 }, data: { tradeName: 'Tapeçaria Teste' } });
    const so = await openServiceOrder(admin, 'Cliente Compras');
    const L = `/api/v1/service-orders/${so.id}/material-list`;
    ok(
      await send(admin, 'POST', L, { description: 'Tecido veludo cinza', quantity: 8, unit: 'm' }),
      201,
    );
    ok(
      await send(admin, 'POST', L, { description: 'Espuma D33', quantity: 2, unit: 'placas' }),
      201,
    );
    const list = ok(
      await send(admin, 'POST', L, { description: 'Grampo 106/8', quantity: 1, unit: 'cx' }),
      201,
    );
    // Já comprado não entra no pedido.
    const grampo = list.materials.find((m: J) => m.description.startsWith('Grampo'));
    ok(
      await send(admin, 'PATCH', `${L}/${grampo.id}`, { purchased: true, version: grampo.version }),
    );

    const compras = await createAgent(admin, 'COMPRAS');
    expect(compras.engine).toBe('DADOS_CENARIO');
    // Sem fornecedor: o agente lista e pede para cadastrar.
    let conv = await ask(admin, compras.id, 'O que preciso comprar?');
    const last = conv.messages.at(-1)!.content;
    expect(last).toMatch(/Tecido veludo cinza/);
    expect(last).not.toMatch(/Grampo/);
    expect(last).toMatch(/Nenhum fornecedor cadastrado/);
    expect(conv.proposals.filter((p) => p.status === 'PENDENTE')).toHaveLength(0);

    const tecidos = ok(
      await send(admin, 'POST', '/api/v1/game/suppliers', {
        name: 'Tecidos Vale',
        contactName: 'Marta Souza',
        phone: '(12) 99999-0001',
        categories: ['TECIDO'],
      }),
      201,
    );
    ok(
      await send(admin, 'POST', '/api/v1/game/suppliers', {
        name: 'Espumas Sul',
        phone: '12988880002',
        categories: ['ESPUMA'],
      }),
      201,
    );
    conv = await ask(admin, compras.id, 'O que preciso comprar?');
    const pending = conv.proposals.filter((p) => p.status === 'PENDENTE');
    expect(pending.map((p) => p.kind)).toEqual(['PEDIR_FORNECEDOR', 'PEDIR_FORNECEDOR']);
    const toFabric = pending.find((p) => p.payload.supplierId === tecidos.id)!;
    expect(toFabric.detail).toMatch(/Olá, Marta! Aqui é da Tapeçaria Teste/);
    expect(toFabric.detail).toMatch(/Tecido veludo cinza — 8 m/);
    expect(toFabric.detail).not.toMatch(/Espuma/);
    expect(String(toFabric.payload.href)).toMatch(/^https:\/\/wa\.me\/5512999990001\?text=/);

    // Aprovar com o texto ajustado pelo dono: sem WhatsApp conectado, volta o link para enviar.
    const decided = ok(
      await send(admin, 'POST', `/api/v1/game/proposals/${toFabric.id}/decide`, {
        decision: 'APROVAR',
        edits: { text: 'Marta, manda 8 m do veludo cinza da OS, por favor.' },
      }),
    );
    expect(decided.status).toBe('APROVADA');
    expect(decided.payload.sent).toBe(false);
    expect(decided.payload.markedPurchased).toBe(1);
    expect(decodeURIComponent(String(decided.payload.href))).toMatch(/manda 8 m do veludo/);
    const after = ok(await admin.get(L));
    const fabric = after.materials.find((m: J) => m.description.startsWith('Tecido'));
    expect(fabric.purchased).toBe(true);
    expect(after.materials.find((m: J) => m.description.startsWith('Espuma')).purchased).toBe(
      false,
    );
    const action = await db().agentAction.findFirst({ where: { kind: 'PEDIR_FORNECEDOR' } });
    expect(action?.status).toBe('APROVADO');

    // Marcado como na oficina pelo painel → o pedido da espuma caduca.
    const foam = after.materials.find((m: J) => m.description.startsWith('Espuma'));
    ok(await send(admin, 'PATCH', `${L}/${foam.id}`, { available: true, version: foam.version }));
    conv = ok(await admin.get(`/api/v1/game/agents/${compras.id}/conversation`));
    expect(conv.proposals.find((p) => p.payload.supplierName === 'Espumas Sul')?.status).toBe(
      'OBSOLETA',
    );
  });
});

describe('Financeiro, Orçamentos, WhatsApp e agente próprio', () => {
  it('o Financeiro resume o caixa e propõe cobrar o vencido pelo WhatsApp', async () => {
    const admin = await loginAdmin(app);
    const fin = (ok(await admin.get('/api/v1/game/agents')) as AgentDto[]).find(
      (a) => a.roleKey === 'FINANCEIRO',
    )!;
    expect(fin.engine).toBe('DADOS_CENARIO');
    const so = await openServiceOrder(admin, 'Cliente Devedor');
    const order = await db().serviceOrder.findUniqueOrThrow({ where: { id: so.id } });
    await db().customer.update({
      where: { id: order.customerId },
      data: { whatsapp: '12977776666' },
    });
    await db().customerReceivable.create({
      data: {
        customerId: order.customerId,
        orderId: order.orderId,
        description: 'Entrada',
        amountCents: 50000,
        expectedMethod: 'PIX',
        dueTrigger: 'DATA',
        dueDate: new Date(Date.now() - 5 * 86_400_000),
      },
    });
    const conv = await ask(admin, fin.id, 'Como está o financeiro?');
    expect(conv.messages.at(-1)!.content).toMatch(/A receber vencido: R\$\s?500,00 \(1\)/);
    const p = conv.proposals.find((x) => x.kind === 'COBRAR_CLIENTE')!;
    expect(p.payload.phone).toBe('5512977776666');
    expect(p.detail).toMatch(/Olá, Cliente!/);
  });

  it('Orçamentos lembra o retorno; WhatsApp avisa sem a Meta; agente próprio sem IA explica o que falta', async () => {
    const admin = await loginAdmin(app);
    const orc = await createAgent(admin, 'ORCAMENTOS');
    await db().quote.create({
      data: {
        customerName: 'Joana Lima',
        phone: '12955554444',
        service: 'Reforma de sofá',
        totalCents: 180000,
        snapshot: {},
        createdAt: new Date(Date.now() - 3 * 86_400_000),
      },
    });
    let conv = await ask(admin, orc.id, 'Quais orçamentos esperam resposta?');
    expect(conv.messages.at(-1)!.content).toMatch(/Joana Lima/);
    expect(conv.proposals.find((p) => p.kind === 'ENVIAR_MENSAGEM')?.payload.phone).toBe(
      '5512955554444',
    );

    const wa = await createAgent(admin, 'WHATSAPP');
    expect(wa.engine).toBe('DADOS_CENARIO');
    conv = await ask(admin, wa.id, 'Quem está esperando?');
    expect(conv.messages.at(-1)!.content).toMatch(/ainda não está conectado/);

    delete process.env.ANTHROPIC_API_KEY;
    const mine = await createAgent(admin, 'PERSONALIZADA', {
      name: 'Pós-venda',
      roleLabel: 'Pós-venda',
      instructions: 'Acompanhe os clientes depois da entrega.',
      dataScopes: ['financeiro'],
    });
    expect(mine.engine).toBe('INSTRUCOES');
    conv = await ask(admin, mine.id, 'Quem devo procurar?');
    expect(conv.messages.at(-1)!.content).toMatch(/IA ligada no servidor/);
  });
});

describe('consulta longa dos eventos (Firma Viva sem perguntar a cada 3 s)', () => {
  it('sem novidade a consulta espera e volta assim que algo muda na empresa', async () => {
    await app.startBackground();
    const admin = await loginAdmin(app);
    const head = ok(await admin.get('/api/sync/status')).headSeq as string;
    // Nada acontece: volta vazia depois do tempo pedido.
    const t0 = Date.now();
    const idle = ok(await admin.get(`/api/sync/events?since=${head}&wait=1`));
    expect(idle.events).toHaveLength(0);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(900);
    // Algo muda enquanto a consulta espera: volta com o evento, antes do tempo.
    const t1 = Date.now();
    const waiting = admin.get(`/api/sync/events?since=${idle.nextSince}&wait=20`);
    await new Promise((r) => setTimeout(r, 300));
    ok(await send(admin, 'POST', '/api/v1/game/suppliers', { name: 'Fornecedor Eventos' }), 201);
    const got = ok(await waiting);
    expect(got.events.length).toBeGreaterThan(0);
    expect(Date.now() - t1).toBeLessThan(15_000);
  });
});
