import {
  ARRIVAL_PROBLEM_LABEL,
  EVENT_TYPES,
  MATERIAL_UNIT_LABEL,
  PHYSICAL_UNIT_LABEL,
  confirmMaterialArrivalSchema,
  confirmPieceArrivalSchema,
  materialReceiptCode,
  purchaseOrderCode,
  type ArrivalConfirmationDto,
  type ArrivalsDto,
  type MaterialArrivalDto,
  type MaterialArrivalDueDto,
  type MaterialUnit,
  type PieceArrivalDto,
  type PieceArrivalStage,
  type ReceiptIssue,
} from '@cenario/shared';
import type { Prisma, PrismaClient, Tx } from '@cenario/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorFrom, audit } from '../../core/audit';
import { shortCustomerName } from '../../core/device-privacy';
import { appendEvent } from '../../core/events/append';
import { Errors } from '../../lib/errors';
import {
  dateOnly,
  orderCode,
  pickupCode,
  receiptCode,
  serviceOrderCode,
} from '../commercial/common';
import { todayIso } from '../finance/common';
import { lockPurchaseOrder } from '../purchasing/purchase-orders';
import { registerMaterialReceipt } from '../purchasing/receipts';
import { pickupBalance, registerReceipt } from '../receipts/service';

/**
 * Simplificação Fase 3 — "Aguardando chegada": central COMPARTILHADA (uma lista para todos os
 * autorizados, não uma fila por pessoa) e confirmação rápida. Não é um segundo sistema de
 * recebimentos: as confirmações chamam os mesmos serviços do painel (`registerReceipt`,
 * `registerMaterialReceipt`), agora com versão esperada (concorrência otimista).
 *
 * Privacidade: nenhum valor comercial, custo, mão de obra ou pagamento; no tablet o cliente
 * aparece como "Primeiro I.". Nenhum aviso de atraso: o horário da retirada é a CHEGADA AO
 * CLIENTE, não à oficina.
 */
const PIECES = { session: 'any', permissions: ['recebimentos.registrar'] } as const;
/** Mesma regra existente do recebimento de materiais: qualquer funcionário. */
const ANY = { session: 'any' } as const;
const ARRIVALS_VIEW = { session: 'any' } as const;
const CONFERENCE_VIEW = {
  session: 'WEB',
  anyPermissions: ['estoque.ver', 'compras.ver', 'estoque.gerenciar'],
} as const;

const PIECE_STATUSES = ['AGENDADA', 'EM_EXECUCAO', 'RETIRADA_REALIZADA', 'COM_OCORRENCIA'] as const;
const DECIMAL_UNITS: MaterialUnit[] = ['METRO', 'METRO_QUADRADO'];
const DEFAULT_LOCATION = 'Área de recebimento';
const arrivalCode = (n: number) => `CH-${String(n).padStart(5, '0')}`;
const num = (v: unknown) => Number(v ?? 0);

function nowHm(timeZone = 'America/Sao_Paulo') {
  return new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone }).format(
    new Date(),
  );
}

async function pieceArrivals(db: PrismaClient | Tx, device: boolean): Promise<PieceArrivalDto[]> {
  const today = todayIso();
  const pickups = await db.pickupRequest.findMany({
    where: {
      status: { in: [...PIECE_STATUSES] },
      order: { status: { not: 'CANCELADO' } },
      OR: [
        { status: { not: 'AGENDADA' } },
        { scheduledDate: { lte: new Date(`${today}T00:00:00Z`) } },
      ],
    },
    include: {
      order: { include: { customer: { select: { name: true } } } },
      items: { include: { orderItem: true }, orderBy: { orderItem: { position: 'asc' } } },
      receipts: { select: { id: true } },
    },
    orderBy: [{ scheduledDate: 'asc' }, { windowStart: 'asc' }],
  });
  const now = nowHm();
  const out: PieceArrivalDto[] = [];
  for (const p of pickups) {
    const balance = await pickupBalance(db as Tx, p.id);
    const items = p.items
      .map((i) => ({
        orderItemId: i.orderItemId,
        pieceType: i.orderItem.pieceType,
        description: i.orderItem.description,
        // Nunca acima do que falta no pedido (outra via pode ter recebido a peça).
        pending: Math.min(
          balance.get(i.orderItemId) ?? 0,
          i.orderItem.quantity - i.orderItem.receivedQuantity,
        ),
      }))
      .filter((i) => i.pending > 0);
    if (!items.length) continue;
    let stage: PieceArrivalStage;
    let stageLabel: string;
    if (p.status === 'AGENDADA') {
      const reached = Boolean(p.windowStart && now >= p.windowStart);
      stage = reached ? 'RETIRADA_PREVISTA' : 'RETIRADA_HOJE';
      stageLabel = reached
        ? `Retirada prevista — equipe no cliente a partir das ${p.windowStart}`
        : `Retirada de hoje — chegada ao cliente ${p.windowStart ?? 'a combinar'}`;
    } else if (p.status === 'EM_EXECUCAO') {
      stage = 'EM_COLETA';
      stageLabel = 'Em coleta no cliente';
    } else if (p.status === 'COM_OCORRENCIA') {
      stage = 'COM_OCORRENCIA';
      stageLabel = 'Retirada com ocorrência';
    } else if (p.receipts.length) {
      stage = 'CHEGOU_EM_PARTE';
      stageLabel = 'Chegou em parte — aguardando o restante';
    } else {
      stage = 'A_CAMINHO';
      stageLabel = 'A caminho da oficina';
    }
    out.push({
      pickupId: p.id,
      pickupCode: pickupCode(p.number),
      orderId: p.orderId,
      orderCode: orderCode(p.order.number),
      customerName: device ? shortCustomerName(p.order.customer.name) : p.order.customer.name,
      stage,
      stageLabel,
      scheduledDate: dateOnly(p.scheduledDate),
      windowStart: p.windowStart,
      items,
      pendingTotal: items.reduce((a, i) => a + i.pending, 0),
      version: p.version,
    });
  }
  return out;
}

/** Itens (de qualquer pedido) com chegada física ainda aguardando conferência. */
async function itemsAwaitingConference(db: PrismaClient | Tx, poIds: string[]) {
  const rows = await db.materialArrival.findMany({
    where: { purchaseOrderId: { in: poIds }, status: 'PENDENTE_CONFERENCIA' },
  });
  const items = new Set<string>();
  const perPo = new Map<string, number>();
  for (const r of rows) {
    perPo.set(r.purchaseOrderId, (perPo.get(r.purchaseOrderId) ?? 0) + 1);
    for (const l of r.lines as { purchaseOrderItemId: string }[]) items.add(l.purchaseOrderItemId);
  }
  return { items, perPo };
}

async function materialArrivals(db: PrismaClient | Tx): Promise<MaterialArrivalDueDto[]> {
  const today = todayIso();
  const pos = await db.purchaseOrder.findMany({
    where: { status: { in: ['CONFIRMADO', 'PARCIALMENTE_RECEBIDO'] } },
    include: {
      supplier: { select: { name: true } },
      items: { orderBy: { position: 'asc' } },
    },
    orderBy: [{ expectedDate: { sort: 'asc', nulls: 'last' } }, { number: 'asc' }],
  });
  const waiting = await itemsAwaitingConference(
    db,
    pos.map((p) => p.id),
  );
  const out: MaterialArrivalDueDto[] = [];
  for (const po of pos) {
    const items = po.items
      .map((i) => ({
        purchaseOrderItemId: i.id,
        description: i.description,
        unit: i.unit,
        unitLabel: MATERIAL_UNIT_LABEL[i.unit],
        pending:
          Math.round(
            (num(i.quantity) +
              num(i.extraAuthorized) -
              num(i.receivedQuantity) -
              num(i.closedQuantity)) *
              1000,
          ) / 1000,
        mode: DECIMAL_UNITS.includes(i.unit) ? ('FISICA' as const) : ('CONTAGEM' as const),
      }))
      .filter((i) => i.pending > 0 && !waiting.items.has(i.purchaseOrderItemId));
    if (!items.length) continue;
    const exp = dateOnly(po.expectedDate);
    out.push({
      purchaseOrderId: po.id,
      code: purchaseOrderCode(po.number),
      supplierName: po.supplier?.name ?? null,
      expectedDate: exp,
      dueLabel: !exp
        ? 'Sem previsão de entrega'
        : exp === today
          ? 'Previsto para hoje'
          : `Previsto para ${exp.split('-').reverse().join('/')}`,
      items,
      awaitingConference: waiting.perPo.get(po.id) ?? 0,
      version: po.version,
    });
  }
  return out;
}

const ISSUE_OF: Record<string, ReceiptIssue> = {
  FALTANDO: 'INCOMPLETO',
  QUANTIDADE: 'INCOMPLETO',
  DIFERENTE: 'INCORRETO',
  DANIFICADO: 'DANIFICADO',
  OUTRO: 'OUTRO',
};

/**
 * Ponto de sincronização SÓ para testes de concorrência (sempre indefinido em produção: nenhum
 * código da aplicação o define). Permite pausar uma confirmação exatamente entre a leitura da
 * retirada e a do saldo — a janela da corrida corrigida em 87f7103 — e provar o resultado de forma
 * determinística, sem depender de atrasos.
 */
export const arrivalTestHooks: { afterPickupRead?: () => Promise<void> } = {};

export async function arrivalRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;

  /** Central compartilhada: peças de clientes (com permissão) e materiais comprados. */
  app.get('/api/v1/arrivals', { config: { access: ARRIVALS_VIEW } }, async (request) => {
    const auth = request.auth!;
    const device = auth.kind === 'DEVICE';
    const dto: ArrivalsDto = {
      pieces: auth.permissions.has('recebimentos.registrar')
        ? await pieceArrivals(prisma, device)
        : null,
      materials: await materialArrivals(prisma),
    };
    return dto;
  });

  /**
   * Confirmação rápida da chegada das peças de uma retirada. Padrão: todo o saldo da retirada.
   * Repetição com a mesma Idempotency-Key devolve a mesma resposta; confirmação feita sobre a
   * versão antiga (outro tablet já confirmou) recebe 409 com a versão atual.
   */
  app.post(
    '/api/v1/arrivals/pickups/:id/confirm',
    { config: { access: PIECES, idempotent: true } },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const input = confirmPieceArrivalSchema.parse(request.body);
      const auth = request.auth!;
      const actor = actorFrom(request);
      const result = await prisma.$transaction(async (tx) => {
        const pickup = await tx.pickupRequest.findUnique({ where: { id } });
        if (!pickup) throw Errors.notFound('Retirada');
        if (arrivalTestHooks.afterPickupRead) await arrivalTestHooks.afterPickupRead();
        const balance = await pickupBalance(tx, id);
        const lines = (
          input.lines ??
          [...balance.entries()].map(([orderItemId, quantity]) => ({ orderItemId, quantity }))
        ).filter((l) => l.quantity > 0);
        if (!lines.length) {
          // Versão relida DEPOIS do saldo: se outra confirmação foi gravada entre a leitura da
          // retirada e a do saldo, o saldo zerado é dela — é conflito (409), não pedido vazio.
          const current = await tx.pickupRequest.findUniqueOrThrow({
            where: { id },
            select: { version: true },
          });
          if (current.version !== input.version)
            throw Errors.conflict('Este recebimento já foi atualizado em outro aparelho.', {
              currentVersion: current.version,
            });
          throw Errors.validation(undefined, 'Informe ao menos uma peça que chegou.');
        }
        const receipt = await registerReceipt(
          tx,
          actor,
          {
            employeeId: auth.employeeId,
            deviceId: auth.deviceId ?? null,
            expectedPickupVersion: input.version,
            limitToPickupBalance: true,
          },
          {
            orderId: pickup.orderId,
            pickupId: pickup.id,
            origin: 'RETIRADA',
            divergences: input.problem?.note ?? null,
            notes: null,
            receivedByEmployeeId: null,
            lines: lines.map((l) => ({
              orderItemId: l.orderItemId,
              quantity: l.quantity,
              condition: input.problem ? 'REGULAR' : 'BOA',
              conditionNotes: input.problem?.note ?? null,
              location: DEFAULT_LOCATION,
            })),
          } as never,
        );
        const so = await tx.serviceOrder.findUnique({ where: { sourceReceiptId: receipt.id } });
        const left = [...(await pickupBalance(tx, id)).values()].reduce((a, b) => a + b, 0);
        const by = actor.userId
          ? await tx.user.findUnique({ where: { id: actor.userId }, select: { displayName: true } })
          : null;
        const dto: ArrivalConfirmationDto = {
          kind: 'PECAS',
          receipt: { id: receipt.id, code: receiptCode(receipt.number) },
          arrival: null,
          serviceOrder: so ? { id: so.id, code: serviceOrderCode(so.number) } : null,
          remaining: left,
          confirmedBy: by?.displayName ?? null,
          confirmedAt: receipt.createdAt.toISOString(),
        };
        return dto;
      });
      return reply.status(201).send(result);
    },
  );

  /**
   * Confirmação rápida de materiais por pedido de compra: só as quantidades FÍSICAS.
   * - Contáveis (peças, placas, unidades, embalagens): viram o recebimento normal (estoque/OS).
   * - Controlados em metros: registram a CHEGADA FÍSICA (ex.: 5 rolos) sem inventar metragem;
   *   o estoque só recebe na conferência técnica posterior (com a medida real).
   * Divergências são opcionais; material diferente/danificado nunca fica disponível.
   */
  app.post(
    '/api/v1/arrivals/purchase-orders/:id/confirm',
    { config: { access: ANY, idempotent: true } },
    async (request, reply) => {
      const { id } = z.object({ id: z.string().uuid() }).parse(request.params);
      const input = confirmMaterialArrivalSchema.parse(request.body);
      const auth = request.auth!;
      const actor = actorFrom(request);
      const result = await prisma.$transaction(async (tx) => {
        const po = await lockPurchaseOrder(tx, id);
        if (po.version !== input.version)
          throw Errors.conflict('Este recebimento já foi atualizado em outro aparelho.', {
            currentVersion: po.version,
          });
        if (!['CONFIRMADO', 'PARCIALMENTE_RECEBIDO'].includes(po.status))
          throw Errors.business('Este pedido não está aguardando recebimento.');
        const items = new Map(po.items.map((i) => [i.id, i]));
        const waiting = await itemsAwaitingConference(tx, [po.id]);
        const counted: z.output<typeof confirmMaterialArrivalSchema>['lines'] = [];
        const physical: typeof counted = [];
        for (const l of input.lines) {
          const item = items.get(l.purchaseOrderItemId);
          if (!item) throw Errors.validation(undefined, 'Item não pertence ao pedido.');
          if (DECIMAL_UNITS.includes(item.unit)) {
            if (waiting.items.has(item.id))
              throw Errors.conflict(`"${item.description}" já chegou e aguarda conferência.`);
            if (!Number.isInteger(l.quantity))
              throw Errors.validation(
                undefined,
                `"${item.description}": informe quantos volumes/rolos chegaram (número inteiro).`,
              );
            physical.push(l);
          } else counted.push(l);
        }
        const problem = input.problem ?? null;
        let receiptOut: ArrivalConfirmationDto['receipt'] = null;
        if (counted.length) {
          const rid = await registerMaterialReceipt(
            tx,
            actor,
            {
              purchaseOrderId: po.id,
              notes:
                problem && !problem.purchaseOrderItemId
                  ? `${ARRIVAL_PROBLEM_LABEL[problem.kind]}: ${problem.note}`
                  : null,
              lines: counted.map((l) => {
                const p = problem?.purchaseOrderItemId === l.purchaseOrderItemId ? problem : null;
                // Diferente/danificado: registrado, mas NÃO disponível (sem autorização).
                const blocked = p && (p.kind === 'DIFERENTE' || p.kind === 'DANIFICADO');
                return {
                  purchaseOrderItemId: l.purchaseOrderItemId,
                  acceptedQuantity: blocked ? 0 : l.quantity,
                  rejectedQuantity: blocked ? l.quantity : 0,
                  specConfirmed: !blocked,
                  issue: p ? ISSUE_OF[p.kind]! : null,
                  issueNote: p ? p.note : null,
                };
              }),
            },
            { deviceId: auth.deviceId ?? null, expectedVersion: input.version },
          );
          const r = await tx.materialReceipt.findUniqueOrThrow({ where: { id: rid } });
          receiptOut = { id: r.id, code: materialReceiptCode(r.number) };
        }
        let arrivalOut: ArrivalConfirmationDto['arrival'] = null;
        if (physical.length) {
          const a = await tx.materialArrival.create({
            data: {
              purchaseOrderId: po.id,
              lines: physical.map((l) => {
                const item = items.get(l.purchaseOrderItemId)!;
                return {
                  purchaseOrderItemId: item.id,
                  description: item.description,
                  unit: item.unit,
                  physicalCount: l.quantity,
                  physicalUnit: l.physicalUnit ?? 'ROLO',
                };
              }) as unknown as Prisma.InputJsonValue,
              problemKind: problem?.kind ?? null,
              problemNote: problem?.note ?? null,
              receivedById: actor.userId!,
              deviceId: auth.deviceId ?? null,
            },
          });
          // Muda a versão do pedido: outra confirmação feita sobre a tela antiga é recusada.
          await tx.purchaseOrder.update({
            where: { id: po.id },
            data: { version: { increment: 1 } },
          });
          await audit(tx, actor, {
            action: 'material_arrival.registered',
            entityType: 'material_arrival',
            entityId: a.id,
            summary: `${arrivalCode(a.number)}: chegada física do pedido ${purchaseOrderCode(po.number)} (${physical
              .map(
                (l) =>
                  `${l.quantity} ${PHYSICAL_UNIT_LABEL[l.physicalUnit ?? 'ROLO']} de ${items.get(l.purchaseOrderItemId)!.description}`,
              )
              .join('; ')}) — aguardando conferência.`,
            changes: { lines: physical, problem },
          });
          await appendEvent(tx, actor, {
            type: EVENT_TYPES.MATERIAL_ARRIVAL_REGISTERED,
            aggregateType: 'purchase_order',
            aggregateId: po.id,
            payload: { id: a.id, code: arrivalCode(a.number), purchaseOrderId: po.id },
            audience: 'all',
          });
          arrivalOut = { id: a.id, code: arrivalCode(a.number) };
        }
        const after = await materialArrivals(tx);
        const mine = after.find((x) => x.purchaseOrderId === po.id);
        const by = actor.userId
          ? await tx.user.findUnique({ where: { id: actor.userId }, select: { displayName: true } })
          : null;
        const dto: ArrivalConfirmationDto = {
          kind: 'MATERIAIS',
          receipt: receiptOut,
          arrival: arrivalOut,
          serviceOrder: null,
          remaining: mine ? mine.items.reduce((s, i) => s + i.pending, 0) : 0,
          confirmedBy: by?.displayName ?? null,
          confirmedAt: new Date().toISOString(),
        };
        return dto;
      });
      return reply.status(201).send(result);
    },
  );

  /** Gestor/estoque: chegadas físicas (ex.: rolos) aguardando conferência técnica. */
  app.get(
    '/api/v1/material-arrivals',
    { config: { access: CONFERENCE_VIEW } },
    async (request): Promise<MaterialArrivalDto[]> => {
      const q = z
        .object({ status: z.enum(['PENDENTE_CONFERENCIA', 'CONFERIDA', 'CANCELADA']).optional() })
        .parse(request.query);
      const rows = await prisma.materialArrival.findMany({
        where: q.status ? { status: q.status } : {},
        include: {
          purchaseOrder: { select: { id: true, number: true } },
          receivedBy: { select: { displayName: true } },
          conferredBy: { select: { displayName: true } },
        },
        orderBy: { receivedAt: 'desc' },
        take: 100,
      });
      const devices = new Map(
        (
          await prisma.device.findMany({
            where: {
              id: { in: rows.map((r) => r.deviceId).filter((d): d is string => Boolean(d)) },
            },
            select: { id: true, name: true },
          })
        ).map((d) => [d.id, d.name]),
      );
      return rows.map((r) => ({
        id: r.id,
        code: arrivalCode(r.number),
        purchaseOrder: { id: r.purchaseOrder.id, code: purchaseOrderCode(r.purchaseOrder.number) },
        status: r.status as MaterialArrivalDto['status'],
        lines: r.lines as MaterialArrivalDto['lines'],
        problemKind: r.problemKind,
        problemNote: r.problemNote,
        receivedBy: r.receivedBy.displayName,
        device: r.deviceId ? (devices.get(r.deviceId) ?? null) : null,
        receivedAt: r.receivedAt.toISOString(),
        conferredBy: r.conferredBy?.displayName ?? null,
        conferredAt: r.conferredAt?.toISOString() ?? null,
      }));
    },
  );
}
