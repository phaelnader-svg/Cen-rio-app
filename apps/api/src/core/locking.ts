import type { Tx } from '@cenario/db';
import { Prisma } from '@cenario/db';

const LOCKABLE = new Set(['employees', 'roles', 'devices', 'company_settings', 'users']);

/**
 * Bloqueia a linha (SELECT ... FOR UPDATE) até o fim da transação. Usado antes
 * da verificação de versão para que a comparação e a gravação sejam atômicas.
 */
export async function lockRow(tx: Tx, table: string, id: string | number): Promise<boolean> {
  if (!LOCKABLE.has(table)) throw new Error(`Tabela não bloqueável: ${table}`);
  const rows = await tx.$queryRaw<{ id: unknown }[]>(
    Prisma.sql`SELECT id FROM ${Prisma.raw(`"${table}"`)} WHERE id = ${
      typeof id === 'number' ? id : Prisma.sql`${id}::uuid`
    } FOR UPDATE`,
  );
  return rows.length > 0;
}
