import { Prisma, TENANCY } from '@cenario/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import type { AccessRule } from '../src/core/types';
import { createCustomer, createOrder, createPickup } from './commercial-helpers';
import { type Client, createTestApp, db, loginAdmin, resetDatabase } from './helpers';

/**
 * Multi-empresa — detector de vazamento entre empresas.
 *
 * Coleta os ids de TODAS as linhas das tabelas de empresa (mapa em packages/db/src/tenancy.ts) e
 * percorre as rotas de leitura da API procurando qualquer um deles na resposta.
 *
 * Etapa 1 (agora): só existe uma empresa. O teste prova que o detector ENXERGA os dados quando
 * eles estão visíveis — o gestor da própria empresa vê os próprios registros. Sem isso, um teste
 * de "zero vazamentos" poderia passar só por estar cego.
 * Etapa 3: o mesmo detector roda logado na empresa B contra os ids da empresa A e precisa achar
 * zero (o `it.todo` abaixo vira teste de verdade).
 */
let app: App;
beforeAll(async () => {
  app = await createTestApp();
  await app.app.ready();
});
afterAll(() => app.close());
beforeEach(resetDatabase);

type Route = { method: string; url: string; access: AccessRule };

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

  it.todo('etapa 3: logado na empresa B, nenhuma rota mostra um id da empresa A');
  it.todo('etapa 3: rotas com parâmetro (/:id) respondem 404 para ids da empresa A');
});
