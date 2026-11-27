import { plural } from '@cenario/shared';
import {
  BILL_ALERT_DAYS_BEFORE,
  DEADLINE_REASON_LABEL,
  DEADLINE_STATE_LABEL,
  MATERIAL_ALERT_DAYS,
  ORDER_DEADLINE_LABEL,
  deadlineWindowEnd,
  NOTIFICATION_KIND_LABEL,
  OPERATIONAL_ALERT_KINDS,
  READY_WITHOUT_DELIVERY_DAYS,
  formatServiceOrderItemCode,
  taskCode,
  type OperationalAlertKind,
  type OperationalState,
  type Permission,
  type TodayDeadlineDto,
  type TodayDto,
  type TodaySuggestionDto,
} from '@cenario/shared';
import type { PrismaClient, TaskStatus, Tx } from '@cenario/db';
import type { FastifyInstance } from 'fastify';
import type { ActorContext } from '../../core/types';
import { now as clockNow } from '../../core/clock';
import { dbDate } from '../attendance/common';
import { dateOnly, orderCode, serviceOrderCode } from '../commercial/common';
import { billsDue } from '../finance/bills';
import { deadlineCalendar, deadlineCandidatesWhere, serviceDeadlines } from '../deadlines/service';
import { loadAttention } from '../issues/attention';
import { resolveNotifications } from '../notifications/notify';
import { loadPipeline } from '../production/pre-planning';
import { notifyUsersWith } from '../quality/common';
import { loadOperationalStates } from '../service-orders/operational';
import { stoppedServices } from '../production/shop-floor';

/**
 * Reformulação, Fase 4 — "Hoje" no Início, alertas internos e ações sugeridas.
 *
 * Alertas (D7): só avisos internos (o sininho do painel) — nada de e-mail, WhatsApp ou outro canal.
 * Recalculados de forma idempotente: o mesmo fato gera um aviso só (chave estável); quando o fato
 * deixa de existir, o aviso é resolvido sozinho. Executado pela manutenção periódica.
 *
 * Ações sugeridas: textos explicativos montados a partir dos mecanismos que já existem (estado da
 * OS e próximo passo da Fase 0, Central de atenção, pré-planejamento, prazos). Cada uma diz o
 * porquê e leva à tela onde o gestor decide; nenhuma executa nada.
 */
const SYSTEM: ActorContext = { userId: null, sessionId: null, ip: null, requestId: null };
const DAY = 24 * 60 * 60 * 1000;
const ALERT_LOCK = 4_242_017;
const OPEN_TASK: TaskStatus[] = [
  'RASCUNHO',
  'PROGRAMADA',
  'LIBERADA',
  'BLOQUEADA',
  'EM_EXECUCAO',
  'PAUSADA',
];

/** Quando a peça ficou pronta para entrega (último evento de etapa), por peça. */
export async function readySince(db: Tx | PrismaClient, itemIds: string[]) {
  const events = itemIds.length
    ? await db.qualityEvent.findMany({
        where: { serviceOrderItemId: { in: itemIds }, kind: 'ETAPA' },
        orderBy: { createdAt: 'desc' },
        select: { serviceOrderItemId: true, createdAt: true, data: true },
      })
    : [];
  const out = new Map<string, Date>();
  for (const e of events) {
    if (out.has(e.serviceOrderItemId)) continue;
    const to = (e.data as { to?: string } | null)?.to;
    if (to === 'PRONTA_ENTREGA') out.set(e.serviceOrderItemId, e.createdAt);
  }
  return out;
}

/** Fatos que geram alerta agora (função pura sobre o banco; usada pelo alerta e pelo painel). */
async function currentFacts(db: Tx | PrismaClient) {
  const cal = await deadlineCalendar(db);
  const now = clockNow();
  // 1. Prazo em risco ou atrasado (motor de prazos canônico).
  const deadlines = await serviceDeadlines(db, deadlineCandidatesWhere(cal), cal);
  const risky = [...deadlines.entries()].filter(([, d]) =>
    ['EM_RISCO', 'ATRASADO'].includes(d.state),
  );
  const riskyOs = risky.length
    ? await db.serviceOrder.findMany({
        where: { id: { in: risky.map(([id]) => id) } },
        select: { id: true, number: true, customer: { select: { name: true } } },
      })
    : [];
  // 2. Peças prontas há dias sem entrega.
  const ready = await db.serviceOrderItem.findMany({
    where: { fulfillmentStage: 'PRONTA_ENTREGA', serviceOrder: { status: 'ABERTA' } },
    select: {
      id: true,
      position: true,
      description: true,
      serviceOrderId: true,
      serviceOrder: { select: { number: true, customer: { select: { name: true } } } },
    },
  });
  const since = await readySince(
    db,
    ready.map((r) => r.id),
  );
  const readyRows = ready.map((r) => {
    const at = since.get(r.id) ?? null;
    return { ...r, since: at, days: at ? Math.floor((now.getTime() - at.getTime()) / DAY) : 0 };
  });
  // 3. Produção programada para já (ou em andamento) com material faltando.
  const horizon = new Date(now.getTime() + MATERIAL_ALERT_DAYS * DAY);
  const soon = await db.serviceOrder.findMany({
    where: {
      status: 'ABERTA',
      productionTasks: {
        some: {
          status: { in: OPEN_TASK.filter((s) => s !== 'RASCUNHO') },
          OR: [{ scheduledAt: { lte: horizon } }, { status: { in: ['EM_EXECUCAO', 'PAUSADA'] } }],
        },
      },
      simpleMaterials: { some: { removedAt: null, available: false } },
    },
    select: {
      id: true,
      number: true,
      customer: { select: { name: true } },
      simpleMaterials: {
        where: { removedAt: null, available: false },
        select: { description: true },
      },
    },
  });
  // 4. Prazos de entrega até uma semana à frente (2026-11-18): OS "prazo próximo" e pedidos que
  // ainda não viraram OS (peça não chegou ou OS não gerada).
  const nearOs = [...deadlines.entries()].filter(([, d]) => d.state === 'PROXIMO');
  const nearOsRows = nearOs.length
    ? await db.serviceOrder.findMany({
        where: { id: { in: nearOs.map(([id]) => id) } },
        select: { id: true, number: true, customer: { select: { name: true } } },
      })
    : [];
  const windowEnd = deadlineWindowEnd(cal.today, cal.workingDays);
  const preOs = await db.commercialOrder.findMany({
    where: {
      status: { not: 'CANCELADO' },
      promisedDate: { not: null, lte: dbDate(windowEnd) },
      serviceOrders: { none: { status: { not: 'CANCELADA' } } },
    },
    select: {
      id: true,
      number: true,
      promisedDate: true,
      customer: { select: { name: true } },
      items: { select: { quantity: true, receivedQuantity: true } },
    },
    orderBy: { promisedDate: 'asc' },
    take: 200,
  });
  const orders = preOs.map((o) => {
    const promisedDate = dateOnly(o.promisedDate)!;
    const missing = o.items.some((i) => i.quantity > i.receivedQuantity);
    return {
      id: o.id,
      number: o.number,
      customer: o.customer.name,
      promisedDate,
      late: promisedDate < cal.today,
      reason: missing ? 'Peças ainda não chegaram na oficina' : 'OS ainda não gerada',
    };
  });
  // 5. Contas a pagar vencidas ou que vencem até amanhã.
  const bills = await billsDue(db, cal.today, BILL_ALERT_DAYS_BEFORE);
  // 6. Oficina sem tablet (2026-11-24): serviço começado sem nenhum movimento há dias.
  const stopped = await stoppedServices(db);
  return { cal, deadlines, risky, riskyOs, readyRows, soon, nearOsRows, orders, bills, stopped };
}

const DAY_MS = 24 * 60 * 60 * 1000;
const calendarDays = (from: string, to: string) =>
  Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / DAY_MS);
const br = (iso: string) => iso.split('-').reverse().join('/');

/**
 * Recalcula os alertas internos (idempotente). Avisa quem já cuida de cada assunto: prazo →
 * `os.gerenciar`; peça pronta → `entregas.gerenciar`; material (lista simples da OS) →
 * `os.gerenciar`. Resolve os avisos cujo fato deixou de existir.
 */
export async function refreshOperationalAlerts(prisma: PrismaClient) {
  return prisma.$transaction(
    async (tx) => {
      const lock = await tx.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(${ALERT_LOCK}::bigint) AS locked`;
      if (!lock[0]?.locked) return { skipped: true, active: 0, resolved: 0 };
      const f = await currentFacts(tx);
      const active = new Set<string>();
      for (const so of f.riskyOs) {
        const d = f.deadlines.get(so.id)!;
        const subject = `PRAZO_EM_RISCO:${so.id}`;
        active.add(subject);
        await notifyUsersWith(
          tx,
          SYSTEM,
          'os.gerenciar',
          'PRAZO_EM_RISCO',
          `${subject}:${d.state}`,
          `${serviceOrderCode(so.number)} (${so.customer.name}) está ${d.state === 'ATRASADO' ? 'atrasada' : 'em risco'}${d.promisedDate ? ` — prazo ${d.promisedDate.split('-').reverse().join('/')}` : ''}${
            d.reasons.length
              ? `: ${d.reasons
                  .map((r) => DEADLINE_REASON_LABEL[r])
                  .join(', ')
                  .toLowerCase()}`
              : ''
          }.`,
          so.id,
        );
      }
      for (const r of f.readyRows.filter((x) => x.days >= READY_WITHOUT_DELIVERY_DAYS)) {
        const subject = `PECA_PRONTA_SEM_ENTREGA:${r.id}`;
        active.add(subject);
        await notifyUsersWith(
          tx,
          SYSTEM,
          'entregas.gerenciar',
          'PECA_PRONTA_SEM_ENTREGA',
          `${subject}:${r.since?.toISOString().slice(0, 10) ?? '-'}`,
          `${formatServiceOrderItemCode(r.serviceOrder.number, r.position)} · ${r.description} (${r.serviceOrder.customer.name}) está pronta há ${plural(r.days, 'dia', 'dias')} sem entrega.`,
          r.serviceOrderId,
        );
      }
      for (const so of f.soon) {
        const subject = `MATERIAL_FALTANTE:${so.id}`;
        active.add(subject);
        const what = so.simpleMaterials
          .map((m) => m.description)
          .slice(0, 3)
          .join(', ');
        await notifyUsersWith(
          tx,
          SYSTEM,
          'os.gerenciar',
          'MATERIAL_FALTANTE',
          subject,
          `${serviceOrderCode(so.number)} (${so.customer.name}) tem produção para os próximos ${MATERIAL_ALERT_DAYS} dias e ainda falta: ${what}.`,
          so.id,
        );
      }
      // 2026-11-18: prazo de entrega a uma semana (OS sem motivo de risco ainda).
      for (const so of f.nearOsRows) {
        const d = f.deadlines.get(so.id)!;
        const subject = `PRAZO_PROXIMO:${so.id}`;
        active.add(subject);
        await notifyUsersWith(
          tx,
          SYSTEM,
          'os.gerenciar',
          'PRAZO_PROXIMO',
          `${subject}:${d.promisedDate}`,
          `${serviceOrderCode(so.number)} (${so.customer.name}) tem entrega combinada para ${br(d.promisedDate!)}: falta ${plural(Math.max(0, calendarDays(f.cal.today, d.promisedDate!)), 'dia', 'dias')}.`,
          so.id,
        );
      }
      // Pedidos que ainda não viraram OS: prazo chegando ou vencido.
      for (const o of f.orders) {
        const kind = o.late ? 'PRAZO_EM_RISCO' : 'PRAZO_PROXIMO';
        const subject = `${kind}:${o.id}`;
        active.add(subject);
        await notifyUsersWith(
          tx,
          SYSTEM,
          'os.gerenciar',
          kind,
          `${subject}:${o.promisedDate}`,
          `${orderCode(o.number)} (${o.customer}) ${o.late ? 'passou do prazo de entrega' : 'tem entrega combinada para'} ${br(o.promisedDate)}: ${o.reason.toLowerCase()}.`,
        );
      }
      // Contas a pagar: um dia antes do vencimento, no dia e depois de vencida. Sem valor no texto:
      // o Início não mostra dinheiro (o valor fica no Resumo do financeiro).
      for (const b of [...f.bills.overdue, ...f.bills.upcoming]) {
        const kind = b.days < 0 ? 'CONTA_VENCIDA' : 'CONTA_A_VENCER';
        const subject = `${kind}:${b.id}`;
        active.add(subject);
        await notifyUsersWith(
          tx,
          SYSTEM,
          'financeiro.ver',
          kind,
          `${subject}:${b.dueDate}`,
          `${b.code} · ${b.beneficiary} ${
            b.days < 0
              ? `venceu em ${br(b.dueDate)}`
              : b.days === 0
                ? 'vence hoje'
                : `vence amanhã, ${br(b.dueDate)}`
          }.`,
        );
      }
      // Serviço parado: começou e não teve nenhum movimento (etapa, qualidade) há dias.
      for (const so of f.stopped) {
        const subject = `SERVICO_PARADO:${so.id}`;
        active.add(subject);
        await notifyUsersWith(
          tx,
          SYSTEM,
          'os.gerenciar',
          'SERVICO_PARADO',
          `${subject}:${so.since!.toISOString().slice(0, 10)}`,
          `${serviceOrderCode(so.number)} (${so.customer.name}) começou e está parada há ${plural(so.days, 'dia', 'dias')}: confira se já ficou pronta.`,
          so.id,
        );
      }
      // Resolve o que deixou de valer (fato corrigido, OS entregue, prazo normalizado…).
      const open = await tx.notification.findMany({
        where: { resolvedAt: null, kind: { in: [...OPERATIONAL_ALERT_KINDS] } },
        select: { dedupeKey: true },
      });
      const stale = new Set<string>();
      for (const n of open) {
        const subject = n.dedupeKey.split(':').slice(0, 2).join(':');
        if (!active.has(subject)) stale.add(subject);
      }
      // Prazo que mudou de estado (risco → atrasado): o aviso do estado anterior sai.
      for (const so of f.riskyOs) {
        const d = f.deadlines.get(so.id)!;
        const other = d.state === 'ATRASADO' ? 'EM_RISCO' : 'ATRASADO';
        await resolveNotifications(tx, SYSTEM, 'PRAZO_EM_RISCO', [
          `PRAZO_EM_RISCO:${so.id}:${other}`,
        ]);
      }
      const resolved = stale.size
        ? await resolveNotifications(tx, SYSTEM, [...OPERATIONAL_ALERT_KINDS], [...stale])
        : 0;
      return { skipped: false, active: active.size, resolved };
    },
    { timeout: 60_000 },
  );
}

const can = (perms: ReadonlySet<Permission>, ...any: Permission[]) => any.some((p) => perms.has(p));

/** Painel "Hoje" (somente leitura). */
export async function loadToday(
  prisma: PrismaClient,
  perms: ReadonlySet<Permission>,
  userId: string,
): Promise<TodayDto> {
  const f = await currentFacts(prisma);
  const seeProduction = can(perms, 'producao.ver', 'producao.planejar', 'os.ver');
  const seeDeliveries = can(perms, 'entregas.ver', 'entregas.gerenciar', 'os.ver');

  let inExecution: TodayDto['inExecution'] = null;
  if (seeProduction) {
    const tasks = await prisma.productionTask.findMany({
      where: { status: { in: ['EM_EXECUCAO', 'PAUSADA'] } },
      include: {
        assignee: { select: { displayName: true } },
        serviceOrder: { select: { id: true, number: true } },
      },
      orderBy: [{ status: 'asc' }, { startedAt: 'asc' }],
      take: 50,
    });
    inExecution = tasks.map((t) => ({
      taskId: t.id,
      code: taskCode(t.number),
      title: t.title,
      serviceOrder: { id: t.serviceOrder.id, code: serviceOrderCode(t.serviceOrder.number) },
      assignee: t.assignee?.displayName ?? null,
      status: t.status as 'EM_EXECUCAO' | 'PAUSADA',
      since: t.startedAt?.toISOString() ?? null,
    }));
  }

  let present: TodayDto['present'] = null;
  if (can(perms, 'presenca.ver', 'presenca.gerenciar')) {
    const rows = await prisma.operationalAttendance.findMany({
      where: {
        date: dbDate(f.cal.today),
        arrivedAt: { not: null },
        departedAt: null,
        departureUnrecordedAt: null,
      },
      include: { employee: { include: { user: { select: { displayName: true } } } } },
      orderBy: { arrivedAt: 'asc' },
    });
    present = {
      total: rows.length,
      people: rows.map((r) => ({
        displayName: r.employee.user?.displayName ?? r.employee.fullName,
        arrivedAt: r.arrivedAt?.toISOString() ?? null,
      })),
    };
  }

  const readyPieces: TodayDto['readyPieces'] = seeDeliveries
    ? f.readyRows
        .sort((a, b) => b.days - a.days)
        .map((r) => ({
          itemId: r.id,
          code: formatServiceOrderItemCode(r.serviceOrder.number, r.position),
          description: r.description,
          customer: r.serviceOrder.customer.name,
          serviceOrderId: r.serviceOrderId,
          days: r.days,
        }))
    : null;

  let pendencies: TodayDto['pendencies'] = null;
  if (can(perms, 'ocorrencias.ver', 'ocorrencias.gerenciar')) {
    const central = await loadAttention(prisma, perms, {});
    pendencies = {
      total: central.total,
      critical: central.counts.CRITICO,
      top: central.items
        .filter((i) => i.category !== 'INFO')
        .slice(0, 5)
        .map((i) => ({
          title: i.title,
          description: i.description,
          link: i.link,
          category: i.category,
        })),
    };
  }

  // Alertas internos ativos deste usuário (os três tipos da Fase 4).
  const mine = await prisma.notification.findMany({
    where: { userId, resolvedAt: null, kind: { in: [...OPERATIONAL_ALERT_KINDS] } },
    orderBy: { createdAt: 'desc' },
    take: 20,
  });
  const alerts = mine.map((n) => ({
    kind: n.kind as OperationalAlertKind,
    title: NOTIFICATION_KIND_LABEL[n.kind as OperationalAlertKind],
    body: n.body,
    link: n.kind.startsWith('CONTA_')
      ? '/painel/financeiro?tab=painel'
      : n.serviceOrderId
        ? `/painel/os/${n.serviceOrderId}`
        : '/painel',
    at: n.createdAt.toISOString(),
  }));

  // 2026-11-18: serviços com prazo de entrega em até uma semana (ou vencido), OS e pedidos.
  let deadlines: TodayDeadlineDto[] | null = null;
  if (can(perms, 'os.ver', 'pedidos.ver')) {
    const osRows = [...f.riskyOs, ...f.nearOsRows];
    deadlines = [
      ...osRows.map((so) => {
        const d = f.deadlines.get(so.id)!;
        return {
          kind: 'OS' as const,
          id: so.id,
          code: serviceOrderCode(so.number),
          customer: so.customer.name,
          promisedDate: d.promisedDate!,
          days: calendarDays(f.cal.today, d.promisedDate!),
          state: d.state,
          stateLabel: DEADLINE_STATE_LABEL[d.state],
          reasons: d.reasons.map((r) => DEADLINE_REASON_LABEL[r]),
          link: `/painel/os/${so.id}`,
        };
      }),
      ...f.orders.map((o) => {
        const state = o.late ? 'PRAZO_VENCIDO' : 'PRAZO_PROXIMO';
        return {
          kind: 'PEDIDO' as const,
          id: o.id,
          code: orderCode(o.number),
          customer: o.customer,
          promisedDate: o.promisedDate,
          days: calendarDays(f.cal.today, o.promisedDate),
          state,
          stateLabel: o.late ? 'Atrasado' : ORDER_DEADLINE_LABEL[state],
          reasons: [o.reason],
          link: `/painel/pedidos/${o.id}`,
        };
      }),
    ].sort((a, b) => a.promisedDate.localeCompare(b.promisedDate) || a.code.localeCompare(b.code));
  }

  // Ações sugeridas (explicativas; nada é executado).
  const suggestions: TodaySuggestionDto[] = [];
  let states: TodayDto['states'];
  if (can(perms, 'os.ver')) {
    const active = await prisma.serviceOrder.findMany({
      where: {
        status: 'ABERTA',
        items: { some: { fulfillmentStage: { notIn: ['ENTREGUE', 'DEVOLVIDA', 'CANCELADA'] } } },
      },
      select: { id: true },
      take: 500,
    });
    const map = await loadOperationalStates(
      prisma,
      active.map((a) => a.id),
    );
    states = {};
    for (const s of map.values()) states[s.state] = (states[s.state] ?? 0) + 1;
    const n = (k: OperationalState) => states?.[k] ?? 0;
    for (const so of f.riskyOs.slice(0, 3)) {
      const d = f.deadlines.get(so.id)!;
      suggestions.push({
        key: `prazo:${so.id}`,
        title: `Revisar a programação da ${serviceOrderCode(so.number)} (${so.customer.name})`,
        why: `O prazo está ${d.state === 'ATRASADO' ? 'vencido' : 'em risco'}${d.reasons.length ? ` por ${d.reasons.map((r) => DEADLINE_REASON_LABEL[r].toLowerCase()).join(', ')}` : ''}.`,
        link: `/painel/os/${so.id}`,
        priority: 'ALTA',
      });
    }
    if (n('NAO_PLANEJADA') && can(perms, 'producao.planejar', 'producao.ver')) {
      const pipeline = await loadPipeline(prisma);
      const toPlan = pipeline.counts.A_PLANEJAR;
      if (toPlan)
        suggestions.push({
          key: 'planejar',
          title: `Planejar ${plural(toPlan, 'serviço recebido', 'serviços recebidos')}`,
          why: 'Estão na oficina sem tapeceiro ou data de início: a produção não começa sem programação publicada.',
          link: '/painel/producao/programacao',
          priority: 'NORMAL',
        });
    }
    if (n('AGUARDANDO_QUALIDADE') && can(perms, 'qualidade.gerenciar'))
      suggestions.push({
        key: 'qualidade',
        title: `Inspecionar ${n('AGUARDANDO_QUALIDADE')} OS aguardando qualidade`,
        why: 'A produção terminou; a peça só fica pronta para entrega depois da aprovação.',
        link: '/painel/qualidade',
        priority: 'NORMAL',
      });
  }
  const oldReady = (readyPieces ?? []).filter((r) => r.days >= READY_WITHOUT_DELIVERY_DAYS);
  if (oldReady.length && can(perms, 'entregas.gerenciar'))
    suggestions.push({
      key: 'entregar',
      title: `Combinar a entrega de ${plural(oldReady.length, 'peça pronta', 'peças prontas')} há ${READY_WITHOUT_DELIVERY_DAYS}+ dias`,
      why: 'Peça pronta parada ocupa espaço e atrasa o recebimento do cliente. Agende ou marque como entregue na OS.',
      link: `/painel/os/${oldReady[0]!.serviceOrderId}?tab=qualidade`,
      priority: 'NORMAL',
    });
  if (f.soon.length && can(perms, 'os.gerenciar'))
    suggestions.push({
      key: 'materiais',
      title: `Providenciar materiais de ${f.soon.length} OS com produção próxima`,
      why: `A produção está programada para os próximos ${MATERIAL_ALERT_DAYS} dias e ainda falta material.`,
      link: `/painel/os/${f.soon[0]!.id}?tab=materiais`,
      priority: 'ALTA',
    });
  if (pendencies?.critical)
    suggestions.push({
      key: 'central',
      title: `Resolver ${plural(pendencies.critical, 'pendência crítica', 'pendências críticas')} na Central de atenção`,
      why: 'São ocorrências ou bloqueios que param a produção ou a entrega.',
      link: '/painel/atencao',
      priority: 'ALTA',
    });

  return {
    date: f.cal.today,
    generatedAt: new Date().toISOString(),
    inExecution,
    present,
    readyPieces,
    pendencies,
    alerts,
    deadlines,
    suggestions: suggestions.sort((a, b) =>
      a.priority === b.priority ? 0 : a.priority === 'ALTA' ? -1 : 1,
    ),
    ...(states ? { states } : {}),
  };
}

const TODAY_ACCESS = {
  session: 'WEB',
  anyPermissions: [
    'os.ver',
    'producao.ver',
    'producao.planejar',
    'presenca.ver',
    'presenca.gerenciar',
    'entregas.ver',
    'entregas.gerenciar',
    'ocorrencias.ver',
  ],
} as const;

export async function todayRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;
  app.get('/api/v1/management/today', { config: { access: TODAY_ACCESS } }, async (request) =>
    loadToday(prisma, request.auth!.permissions, request.auth!.userId),
  );
}
