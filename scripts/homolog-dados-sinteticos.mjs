#!/usr/bin/env node
/**
 * Dados SINTÉTICOS para a homologação (nunca dados reais).
 * Cria, pela API HTTP (as mesmas regras e auditoria do uso normal), clientes fictícios,
 * pedidos, recebimentos de peças e OS abertas, para os testadores começarem do meio do fluxo.
 *
 * Uso:
 *   HOMOLOG_URL=https://homolog.exemplo.com.br \
 *   HOMOLOG_EMAIL=gestor@teste.local HOMOLOG_PASSWORD='…' \
 *   node scripts/homolog-dados-sinteticos.mjs [quantidade=5]
 *
 * Recusa rodar com APP_ENV=production. Cada execução cria registros novos (nomes numerados).
 */
const base = (process.env.HOMOLOG_URL ?? '').replace(/\/$/, '');
const email = process.env.HOMOLOG_EMAIL;
const password = process.env.HOMOLOG_PASSWORD;
const count = Math.min(Math.max(Number(process.argv[2] ?? 5), 1), 50);

if (process.env.APP_ENV === 'production') {
  console.error('Recusado: este script é só para homologação/testes.');
  process.exit(1);
}
if (!base || !email || !password) {
  console.error('Defina HOMOLOG_URL, HOMOLOG_EMAIL e HOMOLOG_PASSWORD.');
  process.exit(1);
}

let cookie = '';
const key = () => crypto.randomUUID().replace(/-/g, '');
async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: {
      origin: base,
      'content-type': 'application/json',
      'idempotency-key': key(),
      ...(cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.getSetCookie?.() ?? [];
  if (set.length) cookie = set.map((c) => c.split(';')[0]).join('; ');
  const text = await res.text();
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
  return text ? JSON.parse(text) : null;
}

const address = {
  label: 'Residência',
  street: 'Rua Exemplo de Homologação',
  number: '100',
  district: 'Bairro Fictício',
  city: 'Cidade Teste',
  state: 'SP',
  postalCode: '01000-000',
};

await call('POST', '/api/auth/login', { email, password });
const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
for (let i = 1; i <= count; i++) {
  const customer = await call('POST', '/api/v1/customers', {
    kind: 'PF',
    name: `Cliente Fictício ${stamp} #${i}`,
    phone: null,
    addresses: [address],
    allowSimilar: true,
  });
  const order = await call('POST', '/api/v1/orders', {
    customerId: customer.id,
    pickupAddressId: customer.addresses[0].id,
    contractedService: 'Reforma completa com troca de tecido (fictício)',
    agreedValueCents: 250000 + i * 10000,
    paymentTerms: '50% na retirada, 50% na entrega',
    items: [
      { pieceType: 'SOFA', description: 'Sofá 3 lugares', quantity: 1 },
      { pieceType: 'POLTRONA', description: 'Poltronas', quantity: 2 },
    ],
  });
  await call('POST', '/api/v1/receipts', {
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
  const so = await call('POST', '/api/v1/service-orders', {
    orderId: order.id,
    items: [
      {
        orderItemId: order.items[0].id,
        quantity: 1,
        description: 'Sofá 3 lugares',
        serviceType: 'REFORMA_COMPLETA',
      },
      {
        orderItemId: order.items[1].id,
        quantity: 2,
        description: 'Poltronas',
        serviceType: 'TROCA_DE_TECIDO',
      },
    ],
  });
  process.stdout.write(
    `✔ ${customer.name}: pedido ${order.number ?? order.id}, OS ${so.number ?? so.id}\n`,
  );
}
process.stdout.write(
  `Concluído: ${count} cliente(s) fictício(s) com pedido, recebimento e OS aberta.\n`,
);
