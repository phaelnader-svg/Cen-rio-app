#!/usr/bin/env node
/**
 * Dados SINTÉTICOS para a demonstração do jogo de gestão (desenvolvimento/homologação).
 * Tudo pela API HTTP — as mesmas regras, auditoria e eventos do uso normal:
 *   - PIN de João, Márcio, Ricardo e Thiago e um tablet cadastrado para cada um;
 *   - materiais do catálogo com saldo inicial (ajuste de entrada) e endereço no mapa;
 *   - 4 OS fictícias: falta de material (vermelho), material reservado (verde), sem
 *     levantamento ("A conferir") e uma já planejada, publicada e com o desmanche INICIADO
 *     pelo João no tablet;
 *   - contas a pagar e recebimentos da semana (para o plano do Gerente).
 *
 * Uso (API rodando):
 *   JOGO_EMAIL=gestor@cenario.test JOGO_PASSWORD='…' node scripts/jogo-dados-sinteticos.mjs
 * Opcional: JOGO_API=http://localhost:4000  JOGO_ORIGIN=http://localhost:3000
 *
 * Recusa APP_ENV=production. Reexecutar não duplica as OS (procura "(jogo)" nos clientes).
 */
const api = (process.env.JOGO_API ?? 'http://localhost:4000').replace(/\/$/, '');
const origin = process.env.JOGO_ORIGIN ?? 'http://localhost:3000';
const email = process.env.JOGO_EMAIL;
const password = process.env.JOGO_PASSWORD;
if (process.env.APP_ENV === 'production') {
  console.error('Recusado: dados sintéticos não entram em produção.');
  process.exit(1);
}
if (!email || !password) {
  console.error('Defina JOGO_EMAIL e JOGO_PASSWORD (conta do gestor).');
  process.exit(1);
}

const key = () => crypto.randomUUID().replace(/-/g, '');
function client() {
  const jar = new Map();
  return async function call(method, path, body) {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await fetch(`${api}${path}`, {
      method,
      headers: {
        origin,
        'content-type': 'application/json',
        'idempotency-key': key(),
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
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
    return text ? JSON.parse(text) : null;
  };
}
const gestor = client();
const log = (m) => process.stdout.write(`${m}\n`);
const day = (offset) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(
    new Date(Date.now() + offset * 86_400_000),
  );
const nextDow = (dow) => {
  const d = new Date(Date.now() + 86_400_000);
  while (d.getUTCDay() !== dow) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

await gestor('POST', '/api/auth/login', { email, password });
const me = await gestor('GET', '/api/auth/me');
const employees = await gestor('GET', '/api/employees');
const emp = (n) => employees.find((e) => e.displayName === n);

// 1. PIN e tablets da equipe (códigos de vinculação para tablets reais).
const team = [
  ['João', '813572'],
  ['Márcio', '924681'],
  ['Ricardo', '735914'],
  ['Thiago', '461829'],
];
const devices = await gestor('GET', '/api/devices');
const pairing = [];
for (const [name, pin] of team) {
  const e = emp(name);
  if (!e) continue;
  await gestor('PUT', `/api/employees/${e.id}/pin`, { pin });
  const existing = (Array.isArray(devices) ? devices : (devices.items ?? [])).find(
    (d) => d.name === `Tablet ${name} (jogo)`,
  );
  if (!existing) {
    const d = await gestor('POST', '/api/devices', {
      name: `Tablet ${name} (jogo)`,
      assignedEmployeeId: e.id,
      restrictToAssigned: true,
    });
    pairing.push({ name, pin, code: d.pairing.code });
  } else pairing.push({ name, pin, code: '(já cadastrado — gere novo código em Dispositivos)' });
}
log('✔ PINs definidos e tablets cadastrados.');

// 2. Catálogo de estoque com saldo inicial.
const catalog = [
  {
    key: 'espuma',
    body: {
      kind: 'ESPUMA',
      description: 'Espuma D28',
      foamDensity: 'D28',
      thicknessCm: 10,
      lengthCm: 190,
      widthCm: 130,
      unit: 'PLACA',
      minQuantity: 2,
    },
    entry: 1,
  },
  {
    key: 'grampo',
    body: { kind: 'OUTRO', description: 'Grampos 80/10', unit: 'EMBALAGEM', minQuantity: 3 },
    entry: 10,
  },
  {
    key: 'percinta',
    body: { kind: 'OUTRO', description: 'Percinta elástica', unit: 'METRO', minQuantity: 20 },
    entry: 60,
  },
  {
    key: 'mecanismo',
    body: { kind: 'OUTRO', description: 'Mecanismo retrátil (par)', unit: 'PECA', minQuantity: 1 },
    entry: 0,
  },
  {
    key: 'pes',
    body: { kind: 'OUTRO', description: 'Pés de madeira 15 cm', unit: 'UNIDADE', minQuantity: 8 },
    entry: 16,
  },
];
const items = {};
const current = await gestor('GET', '/api/v1/stock-items');
for (const c of catalog) {
  let it = (Array.isArray(current) ? current : (current.items ?? [])).find(
    (x) => x.description === c.body.description,
  );
  if (!it) {
    it = await gestor('POST', '/api/v1/stock-items', c.body);
    if (c.entry > 0)
      await gestor('POST', `/api/v1/stock-items/${it.id}/adjust`, {
        quantity: c.entry,
        reason: 'Saldo inicial (dados sintéticos do jogo)',
      });
  }
  items[c.key] = it;
}
log('✔ Materiais do catálogo com saldo inicial.');

// 3. OS fictícias.
const address = {
  label: 'Residência',
  street: 'Rua Fictícia do Jogo',
  number: '10',
  district: 'Bairro Teste',
  city: 'Cidade Teste',
  state: 'SP',
  postalCode: '01000-000',
};
async function openOs(name, pieces, promised) {
  const customer = await gestor('POST', '/api/v1/customers', {
    kind: 'PF',
    name,
    phone: null,
    addresses: [address],
    allowSimilar: true,
  });
  const order = await gestor('POST', '/api/v1/orders', {
    customerId: customer.id,
    pickupAddressId: customer.addresses[0].id,
    contractedService: 'Reforma (fictícia)',
    agreedValueCents: 250000,
    paymentTerms: '50% na retirada, 50% na entrega',
    promisedDate: promised,
    items: pieces.map((p) => ({
      pieceType: p.type,
      description: p.description,
      quantity: p.qty ?? 1,
    })),
  });
  await gestor('POST', '/api/v1/receipts', {
    orderId: order.id,
    pickupId: null,
    origin: 'ENTREGUE_PELO_CLIENTE',
    lines: order.items.map((it) => ({
      orderItemId: it.id,
      quantity: it.quantity,
      condition: 'BOA',
      location: 'Área de recebimento',
    })),
  });
  const existing = await gestor('GET', `/api/v1/service-orders?q=${encodeURIComponent(name)}`);
  let so = existing.items?.[0];
  if (so) so = await gestor('GET', `/api/v1/service-orders/${so.id}`);
  else
    so = await gestor('POST', '/api/v1/service-orders', {
      orderId: order.id,
      promisedDate: promised,
      items: order.items.map((it, i) => ({
        orderItemId: it.id,
        quantity: it.quantity,
        description: pieces[i].description,
        serviceType: pieces[i].service,
      })),
    });
  return { order, so };
}
async function approve(so, reqItems) {
  const m = await gestor('POST', '/api/v1/measurements', {
    serviceOrderId: so.id,
    kind: 'ROTINA',
    assigneeUserId: me.user.id,
    dueDate: nextDow(5),
  });
  const draft = await gestor('PUT', `/api/v1/measurements/${m.id}/draft`, {
    pieces: [],
    items: reqItems,
    version: m.version,
  });
  const sub = await gestor('POST', `/api/v1/measurements/${m.id}/submit`, {
    version: draft.version,
  });
  await gestor('POST', `/api/v1/measurements/${m.id}/request/approve`, {
    version: sub.request.version,
  });
}
const stockReq = (it, quantity) => ({
  kind: it.kind,
  sourcing: 'ESTOQUE',
  description: it.description,
  foamDensity: it.foamDensity ?? null,
  thicknessCm: it.thicknessCm ?? null,
  lengthCm: it.lengthCm ?? null,
  widthCm: it.widthCm ?? null,
  quantity,
  unit: it.unit,
});
async function reserveAll(so) {
  const r = await gestor('GET', `/api/v1/service-orders/${so.id}/material-readiness`);
  for (const l of r.lines.filter((x) => x.sourcing === 'ESTOQUE' && x.covered < x.need)) {
    const it = Object.values(items).find((x) => x.description === l.description);
    if (it)
      await gestor('POST', '/api/v1/stock-reservations', {
        stockItemId: it.id,
        serviceOrderId: so.id,
        materialRequirementId: l.requirementId,
        quantity: l.need - l.covered,
      });
  }
}

const already = await gestor('GET', `/api/v1/service-orders?q=${encodeURIComponent('(jogo)')}`);
let osD = null;
if (already.total > 0) {
  log(`• Já existem ${already.total} OS "(jogo)": mantidas (sem duplicar).`);
} else {
  // A — sofá retrátil com falta de material (vermelho).
  const A = await openOs(
    'Ana Fictícia (jogo)',
    [{ type: 'SOFA', description: 'Sofá retrátil 3 lugares', service: 'REFORMA_COMPLETA' }],
    day(6),
  );
  await approve(A.so, [
    {
      kind: 'TECIDO',
      sourcing: 'EXCLUSIVO_OS',
      serviceOrderItemId: A.so.items[0].id,
      description: 'Linho',
      color: 'Cinza grafite',
      quantity: 9,
      unit: 'METRO',
    },
    stockReq(items.espuma, 2),
    stockReq(items.mecanismo, 1),
    stockReq(items.grampo, 1),
  ]);
  log('✔ OS da Ana: sofá retrátil com tecido e mecanismo faltando.');
  // B — poltronas + cabeceira com material reservado (verde).
  const B = await openOs(
    'Bruno Fictício (jogo)',
    [
      { type: 'POLTRONA', description: 'Poltronas', service: 'TROCA_DE_TECIDO', qty: 2 },
      { type: 'CABECEIRA', description: 'Cabeceira queen', service: 'REFORMA_COMPLETA' },
    ],
    day(12),
  );
  await approve(B.so, [stockReq(items.grampo, 1), stockReq(items.percinta, 10)]);
  await reserveAll(B.so);
  log('✔ OS do Bruno: material reservado no estoque.');
  // C — sofá de canto sem levantamento (A conferir).
  await openOs(
    'Carla Fictícia (jogo)',
    [{ type: 'SOFA', description: 'Sofá de canto com chaise', service: 'TROCA_DE_TECIDO' }],
    day(20),
  );
  log('✔ OS da Carla: ainda sem levantamento de materiais.');
  // D — sofá 2 lugares planejado e publicado; João inicia o desmanche no tablet.
  const D = await openOs(
    'Diego Fictício (jogo)',
    [{ type: 'SOFA', description: 'Sofá 2 lugares', service: 'REFORMA_COMPLETA' }],
    day(4),
  );
  await approve(D.so, [stockReq(items.grampo, 1), stockReq(items.pes, 4)]);
  await reserveAll(D.so);
  osD = D.so;
  const ricardo = emp('Ricardo');
  const planned = await gestor('POST', '/api/v1/production/plan-services', {
    entries: [
      {
        serviceOrderId: D.so.id,
        startDate: day(0),
        pieces: [
          {
            serviceOrderItemId: D.so.items[0].id,
            upholstererUserId:
              ricardo.userId ?? (await gestor('GET', `/api/employees/${ricardo.id}`)).userId,
          },
        ],
      },
    ],
  });
  const planId = planned.planned[0].planId;
  const plan = await gestor('GET', `/api/v1/production-plans/${planId}`);
  await gestor('POST', `/api/v1/production-plans/${planId}/publish`, {
    version: plan.version,
    notes: 'Semana fictícia do jogo',
  });
  log('✔ OS do Diego planejada (titular Ricardo) e publicada.');

  // Contas da semana (para o plano do Gerente).
  await gestor('POST', '/api/v1/finance/payables', {
    beneficiary: 'Imobiliária Fictícia',
    category: 'ALUGUEL',
    description: 'Aluguel do galpão (fictício)',
    amountCents: 450000,
    dueDate: day(3),
  });
  await gestor('POST', '/api/v1/finance/payables', {
    beneficiary: 'Tecidos Fictícios Ltda',
    category: 'MATERIAL',
    description: 'Tecidos da semana (fictício)',
    amountCents: 238000,
    dueDate: day(5),
  });
  await gestor('POST', '/api/v1/finance/receivables', {
    orderId: B.order.id,
    serviceOrderId: B.so.id,
    description: 'Sinal OS do Bruno (fictício)',
    amountCents: 180000,
    dueTrigger: 'DATA',
    dueDate: day(2),
    expectedMethod: 'PIX',
  });
  await gestor('POST', '/api/v1/finance/receivables', {
    orderId: D.order.id,
    serviceOrderId: D.so.id,
    description: 'Saldo na entrega OS do Diego (fictício)',
    amountCents: 125000,
    dueTrigger: 'ENTREGA',
    expectedMethod: 'PIX',
  });
  log('✔ Contas a pagar e recebimentos fictícios da semana.');
}

// 4. Endereço dos materiais no mapa (Tapeçaria → Estoque → Estante A → Prateleira 1…).
const space = await gestor('GET', '/api/v1/game/spaces/TAPECARIA');
const unit = (label) => space.storageUnits.find((u) => u.label === label);
const put = (label, level, ...keys) => {
  const u = unit(label);
  const s = u?.slots.find((x) => x.level === level);
  if (s) s.stockItemIds = [...new Set([...s.stockItemIds, ...keys.map((k) => items[k].id)])];
};
put('Estante A', 1, 'grampo');
put('Estante A', 2, 'percinta');
put('Estante B', 1, 'mecanismo');
put('Estante B', 2, 'pes');
put('Estrado de espumas', 1, 'espuma');
await gestor('PUT', '/api/v1/game/spaces/TAPECARIA', {
  ...space,
  summary: 'Materiais endereçados (dados sintéticos)',
});
log('✔ Materiais endereçados nas estantes do mapa.');

// 5. João inicia o desmanche da OS do Diego pelo próprio tablet (confirmação do funcionário).
if (osD) {
  const joao = emp('João');
  const d = await gestor('POST', '/api/devices', {
    name: 'Tablet João (script do jogo)',
    assignedEmployeeId: joao.id,
    restrictToAssigned: true,
  });
  const tablet = client();
  await tablet('POST', '/api/tablet/pair', { code: d.pairing.code });
  await tablet('POST', '/api/tablet/login', { employeeId: joao.id, pin: '813572' });
  const q = await tablet('GET', '/api/v1/production-tasks/mine/queue');
  const t = q.items.find((e) => e.executable && e.task.serviceOrder.id === osD.id);
  if (t) {
    await tablet('POST', `/api/v1/production-tasks/${t.task.id}/start`, {});
    log(`✔ João iniciou "${t.task.title}" no tablet.`);
  } else log('• Desmanche ainda não liberado para o João (confira a fila dele).');
}

log('\nTablets para a demonstração (vincule em /tablet com o código; PIN do funcionário):');
for (const p of pairing) log(`  ${p.name.padEnd(8)} PIN ${p.pin}  código ${p.code}`);
log(
  '\nPronto: no Firma Viva, conecte o Cenário Gestão (Central de Conexões) com a conta do gestor.',
);
