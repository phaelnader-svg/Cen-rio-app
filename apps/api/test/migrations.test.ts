import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db, resetDatabase } from './helpers';

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
});
