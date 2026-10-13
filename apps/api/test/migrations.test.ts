import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Prisma } from '@cenario/db';
import { db, resetDatabase } from './helpers';

/** Separa os comandos de um script de reversão respeitando blocos $$ … $$ (sem BEGIN/COMMIT). */
function splitSql(sql: string): string[] {
  const statements: string[] = [];
  let cur = '';
  let quoted = false;
  for (const line of sql.replace(/--.*$/gm, '').split('\n')) {
    cur += line + '\n';
    quoted = quoted !== ((line.match(/\$\$/g) ?? []).length % 2 === 1);
    if (!quoted && line.trim().endsWith(';')) {
      const st = cur.trim().replace(/;$/, '');
      if (!/^(BEGIN|COMMIT)$/i.test(st)) statements.push(st);
      cur = '';
    }
  }
  return statements;
}

describe('Banco de dados e migrations', () => {
  beforeAll(resetDatabase);
  afterAll(async () => undefined);

  it('todas as migrations versionadas estão aplicadas no banco de teste criado do zero', () => {
    const out = execFileSync('pnpm', ['exec', 'prisma', 'migrate', 'status'], {
      cwd: resolve(__dirname, '../../../packages/db'),
      env: process.env,
      encoding: 'utf8',
    });
    expect(out).toContain('Database schema is up to date');
  });

  it('cria as tabelas fundamentais da Fase 1', async () => {
    const rows = await db().$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY tablename`;
    const names = rows.map((r) => r.tablename);
    for (const t of [
      'users',
      'employees',
      'roles',
      'role_permissions',
      'user_roles',
      'user_permissions',
      'devices',
      'sessions',
      'company_settings',
      'audit_logs',
      'domain_events',
      'event_consumers',
      'idempotency_keys',
      'auth_throttle',
      'stored_files',
      // Fase 2
      'customers',
      'customer_addresses',
      'commercial_orders',
      'commercial_order_items',
      'pickup_requests',
      'pickup_request_items',
      'pickup_events',
      'receipts',
      'receipt_lines',
      'service_orders',
      'service_order_items',
      'service_order_revisions',
      'material_requirements',
      'attachments',
      // Fase 3
      'measurements',
      'measurement_pieces',
      'material_requests',
      'material_request_items',
      'measurement_revisions',
      'suppliers',
      'purchase_orders',
      'purchase_order_items',
      'purchase_allocations',
      'purchase_order_history',
      'material_receipts',
      'material_receipt_lines',
      'material_receipt_reversals',
      'stock_items',
      'stock_movements',
      'stock_reservations',
      'material_leftovers',
      'material_leftover_transfers',
      'production_templates',
      'production_template_steps',
      'production_plans',
      'production_plan_items',
      'production_plan_revisions',
      'production_tasks',
      'production_task_dependencies',
      'production_task_events',
      'production_task_materials',
      'notifications',
      // Fase 10
      'quality_templates',
      'quality_template_items',
      'quality_inspections',
      'quality_inspection_items',
      'quality_events',
      'packaging_records',
      'item_locations',
      'item_location_events',
      'deliveries',
      'delivery_items',
      'delivery_events',
      'logistics_occurrences',
      'logistics_occurrence_events',
      'piece_returns',
      'piece_return_lines',
      'receipt_corrections',
      // Fase 11
      'commercial_adjustments',
      'customer_receivables',
      'customer_payments',
      'service_order_costs',
      'production_payables',
      'financial_adjustments',
      'professional_payments',
      'team_monthly_costs',
      'logistics_costs',
      'logistics_cost_allocations',
      'recurring_expenses',
      'operational_expenses',
      'account_payables',
      'payable_payments',
      'financial_events',
    ]) {
      expect(names).toContain(t);
    }
  });

  it('auditoria é imutável (UPDATE e DELETE bloqueados no banco)', async () => {
    const log = await db().auditLog.create({
      data: { action: 'teste', entityType: 'teste', summary: 'registro de teste' },
    });
    await expect(
      db().auditLog.update({ where: { id: log.id }, data: { summary: 'adulterado' } }),
    ).rejects.toThrow(/somente inserção/);
    await expect(db().auditLog.delete({ where: { id: log.id } })).rejects.toThrow(
      /somente inserção/,
    );
  });

  it('eventos de domínio não podem ser alterados', async () => {
    const e = await db().domainEvent.create({
      data: { type: 'sync.signal', aggregateType: 't', aggregateId: 't', payload: {} },
    });
    await expect(
      db().domainEvent.update({ where: { id: e.id }, data: { type: 'x' } }),
    ).rejects.toThrow(/somente inserção/);
  });

  it('restrições de integridade: configuração única, e-mail minúsculo, credencial de dispositivo', async () => {
    await expect(
      db().companySettings.create({ data: { id: 2, tradeName: 'Outra' } }),
    ).rejects.toThrow();
    await expect(
      db().user.create({ data: { displayName: 'X', email: 'Maiuscula@Teste.local' } }),
    ).rejects.toThrow();
    await expect(
      db().device.create({ data: { name: 'Sem credencial', status: 'ACTIVE' } }),
    ).rejects.toThrow();
    await expect(
      db().companySettings.update({ where: { id: 1 }, data: { workdayStart: '25:00' } }),
    ).rejects.toThrow();
  });

  it('Fase 2: restrições impedem recebimento acima do pedido e tecido fora da OS', async () => {
    const customer = await db().customer.create({
      data: { kind: 'PF', name: 'Teste', searchText: 'teste' },
    });
    const order = await db().commercialOrder.create({
      data: {
        customerId: customer.id,
        contractedService: 'Teste',
        items: { create: { position: 1, pieceType: 'SOFA', description: 'Sofá', quantity: 1 } },
      },
      include: { items: true },
    });
    await expect(
      db().commercialOrderItem.update({
        where: { id: order.items[0]!.id },
        data: { receivedQuantity: 2 },
      }),
    ).rejects.toThrow();
    await expect(
      db().customer.create({
        data: { kind: 'PF', name: 'Doc', searchText: 'doc', document: '123' },
      }),
    ).rejects.toThrow();
  });

  it('seed é idempotente e não cria credenciais para a equipe', async () => {
    const { runSeed } = await import('@cenario/db/seed');
    await runSeed({ withTeam: true, log: () => undefined });
    // Fase 10: + função de logística terceirizada, André e Izaías (sem credenciais).
    expect(await db().role.count()).toBe(5);
    expect(await db().employee.count()).toBe(7);
    const team = await db().user.findMany({ where: { email: null } });
    expect(team).toHaveLength(6);
    expect(await db().qualityTemplate.count()).toBe(4);
    expect(await db().itemLocation.count()).toBe(8);
    expect(team.every((u) => u.pinHash === null && u.passwordHash === null)).toBe(true);
  });

  it('estabilização da Fase 3: instalação existente passa a ter recebimentos.registrar nas funções da oficina (migration e reversão)', async () => {
    const DB = resolve(__dirname, '../../../packages/db');
    const NAME = '20261220000000_recebimentos_permissao_funcoes';
    const up = readFileSync(resolve(DB, `prisma/migrations/${NAME}/migration.sql`), 'utf8');
    const down = readFileSync(resolve(DB, `rollback/${NAME}.down.sql`), 'utf8');
    const KEYS = ['tapeceiro', 'cabeceiras_qualidade', 'ajudante'];
    const granted = async () =>
      (
        await db().rolePermission.findMany({
          where: { permission: 'recebimentos.registrar' },
          include: { role: { select: { key: true } } },
        })
      )
        .map((p) => p.role.key)
        .sort();
    // Instalação existente: funções já tinham permissões (o seed não as completa) e não tinham esta.
    const roles = await db().role.findMany({ where: { key: { in: KEYS } } });
    expect(roles).toHaveLength(3);
    await db().rolePermission.deleteMany({
      where: { permission: 'recebimentos.registrar', roleId: { in: roles.map((r) => r.id) } },
    });
    const custom = await db().role.create({
      data: {
        key: 'funcao_personalizada',
        name: 'Personalizada',
        description: 'teste',
        system: false,
      },
    });
    expect(await granted()).toEqual(['gestor']);
    const others = await db().rolePermission.count({
      where: { permission: { not: 'recebimentos.registrar' } },
    });
    // Migration: concede às três funções; repetir não duplica; nada mais muda.
    await db().$executeRawUnsafe(up);
    await db().$executeRawUnsafe(up);
    expect(await granted()).toEqual(['ajudante', 'cabeceiras_qualidade', 'gestor', 'tapeceiro']);
    expect(await db().rolePermission.count({ where: { roleId: custom.id } })).toBe(0);
    expect(
      await db().rolePermission.count({ where: { permission: { not: 'recebimentos.registrar' } } }),
    ).toBe(others);
    // Reversão (executada numa transação desfeita no fim, para não alterar o banco de teste).
    const statements = down
      .split(';')
      .map((st) => st.replace(/--.*$/gm, '').trim())
      .filter((st) => st && !/^(BEGIN|COMMIT)$/i.test(st));
    expect(statements).toHaveLength(2);
    await expect(
      db().$transaction(async (tx) => {
        for (const st of statements) await tx.$executeRawUnsafe(st);
        const left = await tx.rolePermission.findMany({
          where: { permission: 'recebimentos.registrar' },
          include: { role: { select: { key: true } } },
        });
        expect(left.map((p) => p.role.key)).toEqual(['gestor']);
        expect(
          await tx.$queryRawUnsafe<{ n: bigint }[]>(
            `SELECT count(*) AS n FROM "_prisma_migrations" WHERE "migration_name" = '${NAME}'`,
          ),
        ).toEqual([{ n: 0n }]);
        throw new Error('desfazer');
      }),
    ).rejects.toThrow('desfazer');
    expect(await granted()).toEqual(['ajudante', 'cabeceiras_qualidade', 'gestor', 'tapeceiro']);
    await db().role.delete({ where: { id: custom.id } });
  });
  it('estabilização da Fase 2: pedido "cliente entrega" (migration aditiva e reversão condicionada)', async () => {
    const DB = resolve(__dirname, '../../../packages/db');
    const NAME = '20261227000000_servico_sem_retirada';
    const up = readFileSync(resolve(DB, `prisma/migrations/${NAME}/migration.sql`), 'utf8');
    const down = readFileSync(resolve(DB, `rollback/${NAME}.down.sql`), 'utf8');
    const statements = splitSql(down);
    expect(statements).toHaveLength(3);
    const column = (tx: Pick<Prisma.TransactionClient, '$queryRawUnsafe'>) =>
      tx.$queryRawUnsafe<{ default: string | null; nullable: string }[]>(
        `SELECT column_default AS "default", is_nullable AS nullable FROM information_schema.columns
          WHERE table_name = 'commercial_orders' AND column_name = 'customer_drop_off'`,
      );
    expect(await column(db())).toEqual([{ default: 'false', nullable: 'NO' }]);
    const customer = await db().customer.create({
      data: { kind: 'PF', name: 'Cliente Migração', searchText: 'cliente migracao' },
    });
    const order = await db().commercialOrder.create({
      data: { customerId: customer.id, contractedService: 'Reforma' },
    });
    // Pedido anterior à migration (sem a informação) fica como "aguardando retirada" (false).
    expect(order.customerDropOff).toBe(false);
    const run = async (tx: Prisma.TransactionClient) => {
      for (const st of statements) await tx.$executeRawUnsafe(st);
    };
    // Reversão sem pedidos "cliente entrega": remove a coluna e o registro; reaplicar funciona.
    await expect(
      db().$transaction(async (tx) => {
        await run(tx);
        expect(await column(tx)).toEqual([]);
        expect(
          await tx.$queryRawUnsafe<{ n: bigint }[]>(
            `SELECT count(*) AS n FROM "_prisma_migrations" WHERE "migration_name" = '${NAME}'`,
          ),
        ).toEqual([{ n: 0n }]);
        await tx.$executeRawUnsafe(up);
        expect(await column(tx)).toEqual([{ default: 'false', nullable: 'NO' }]);
        throw new Error('desfazer');
      }),
    ).rejects.toThrow('desfazer');
    // Com um pedido "cliente entrega", a reversão é bloqueada (a informação se perderia).
    await db().commercialOrder.update({ where: { id: order.id }, data: { customerDropOff: true } });
    await expect(db().$transaction(async (tx) => run(tx))).rejects.toThrow(
      /Reversão bloqueada: 1 pedido/,
    );
    expect(await column(db())).toEqual([{ default: 'false', nullable: 'NO' }]);
    expect(
      (await db().commercialOrder.findUniqueOrThrow({ where: { id: order.id } })).customerDropOff,
    ).toBe(true);
  });
  it('estabilização da Fase 2: titular e mão de obra previstos (CHECK, migration e reversão condicionada)', async () => {
    const DB = resolve(__dirname, '../../../packages/db');
    const NAME = '20261228000000_titular_mao_de_obra_prevista';
    const up = splitSql(
      readFileSync(resolve(DB, `prisma/migrations/${NAME}/migration.sql`), 'utf8'),
    );
    const down = splitSql(readFileSync(resolve(DB, `rollback/${NAME}.down.sql`), 'utf8'));
    expect(down).toHaveLength(7);
    const columns = (tx: Pick<Prisma.TransactionClient, '$queryRawUnsafe'>) =>
      tx.$queryRawUnsafe<{ name: string }[]>(
        `SELECT column_name AS name FROM information_schema.columns
          WHERE table_name = 'commercial_order_items' AND column_name LIKE 'planned_%' ORDER BY 1`,
      );
    expect(await columns(db())).toEqual([
      { name: 'planned_labor_unit_cents' },
      { name: 'planned_upholsterer_user_id' },
    ]);
    const customer = await db().customer.create({
      data: { kind: 'PF', name: 'Cliente Intenção', searchText: 'cliente intencao' },
    });
    const order = await db().commercialOrder.create({
      data: {
        customerId: customer.id,
        contractedService: 'Reforma',
        items: { create: [{ position: 1, pieceType: 'SOFA', description: 'Sofá', quantity: 1 }] },
      },
      include: { items: true },
    });
    const item = order.items[0]!;
    // Item anterior à migration: sem intenção.
    expect(item).toMatchObject({ plannedUpholstererUserId: null, plannedLaborUnitCents: null });
    // CHECK: mão de obra sem titular, ou não positiva, é recusada pelo próprio banco.
    const owner = (await db().user.findFirstOrThrow({ where: { displayName: 'Ricardo' } })).id;
    await expect(
      db().commercialOrderItem.update({
        where: { id: item.id },
        data: { plannedLaborUnitCents: 1000 },
      }),
    ).rejects.toThrow(/planned_labor_ck/);
    await expect(
      db().commercialOrderItem.update({
        where: { id: item.id },
        data: { plannedUpholstererUserId: owner, plannedLaborUnitCents: 0 },
      }),
    ).rejects.toThrow(/planned_labor_ck/);
    const run = async (tx: Prisma.TransactionClient, sql: string[]) => {
      for (const st of sql) await tx.$executeRawUnsafe(st);
    };
    // Sem intenção registrada: a reversão remove tudo; reaplicar a migration funciona.
    await expect(
      db().$transaction(async (tx) => {
        await run(tx, down);
        expect(await columns(tx)).toEqual([]);
        expect(
          await tx.$queryRawUnsafe<{ n: bigint }[]>(
            `SELECT count(*) AS n FROM "_prisma_migrations" WHERE "migration_name" = '${NAME}'`,
          ),
        ).toEqual([{ n: 0n }]);
        await run(tx, up);
        expect(await columns(tx)).toHaveLength(2);
        throw new Error('desfazer');
      }),
    ).rejects.toThrow('desfazer');
    // Com intenção registrada: a reversão é bloqueada (a intenção se perderia).
    await db().commercialOrderItem.update({
      where: { id: item.id },
      data: { plannedUpholstererUserId: owner, plannedLaborUnitCents: 1000 },
    });
    await expect(db().$transaction(async (tx) => run(tx, down))).rejects.toThrow(
      /Reversão bloqueada: 1 item/,
    );
    expect(await columns(db())).toHaveLength(2);
  });
});
