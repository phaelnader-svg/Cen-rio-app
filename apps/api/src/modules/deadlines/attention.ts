import {
  DEADLINE_REASON_LABEL,
  DEADLINE_STATE_LABEL,
  ORDER_DEADLINE_LABEL,
  type AttentionItemDto,
  type DeadlineReason,
  type ServiceDeadline,
} from '@cenario/shared';
import type { PrismaClient } from '@cenario/db';
import { brDate } from '../attendance/common';
import { orderCode, serviceOrderCode } from '../commercial/common';
import {
  deadlineCalendar,
  deadlineCandidatesWhere,
  orderCandidatesWhere,
  orderDeadlines,
  serviceDeadlines,
} from './service';

/**
 * Ação sugerida por motivo. Correção, peça pronta sem entrega e entrega frustrada já têm o seu
 * item próprio (QUALIDADE/LOGÍSTICA) com a ação: aqui ficam só como motivo, sem repetir a ação.
 */
const ACTION: Partial<Record<DeadlineReason, string>> = {
  NAO_PLANEJADA: 'Planejar a OS (Produção → A planejar)',
  PRODUCAO_NAO_INICIADA: 'Conferir a fila de quem vai executar',
  BLOQUEADA: 'Resolver o bloqueio da produção',
  MATERIAIS: 'Conferir os materiais da OS',
  ENTREGA_DEPOIS_DO_PRAZO: 'Antecipar a entrega ou renegociar o prazo',
};

const timing = (d: ServiceDeadline) => {
  const n = d.workingDays ?? 0;
  if (n < 0) return `${-n} dia(s) útil(eis) de atraso`;
  if (n === 0) return d.state === 'ATRASADO' ? 'vencido' : 'vence hoje';
  return `faltam ${n} dia(s) útil(eis)`;
};

/**
 * Central de atenção — prazos (derivado a cada consulta, nada é gravado):
 * - PRAZO_OS: no máximo UM item por OS, só ATRASADO (crítico) ou EM_RISCO (ação); os motivos
 *   ficam dentro do item. PROXIMO e SEM_PRAZO não entram;
 * - PRAZO_PEDIDO: um item por pedido com prazo vencido/próximo e peças ainda não recebidas
 *   (antes de a OS existir — nunca vira "OS atrasada").
 */
export async function deadlineAttention(prisma: PrismaClient): Promise<AttentionItemDto[]> {
  const cal = await deadlineCalendar(prisma);
  const items: AttentionItemDto[] = [];
  const where = deadlineCandidatesWhere(cal);
  const [states, sos] = await Promise.all([
    serviceDeadlines(prisma, where, cal),
    prisma.serviceOrder.findMany({
      where,
      select: {
        id: true,
        number: true,
        priority: true,
        updatedAt: true,
        customer: { select: { name: true } },
      },
    }),
  ]);
  for (const so of sos) {
    const d = states.get(so.id);
    if (!d || (d.state !== 'ATRASADO' && d.state !== 'EM_RISCO')) continue;
    const code = serviceOrderCode(so.number);
    const late = d.state === 'ATRASADO';
    const actions = [
      ...new Set(d.reasons.map((r) => ACTION[r]).filter((a): a is string => Boolean(a))),
    ];
    items.push({
      key: `PRAZO_OS:${so.id}`,
      type: 'PRAZO_OS',
      category: late ? 'CRITICO' : 'ACAO',
      title: `${code} · ${so.customer.name} — ${DEADLINE_STATE_LABEL[d.state].toUpperCase()}`,
      description: [
        `Prazo prometido ${brDate(d.promisedDate!)} (${timing(d)}).`,
        ...d.context,
      ].join(' '),
      serviceOrder: { id: so.id, code },
      task: null,
      employee: null,
      priority: so.priority,
      status: d.state,
      statusLabel: DEADLINE_STATE_LABEL[d.state],
      at: so.updatedAt.toISOString(),
      deadline: d.promisedDate,
      solver: null,
      impacts: d.reasons.map((r) => DEADLINE_REASON_LABEL[r]),
      nextActions: late
        ? ['Renegociar o prazo com o cliente ou priorizar a OS', ...actions]
        : actions,
      link: `/painel/os/${so.id}`,
    });
  }
  for (const o of await orderDeadlines(prisma, orderCandidatesWhere(cal), cal)) {
    const code = orderCode(o.number);
    const pieces = o.missing.map((m) => `${m.quantity}× ${m.description}`);
    items.push({
      key: `PRAZO_PEDIDO:${o.id}`,
      type: 'PRAZO_PEDIDO',
      category: o.state === 'PRAZO_VENCIDO' ? 'CRITICO' : 'ACAO',
      title: `${code} · ${o.customerName} — ${ORDER_DEADLINE_LABEL[o.state].toUpperCase()}`,
      description: `Prazo prometido ${brDate(o.promisedDate)}. ${
        pieces.length === 1 ? 'Peça ainda não recebida' : 'Peças ainda não recebidas'
      }: ${pieces.join(', ')}.`,
      serviceOrder: null,
      task: null,
      employee: null,
      priority: 'NORMAL',
      status: o.state,
      statusLabel: ORDER_DEADLINE_LABEL[o.state],
      at: o.updatedAt.toISOString(),
      deadline: o.promisedDate,
      solver: null,
      impacts: pieces,
      nextActions: [
        'Conferir a retirada ou a entrega das peças pelo cliente',
        'Renegociar o prazo se preciso',
      ],
      link: `/painel/pedidos/${o.id}`,
    });
  }
  return items;
}
