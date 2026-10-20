import {
  DELIVERY_STATUS_LABEL,
  INSPECTION_STATUS_LABEL,
  LOGISTICS_KIND_LABEL,
  LOGISTICS_STATUS_LABEL,
  deliveryCode,
  inspectionCode,
  logisticsCode,
  packagingCode,
  taskCode,
  type AttentionItemDto,
  type LogisticsKind,
  type LogisticsStatus,
} from '@cenario/shared';
import type { PrismaClient } from '@cenario/db';
import { dateOnly, serviceOrderCode } from '../commercial/common';
import { serviceDeadlines } from '../deadlines/service';
import { pieceCode, pieceInclude } from './common';

const base = {
  task: null,
  solver: null,
  impacts: [] as string[],
} as const;

/** Itens da central de atenção da Fase 10 (só exceções; chave estável por fato). */
export async function qualityAttention(prisma: PrismaClient): Promise<AttentionItemDto[]> {
  const items: AttentionItemDto[] = [];

  // Inspeções sem inspetor (ausente, executor ou não definido): o gestor decide.
  const waiting = await prisma.qualityInspection.findMany({
    where: { status: { in: ['PENDENTE', 'EM_ANDAMENTO'] }, inspectorUserId: null },
    include: { serviceOrderItem: { include: pieceInclude } },
    orderBy: { createdAt: 'asc' },
  });
  for (const i of waiting) {
    const p = i.serviceOrderItem;
    items.push({
      ...base,
      key: `QUALIDADE:inspecao:${i.id}`,
      type: 'QUALIDADE',
      category: 'ACAO',
      title: `${inspectionCode(i.number)} · ${pieceCode(p)} · ${p.description}`,
      description: `${i.substituteReason ?? 'Sem inspetor'} — ${p.serviceOrder.customer.name}.`,
      serviceOrder: { id: p.serviceOrder.id, code: serviceOrderCode(p.serviceOrder.number) },
      employee: null,
      priority: i.priority,
      status: i.status,
      statusLabel: INSPECTION_STATUS_LABEL[i.status],
      at: i.createdAt.toISOString(),
      deadline: dateOnly(i.dueDate),
      nextActions: ['Designar inspetor substituto ou aprovar diretamente'],
      link: `/painel/qualidade/inspecoes/${i.id}`,
    });
  }

  // Correções em andamento (serviço reprovado).
  const rejected = await prisma.qualityInspection.findMany({
    where: {
      status: 'REPROVADA',
      tasks: { some: { activity: 'CORRECAO', status: { notIn: ['CONCLUIDA', 'CANCELADA'] } } },
    },
    include: {
      serviceOrderItem: { include: pieceInclude },
      tasks: {
        where: { activity: 'CORRECAO' },
        include: { assignee: { select: { id: true, displayName: true } } },
      },
    },
  });
  // Fase 10: atraso pela regra ÚNICA de prazos (dias úteis, ATRASADO) — nunca uma comparação
  // própria com a data prometida.
  const late = await lateServiceOrders(prisma, [
    ...rejected.map((i) => i.serviceOrderItem.serviceOrderId),
  ]);
  for (const i of rejected) {
    const p = i.serviceOrderItem;
    const c = i.tasks.find((t) => !['CONCLUIDA', 'CANCELADA'].includes(t.status)) ?? i.tasks[0];
    items.push({
      ...base,
      key: `QUALIDADE:correcao:${i.id}`,
      type: 'QUALIDADE',
      category: late.has(p.serviceOrderId) ? 'CRITICO' : 'ATENCAO',
      task: c ? { id: c.id, code: taskCode(c.number), title: c.title } : null,
      title: `Correção · ${pieceCode(p)} · ${p.description}`,
      description: `Reprovada em ${inspectionCode(i.number)}: ${i.decisionNote ?? ''}`,
      serviceOrder: { id: p.serviceOrder.id, code: serviceOrderCode(p.serviceOrder.number) },
      employee: c?.assignee ? { userId: c.assignee.id, displayName: c.assignee.displayName } : null,
      priority: c?.priority ?? i.priority,
      status: 'EM_CORRECAO',
      statusLabel: 'Em correção',
      at: (i.decidedAt ?? i.updatedAt).toISOString(),
      deadline: dateOnly(c?.dueDate ?? null),
      nextActions: ['Acompanhar a correção; nova inspeção é obrigatória'],
      link: `/painel/qualidade/inspecoes/${i.id}`,
    });
  }

  // Embalagens aprovadas sem responsável.
  const unassigned = await prisma.packagingRecord.findMany({
    where: { status: 'PENDENTE', assigneeUserId: null },
    include: { serviceOrderItem: { include: pieceInclude } },
  });
  for (const r of unassigned) {
    const p = r.serviceOrderItem;
    items.push({
      ...base,
      key: `QUALIDADE:embalagem:${r.id}`,
      type: 'QUALIDADE',
      category: 'ACAO',
      title: `${packagingCode(r.number)} · ${pieceCode(p)} · ${p.description}`,
      description: 'Aprovada pela qualidade, sem ninguém disponível para embalar.',
      serviceOrder: { id: p.serviceOrder.id, code: serviceOrderCode(p.serviceOrder.number) },
      employee: null,
      priority: p.serviceOrder.priority,
      status: r.status,
      statusLabel: 'Aguardando responsável',
      at: r.createdAt.toISOString(),
      deadline: dateOnly(p.serviceOrder.promisedDate),
      nextActions: ['Designar quem embala (tapeceiro só com autorização)'],
      link: '/painel/qualidade',
    });
  }

  // Peças prontas para entrega ainda sem agendamento (informativo; nunca agenda sozinho). A peça
  // que voltou de uma entrega frustrada já está no item da frustrada (reagendar): não repete.
  const ready = await prisma.serviceOrderItem.findMany({
    where: {
      fulfillmentStage: 'PRONTA_ENTREGA',
      deliveryItems: { none: { active: true, delivery: { status: 'FRUSTRADA' } } },
    },
    include: pieceInclude,
  });
  const readyLate = await lateServiceOrders(
    prisma,
    ready.map((p) => p.serviceOrderId),
  );
  for (const p of ready) {
    const promised = dateOnly(p.serviceOrder.promisedDate);
    items.push({
      ...base,
      key: `LOGISTICA:pronta:${p.id}`,
      type: 'LOGISTICA',
      category: readyLate.has(p.serviceOrderId) ? 'ATENCAO' : 'INFO',
      title: `${pieceCode(p)} · ${p.description} pronta para entrega`,
      description: `${p.serviceOrder.customer.name}${promised ? ` — prometida para ${promised.split('-').reverse().join('/')}` : ''}.`,
      serviceOrder: { id: p.serviceOrder.id, code: serviceOrderCode(p.serviceOrder.number) },
      employee: null,
      priority: p.serviceOrder.priority,
      status: 'PRONTA_ENTREGA',
      statusLabel: 'Pronta para entrega',
      at: p.updatedAt.toISOString(),
      deadline: promised,
      nextActions: ['Agendar a entrega com o cliente'],
      link: '/painel/entregas?tab=ready',
    });
  }

  // Ocorrências logísticas abertas. A ocorrência que só registra a tentativa frustrada (sem
  // bloquear a expedição) fica dentro do item da frustrada — um fato, um item.
  const occurrences = await prisma.logisticsOccurrence.findMany({
    where: {
      status: { in: ['ABERTA', 'EM_TRATAMENTO'] },
      NOT: { blocksShipping: false, delivery: { status: 'FRUSTRADA' } },
    },
    include: {
      delivery: { select: { id: true, number: true } },
      responsible: { select: { id: true, displayName: true } },
      reportedBy: { select: { id: true, displayName: true } },
    },
  });
  for (const o of occurrences) {
    items.push({
      ...base,
      key: `LOGISTICA:ocorrencia:${o.id}`,
      type: 'LOGISTICA',
      category: o.blocksShipping ? 'CRITICO' : o.status === 'ABERTA' ? 'ACAO' : 'ATENCAO',
      title: `${logisticsCode(o.number)} · ${LOGISTICS_KIND_LABEL[o.kind as LogisticsKind]}`,
      description: `${o.description}${o.delivery ? ` (${deliveryCode(o.delivery.number)})` : ''}${o.blocksShipping ? ' — bloqueia a expedição' : ''}`,
      serviceOrder: null,
      employee: o.reportedBy
        ? { userId: o.reportedBy.id, displayName: o.reportedBy.displayName }
        : null,
      priority: o.blocksShipping ? 'ALTA' : 'NORMAL',
      status: o.status,
      statusLabel: LOGISTICS_STATUS_LABEL[o.status as LogisticsStatus],
      at: o.createdAt.toISOString(),
      deadline: null,
      solver: o.responsible
        ? { userId: o.responsible.id, displayName: o.responsible.displayName }
        : null,
      nextActions: [
        o.status === 'ABERTA' ? 'Definir responsável e tratar' : 'Acompanhar e resolver',
      ],
      link: `/painel/entregas/ocorrencias/${o.id}`,
    });
  }

  // Entregas frustradas aguardando reagendamento.
  const frustrated = await prisma.delivery.findMany({
    where: { status: 'FRUSTRADA' },
    include: {
      customer: { select: { name: true } },
      occurrences: {
        where: { status: { in: ['ABERTA', 'EM_TRATAMENTO'] }, blocksShipping: false },
        select: { kind: true, description: true },
        orderBy: { createdAt: 'desc' },
        take: 1,
      },
    },
  });
  for (const d of frustrated) {
    items.push({
      ...base,
      key: `LOGISTICA:frustrada:${d.id}`,
      type: 'LOGISTICA',
      category: 'ACAO',
      title: `${deliveryCode(d.number)} · ${d.customer.name}`,
      description: `Tentativa frustrada (${d.attempts} tentativa(s))${d.occurrences[0] ? `: ${LOGISTICS_KIND_LABEL[d.occurrences[0].kind as LogisticsKind]} — ${d.occurrences[0].description}` : ''}.`,
      serviceOrder: null,
      employee: null,
      priority: 'ALTA',
      status: d.status,
      statusLabel: DELIVERY_STATUS_LABEL[d.status],
      at: d.updatedAt.toISOString(),
      deadline: dateOnly(d.scheduledDate),
      nextActions: ['Reagendar com o cliente ou cancelar'],
      link: `/painel/entregas/${d.id}`,
    });
  }
  return items;
}

/** OS ATRASADAS pela regra única de prazos (mesma fonte da lista, do detalhe e do Início). */
async function lateServiceOrders(prisma: PrismaClient, ids: string[]) {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Set<string>();
  const states = await serviceDeadlines(prisma, { id: { in: unique } });
  return new Set([...states].filter(([, d]) => d.state === 'ATRASADO').map(([id]) => id));
}
