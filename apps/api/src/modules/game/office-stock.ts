/**
 * Material acabando (Compras, 2026-11-25): compara o estoque da oficina com o que as OS abertas
 * ainda vão usar (materiais ligados ao item do estoque, marcados como "já na oficina" e ainda não
 * comprados). Se não dá para todas, avisa no sininho quanto falta e para quais OS. Um aviso por
 * material por semana; some sozinho quando o estoque volta a dar.
 */
import { plural } from '@cenario/shared';
import type { PrismaClient } from '@cenario/db';
import type { ActorContext } from '../../core/types';
import { serviceOrderCode } from '../commercial/common';
import { resolveNotifications } from '../notifications/notify';
import { notifyUsersWith } from '../quality/common';

const SYSTEM: ActorContext = { userId: null, sessionId: null, ip: null, requestId: null };

export interface StockShortage {
  itemId: string;
  name: string;
  unit: string;
  stock: number;
  needed: number;
  osCodes: string[];
}

const fmt = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 2 });

export async function stockShortages(db: PrismaClient): Promise<StockShortage[]> {
  const rows = await db.serviceOrderMaterial.findMany({
    where: {
      removedAt: null,
      purchased: false,
      available: true,
      inventoryItemId: { not: null },
      quantity: { not: null },
      serviceOrder: { status: 'ABERTA' },
      inventoryItem: { archivedAt: null },
    },
    include: {
      inventoryItem: { select: { id: true, name: true, unit: true, quantity: true } },
      serviceOrder: { select: { number: true } },
    },
    take: 1000,
  });
  const by = new Map<string, StockShortage>();
  for (const r of rows) {
    const it = r.inventoryItem!;
    // Unidade diferente da do estoque: não dá para comparar, fica de fora.
    if (r.unit && r.unit.trim().toLowerCase() !== it.unit.trim().toLowerCase()) continue;
    const s = by.get(it.id) ?? {
      itemId: it.id,
      name: it.name,
      unit: it.unit,
      stock: Number(it.quantity),
      needed: 0,
      osCodes: [],
    };
    s.needed += Number(r.quantity);
    const code = serviceOrderCode(r.serviceOrder.number);
    if (!s.osCodes.includes(code)) s.osCodes.push(code);
    by.set(it.id, s);
  }
  return [...by.values()]
    .filter((s) => s.needed > s.stock + 1e-9)
    .sort((a, b) => b.needed - b.stock - (a.needed - a.stock));
}

/** Avisa no sininho cada material que não dá para as OS abertas (e resolve os que voltaram a dar). */
export async function stockShortageNotices(prisma: PrismaClient, today: string) {
  const list = await stockShortages(prisma);
  const week = `${today.slice(0, 4)}-${Math.floor((Date.parse(`${today}T12:00:00Z`) / 86_400_000 + 3) / 7)}`;
  await prisma.$transaction(async (tx) => {
    const open = await tx.notification.findMany({
      where: { kind: 'MATERIAL_ACABANDO', resolvedAt: null },
      select: { dedupeKey: true },
    });
    const still = new Set(list.map((s) => s.itemId));
    const gone = [
      ...new Set(
        open
          .map((n) => n.dedupeKey?.split(':')[1])
          .filter((id): id is string => !!id && !still.has(id)),
      ),
    ];
    for (const id of gone)
      await resolveNotifications(tx, SYSTEM, 'MATERIAL_ACABANDO', [`MATERIAL_ACABANDO:${id}`]);
    for (const s of list.slice(0, 10))
      await notifyUsersWith(
        tx,
        SYSTEM,
        'estoque.ver',
        'MATERIAL_ACABANDO',
        `MATERIAL_ACABANDO:${s.itemId}:${week}`,
        `${s.name}: tem ${fmt(s.stock)} ${s.unit} no estoque e as OS abertas pedem ${fmt(s.needed)} ${s.unit} (${s.osCodes.slice(0, 4).join(', ')}${s.osCodes.length > 4 ? ` e mais ${plural(s.osCodes.length - 4, 'OS', 'OS')}` : ''}). Faltam ${fmt(s.needed - s.stock)} ${s.unit}.`.slice(
          0,
          300,
        ),
      );
  });
  return list.length;
}
