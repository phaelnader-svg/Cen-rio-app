import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { setClock } from '../src/core/clock';
import { planCharges } from '../src/modules/office/charges';
import { type Client, createTestApp, db, idemKey, loginAdmin, resetDatabase } from './helpers';
import { FAKE_CPF } from './commercial-helpers';
import { openServiceOrder } from './measurement-helpers';

/**
 * Escritório financeiro — primeira demonstração (modo de teste local, sem credenciais):
 * orçamento aprovado → contrato preparado/revisado/enviado/assinado → entrada → pagamento
 * confirmado pelo provedor → baixa na conta a receber oficial → ficha atualizada.
 * Reenviar a mesma confirmação (ou outra confirmação do mesmo pagamento) não gera nova baixa.
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

async function approvedOrder(admin: Client) {
  const so = (await openServiceOrder(admin, 'Ana Paula Teste')) as { id: string };
  const row = await db().serviceOrder.findUniqueOrThrow({ where: { id: so.id } });
  await db().commercialOrder.update({
    where: { id: row.orderId },
    data: { agreedValueCents: 300000, promisedDate: new Date('2026-12-10T00:00:00Z') },
  });
  await db().customer.update({
    where: { id: row.customerId },
    data: { document: FAKE_CPF[0], email: 'ana.teste@exemplo.test' },
  });
  return { soId: so.id, orderId: row.orderId };
}

describe('plano de cobrança', () => {
  it('R$ 3.000 em 50/50 vira duas parcelas de R$ 1.500; cartão vira uma cobrança parcelada', () => {
    const l = planCharges(
      300000,
      {
        mode: 'ENTRADA_SALDO',
        entradaPercent: 50,
        installments: 1,
        method: 'PIX',
        saldoTrigger: 'ENTREGA',
      },
      '2026-11-15',
    );
    expect(l.map((x) => x.amountCents)).toEqual([150000, 150000]);
    expect(l[1]).toMatchObject({ dueTrigger: 'ENTREGA', emitNow: false });
    const c = planCharges(
      300001,
      {
        mode: 'CARTAO_TOTAL',
        entradaPercent: 50,
        installments: 6,
        method: 'PIX',
        saldoTrigger: 'ENTREGA',
      },
      '2026-11-15',
    );
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({
      amountCents: 300001,
      installments: 6,
      expectedMethod: 'CARTAO_CREDITO',
    });
  });
});

describe('primeira demonstração: contrato → entrada → baixa única', () => {
  it('fluxo completo com idempotência da confirmação de pagamento', async () => {
    const admin = await loginAdmin(app);
    const { soId, orderId } = await approvedOrder(admin);
    for (const k of ['ASSINATURA', 'COBRANCAS'])
      expect((await post(admin, `/api/v1/connections/${k}/test-mode`, {})).status).toBe(200);

    // 1. Contrato preparado pelo modelo; falta o CNPJ/endereço da Cenário → não envia.
    const c1 = await post(admin, `/api/v1/office/orders/${orderId}/contract`, {});
    expect(c1.status).toBe(200);
    const k1 = c1.body as {
      id: string;
      body: string;
      missing: string[];
      version: number;
      revision: number;
    };
    expect(k1.body).toMatch(/Ana Paula Teste/);
    expect(k1.body).toMatch(/R\$\s?3\.000,00/);
    expect(k1.body).toMatch(/529\.982\.247-25/);
    expect(k1.missing).toEqual(expect.arrayContaining(['CNPJ da Cenário', 'endereço da Cenário']));
    const blocked = await post(admin, `/api/v1/office/contracts/${k1.id}/send`, {
      version: k1.version,
    });
    expect(blocked.status).toBe(422);

    // Completa o cadastro da empresa e o agente prepara a revisão 2 (a 1 fica substituída).
    await db().companySettings.update({
      where: { id: 1 },
      data: {
        document: '11222333000181',
        address: 'Rua das Oficinas, 50, São José dos Campos/SP',
        email: 'contato@cenario.test',
        legalName: 'Cenário Estofados Ltda',
      },
    });
    const c2 = (await post(admin, `/api/v1/office/orders/${orderId}/contract`, {}))
      .body as typeof k1 & { signers: { name: string; email: string; role: string }[] };
    expect(c2.revision).toBe(2);
    expect(c2.missing).toEqual([]);
    const history = (await admin.get(`/api/v1/office/orders/${orderId}/contracts`)).body as {
      revision: number;
      status: string;
    }[];
    expect(history.map((h) => `${h.revision}:${h.status}`)).toEqual([
      '2:RASCUNHO',
      '1:SUBSTITUIDO',
    ]);

    // Revisão do gestor e envio (aprovação explícita).
    const edited = await admin.req(
      'PUT',
      `/api/v1/office/contracts/${c2.id}`,
      {
        body: `${c2.body}\n\n8. Inclui proteção impermeabilizante.`,
        signers: c2.signers,
        version: c2.version,
      },
      { 'idempotency-key': idemKey() },
    );
    expect(edited.status).toBe(200);
    const sent = await post(admin, `/api/v1/office/contracts/${c2.id}/send`, {
      version: (edited.body as { version: number }).version,
    });
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ status: 'ENVIADO', provider: 'CLICKSIGN_TESTE' });

    // Retorno do provedor (webhook com HMAC): assinado e PDF arquivado.
    const signed = await post(admin, `/api/v1/office/contracts/${c2.id}/simulate`, {
      event: 'auto_close',
    });
    expect(signed.body).toMatchObject({ duplicate: false, result: 'assinado' });
    const after = (await admin.get(`/api/v1/office/orders/${orderId}/contracts`)).body as {
      status: string;
      signedFileUrl: string;
    }[];
    expect(after[0]!.status).toBe('ASSINADO');
    const pdf = await app.app.inject({
      method: 'GET',
      url: after[0]!.signedFileUrl,
      headers: { cookie: [...admin.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
    });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-');

    // 2. Plano: entrada 50% por Pix agora, saldo na entrega.
    const prev = (
      await post(admin, `/api/v1/office/orders/${orderId}/charges/preview`, {
        mode: 'ENTRADA_SALDO',
        entradaPercent: 50,
      })
    ).body as { lines: { amountCents: number }[]; provider: { test: boolean } };
    expect(prev.lines.map((l) => l.amountCents)).toEqual([150000, 150000]);
    expect(prev.provider.test).toBe(true);
    const plan = await post(admin, `/api/v1/office/orders/${orderId}/charges`, {
      mode: 'ENTRADA_SALDO',
      entradaPercent: 50,
    });
    expect(plan.status).toBe(200);
    const lines = (
      plan.body as {
        lines: {
          receivableId: string;
          charge: { id: string; status: string; pixPayload: string } | null;
        }[];
      }
    ).lines;
    expect(lines[0]!.charge).toMatchObject({ status: 'ABERTA' });
    expect(lines[0]!.charge!.pixPayload).toMatch(/^000201/);
    expect(lines[1]!.charge).toBeNull();
    // Repetir a aprovação não duplica as contas: o valor do pedido já está todo lançado.
    expect(
      (await post(admin, `/api/v1/office/orders/${orderId}/charges`, { mode: 'ENTRADA_SALDO' }))
        .status,
    ).toBe(422);

    // 3. Pagamento confirmado pelo provedor → baixa uma única vez.
    const chargeId = lines[0]!.charge!.id;
    const p1 = await post(admin, `/api/v1/office/charges/${chargeId}/simulate`, {
      event: 'PAYMENT_RECEIVED',
      eventId: 'evt_demo_1',
    });
    expect(p1.body).toMatchObject({ status: 200, duplicate: false, result: 'baixa registrada' });
    const p2 = await post(admin, `/api/v1/office/charges/${chargeId}/simulate`, {
      event: 'PAYMENT_RECEIVED',
      eventId: 'evt_demo_1',
    });
    expect(p2.body).toMatchObject({ status: 200, duplicate: true });
    const p3 = await post(admin, `/api/v1/office/charges/${chargeId}/simulate`, {
      event: 'PAYMENT_CONFIRMED',
      eventId: 'evt_demo_2',
    });
    expect(p3.body).toMatchObject({
      duplicate: false,
      result: 'já baixada (confirmação repetida ignorada)',
    });
    expect(
      await db().customerPayment.count({ where: { receivableId: lines[0]!.receivableId } }),
    ).toBe(1);
    const rec = await db().customerReceivable.findUniqueOrThrow({
      where: { id: lines[0]!.receivableId },
    });
    expect(rec).toMatchObject({ status: 'RECEBIDO', receivedCents: 150000 });

    // 4. Ficha do sofá com estados separados.
    const ficha = (await admin.get(`/api/v1/office/service-orders/${soId}/ficha`)).body as {
      balanceCents: number;
      steps: { key: string; state: string }[];
    };
    const st = Object.fromEntries(ficha.steps.map((s) => [s.key, s.state]));
    expect(st).toMatchObject({
      ORCAMENTO: 'Aprovado',
      CONTRATO: 'Assinado',
      ENTRADA: 'Pago',
      NOTA: 'Não emitida',
    });
    expect(st.SALDO).toMatch(/1\.500,00 a receber/);
    expect(ficha.balanceCents).toBe(150000);
  });

  it('webhooks de cobrança e assinatura recusam chamadas sem autenticação do provedor', async () => {
    const body = JSON.stringify({
      id: 'evt_x',
      event: 'PAYMENT_RECEIVED',
      payment: { id: 'pay_x' },
    });
    expect(
      (
        await app.app.inject({
          method: 'POST',
          url: '/api/webhooks/asaas',
          payload: body,
          headers: { 'content-type': 'application/json' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.app.inject({
          method: 'POST',
          url: '/api/webhooks/asaas',
          payload: body,
          headers: { 'content-type': 'application/json', 'asaas-access-token': 'errado' },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.app.inject({
          method: 'POST',
          url: '/api/webhooks/clicksign',
          payload: body,
          headers: { 'content-type': 'application/json', 'content-hmac': 'sha256=00' },
        })
      ).statusCode,
    ).toBe(401);
  });
});

describe('fiscal: perfis, o que falta e autorização com revisão', () => {
  it('não emite sem perfil validado; com tudo configurado autoriza (teste) e guarda arquivos', async () => {
    const admin = await loginAdmin(app);
    const { soId, orderId } = await approvedOrder(admin);
    const prep = await post(admin, `/api/v1/office/orders/${orderId}/fiscal`, {});
    expect(prep.status).toBe(200);
    const doc = prep.body as {
      id: string;
      version: number;
      profile: { name: string };
      missing: string[];
    };
    expect(doc.profile.name).toBe('Reforma de estofados (serviço)');
    expect(doc.missing).toEqual(
      expect.arrayContaining([
        'perfil fiscal validado pela contabilidade',
        'código de tributação nacional do serviço',
        'alíquota de ISS',
        'conexão com o emissor fiscal (Central de Conexões)',
        'CNPJ da Cenário',
      ]),
    );
    expect(
      (await post(admin, `/api/v1/office/fiscal/${doc.id}/authorize`, { version: doc.version }))
        .status,
    ).toBe(422);

    const profiles = (await admin.get('/api/v1/office/fiscal/profiles')).body as {
      id: string;
      name: string;
      version: number;
      hint: string;
      descriptionTemplate: string;
    }[];
    const reforma = profiles.find((p) => p.name.startsWith('Reforma'))!;
    expect(reforma.hint).toMatch(/14\.11/);
    const saved = await admin.req(
      'PUT',
      `/api/v1/office/fiscal/profiles/${reforma.id}`,
      {
        documentKind: 'NFSE',
        serviceCode: '141101',
        municipalTaxCode: null,
        cnae: '9529199',
        issRatePercent: 3,
        ncm: null,
        cfop: null,
        descriptionTemplate: reforma.descriptionTemplate,
        validatedByAccountant: true,
        version: reforma.version,
      },
      { 'idempotency-key': idemKey() },
    );
    expect(saved.status).toBe(200);
    await db().companySettings.update({ where: { id: 1 }, data: { document: '11222333000181' } });
    await post(admin, '/api/v1/connections/FISCAL/test-mode', {});
    const again = (await admin.get(`/api/v1/office/orders/${orderId}/fiscal`)).body as {
      id: string;
      version: number;
      missing: string[];
    }[];
    expect(again[0]!.missing).toEqual([]);
    const ok = await post(admin, `/api/v1/office/fiscal/${doc.id}/authorize`, {
      version: again[0]!.version,
    });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ status: 'AUTORIZADA', number: 'TESTE-000001' });
    expect((ok.body as { files: unknown[] }).files).toHaveLength(2);
    const ficha = (await admin.get(`/api/v1/office/service-orders/${soId}/ficha`)).body as {
      steps: { key: string; state: string }[];
    };
    expect(ficha.steps.find((s) => s.key === 'NOTA')!.state).toBe('Autorizada nº TESTE-000001');
    // Fechamento do mês: nota emitida no pacote.
    const month = new Date().toISOString().slice(0, 7);
    const closing = (await admin.get(`/api/v1/office/accounting/${month}`)).body as {
      groups: { kind: string; docs: unknown[] }[];
      pending: { kind: string }[];
    };
    expect(closing.groups.find((g) => g.kind === 'NOTA_EMITIDA')!.docs).toHaveLength(2);
    expect(closing.pending.map((p) => p.kind)).toContain('EXTRATO');
    const zipRes = await app.app.inject({
      method: 'GET',
      url: `/api/v1/office/accounting/${month}/package`,
      headers: { cookie: [...admin.cookies].map(([k, v]) => `${k}=${v}`).join('; ') },
    });
    expect(zipRes.statusCode).toBe(200);
    expect(zipRes.rawPayload.subarray(0, 2).toString()).toBe('PK');
  });
});

describe('banco: extrato, pagamento preparado e conciliação', () => {
  it('pagamento só vira pago pela conciliação; reimportar o extrato não duplica', async () => {
    // Datas do extrato e da maquininha são fixas: o "hoje" da previsão é o dia do extrato.
    setClock(() => new Date('2026-11-15T15:00:00Z'));
    const admin = await loginAdmin(app);
    const pay = await post(admin, '/api/v1/finance/payables', {
      beneficiary: 'Espumas Vale Ltda',
      category: 'MATERIAL',
      description: 'Espuma D28 — NF 123',
      amountCents: 84000,
      dueDate: '2026-11-20',
    });
    expect(pay.status).toBe(201);
    const payableId = (pay.body as { id: string }).id;
    const acc = (
      await post(admin, '/api/v1/office/bank/accounts', {
        label: 'Conta PJ',
        bank: 'Banco Teste',
        masked: 'ag 0001 · cc ****1234',
      })
    ).body as { id: string };
    const po = (
      await post(admin, `/api/v1/office/payables/${payableId}/payment-order`, {
        accountId: acc.id,
        method: 'PIX',
      })
    ).body as {
      id: string;
      status: string;
      version: number;
      beneficiary: string;
      amountCents: number;
    };
    expect(po).toMatchObject({
      status: 'PREPARADO',
      beneficiary: 'Espumas Vale Ltda',
      amountCents: 84000,
    });
    const conf = (
      await post(admin, `/api/v1/office/payment-orders/${po.id}/confirm`, { version: po.version })
    ).body as { status: string };
    expect(conf.status).toBe('AGUARDANDO_APP');
    expect((await db().accountPayable.findUniqueOrThrow({ where: { id: payableId } })).status).toBe(
      'ABERTO',
    );

    const csv =
      'data;descricao;valor\n15/11/2026;PIX ENVIADO ESPUMAS VALE;-840,00\n15/11/2026;PIX RECEBIDO ANA;1.500,00\n';
    const imp = (
      await post(admin, `/api/v1/office/bank/accounts/${acc.id}/import`, {
        format: 'CSV',
        content: csv,
      })
    ).body as { imported: number };
    expect(imp.imported).toBe(2);
    const dup = (
      await post(admin, `/api/v1/office/bank/accounts/${acc.id}/import`, {
        format: 'CSV',
        content: csv,
      })
    ).body as { imported: number; duplicates: number };
    expect(dup).toMatchObject({ imported: 0, duplicates: 2 });
    const txs = (await admin.get('/api/v1/office/bank/transactions')).body as {
      id: string;
      amountCents: number;
      suggestions: { refType: string; refId: string }[];
    }[];
    const out = txs.find((t) => t.amountCents === -84000)!;
    expect(out.suggestions[0]).toMatchObject({ refType: 'payment_order', refId: po.id });
    const rec = await post(admin, `/api/v1/office/bank/transactions/${out.id}/reconcile`, {
      refType: 'payment_order',
      refId: po.id,
    });
    expect(rec.status).toBe(200);
    expect((await db().accountPayable.findUniqueOrThrow({ where: { id: payableId } })).status).toBe(
      'PAGO',
    );
    expect((await db().paymentOrder.findUniqueOrThrow({ where: { id: po.id } })).status).toBe(
      'PAGO',
    );
    expect(
      (
        await post(admin, `/api/v1/office/bank/transactions/${out.id}/reconcile`, {
          refType: 'payment_order',
          refId: po.id,
        })
      ).status,
    ).toBe(409);
    expect(await db().payablePayment.count({ where: { payableId } })).toBe(1);

    // Maquininha: bruto, taxa, líquido; previsão da semana.
    const card = (
      await post(admin, '/api/v1/office/card/import', {
        provider: 'Stone',
        content:
          'data;bruto;taxa;liquido;parcelas;previsao\n15/11/2026;1.000,00;-31,90;968,10;1;16/11/2026\n',
      })
    ).body as { imported: number };
    expect(card.imported).toBe(1);
    const fc = (await admin.get('/api/v1/office/forecast?days=7')).body as {
      inCents: number;
      cards: unknown[];
    };
    expect(fc.cards).toHaveLength(1);
    expect(fc.inCents).toBe(96810);
  });
});

describe('Falar com a Cenário — pedidos financeiros', () => {
  it('prepara o contrato, mostra a prévia da entrada e lista contas até sexta', async () => {
    const admin = await loginAdmin(app);
    const { soId } = await approvedOrder(admin);
    const ask = async (text: string) =>
      (await post(admin, '/api/v1/game/command', { text, spaceKey: 'ESCRITORIO' })).body as {
        reply: string;
        effect: {
          kind: string;
          serviceOrderId?: string;
          filter?: string;
          rows?: { label: string }[];
        };
      };
    const c = await ask('Prepare o contrato da Ana Paula');
    expect(c.effect).toMatchObject({
      kind: 'ABRIR_PAINEL',
      panel: 'FINANCEIRO',
      serviceOrderId: soId,
      filter: 'CONTRATO',
    });
    expect(c.reply).toMatch(/Preparei o contrato/);
    expect(await db().contract.count()).toBe(1);
    expect(await db().contract.count({ where: { status: 'ENVIADO' } })).toBe(0);
    const so = await db().serviceOrder.findUniqueOrThrow({ where: { id: soId } });
    const e = await ask(`Gere a entrada por Pix da OS ${so.number}`);
    expect(e.reply).toMatch(/Entrada \(50%\) R\$\s?1\.500,00/);
    expect(e.effect.filter).toBe('COBRANCA:ENTRADA:50:PIX');
    expect(await db().customerReceivable.count()).toBe(0); // só prévia
    await post(admin, '/api/v1/finance/payables', {
      beneficiary: 'Espumas Vale',
      category: 'MATERIAL',
      description: 'Espuma D28',
      amountCents: 84000,
      dueDate: '2026-11-18',
    });
    const p = await ask('Quais contas vencem até sexta?');
    expect(p.effect.kind).toBe('LISTA');
    expect(p.effect.rows![0]!.label).toMatch(/Espumas Vale/);
    const f = await ask('Preparar o pagamento do fornecedor de espuma');
    expect(f.effect.rows).toHaveLength(1);
    const n = await ask('Separe as notas e comprovantes do mês');
    expect(n.effect).toMatchObject({ kind: 'ABRIR_PAINEL', filter: 'FECHAMENTO' });
  });
});
