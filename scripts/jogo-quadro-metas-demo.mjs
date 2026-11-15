#!/usr/bin/env node
/**
 * Demonstração SINTÉTICA do Quadro de Metas (desenvolvimento). Tudo pelas rotas oficiais.
 * Pré-requisito: scripts/jogo-dados-sinteticos.mjs já executado (e, para a entrega, o sofá da
 * Ana na expedição — docs/evidencias/jogo/demonstracao-playwright.cjs com ONLY2=1).
 *
 * Linha do tempo (semanas de segunda a domingo, São Paulo):
 *   Semana −2 (positiva): saldo informado R$ 50.000 na Conta PJ (segunda 08:00); recebe
 *     R$ 12.000 de entrada da Ana; compra a prazo e paga R$ 4.000 de material; paga R$ 3.000 de
 *     mão de obra → fecha R$ 55.000 (+R$ 5.000, +10%). Meta "Reserva de R$ 55 mil" atingida.
 *   Semana −1 (negativa): paga R$ 2.750 de material → R$ 52.250 (−R$ 2.750, −5%): abaixo da meta.
 *   Semana atual: transferência de R$ 10.000 para a Reserva (total igual); compra a prazo em
 *     aberto; cobrança Pix do Bruno confirmada pelo provedor (reenviada: muda o saldo uma vez);
 *     entrega da Ana com saldo de R$ 3.000 em A receber.
 * Uso: JOGO_EMAIL=… JOGO_PASSWORD=… node scripts/jogo-quadro-metas-demo.mjs
 */
const api = (process.env.JOGO_API ?? 'http://localhost:4000').replace(/\/$/, '');
const origin = process.env.JOGO_ORIGIN ?? 'http://localhost:3000';
if (process.env.APP_ENV === 'production') {
  console.error('Recusado: dados sintéticos não entram em produção.');
  process.exit(1);
}
const jar = new Map();
async function call(method, path, body, okStatuses = []) {
  const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const res = await fetch(`${api}${path}`, {
    method,
    headers: {
      origin,
      'content-type': 'application/json',
      'idempotency-key': crypto.randomUUID().replace(/-/g, ''),
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  for (const c of res.headers.getSetCookie?.() ?? []) {
    const [pair] = c.split(';');
    const i = pair.indexOf('=');
    jar.set(pair.slice(0, i).trim(), pair.slice(i + 1));
  }
  const text = await res.text();
  if (!res.ok && !okStatuses.includes(res.status))
    throw new Error(`${method} ${path}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}
const log = (m) => process.stdout.write(`${m}\n`);
const sp = (d) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(d);
const addDays = (iso, n) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const today = sp(new Date());
const monday = addDays(today, -((new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7));
const w2 = addDays(monday, -14);
const w1 = addDays(monday, -7);
const at = (date, time) => `${date}T${time}:00-03:00`;

await call('POST', '/api/auth/login', {
  email: process.env.JOGO_EMAIL,
  password: process.env.JOGO_PASSWORD,
});
const employees = await call('GET', '/api/employees');
const userOf = (n) => employees.find((e) => e.displayName === n).userId;
const soOf = async (name) => {
  const r = await call('GET', `/api/v1/service-orders?q=${encodeURIComponent(name)}`);
  return call('GET', `/api/v1/service-orders/${r.items[0].id}`);
};

// Contas do caixa e saldo informado.
const board0 = await call('GET', '/api/v1/office/cash');
let pj = board0.accounts.find((a) => a.label === 'Conta PJ');
const already = Boolean(pj);
const ana = await soOf('Ana Fictícia');
const bruno = await soOf('Bruno Fictício');
const diego = await soOf('Diego Fictício');
if (already) log('• Contas e lançamentos já configurados: só confere a entrega.');
if (!already) {
  pj = await call('POST', '/api/v1/office/cash/accounts', {
    label: 'Conta PJ',
    bank: 'Banco Fictício',
    masked: 'ag 0001 · cc ****1234',
    isDefault: true,
  });
  const reserva = await call('POST', '/api/v1/office/cash/accounts', {
    label: 'Reserva',
    bank: 'Banco Fictício',
    masked: 'poupança ****9876',
  });
  await call('POST', '/api/v1/office/cash/snapshots', {
    accountId: pj.id,
    amountCents: 5_000_000,
    takenAt: at(w2, '08:00'),
    note: 'Saldo de abertura da demonstração',
  });
  await call('POST', '/api/v1/office/cash/snapshots', {
    accountId: reserva.id,
    amountCents: 0,
    takenAt: at(w2, '08:00'),
  });
  log(
    `✔ Contas: Conta PJ R$ 50.000 e Reserva R$ 0 informados em ${w2.split('-').reverse().join('/')} 08:00.`,
  );

  // Pedidos com valores da demonstração (ajuste comercial oficial, com motivo).
  for (const [so, cents] of [
    [ana, 1_250_000],
    [bruno, 300_000],
  ])
    await call('POST', `/api/v1/finance/orders/${so.orderId ?? so.order.id}/adjustments`, {
      kind: 'ACRESCIMO',
      amountCents: cents,
      reason: 'Valor fictício da demonstração do Quadro de Metas',
    });

  // Semana −2: recebimento liquidado (entrada da Ana), compra a prazo paga e mão de obra paga.
  const anaOrder = ana.orderId ?? ana.order.id;
  const entrada = await call('POST', '/api/v1/finance/receivables', {
    orderId: anaOrder,
    serviceOrderId: ana.id,
    description: 'Entrada da Ana (fictícia)',
    amountCents: 1_200_000,
    dueTrigger: 'DATA',
    dueDate: addDays(w2, 1),
    expectedMethod: 'PIX',
  });
  await call('POST', `/api/v1/finance/receivables/${entrada.id}/payments`, {
    amountCents: 1_200_000,
    receivedAt: addDays(w2, 1),
    method: 'PIX',
    version: entrada.version,
  });
  await call('POST', '/api/v1/finance/receivables', {
    orderId: anaOrder,
    serviceOrderId: ana.id,
    description: 'Saldo da Ana na entrega (fictício)',
    amountCents: 300_000,
    dueTrigger: 'ENTREGA',
    expectedMethod: 'PIX',
  });
  const espuma = await call('POST', '/api/v1/finance/payables', {
    beneficiary: 'Espumas Fictícias Ltda',
    category: 'MATERIAL',
    description: 'Espuma D28 — compra a prazo (fictícia)',
    amountCents: 400_000,
    dueDate: addDays(w2, 2),
  });
  await call('POST', `/api/v1/finance/payables/${espuma.id}/payments`, {
    amountCents: 400_000,
    paidAt: addDays(w2, 2),
    method: 'PIX',
    version: espuma.version,
  });
  const ricardo = userOf('Ricardo');
  let labor = await call(
    'POST',
    '/api/v1/finance/labor',
    {
      professionalUserId: ricardo,
      serviceOrderId: diego.id,
      serviceOrderItemId: diego.items[0].id,
      service: 'Reforma do sofá do Diego',
      agreedCents: 300_000,
    },
    [409],
  );
  if (!labor?.id) {
    const list = await call('GET', `/api/v1/finance/labor?serviceOrderId=${diego.id}`);
    labor = (list.items ?? list)[0];
  }
  await call(
    'POST',
    `/api/v1/finance/weekly-closings/${w2}/exceptions`,
    {
      beneficiaryUserId: ricardo,
      reason: 'Adiantamento combinado (demonstração)',
      itemIds: [labor.id],
    },
    [409, 422],
  );
  await call('POST', `/api/v1/finance/labor/${labor.id}/payments`, {
    amountCents: 300_000,
    paidAt: addDays(w2, 3),
    method: 'PIX',
    earlyReason: 'Adiantamento combinado (demonstração)',
    version: labor.version,
  });
  log('✔ Semana −2: +R$ 12.000 (Ana), −R$ 4.000 (espuma), −R$ 3.000 (mão de obra do Ricardo).');

  // Meta da demonstração (atingida na semana −2 e perdida na −1).
  await call('POST', '/api/v1/office/cash/goals', {
    name: 'Reserva de R$ 55 mil (demonstração)',
    targetCents: 5_500_000,
    deadline: addDays(monday, 13),
    accountIds: [],
  });

  // Semana −1: material pago (−5%).
  const tecido = await call('POST', '/api/v1/finance/payables', {
    beneficiary: 'Tecidos Fictícios Ltda',
    category: 'MATERIAL',
    description: 'Linho cinza — compra a prazo (fictícia)',
    amountCents: 275_000,
    dueDate: addDays(w1, 1),
  });
  await call('POST', `/api/v1/finance/payables/${tecido.id}/payments`, {
    amountCents: 275_000,
    paidAt: addDays(w1, 1),
    method: 'BOLETO',
    version: tecido.version,
  });
  log('✔ Semana −1: −R$ 2.750 (linho) → abaixo da meta de R$ 55 mil.');

  // Semana atual: transferência interna, compra a prazo em aberto e cobrança confirmada (reenviada).
  await call('POST', '/api/v1/office/cash/entries', {
    accountId: pj.id,
    kind: 'TRANSFERENCIA',
    toAccountId: reserva.id,
    amountCents: 1_000_000,
    description: 'Reserva para a máquina de costura nova',
  });
  await call('POST', '/api/v1/finance/payables', {
    beneficiary: 'Ferragens Fictícias',
    category: 'MATERIAL',
    description: 'Mecanismos retráteis — compra a prazo (fictícia)',
    amountCents: 180_000,
    dueDate: addDays(today, 10),
  });
  await call('POST', '/api/v1/connections/COBRANCAS/test-mode', {}, [409, 422]);
  const brunoOrder = bruno.orderId ?? bruno.order.id;
  const plan = await call('POST', `/api/v1/office/orders/${brunoOrder}/charges`, {
    mode: 'ENTRADA_SALDO',
    entradaPercent: 50,
  });
  const charge = plan.lines[0].charge;
  const before = (await call('GET', '/api/v1/office/cash')).balanceCents;
  await call('POST', `/api/v1/office/charges/${charge.id}/simulate`, {
    event: 'PAYMENT_RECEIVED',
    eventId: `evt_demo_${charge.id}`,
  });
  const once = (await call('GET', '/api/v1/office/cash')).balanceCents;
  const again = await call('POST', `/api/v1/office/charges/${charge.id}/simulate`, {
    event: 'PAYMENT_RECEIVED',
    eventId: `evt_demo_${charge.id}`,
  });
  const twice = (await call('GET', '/api/v1/office/cash')).balanceCents;
  log(
    `✔ Cobrança Pix do Bruno confirmada: saldo ${before / 100} → ${once / 100}; reenvio (${again.duplicate ? 'duplicado, ignorado' : again.result}) → ${twice / 100}.`,
  );
}

// Entrega da Ana (se o sofá estiver pronto): saldo de R$ 3.000 continua em A receber.
const snap = await call('GET', '/api/v1/game/snapshot');
const anaPiece = snap.pieces.find((p) => p.serviceOrderId === ana.id);
if (anaPiece && ['PRONTA_ENTREGA', 'ENTREGA_AGENDADA'].includes(anaPiece.stage)) {
  let d = await call('POST', '/api/v1/deliveries', {
    customerId: ana.customer.id,
    scheduledDate: today,
    windowStart: '14:00',
    windowEnd: '16:00',
    itemIds: [anaPiece.id],
    contactName: 'Ana Fictícia',
  });
  d = await call('POST', `/api/v1/deliveries/${d.id}/confirm`, { version: d.version });
  d = await call('POST', `/api/v1/deliveries/${d.id}/depart`, { version: d.version });
  d = await call('POST', `/api/v1/deliveries/${d.id}/arrive`, { version: d.version });
  d = await call('POST', `/api/v1/deliveries/${d.id}/items`, {
    items: [{ serviceOrderItemId: anaPiece.id, status: 'ENTREGUE' }],
    version: d.version,
  });
  d = await call('POST', `/api/v1/deliveries/${d.id}/complete`, { version: d.version });
  log(`✔ Entrega da Ana concluída (${d.status}); saldo de R$ 3.000 segue em A receber.`);
} else
  log(
    `• Entrega da Ana não feita: o sofá está em "${anaPiece?.stage ?? 'fora do mapa'}" (rode a demonstração de produção com ONLY2=1 antes).`,
  );

const b = await call('GET', '/api/v1/office/cash');
for (const w of b.weeks)
  log(
    `  semana ${w.weekStart}: ${w.openingCents / 100} → ${w.closingCents / 100} (${w.deltaCents / 100}; ${w.pct ?? 'n/a'}%)${w.partial ? ' parcial' : ''}`,
  );
for (const g of b.goals)
  log(
    `  meta ${g.name}: ${g.pctOfGoal}% · falta ${g.missingCents / 100}${g.achieved ? ` · conquistada ${g.achieved.at.slice(0, 10)}` : ''}${g.belowAfterAchieved ? ' · ABAIXO do patamar' : ''}`,
  );
log(
  `Saldo: ${b.balanceCents / 100} · a receber ${b.obligations.receivable.totalCents / 100} · a pagar ${b.obligations.payable.totalCents / 100}`,
);
