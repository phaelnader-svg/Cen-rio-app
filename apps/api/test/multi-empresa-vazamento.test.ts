import { Prisma, TENANCY } from '@cenario/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import type { AccessRule } from '../src/core/types';
import { createCustomer, createOrder, createPickup } from './commercial-helpers';
import { Client, createTestApp, db, loginAdmin, resetDatabase, EMPRESA_NOVA } from './helpers';

/**
 * Multi-empresa — detector de vazamento entre empresas.
 *
 * Coleta os ids de TODAS as linhas das tabelas de empresa (mapa em packages/db/src/tenancy.ts) e
 * percorre as rotas de leitura da API procurando qualquer um deles na resposta.
 *
 * Primeiro o teste prova que o detector ENXERGA os dados quando eles estão visíveis (o gestor da
 * própria empresa vê os próprios registros) — sem isso, "zero vazamentos" poderia passar só por
 * estar cego. Depois (etapa 3) o mesmo detector roda logado na empresa B contra os ids da empresa
 * A, nas listas e nas rotas com /:id, e precisa achar zero. A empresa B nasce pelo "Criar conta".
 */
let app: App;
beforeAll(async () => {
  app = await createTestApp();
  await app.app.ready();
});
afterAll(() => app.close());
beforeEach(resetDatabase);

type Route = { method: string; url: string; access: AccessRule };
const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;

/** Rotas de leitura sem parâmetro (listas, painéis, relatórios) acessíveis por sessão. */
function listRoutes(): string[] {
  return (app.app.routeCatalog as Route[])
    .filter(
      (r) =>
        r.method === 'GET' &&
        r.url.startsWith('/api') &&
        !r.url.includes(':') &&
        !('public' in r.access) &&
        !r.url.includes('/realtime') &&
        !r.url.endsWith('/stream'),
    )
    .map((r) => r.url);
}

const tablesDeEmpresa = () =>
  Prisma.dmmf.datamodel.models
    .filter((m) => TENANCY[m.name]?.class === 'empresa' || TENANCY[m.name]?.class === 'acesso')
    .map((m) => m.dbName ?? m.name);

/** Todos os ids (UUID) gravados nas tabelas de empresa — "os dados da empresa A". */
async function idsDaEmpresa(): Promise<Map<string, string>> {
  const tabelas = new Set(tablesDeEmpresa());
  const cols = await db().$queryRaw<{ table_name: string }[]>`
    SELECT table_name FROM information_schema.columns
     WHERE table_schema = 'public' AND column_name = 'id' AND data_type = 'uuid'`;
  const ids = new Map<string, string>();
  for (const { table_name } of cols) {
    if (!tabelas.has(table_name)) continue;
    const rows = await db().$queryRawUnsafe<{ id: string }[]>(
      `SELECT id::text AS id FROM "${table_name}"`,
    );
    for (const r of rows) ids.set(r.id, table_name);
  }
  return ids;
}

/** Rotas de leitura com parâmetros (/:id…) acessíveis por sessão. */
function paramRoutes(): string[] {
  return (app.app.routeCatalog as Route[])
    .filter(
      (r) =>
        r.method === 'GET' &&
        r.url.startsWith('/api') &&
        r.url.includes(':') &&
        !('public' in r.access) &&
        !r.url.includes('/realtime'),
    )
    .map((r) => r.url);
}

/** Percorre as rotas de leitura e devolve onde algum id de fora apareceu. */
async function varrerVazamentos(client: Client, ids: Map<string, string>) {
  const achados: { rota: string; tabela: string }[] = [];
  let rotas = 0;
  for (const url of listRoutes()) {
    const res = await client.get(url);
    if (res.status !== 200) continue;
    rotas += 1;
    const texto = JSON.stringify(res.body);
    for (const m of texto.matchAll(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
    )) {
      const tabela = ids.get(m[0]);
      if (tabela) achados.push({ rota: url, tabela });
    }
  }
  return { rotas, achados };
}

describe('Multi-empresa: detector de vazamento', () => {
  it('o detector enxerga os dados da empresa quando eles estão visíveis', async () => {
    const admin = await loginAdmin(app);
    const customer = await createCustomer(admin);
    const order = await createOrder(admin, customer);
    await createPickup(admin, order);

    const ids = await idsDaEmpresa();
    expect(ids.get(customer.id)).toBe('customers');
    expect(ids.get(order.id)).toBe('commercial_orders');

    const { rotas, achados } = await varrerVazamentos(admin, ids);
    // Percorreu de fato as telas de leitura do painel.
    expect(rotas).toBeGreaterThan(40);
    const tabelasVistas = new Set(achados.map((a) => a.tabela));
    // O próprio gestor vê clientes, pedidos e retiradas da empresa dele.
    expect(tabelasVistas).toContain('customers');
    expect(tabelasVistas).toContain('commercial_orders');
    expect(tabelasVistas).toContain('pickup_requests');
  });

  it('etapa 3: logado na empresa B, nenhuma rota de leitura mostra um dado da empresa A', async () => {
    const adminA = await loginAdmin(app);
    const customer = await createCustomer(adminA);
    const order = await createOrder(adminA, customer);
    await createPickup(adminA, order);
    const idsA = await idsDaEmpresa();

    const { client: adminB } = await criarEmpresaB();
    const { rotas, achados } = await varrerVazamentos(adminB, idsA);
    expect(rotas).toBeGreaterThan(40);
    expect(achados).toEqual([]);
  });

  it('etapa 3: rotas com parâmetro (/:id…) não entregam nada da empresa A para a empresa B', async () => {
    const adminA = await loginAdmin(app);
    const customer = await createCustomer(adminA);
    const order = await createOrder(adminA, customer);
    await createPickup(adminA, order);
    const idsA = await idsDaEmpresa();
    // Um id de cada tabela da empresa A, mais os usuários e funcionários (alvo comum de /:id).
    const amostra = new Map<string, string>();
    for (const [id, tabela] of idsA) if (!amostra.has(tabela)) amostra.set(tabela, id);
    const candidatos = [...amostra.values()];

    const varrer = async (client: Client) => {
      const vistos: string[] = [];
      let chamadas = 0;
      for (const url of paramRoutes()) {
        for (const id of candidatos) {
          const res = await client.get(url.replace(/:[A-Za-z]+/g, id));
          chamadas += 1;
          if (res.status !== 200) continue;
          for (const m of JSON.stringify(res.body).matchAll(UUID_RE)) {
            const tabela = idsA.get(m[0]);
            if (tabela) vistos.push(`${url} → ${tabela}`);
          }
        }
      }
      return { chamadas, vistos: [...new Set(vistos)] };
    };
    // Controle: o gestor da própria empresa A acha os dados dela por essas mesmas rotas.
    const controle = await varrer(adminA);
    expect(controle.vistos.length).toBeGreaterThan(5);

    const { client: adminB } = await criarEmpresaB();
    const b = await varrer(adminB);
    expect(b.chamadas).toBeGreaterThan(100);
    expect(b.vistos).toEqual([]);
  });

  it('etapa 3: a empresa A continua vendo tudo o que é dela depois que a B existe', async () => {
    const adminA = await loginAdmin(app);
    const customer = await createCustomer(adminA);
    await criarEmpresaB();
    const lista = await adminA.get('/api/v1/customers');
    expect(JSON.stringify(lista.body)).toContain(customer.id);
  });
});

/**
 * Empresa B: criada pelo "Criar conta" de verdade (etapa 4), que já entra logada como gestor da
 * empresa nova. Ganha um cliente próprio (o detector não pode confundir com os da A).
 */
async function criarEmpresaB() {
  const client = new Client(app);
  const r = await client.post('/api/auth/signup', {
    ...EMPRESA_NOVA,
    email: 'gestor@empresa-b.local',
    password: 'SenhaDaEmpresaB1',
    passwordConfirm: 'SenhaDaEmpresaB1',
  });
  if (r.status !== 201) throw new Error(`signup: ${JSON.stringify(r.body)}`);
  await createCustomer(client, { name: 'Cliente da B' });
  return { client };
}
