/**
 * Retrato da operação para o mapa: cada peça de OS aberta com a posição REPRESENTADA (etapa
 * registrada nas tarefas e na qualidade/expedição) e, separada, a posição FÍSICA confirmada
 * (item_location_events). Funcionários com a tarefa iniciada e a fila oficial (loadQueue).
 * Nada aqui decide regra: só lê os registros do Cenário Gestão.
 */
import {
  type GameEmployeeDto,
  type GamePieceDto,
  type GameSnapshotDto,
  type GameTaskRef,
  formatServiceOrderItemCode,
  furnitureModel,
  materialTone,
  placePiece,
} from '@cenario/shared';
import type { FastifyInstance } from 'fastify';
import { serviceOrderCode } from '../commercial/common';
import { loadQueue } from '../production/queue';
import { GAME_ACCESS, ensureDefaultSpaces, loadSpace, num } from './common';
import { now as clockNow } from '../../core/clock';

const GONE = ['ENTREGUE', 'DEVOLVIDA', 'CANCELADA'];
const taskCode = (n: number) => `TP-${String(n).padStart(5, '0')}`;
const ACTIVE = ['BLOQUEADA', 'PROGRAMADA', 'LIBERADA', 'EM_EXECUCAO', 'PAUSADA'];

export async function gameSnapshotRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;

  app.get(
    '/api/v1/game/snapshot',
    { config: { access: { ...GAME_ACCESS, anyPermissions: ['producao.ver', 'producao.planejar'] } } },
    async (request): Promise<GameSnapshotDto> => {
      await ensureDefaultSpaces(prisma);
      const perms = request.auth!.permissions;
      const [layout, head] = await Promise.all([
        loadSpace(prisma, 'TAPECARIA'),
        prisma.domainEvent.findFirst({ orderBy: { seq: 'desc' }, select: { seq: true } }),
      ]);
      const l = layout ?? { stations: [], areas: [] };
      const orders = await prisma.serviceOrder.findMany({
        where: { status: 'ABERTA' },
        include: {
          customer: { select: { name: true } },
          items: {
            orderBy: { position: 'asc' },
            include: {
              upholsterer: { select: { id: true, displayName: true } },
              currentLocation: true,
              locationEvents: {
                orderBy: { createdAt: 'desc' },
                take: 1,
                include: { location: true, actor: { select: { displayName: true } } },
              },
            },
          },
          productionTasks: {
            where: { status: { notIn: ['CANCELADA'] } },
            orderBy: [{ sequence: 'asc' }, { number: 'asc' }],
            include: { assignee: { select: { displayName: true } } },
          },
          productionPlanItems: { select: { id: true }, orderBy: { createdAt: 'desc' }, take: 1 },
        },
        orderBy: [{ priority: 'desc' }, { number: 'asc' }],
        take: 300,
      });
      const users = await prisma.employee.findMany({
        where: { active: true, user: { active: true } },
        include: { user: { include: { roles: { include: { role: true } } } } },
        orderBy: { displayName: 'asc' },
      });
      const names = Object.fromEntries(users.map((u) => [u.userId, u.displayName]));
      const itemIds = orders.flatMap((o) => o.items.map((i) => i.id));
      const photos = await prisma.attachment.groupBy({
        by: ['entityId'],
        where: {
          deletedAt: null,
          OR: [
            { entityType: 'SERVICE_ORDER', entityId: { in: orders.map((o) => o.id) } },
            { entityType: 'SERVICE_ORDER_ITEM', entityId: { in: itemIds } },
          ],
        },
        _count: { _all: true },
      });
      const photoCount = new Map(photos.map((p) => [p.entityId, p._count._all]));
      const areaByLocation = new Map(l.areas.filter((a) => a.itemLocationId).map((a) => [a.itemLocationId!, a.id]));

      const ref = (t: (typeof orders)[number]['productionTasks'][number]): GameTaskRef => ({
        id: t.id,
        code: taskCode(t.number),
        title: t.title,
        activity: t.activity,
        status: t.status,
        assigneeUserId: t.assigneeUserId,
        assigneeName: t.assignee?.displayName ?? null,
        version: t.version,
        startedAt: t.startedAt?.toISOString() ?? null,
        completedAt: t.completedAt?.toISOString() ?? null,
        blockers: t.blockers,
        planId: t.planId,
      });

      const pieces: GamePieceDto[] = [];
      for (const so of orders)
        for (const item of so.items) {
          if (GONE.includes(item.fulfillmentStage)) continue;
          // Tarefas da peça e da OS inteira (sem peça), na ordem da produção.
          const tasks = so.productionTasks.filter(
            (t) => t.serviceOrderItemId === item.id || t.serviceOrderItemId === null,
          );
          const refs = tasks.map(ref);
          const placement = placePiece(l, {
            stage: item.fulfillmentStage,
            tasks: refs.map((t) => ({
              id: t.id,
              activity: t.activity,
              status: t.status,
              assigneeUserId: t.assigneeUserId,
            })),
            names,
          });
          const current = refs.find((t) => t.status === 'EM_EXECUCAO' || t.status === 'PAUSADA') ?? null;
          const next =
            refs.find((t) => t.id !== current?.id && ['LIBERADA', 'PROGRAMADA', 'BLOQUEADA', 'RASCUNHO'].includes(t.status)) ??
            null;
          const ev = item.locationEvents[0];
          pieces.push({
            id: item.id,
            itemCode: formatServiceOrderItemCode(so.number, item.position),
            serviceOrderId: so.id,
            osCode: serviceOrderCode(so.number),
            osNumber: so.number,
            osVersion: so.version,
            customerName: perms.has('os.ver') || perms.has('clientes.ver') ? so.customer.name : null,
            description: item.description,
            pieceType: item.pieceType,
            model: furnitureModel(item.pieceType, item.description),
            quantity: item.quantity,
            serviceType: item.serviceType,
            fabric: [item.fabricName, item.fabricColor].filter(Boolean).join(' · ') || null,
            priority: so.priority,
            promisedDate: so.promisedDate?.toISOString().slice(0, 10) ?? null,
            stage: item.fulfillmentStage,
            readiness: so.materialsReadiness,
            tone: materialTone(so.materialsReadiness),
            upholstererUserId: item.upholstererUserId,
            upholstererName: item.upholsterer?.displayName ?? null,
            planned: so.productionPlanItems.length > 0,
            planItemId: so.productionPlanItems[0]?.id ?? null,
            tasks: refs,
            placement,
            currentTask: current,
            nextTask: next,
            confirmedLocation: ev
              ? {
                  label: ev.location.label,
                  areaId: areaByLocation.get(ev.locationId) ?? null,
                  at: ev.createdAt.toISOString(),
                  by: ev.actor?.displayName ?? null,
                }
              : null,
            photoCount: (photoCount.get(so.id) ?? 0) + (photoCount.get(item.id) ?? 0),
          });
        }

      // Funcionários: tarefa iniciada (qualquer tipo) e fila oficial da semana.
      const running = await prisma.productionTask.findMany({
        where: { status: { in: ['EM_EXECUCAO', 'PAUSADA'] }, assigneeUserId: { in: users.map((u) => u.userId) } },
        include: {
          assignee: { select: { displayName: true } },
          serviceOrder: { select: { number: true } },
          serviceOrderItem: { select: { position: true } },
        },
        orderBy: [{ status: 'asc' }, { startedAt: 'desc' }],
      });
      const s = await prisma.companySettings.findUnique({ where: { id: 1 } });
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: s?.timezone ?? 'America/Sao_Paulo' }).format(clockNow());
      const attendance = await prisma.operationalAttendance.findMany({
        where: { date: new Date(`${today}T00:00:00Z`), employeeId: { in: users.map((u) => u.id) } },
        select: { employeeId: true, situation: true },
      });
      const employees: GameEmployeeDto[] = [];
      for (const e of users) {
        const isProduction = e.user.roles.some((r) => ['tapeceiro', 'ajudante', 'cabeceiras_qualidade'].includes(r.role.key ?? ''));
        const stationIds = l.stations.filter((st) => st.assigneeUserIds.includes(e.userId)).map((st) => st.id);
        if (!isProduction && !stationIds.length) continue;
        const mine = running.filter((t) => t.assigneeUserId === e.userId);
        const cur = mine.find((t) => t.status === 'EM_EXECUCAO') ?? mine[0] ?? null;
        const q = await loadQueue(prisma, e.userId);
        const curRef = cur
          ? {
              ...ref({ ...cur, assignee: cur.assignee } as never),
              osCode: serviceOrderCode(cur.serviceOrder.number),
              itemCode: cur.serviceOrderItem ? formatServiceOrderItemCode(cur.serviceOrder.number, cur.serviceOrderItem.position) : null,
            }
          : null;
        const station = cur
          ? pieces.find((p) => p.currentTask?.id === cur.id)?.placement.stationId ??
            l.stations.find((st) => st.assigneeUserIds.includes(e.userId) && (st.activities.length === 0 || st.activities.includes(cur.activity)))?.id ??
            null
          : (stationIds[0] ?? null);
        employees.push({
          userId: e.userId,
          employeeId: e.id,
          name: e.displayName,
          color: e.color,
          roles: e.user.roles.map((r) => r.role.name),
          stationIds,
          currentTask: curRef,
          queue: q.items
            .filter((i) => ACTIVE.includes(i.task.status) && i.task.id !== cur?.id)
            .map((i) => ({
              id: i.task.id,
              code: i.task.code,
              title: i.task.title,
              activity: i.task.activity,
              status: i.task.status,
              assigneeUserId: e.userId,
              assigneeName: e.displayName,
              version: (i.task as unknown as { version: number }).version ?? 1,
              startedAt: i.task.startedAt,
              completedAt: i.task.completedAt,
              blockers: i.task.blockers,
              planId: i.task.plan?.id ?? null,
              osCode: i.task.serviceOrder.code,
              itemCode: i.task.serviceOrderItem?.code ?? null,
            })),
          attendance: attendance.find((a) => a.employeeId === e.id)?.situation ?? null,
          stationId: station,
          areaId: l.stations.find((st) => st.id === station)?.areaId ?? null,
        });
      }

      // Semáforo das posições de estoque: material abaixo do mínimo ou com OS aguardando.
      const slotAlerts: GameSnapshotDto['slotAlerts'] = {};
      const allSlots = (layout?.storageUnits ?? []).flatMap((u) => u.slots);
      const stockIds = [...new Set(allSlots.flatMap((sl) => sl.stockItemIds))];
      if (stockIds.length) {
        const items = await prisma.stockItem.findMany({ where: { id: { in: stockIds } } });
        for (const sl of allSlots) {
          let tone: 'FALTA' | 'BAIXO' | 'OK' = 'OK';
          for (const id of sl.stockItemIds) {
            const it = items.find((x) => x.id === id);
            if (!it) continue;
            const avail = num(it.onHand) - num(it.reserved);
            if (avail <= 0) tone = 'FALTA';
            else if (it.minQuantity !== null && avail < num(it.minQuantity) && tone !== 'FALTA') tone = 'BAIXO';
          }
          if (sl.stockItemIds.length) slotAlerts[sl.id] = tone;
        }
      }

      return {
        generatedAt: clockNow().toISOString(),
        lastSeq: head ? String(head.seq) : null,
        pieces,
        employees,
        slotAlerts,
        canPlan: perms.has('producao.planejar'),
        canExecuteStock: perms.has('estoque.gerenciar'),
      };
    },
  );
}
