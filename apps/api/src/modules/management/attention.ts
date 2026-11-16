import {
  PURCHASE_ORDER_RECEIVABLE,
  REQUEST_AWAITING_REVIEW,
  closingWeekStart,
  measurementCode,
  purchaseOrderCode,
  valueChangeCode,
  type AttentionItemDto,
  DRAFT_STALE_DAYS,
  draftAgeDays,
} from '@cenario/shared';
import type { PrismaClient } from '@cenario/db';
import { brDate, type AttendanceConfig, openShifts } from '../attendance/common';
import {
  dateOnly,
  orderCode,
  pickupCode,
  receiptCode,
  serviceOrderCode,
} from '../commercial/common';
import { loadPipeline } from '../production/pre-planning';
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
    // F10-18: decidir a negociação exige `financeiro.ajustes` (a mesma permissão da aprovação).
    if (perms.has('financeiro.ajustes'))
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
          link: `/painel/financeiro?tab=fechamento&profissional=${r.beneficiary.id}&foco=${r.id}`,
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
        link: `/painel/financeiro?tab=producao&foco=${r.id}`,
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

  if (anyOf(perms, 'compras.ver', 'compras.gerenciar', 'compras.aprovar')) {
    // F6-14 (D10): o rascunho desconta "A comprar"; parado há DRAFT_STALE_DAYS dias da oficina ou
    // mais, vira aviso (a data é a criação do rascunho). Confirmado ou cancelado, some.
    const drafts = await prisma.purchaseOrder.findMany({
      where: { status: 'RASCUNHO' },
      select: {
        id: true,
        number: true,
        createdAt: true,
        supplier: { select: { name: true } },
        _count: { select: { items: true } },
      },
      orderBy: { createdAt: 'asc' },
    });
    for (const po of drafts) {
      const days = draftAgeDays(po.createdAt, cfg.today, cfg.timezone);
      if (days < DRAFT_STALE_DAYS) continue;
      items.push({
        ...base,
        key: `MATERIAL:rascunho:${po.id}`,
        type: 'MATERIAL',
        category: 'ATENCAO',
        title: `${purchaseOrderCode(po.number)}${po.supplier ? ` · ${po.supplier.name}` : ''} — em rascunho há ${days} dias`,
        description: `${po._count.items} item(ns) contados como "em rascunho" em A comprar: confirme a compra ou cancele o rascunho.`,
        priority: 'NORMAL',
        status: 'RASCUNHO',
        statusLabel: `Rascunho há ${days} dias`,
        at: po.createdAt.toISOString(),
        nextActions: ['Confirmar o pedido com o fornecedor ou cancelar o rascunho'],
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
        link: `/painel/presenca?foco=${a.id}`,
      });
  }

  if (anyOf(perms, 'producao.planejar', 'producao.ver')) {
    // Rodada 3 (F10-04): serviços já recebidos e ainda não planejados — a mesma etapa "A planejar"
    // do pipeline da Produção (fonte única). Um item agregado; planejou, sai da contagem.
    const pipeline = await loadPipeline(prisma);
    const toPlan = pipeline.items.filter((i) => i.stage === 'A_PLANEJAR');
    if (toPlan.length)
      items.push({
        ...base,
        key: 'PLANEJAMENTO:a-planejar',
        type: 'PLANEJAMENTO',
        category: 'ACAO',
        title: `${toPlan.length} serviço(s) aguardando planejamento`,
        description: 'Peças já na oficina, sem semana nem tarefas planejadas.',
        impacts: toPlan.slice(0, 5).map((i) => `${i.serviceOrder.code} · ${i.customerName}`),
        priority: 'NORMAL',
        status: 'A_PLANEJAR',
        statusLabel: 'A planejar',
        at: new Date(`${cfg.today}T12:00:00Z`).toISOString(),
        nextActions: ['Planejar em Produção → A planejar'],
        link: '/painel/producao/a-planejar',
      });
  }

  const pickupsView = anyOf(perms, 'retiradas.ver', 'retiradas.gerenciar');
  const deliveriesView = anyOf(perms, 'entregas.ver', 'entregas.gerenciar');
  if (pickupsView || deliveriesView) {
    // Rodada 3 (F10-05): retiradas e entregas dos próximos dias (hoje + 2), para o roteiro.
    const from = new Date(`${cfg.today}T00:00:00.000Z`);
    const to = new Date(`${shiftDays(cfg.today, 2)}T00:00:00.000Z`);
    const [pickups, deliveries] = await Promise.all([
      pickupsView
        ? prisma.pickupRequest.count({
            where: {
              status: { in: ['AGENDADA', 'EM_EXECUCAO'] },
              scheduledDate: { gte: from, lte: to },
            },
          })
        : 0,
      deliveriesView
        ? prisma.delivery.count({
            where: { status: 'AGENDADA', scheduledDate: { gte: from, lte: to } },
          })
        : 0,
    ]);
    if (pickups + deliveries > 0)
      items.push({
        ...base,
        key: 'LOGISTICA:proximas',
        type: 'LOGISTICA',
        category: 'INFO',
        title: `Próximos 3 dias: ${pickups} retirada(s) e ${deliveries} entrega(s)`,
        description: 'Agendadas de hoje até depois de amanhã.',
        priority: 'NORMAL',
        status: 'AGENDADA',
        statusLabel: 'Agendadas',
        at: new Date(`${cfg.today}T12:00:00Z`).toISOString(),
        nextActions: ['Conferir o roteiro do dia'],
        link: `/painel/roteiro?data=${cfg.today}`,
      });
  }

  if (pickupsView) {
    // Rodada 3 (F10-06): retirada feita (peças coletadas) que ainda não chegou toda à oficina —
    // recebimento aguardado fora da janela de prazo. Recebida por completo ou cancelada, some.
    const collected = await prisma.pickupRequest.findMany({
      where: { status: 'RETIRADA_REALIZADA' },
      select: {
        id: true,
        number: true,
        updatedAt: true,
        order: { select: { number: true, customer: { select: { name: true } } } },
      },
      orderBy: { updatedAt: 'asc' },
    });
    for (const p of collected)
      items.push({
        ...base,
        key: `LOGISTICA:aguardando-chegada:${p.id}`,
        type: 'LOGISTICA',
        category: 'ATENCAO',
        title: `${pickupCode(p.number)} · ${p.order.customer.name} — retirada feita, peças aguardando chegada`,
        description: `Pedido ${orderCode(p.order.number)}: registrar o recebimento quando as peças chegarem à oficina.`,
        priority: 'NORMAL',
        status: 'RETIRADA_REALIZADA',
        statusLabel: 'Aguardando chegada',
        at: p.updatedAt.toISOString(),
        nextActions: ['Registrar o recebimento das peças'],
        link: `/painel/retiradas?foco=${p.id}`,
      });
  }

  if (anyOf(perms, 'pedidos.ver', 'recebimentos.registrar', 'os.ver')) {
    // Rodada 3 (F1-15a): divergência/avaria registrada no recebimento de PEÇA de cliente fica
    // visível enquanto o serviço está ativo (pedido não cancelado e OS aberta com peça ainda não
    // entregue, ou ainda sem OS). Encerrado o serviço, o registro segue no recebimento/linha do
    // tempo, mas sai da Central.
    const receipts = await prisma.receipt.findMany({
      where: {
        divergences: { not: null },
        order: {
          status: { not: 'CANCELADO' },
          OR: [
            { serviceOrders: { none: {} } },
            {
              serviceOrders: {
                some: {
                  status: 'ABERTA',
                  items: {
                    some: { fulfillmentStage: { notIn: ['ENTREGUE', 'DEVOLVIDA', 'CANCELADA'] } },
                  },
                },
              },
            },
          ],
        },
      },
      select: {
        id: true,
        number: true,
        divergences: true,
        receivedAt: true,
        order: { select: { id: true, number: true, customer: { select: { name: true } } } },
      },
      orderBy: { receivedAt: 'desc' },
    });
    for (const r of receipts) {
      if (!r.divergences?.trim()) continue;
      items.push({
        ...base,
        key: `RECEBIMENTO:divergencia:${r.id}`,
        type: 'RECEBIMENTO',
        category: 'ATENCAO',
        title: `${receiptCode(r.number)} · ${r.order.customer.name} — peça recebida com divergência`,
        description: r.divergences.slice(0, 300),
        priority: 'NORMAL',
        status: 'DIVERGENCIA',
        statusLabel: 'Divergência registrada',
        at: r.receivedAt.toISOString(),
        nextActions: [
          'Conferir a divergência com o cliente e registrar o encaminhamento no pedido',
        ],
        link: `/painel/pedidos/${r.order.id}`,
      });
    }
  }
  return items;
}
