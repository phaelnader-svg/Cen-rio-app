import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { setClock } from '../src/core/clock';
import { signBody, webhookSecret } from '../src/modules/integrations/meta';
import { type Client, createTestApp, db, idemKey, loginAdmin, resetDatabase } from './helpers';
import { openServiceOrder } from './measurement-helpers';

/**
 * Central de Conexões + caixa de entrada (modo de teste local, sem credenciais reais):
 * mensagem do WhatsApp chega pelo webhook assinado, o agente de Atendimento prepara o rascunho,
 * o gestor revisa/envia e vincula a conversa a uma OS. Reenvio do mesmo webhook não duplica.
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

async function atendimento(admin: Client, policy: 'RASCUNHO' | 'EXECUTAR', rules: string[] = []) {
  const r = await post(admin, '/api/v1/game/agents', {
    name: 'Atendimento',
    roleKey: 'ATENDIMENTO',
    roleLabel: 'Atendimento',
    instructions: 'Responda no tom da Cenário.',
    dataScopes: ['os'],
    channelPolicies: { WHATSAPP: policy, INSTAGRAM: 'RASCUNHO', MESSENGER: 'RASCUNHO' },
    autoSendRules: rules,
  });
  expect(r.status).toBe(201);
  return r.body as { id: string; channelPolicies: Record<string, string> };
}

describe('Central de Conexões', () => {
  it('lista os cartões com sessão do Cenário conectada, o que falta e o modo de teste', async () => {
    const admin = await loginAdmin(app);
    const r = await admin.get('/api/v1/connections');
    expect(r.status).toBe(200);
    const cards = (r.body as { cards?: unknown[] }).cards ?? (r.body as unknown[]);
    const byKey = Object.fromEntries((cards as { key: string }[]).map((c) => [c.key, c])) as Record<
      string,
      { status: string; missing: string[]; testModeAvailable: boolean }
    >;
    expect(byKey.CENARIO!.status).toBe('CONECTADA');
    expect(byKey.WHATSAPP!.status).toBe('DESCONECTADA');
    expect(byKey.WHATSAPP!.missing.map((m) => (m as unknown as { name: string }).name)).toContain(
      'META_APP_ID',
    );
    expect(byKey.WHATSAPP!.testModeAvailable).toBe(true);
    for (const k of [
      'ASSINATURA',
      'FISCAL',
      'COBRANCAS',
      'BANCO_PJ',
      'MAQUININHA',
      'CONTABILIDADE',
      'AGENDA_ENTREGAS',
      'GOOGLE_ADS',
    ])
      expect(byKey[k]).toBeTruthy();

    expect((await post(admin, '/api/v1/connections/WHATSAPP/test-mode', {})).status).toBe(200);
    expect((await post(admin, '/api/v1/connections/WHATSAPP/test', {})).status).toBe(200);
    const after = await admin.get('/api/v1/connections');
    const wa = ((after.body as { cards?: unknown[] }).cards ?? (after.body as unknown[])).find(
      (c) => (c as { key: string }).key === 'WHATSAPP',
    ) as { status: string; mode: string; accountLabel: string; lastSyncAt: string };
    expect(wa).toMatchObject({ status: 'CONECTADA', mode: 'TESTE_LOCAL' });
    expect(wa.accountLabel).toMatch(/teste/i);
    expect(wa.lastSyncAt).toBeTruthy();
    // O segredo nunca sai do servidor.
    expect(JSON.stringify(after.body)).not.toMatch(/secretEnc|userToken|pageToken|access_token/);

    expect((await post(admin, '/api/v1/connections/WHATSAPP/disconnect', {})).status).toBe(200);
  });
});

describe('WhatsApp em modo de teste: mensagem → rascunho do agente → envio → vínculo com a OS', () => {
  it('fluxo completo, idempotência do webhook e regra da janela de 24 h', async () => {
    const admin = await loginAdmin(app);
    await post(admin, '/api/v1/connections/WHATSAPP/test-mode', {});
    const agent = await atendimento(admin, 'RASCUNHO');
    expect(agent.channelPolicies.WHATSAPP).toBe('RASCUNHO');

    const sim = await post(admin, '/api/v1/connections/WHATSAPP/simulate', {
      from: '5512991110000',
      name: 'Hadassa Lima',
      text: 'Oi! Quanto fica a reforma do meu sofá de 3 lugares? Ele tem 2,10 m de largura.',
      id: 'wamid.teste.1',
    });
    expect(sim.status).toBe(200);
    expect(sim.body).toMatchObject({ received: 1, duplicates: 0 });

    // Mesmo evento de novo (a Meta reenvia): não duplica.
    const again = await post(admin, '/api/v1/connections/WHATSAPP/simulate', {
      from: '5512991110000',
      name: 'Hadassa Lima',
      text: 'x',
      id: 'wamid.teste.1',
    });
    expect(again.body).toMatchObject({ received: 1, duplicates: 1 });

    const list = (await admin.get('/api/v1/inbox')).body as {
      id: string;
      channel: string;
      status: string;
      summary: string;
      unread: number;
    }[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      channel: 'WHATSAPP',
      status: 'AGUARDANDO_ORCAMENTO',
      unread: 1,
    });
    expect(list[0]!.summary).toMatch(/reforma de sofá/);
    expect(list[0]!.summary).toMatch(/fotos/);

    const conv = (await admin.get(`/api/v1/inbox/${list[0]!.id}`)).body as {
      messages: {
        id: string;
        direction: string;
        status: string;
        text: string;
        agent: string | null;
      }[];
      rule: { free: boolean };
    };
    expect(conv.messages.filter((m) => m.direction === 'IN')).toHaveLength(1);
    const draft = conv.messages.find((m) => m.status === 'RASCUNHO')!;
    expect(draft.agent).toBe('Atendimento');
    expect(draft.text).toMatch(/Hadassa/);
    expect(draft.text).toMatch(/fotos/);
    expect(conv.rule.free).toBe(true);

    // Gestor revisa (edita) e envia o rascunho.
    const sent = await post(admin, `/api/v1/inbox/${list[0]!.id}/send`, {
      draftId: draft.id,
      text: `${draft.text} Atendemos em São José dos Campos.`,
    });
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ status: 'ENVIADA_TESTE', test: true });

    // Vincula a uma OS de teste.
    const so = await openServiceOrder(admin, 'Hadassa Lima');
    expect(
      (await post(admin, `/api/v1/inbox/${list[0]!.id}/link`, { serviceOrderId: so.id })).status,
    ).toBe(200);
    const linked = (await admin.get(`/api/v1/inbox/${list[0]!.id}`)).body as {
      serviceOrder: { number: number };
      customer: { id: string };
      messages: { status: string }[];
    };
    expect(linked.serviceOrder.number).toBe(so.number);
    expect(linked.customer.id).toBeTruthy();
    expect(linked.messages.map((m) => m.status)).toEqual(['RECEBIDA', 'ENVIADA_TESTE']);

    // Histórico do agente: rascunho + resposta aprovada (com quem aprovou).
    const actions = (await admin.get(`/api/v1/game/agents/${agent.id}/actions`)).body as {
      kind: string;
      channel: string;
      approvedBy: string | null;
      accountLabel: string;
    }[];
    expect(actions.map((a) => a.kind).sort()).toEqual(['RASCUNHO_RESPOSTA', 'RESPOSTA_APROVADA']);
    expect(actions.find((a) => a.kind === 'RESPOSTA_APROVADA')!.approvedBy).toBeTruthy();
    expect(actions[0]!.accountLabel).toMatch(/teste/i);

    // Fora da janela de 24 h: texto livre recusado, modelo aprovado aceito.
    await db().inboxConversation.update({
      where: { id: list[0]!.id },
      data: { lastInboundAt: new Date(Date.now() - 25 * 3600_000) },
    });
    const late = await post(admin, `/api/v1/inbox/${list[0]!.id}/send`, { text: 'Oi?' });
    expect(late.status).toBe(422);
    const tpl = await post(admin, `/api/v1/inbox/${list[0]!.id}/send`, {
      template: { name: 'retomar_orcamento', language: 'pt_BR' },
    });
    expect(tpl.status).toBe(200);
  });

  it('envio automático só nos casos liberados e nunca com a conversa assumida', async () => {
    const admin = await loginAdmin(app);
    await post(admin, '/api/v1/connections/WHATSAPP/test-mode', {});
    await atendimento(admin, 'EXECUTAR', ['PEDIR_FOTOS_MEDIDAS']);
    await post(admin, '/api/v1/connections/WHATSAPP/simulate', {
      from: '5512990000001',
      name: 'Ana',
      text: 'Quero reformar uma poltrona',
    });
    const [c] = (await admin.get('/api/v1/inbox')).body as { id: string }[];
    let d = (await admin.get(`/api/v1/inbox/${c!.id}`)).body as { messages: { status: string }[] };
    expect(d.messages.map((m) => m.status)).toEqual(['RECEBIDA', 'ENVIADA_TESTE']);

    expect((await post(admin, `/api/v1/inbox/${c!.id}/takeover`, { on: true })).status).toBe(200);
    await post(admin, '/api/v1/connections/WHATSAPP/simulate', {
      from: '5512990000001',
      name: 'Ana',
      text: 'Mais uma coisa',
    });
    d = (await admin.get(`/api/v1/inbox/${c!.id}`)).body as { messages: { status: string }[] };
    expect(d.messages.map((m) => m.status)).toEqual(['RECEBIDA', 'ENVIADA_TESTE', 'RECEBIDA']);
  });

  it('webhook da Meta recusa assinatura inválida e aceita a oficial', async () => {
    const admin = await loginAdmin(app);
    await post(admin, '/api/v1/connections/WHATSAPP/test-mode', {});
    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [] });
    const bad = await app.app.inject({
      method: 'POST',
      url: '/api/webhooks/meta',
      payload: body,
      headers: { 'content-type': 'application/json', 'x-hub-signature-256': 'sha256=00' },
    });
    expect(bad.statusCode).toBe(401);
    const good = await app.app.inject({
      method: 'POST',
      url: '/api/webhooks/meta',
      payload: body,
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': signBody(webhookSecret(true)!, body),
      },
    });
    expect(good.statusCode).toBe(200);
  });
});

describe('Instagram, Messenger e Meta Ads (modo de teste)', () => {
  it('direct do Instagram e Messenger chegam; Tráfego propõe e só muda orçamento com aprovação', async () => {
    const admin = await loginAdmin(app);
    for (const k of ['INSTAGRAM', 'MESSENGER', 'META_ADS'])
      await post(admin, `/api/v1/connections/${k}/test-mode`, {});
    await atendimento(admin, 'RASCUNHO');
    await post(admin, '/api/v1/connections/INSTAGRAM/simulate', {
      from: 'ig-user-1',
      text: 'Vocês fazem cabeceira sob medida?',
    });
    await post(admin, '/api/v1/connections/MESSENGER/simulate', {
      from: 'psid-1',
      text: 'Qual o valor da troca de espuma?',
    });
    const list = (await admin.get('/api/v1/inbox')).body as { channel: string }[];
    expect(list.map((c) => c.channel).sort()).toEqual(['INSTAGRAM', 'MESSENGER']);

    // Post de teste do Marketing: rascunho → publicação aprovada.
    const draft = await post(admin, '/api/v1/marketing/draft', {});
    expect(draft.status).toBe(200);
    const noPhoto = await post(
      admin,
      `/api/v1/marketing/posts/${(draft.body as { id: string }).id}/publish`,
      {},
    );
    expect(noPhoto.status).toBe(422);
    await admin.req(
      'PUT',
      `/api/v1/marketing/posts/${(draft.body as { id: string }).id}`,
      { caption: 'Sofá renovado ✨', mediaUrls: ['https://exemplo.test/sofa.jpg'] },
      { 'idempotency-key': idemKey() },
    );
    const pub = await post(
      admin,
      `/api/v1/marketing/posts/${(draft.body as { id: string }).id}/publish`,
      {},
    );
    expect(pub.status).toBe(200);
    expect(pub.body).toMatchObject({ test: true });

    // Tráfego: leitura das campanhas e proposta exata de orçamento.
    const camp = (await admin.get('/api/v1/ads/campaigns')).body as {
      campaigns: unknown[];
      test: boolean;
    };
    expect(camp.test).toBe(true);
    expect(camp.campaigns.length).toBeGreaterThan(1);
    await post(admin, '/api/v1/game/agents', {
      name: 'Tráfego',
      roleKey: 'TRAFEGO',
      roleLabel: 'Tráfego',
      instructions: '',
      dataScopes: [],
      channelPolicies: { META_ADS: 'CONSULTAR' },
    });
    const an = await post(admin, '/api/v1/ads/analyze', {});
    expect(an.status).toBe(200);
    const ids = (an.body as { proposals: string[] }).proposals;
    expect(ids.length).toBe(2);
    const prop = await db().aiAgentProposal.findUniqueOrThrow({ where: { id: ids[0]! } });
    expect(prop.title).toMatch(/→/);
    expect(prop.detail).toMatch(/daily_budget de \d+ para \d+ centavos/);
    expect(await db().agentAction.count({ where: { kind: 'ALTERAR_ORCAMENTO' } })).toBe(0);
    const dec = await post(admin, `/api/v1/game/proposals/${ids[0]}/decide`, {
      decision: 'APROVAR',
    });
    expect(dec.status).toBe(200);
    expect(dec.body).toMatchObject({ status: 'EXECUTADA_TESTE' });
    expect(
      await db().agentAction.count({
        where: { kind: 'ALTERAR_ORCAMENTO', approvedById: { not: null } },
      }),
    ).toBe(1);
    const rej = await post(admin, `/api/v1/game/proposals/${ids[1]}/decide`, {
      decision: 'REJEITAR',
    });
    expect(rej.body).toMatchObject({ status: 'REJEITADA' });
    expect(await db().agentAction.count({ where: { kind: 'ALTERAR_ORCAMENTO' } })).toBe(1);
  });
});
