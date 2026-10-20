import {
  PURCHASE_ORDER_RECEIVABLE,
  REQUEST_AWAITING_REVIEW,
  closingWeekStart,
  measurementCode,
  purchaseOrderCode,
  valueChangeCode,
  type AttentionItemDto,
} from '@cenario/shared';
import type { PrismaClient } from '@cenario/db';
import { brDate, type AttendanceConfig, openShifts } from '../attendance/common';
import { dateOnly, serviceOrderCode } from '../commercial/common';
import { weekCoverage } from '../finance/confirmations';
import { laborReviewCode } from '../finance/labor';
import { substitutionWhere } from '../measurements/service';
import { pendingQuantity } from '../purchasing/common';
import { purchaseShortages } from '../purchasing/shortages';

const shiftDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

const base = {
  serviceOrder: null,
  task: null,
  employee: null,
  solver: null,
  deadline: null,
  impacts: [] as string[],
} as const;

const anyOf = (perms: ReadonlySet<string>, ...names: string[]) => names.some((n) => perms.has(n));

/**
 * Fase 10 (plano principal) — decisões que já existiam no sistema, mas não chegavam à Central:
 * negociação de valores pendente (R2), revisão financeira aberta (R1), materiais a comprar,
 * chegadas de material aguardando conferência e expediente de dia anterior sem saída. Só
 * projeção (nada é gravado); cada item exige a permissão do domínio de onde vem e leva à tela em
 * que a ação canônica já existe.
 */
export async function managementAttention(
  prisma: PrismaClient,
  perms: ReadonlySet<string>,
  cfg: AttendanceConfig,
): Promise<AttentionItemDto[]> {
  const items: AttentionItemDto[] = [];

  if (perms.has('financeiro.ver')) {
    // Negociação: pedido do próprio profissional aguardando decisão (sem valores no item).
    const requests = await prisma.valueChangeRequest.findMany({
      where: { status: 'PENDENTE' },
      include: { beneficiary: { select: { id: true, displayName: true } } },
      orderBy: { createdAt: 'asc' },
    });
    for (const r of requests)
      items.push({
        ...base,
        key: `FINANCEIRO:negociacao:${r.id}`,
        type: 'FINANCEIRO',
        category: 'ACAO',
        title: `${valueChangeCode(r.number)} · ${r.beneficiary.displayName} pede alteração de valor`,
        description: r.reason,
        employee: { userId: r.beneficiary.id, displayName: r.beneficiary.displayName },
        priority: 'NORMAL',
        status: r.status,
        statusLabel: 'Aguardando decisão',
        at: r.createdAt.toISOString(),
        nextActions: ['Aprovar ou recusar no Fechamento semanal'],
        link: '/painel/financeiro?tab=fechamento',
      });
    // Revisão financeira (troca de titular, valor alterado…) ainda não resolvida.
    const reviews = await prisma.laborReview.findMany({
      where: { status: 'ABERTA' },
      include: { serviceOrder: { select: { id: true, number: true } } },
      orderBy: { createdAt: 'asc' },
    });
    for (const r of reviews)
      items.push({
        ...base,
        key: `FINANCEIRO:revisao:${r.id}`,
        type: 'FINANCEIRO',
        category: 'ACAO',
        title: `${laborReviewCode(r.number)} · revisão financeira da ${serviceOrderCode(r.serviceOrder.number)}`,
        description: r.reason,
        serviceOrder: { id: r.serviceOrder.id, code: serviceOrderCode(r.serviceOrder.number) },
        priority: 'NORMAL',
        status: r.status,
        statusLabel: 'Revisão aberta',
        at: r.createdAt.toISOString(),
        nextActions: ['Resolver a revisão em Financeiro → Produção e equipe'],
        link: '/painel/financeiro?tab=producao',
      });

    // F10-11/F10-13o e F10-12: a mesma leitura do Fechamento semanal (`buildClosingItems`) e as
    // mesmas regras de conferência e do portão D13 (`weekCoverage`). Sem valores nos itens.
    const week = closingWeekStart(cfg.today);
    const previous = shiftDays(week, -7);
    const [current, before] = await Promise.all([
      weekCoverage(prisma, week),
      weekCoverage(prisma, previous),
    ]);
    const closingLink = (weekStart: string, userId: string) =>
      `/painel/financeiro?tab=fechamento&semana=${weekStart}&profissional=${userId}`;
    for (const p of current) {
      // Semana corrente com valor devido e sem conferência VÁLIDA do profissional (nunca vista ou
      // que deixou de valer porque algo mudou). Exceção administrativa vigente não pede ação.
      if (p.state !== 'SEM_CONFIRMACAO' && p.state !== 'DESATUALIZADA') continue;
      const stale = p.state === 'DESATUALIZADA';
      items.push({
        ...base,
        key: `FINANCEIRO:confirmacao:${p.userId}`,
        type: 'FINANCEIRO',
        category: 'ATENCAO',
        title: `${p.displayName} · semana de ${brDate(week)} aguardando confirmação`,
        description: stale
          ? 'A semana mudou depois da conferência do profissional: a confirmação anterior não vale mais.'
          : 'O profissional ainda não conferiu os valores devidos da semana no tablet.',
        employee: { userId: p.userId, displayName: p.displayName },
        priority: 'NORMAL',
        status: p.state,
        statusLabel: stale ? 'Confirmação desatualizada' : 'Sem confirmação',
        at: new Date(`${week}T12:00:00Z`).toISOString(),
        nextActions: [
          'Pedir a conferência no tablet ou registrar exceção administrativa (com motivo)',
        ],
        link: closingLink(week, p.userId),
      });
    }
    // Pagável agora: coberto na semana corrente ou na anterior (o lote da semana anterior continua
    // aceito pelo portão D13). O mesmo item conta uma vez; o link abre a semana que o cobre.
    const people = new Map<string, { name: string; ids: Set<string>; week: string }>();
    for (const [weekStart, list] of [
      [week, current],
      [previous, before],
    ] as const)
      for (const p of list) {
        if (!p.available.length) continue;
        const entry = people.get(p.userId) ?? {
          name: p.displayName,
          ids: new Set(),
          week: weekStart,
        };
        for (const i of p.available) entry.ids.add(`${i.kind}:${i.id}`);
        people.set(p.userId, entry);
      }
    for (const [userId, p] of people)
      items.push({
        ...base,
        key: `FINANCEIRO:pagamento:${userId}`,
        type: 'FINANCEIRO',
        category: 'ACAO',
        title: `${p.name} · ${p.ids.size} pagamento(s) liberado(s) para pagar`,
        description:
          'Valores devidos, confirmados pelo profissional (ou liberados por exceção administrativa) e ainda com saldo.',
        employee: { userId, displayName: p.name },
        priority: 'NORMAL',
        status: 'DISPONIVEL',
        statusLabel: 'Pagamento disponível',
        at: new Date(`${p.week}T12:00:00Z`).toISOString(),
        nextActions: ['Registrar o pagamento no Fechamento semanal'],
        link: closingLink(p.week, userId),
      });
  }

  if (anyOf(perms, 'compras.ver', 'compras.gerenciar', 'compras.aprovar')) {
    // "A comprar": um item só (a lista consolidada já existe; aqui não se repete linha a linha).
    const shortages = (await purchaseShortages(prisma, { prices: false })).filter(
      (s) => s.suggestion > 0,
    );
    if (shortages.length) {
      const blocking = shortages.filter((s) => s.blocksProduction).length;
      items.push({
        ...base,
        key: 'MATERIAL:comprar',
        type: 'MATERIAL',
        category: blocking ? 'ACAO' : 'ATENCAO',
        title: `${shortages.length} material(is) a comprar`,
        description: blocking
          ? `${blocking} deles já seguram tarefas da produção.`
          : 'Nenhum deles segura a produção por enquanto.',
        priority: blocking ? 'ALTA' : 'NORMAL',
        status: 'A_COMPRAR',
        statusLabel: 'A comprar',
        at: new Date(`${cfg.today}T12:00:00Z`).toISOString(),
        nextActions: ['Conferir Compras → A comprar e emitir os pedidos'],
        link: '/painel/compras',
      });
    }
  }

  if (anyOf(perms, 'compras.ver', 'compras.gerenciar', 'compras.aprovar')) {
    // F10-08/F10-13d: compra confirmada com material ainda por chegar (saldo = quantidade −
    // recebido − encerrado, a mesma conta do pedido). Itens cuja chegada já foi registrada e
    // aguarda conferência ficam no item "chegada a conferir" (não aparecem duas vezes).
    const [orders, waiting] = await Promise.all([
      prisma.purchaseOrder.findMany({
        where: { status: { in: [...PURCHASE_ORDER_RECEIVABLE] } },
        select: {
          id: true,
          number: true,
          status: true,
          expectedDate: true,
          confirmedAt: true,
          createdAt: true,
          supplier: { select: { name: true } },
          items: {
            select: {
              id: true,
              quantity: true,
              receivedQuantity: true,
              closedQuantity: true,
              serviceOrder: { select: { id: true, number: true } },
            },
          },
        },
        orderBy: { number: 'asc' },
      }),
      prisma.materialArrival.findMany({
        where: { status: 'PENDENTE_CONFERENCIA' },
        select: { lines: true },
      }),
    ]);
    const arrived = new Set(
      waiting.flatMap((a) =>
        ((a.lines as { purchaseOrderItemId?: string }[] | null) ?? []).map(
          (l) => l.purchaseOrderItemId,
        ),
      ),
    );
    for (const po of orders) {
      const open = po.items.filter((i) => pendingQuantity(i) > 0 && !arrived.has(i.id));
      if (!open.length) continue;
      const late = po.expectedDate !== null && dateOnly(po.expectedDate)! < cfg.today;
      const sos = [
        ...new Map(
          open.flatMap((i) => (i.serviceOrder ? [i.serviceOrder] : [])).map((s) => [s.id, s]),
        ).values(),
      ];
      const code = purchaseOrderCode(po.number);
      items.push({
        ...base,
        key: `MATERIAL:aguardando-entrega:${po.id}`,
        type: 'MATERIAL',
        category: late ? 'ATENCAO' : 'INFO',
        title: `${code}${po.supplier ? ` · ${po.supplier.name}` : ''} — aguardando entrega`,
        description: `${open.length} item(ns) com saldo a receber${po.status === 'PARCIALMENTE_RECEBIDO' ? ' (recebimento parcial)' : ''}${po.expectedDate ? ` · previsão ${brDate(dateOnly(po.expectedDate)!)}${late ? ' (atrasada)' : ''}` : ' · sem previsão de entrega'}.`,
        serviceOrder:
          sos.length === 1 ? { id: sos[0]!.id, code: serviceOrderCode(sos[0]!.number) } : null,
        deadline: po.expectedDate ? dateOnly(po.expectedDate) : null,
        priority: late ? 'ALTA' : 'NORMAL',
        status: po.status,
        statusLabel: late ? 'Entrega atrasada' : 'Aguardando entrega',
        at: (po.confirmedAt ?? po.createdAt).toISOString(),
        nextActions: ['Acompanhar com o fornecedor; registrar o recebimento quando chegar'],
        link: `/painel/compras/${po.id}`,
      });
    }
  }

  if (perms.has('materiais.aprovar')) {
    // F10-13r: medição enviada para revisão que pode substituir necessidades ATIVAS da OS (Compras
    // Etapa 2). A decisão (substitui / nova / manter / cancelar) é feita na aprovação da medição;
    // aprovada, devolvida ou cancelada — ou sem necessidade ativa a substituir — o item some.
    const inReview = await prisma.materialRequest.findMany({
      where: { status: { in: [...REQUEST_AWAITING_REVIEW] } },
      select: {
        status: true,
        submittedAt: true,
        updatedAt: true,
        measurement: {
          select: {
            id: true,
            number: true,
            serviceOrderId: true,
            serviceOrderItemId: true,
            serviceOrder: { select: { number: true } },
          },
        },
      },
      orderBy: { updatedAt: 'asc' },
    });
    const scopes = await Promise.all(
      inReview.map((r) =>
        prisma.materialRequirement.count({ where: substitutionWhere(r.measurement) }),
      ),
    );
    inReview.forEach((r, i) => {
      const candidates = scopes[i]!;
      if (!candidates) return;
      const m = r.measurement;
      items.push({
        ...base,
        key: `MATERIAL:substituicao:${m.id}`,
        type: 'MATERIAL',
        category: 'ACAO',
        title: `${measurementCode(m.number)} · decidir substituição de material da ${serviceOrderCode(m.serviceOrder.number)}`,
        description: `A nova medição pode substituir ${candidates} necessidade(s) já aprovada(s): escolha, item a item, se substitui, é nova, mantém ou cancela.`,
        serviceOrder: { id: m.serviceOrderId, code: serviceOrderCode(m.serviceOrder.number) },
        priority: 'NORMAL',
        status: r.status,
        statusLabel: 'Aguardando decisão',
        at: (r.submittedAt ?? r.updatedAt).toISOString(),
        nextActions: ['Revisar a medição e decidir a substituição na aprovação'],
        link: `/painel/medicoes/${m.id}`,
      });
    });
  }

  if (anyOf(perms, 'estoque.ver', 'compras.ver', 'estoque.gerenciar')) {
    // F10-15: o título traz a contagem da fonte (count), não o tamanho de uma lista limitada.
    const pendingArrival = { status: 'PENDENTE_CONFERENCIA' };
    const [arrivalsTotal, arrivals] = await Promise.all([
      prisma.materialArrival.count({ where: pendingArrival }),
      prisma.materialArrival.findMany({
        where: pendingArrival,
        include: { purchaseOrder: { select: { number: true } } },
        orderBy: { receivedAt: 'asc' },
        take: 100,
      }),
    ]);
    if (arrivalsTotal)
      items.push({
        ...base,
        key: 'MATERIAL:conferencia',
        type: 'MATERIAL',
        category: 'ACAO',
        title: `${arrivalsTotal} chegada(s) de material aguardando conferência`,
        description: [...new Set(arrivals.map((a) => purchaseOrderCode(a.purchaseOrder.number)))]
          .slice(0, 5)
          .join(', '),
        priority: 'NORMAL',
        status: 'PENDENTE_CONFERENCIA',
        statusLabel: 'Aguardando conferência',
        at: arrivals[0]!.receivedAt.toISOString(),
        nextActions: ['Conferir a medida e registrar o recebimento'],
        link: '/painel/recebimento-materiais',
      });
  }

  if (perms.has('presenca.gerenciar')) {
    // Expediente de dia anterior sem saída (o sistema nunca inventa o horário).
    for (const a of await openShifts(prisma, cfg))
      items.push({
        ...base,
        key: `PRESENCA:expediente:${a.id}`,
        type: 'PRESENCA',
        category: 'ACAO',
        title: `${a.employee.displayName} · expediente de ${brDate(a.date.toISOString().slice(0, 10))} sem saída`,
        description: 'O expediente não foi encerrado. Registre o horário de saída informado.',
        employee: { userId: a.employee.userId, displayName: a.employee.displayName },
        priority: 'NORMAL',
        status: 'EXPEDIENTE_ABERTO',
        statusLabel: 'Sem encerramento',
        at: (a.arrivedAt ?? a.updatedAt).toISOString(),
        nextActions: ['Resolver em Presença da equipe (horário informado, nunca inventado)'],
        link: '/painel/presenca',
      });
  }
  return items;
}
