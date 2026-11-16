import { Prisma, TENANCY, type Tx } from '@cenario/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { FAKE_CPF, createCustomer, createOrder } from './commercial-helpers';
import { createTestApp, db, loginAdmin, resetDatabase } from './helpers';

/**
 * Multi-empresa — etapa 2: o banco sabe de quem é cada linha.
 *
 * Confere no próprio Postgres (não só no schema do Prisma) que toda tabela de empresa tem
 * company_id obrigatório e ligado à tabela de empresas, que nenhuma unicidade impede duas empresas
 * de terem o mesmo nome/número, e que a numeração recomeça em cada empresa.
 */
let app: App;
beforeAll(async () => {
  app = await createTestApp();
  await app.app.ready();
});
afterAll(() => app.close());
beforeEach(resetDatabase);

const tabela = (model: string) =>
  Prisma.dmmf.datamodel.models.find((m) => m.name === model)!.dbName ?? model;
const tabelasComEmpresa = Object.entries(TENANCY)
  .filter(([, e]) => e.class === 'empresa' || e.class === 'acesso')
  .map(([n]) => tabela(n));

/** Unicidades que continuam valendo no sistema inteiro, de propósito. */
const UNICAS_NO_SISTEMA = new Set([
  'users_email_key', // um e-mail pertence a uma única empresa
  'sessions_token_hash_key',
  'devices_credential_hash_key',
  'devices_pairing_code_hash_key',
  'oauth_codes_code_hash_key',
  'oauth_grants_refresh_hash_key',
  'oauth_access_tokens_token_hash_key',
  'stored_files_storage_key_key', // caminho no disco; ganha prefixo da empresa na etapa 3
  'stored_files_thumb_key_key',
  'service_order_costs_source_key_key', // montado com UUIDs
  'reschedule_proposals_dedupe_key_key', // montado com UUIDs
  'company_counters_pkey',
  'domain_events_seq_key', // posição técnica na fila de eventos
]);

/** Roda `fn` como se a requisição fosse da empresa `companyId` (o que a etapa 3 fará sozinha). */
function comoEmpresa<T>(companyId: number, fn: (tx: Tx) => Promise<T>) {
  return db().$transaction(async (tx) => {
    await tx.$executeRaw`SELECT set_config('app.company_id', ${String(companyId)}, true)`;
    return fn(tx);
  });
}

describe('Multi-empresa: banco', () => {
  it('toda tabela de empresa tem company_id obrigatório, com padrão da transação e FK', async () => {
    const cols = await db().$queryRaw<
      { table_name: string; is_nullable: string; column_default: string | null }[]
    >`SELECT table_name, is_nullable, column_default FROM information_schema.columns
       WHERE table_schema = 'public' AND column_name = 'company_id'`;
    const fks = await db().$queryRaw<{ table_name: string }[]>`
      SELECT tc.table_name FROM information_schema.table_constraints tc
        JOIN information_schema.constraint_column_usage cu USING (constraint_name, table_schema)
       WHERE tc.table_schema = 'public' AND tc.constraint_type = 'FOREIGN KEY'
         AND cu.table_name = 'company_settings' AND tc.constraint_name LIKE '%company_id_fkey'`;
    const porTabela = new Map(cols.map((c) => [c.table_name, c]));
    const comFk = new Set(fks.map((f) => f.table_name));
    const problemas: string[] = [];
    for (const t of tabelasComEmpresa) {
      const c = porTabela.get(t);
      if (!c) problemas.push(`${t}: sem company_id`);
      else {
        if (c.is_nullable !== 'NO') problemas.push(`${t}: company_id aceita vazio`);
        if (c.column_default !== 'app_company_id()')
          problemas.push(`${t}: padrão ${c.column_default}`);
      }
      if (!comFk.has(t)) problemas.push(`${t}: sem FK para company_settings`);
    }
    expect(problemas).toEqual([]);
    expect(tabelasComEmpresa.length).toBe(129);
  });

  it('nenhuma unicidade de tabela de empresa vale no sistema inteiro sem motivo', async () => {
    const idx = await db().$queryRaw<{ tablename: string; indexname: string; indexdef: string }[]>`
      SELECT tablename, indexname, indexdef FROM pg_indexes
       WHERE schemaname = 'public' AND indexdef LIKE 'CREATE UNIQUE%'`;
    const uuidCols = await db().$queryRaw<{ table_name: string; column_name: string }[]>`
      SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND data_type = 'uuid'`;
    const uuids = new Set(uuidCols.map((c) => `${c.table_name}.${c.column_name}`));
    const alvo = new Set(tabelasComEmpresa);
    const problemas: string[] = [];
    for (const i of idx) {
      if (!alvo.has(i.tablename) || i.indexname.endsWith('_pkey')) continue;
      if (UNICAS_NO_SISTEMA.has(i.indexname)) continue;
      const colunas = /\((.*)\)/.exec(i.indexdef.split(' USING ')[1] ?? '')?.[1] ?? '';
      if (/\bcompany_id\b/.test(colunas)) continue;
      // Presa a um registro (ex.: item da OS, tarefa): já é de uma empresa só.
      const nomes = colunas.match(/[a-z_]+/g) ?? [];
      if (nomes.some((n) => uuids.has(`${i.tablename}.${n}`))) continue;
      problemas.push(`${i.indexname}: ${colunas}`);
    }
    expect(problemas).toEqual([]);
  });

  it('dados existentes e criados sem empresa definida ficam na empresa 1 (Cenário Estofados)', async () => {
    const admin = await loginAdmin(app);
    const customer = await createCustomer(admin);
    const row = await db().customer.findUniqueOrThrow({ where: { id: customer.id } });
    expect(row.companyId).toBe(1);
    const company = await db().companySettings.findUniqueOrThrow({ where: { id: 1 } });
    expect(company.tradeName).toBe('Cenário Estofados');
    const outras = await db().$queryRaw<{ n: bigint }[]>`
      SELECT COUNT(*)::bigint AS n FROM users WHERE company_id <> 1`;
    expect(outras[0]!.n).toBe(0n);
  });

  it('a numeração e os nomes únicos recomeçam em cada empresa', async () => {
    const admin = await loginAdmin(app);
    const c1 = await createCustomer(admin, { document: FAKE_CPF[0] });
    const o1 = await createOrder(admin, c1);
    const o1b = await createOrder(admin, c1);
    expect([o1.number, o1b.number]).toEqual([1, 2]);

    const nova = await db().companySettings.create({ data: { tradeName: 'Tapeçaria Exemplo' } });
    expect(nova.id).toBe(2);
    const o2 = await comoEmpresa(nova.id, async (tx) => {
      // Mesmo CPF e mesmo nome de função: permitidos, porque são de outra empresa.
      const c2 = await tx.customer.create({
        data: { kind: 'PF', name: 'Cliente da outra', document: FAKE_CPF[0], searchText: 'x' },
      });
      await tx.role.create({ data: { key: 'gestor', name: 'Gestor', system: true } });
      return tx.commercialOrder.create({
        data: { customerId: c2.id, contractedService: 'Reforma' },
      });
    });
    expect(o2.companyId).toBe(2);
    expect(o2.number).toBe(1);

    // A empresa 1 continua a própria sequência.
    const o1c = await createOrder(admin, c1);
    expect(o1c.number).toBe(3);

    // Dentro da mesma empresa as regras continuam valendo.
    await expect(
      comoEmpresa(nova.id, (tx) =>
        tx.role.create({ data: { key: 'gestor', name: 'Outro gestor', system: false } }),
      ),
    ).rejects.toThrow();
  });

  it('a numeração da empresa 1 continua de onde parou (não volta para 1)', async () => {
    const admin = await loginAdmin(app);
    const c1 = await createCustomer(admin);
    await createOrder(admin, c1);
    await createOrder(admin, c1);
    const rows = await db().$queryRaw<{ last_value: number }[]>`
      SELECT last_value FROM company_counters WHERE company_id = 1 AND key = 'commercial_orders'`;
    expect(rows.map((r) => r.last_value)).toEqual([2]);
  });
});
