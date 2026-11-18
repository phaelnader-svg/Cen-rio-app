import { Prisma, TENANCY, scopedPrismaClient, type Tx } from '@cenario/db';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../src/app';
import { FAKE_CPF, createCustomer, createOrder } from './commercial-helpers';
import { createTestApp, db, loginAdmin, ownerDb, rawDb, resetDatabase } from './helpers';

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
  'quote_settings_pkey', // id automático (uma linha por empresa, UNIQUE company_id)
  'integration_oauth_states_pkey', // "state" aleatório da autorização OAuth
  // Ids gerados pelo provedor externo (assinatura, cobrança, nota, pagamento): únicos no mundo.
  'contracts_provider_envelope_id_key',
  'payment_charges_provider_charge_id_key',
  'fiscal_documents_provider_ref_key',
  'payment_orders_provider_ref_key',
  // Cobrança e e-mails (2026-11-17): id da cobrança no Asaas e hash do link enviado por e-mail.
  'subscription_invoices_external_id_key',
  'email_tokens_token_hash_key',
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
      SELECT conrelid::regclass::text AS table_name FROM pg_constraint
       WHERE contype = 'f' AND confrelid = 'company_settings'::regclass
         AND conname LIKE '%company_id_fkey'`;
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
    // 167: + feedback_reports (melhorias rodada 2).
    // 168: + expense_categories (despesas, prazos e alertas).
    expect(tabelasComEmpresa.length).toBe(168);
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
      if (!alvo.has(i.tablename)) continue;
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

  it('etapa 3: sem empresa definida, o banco não mostra nada e não grava nada', async () => {
    const admin = await loginAdmin(app);
    await createCustomer(admin);
    const semEmpresa = scopedPrismaClient(rawDb(), () => ({ companyId: null, bypass: false }));
    expect(await semEmpresa.customer.count()).toBe(0);
    expect(await semEmpresa.user.count()).toBe(0);
    const viaSql = await semEmpresa.$queryRaw<
      { n: bigint }[]
    >`SELECT COUNT(*)::bigint AS n FROM customers`;
    expect(viaSql[0]!.n).toBe(0n);
    await expect(
      semEmpresa.customer.create({ data: { kind: 'PF', name: 'Sem dono', searchText: 'x' } }),
    ).rejects.toThrow();
  });

  it('etapa 3: a empresa 2 não vê, não altera e não grava na empresa 1 — nem por SQL direto', async () => {
    const admin = await loginAdmin(app);
    const c1 = await createCustomer(admin);
    await db().companySettings.create({ data: { id: 2, tradeName: 'Tapeçaria Exemplo' } });
    const empresa2 = scopedPrismaClient(rawDb(), () => ({ companyId: 2, bypass: false }));

    expect(await empresa2.customer.findUnique({ where: { id: c1.id } })).toBeNull();
    expect(await empresa2.customer.count()).toBe(0);
    const viaSql = await empresa2.$queryRawUnsafe<{ n: bigint }[]>(
      'SELECT COUNT(*)::bigint AS n FROM customers WHERE id = $1::uuid',
      c1.id,
    );
    expect(viaSql[0]!.n).toBe(0n);
    const alterou = await empresa2.customer.updateMany({
      where: { id: c1.id },
      data: { name: 'Invadido' },
    });
    expect(alterou.count).toBe(0);
    const apagou = await empresa2.$executeRawUnsafe(
      'DELETE FROM customers WHERE id = $1::uuid',
      c1.id,
    );
    expect(apagou).toBe(0);
    await expect(
      empresa2.customer.create({
        data: { companyId: 1, kind: 'PF', name: 'Plantado', searchText: 'x' },
      }),
    ).rejects.toThrow();
    // A empresa 2 enxerga só a si mesma na tabela de empresas.
    expect((await empresa2.companySettings.findMany()).map((c) => c.id)).toEqual([2]);

    const intacto = await db().customer.findUniqueOrThrow({ where: { id: c1.id } });
    expect(intacto.name).toBe(c1.name);
    expect(intacto.companyId).toBe(1);
  });

  it('etapa 3: a API trabalha com o papel cenario_app, sem superusuário nem BYPASSRLS', async () => {
    const rows = await db().$queryRaw<{ u: string; s: boolean; b: boolean }[]>`
      SELECT current_user AS u, r.rolsuper AS s, r.rolbypassrls AS b
        FROM pg_roles r WHERE r.rolname = current_user`;
    expect(rows).toEqual([{ u: 'cenario_app', s: false, b: false }]);
  });

  it('etapa 3: depois de restaurar um backup sem GRANTs, a API refaz os privilégios ao iniciar', async () => {
    await ownerDb().$executeRawUnsafe('REVOKE ALL ON "customers" FROM cenario_app');
    await expect(db().customer.count()).rejects.toThrow(/permission denied/);
    const outra = await createTestApp();
    await outra.close();
    expect(await db().customer.count()).toBeGreaterThanOrEqual(0);
  });
});
