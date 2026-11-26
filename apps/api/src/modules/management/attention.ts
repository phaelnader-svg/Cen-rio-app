import { plural } from '@cenario/shared';
import {
  closingWeekStart,
  deliveryCode,
  valueChangeCode,
  type AttentionItemDto,
} from '@cenario/shared';
import type { PrismaClient } from '@cenario/db';
import { brDate, type AttendanceConfig, openShifts } from '../attendance/common';
import { pickupCode, serviceOrderCode } from '../commercial/common';
import { loadPipeline } from '../production/pre-planning';
import { weekCoverage } from '../finance/confirmations';
import { laborReviewCode } from '../finance/labor';

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
 * negociação de valores pendente (R2), revisão financeira aberta (R1) e expediente de dia
 * anterior sem saída. Só
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
          ? 'A semana mudou depois da conferência do funcionário: a confirmação anterior não vale mais.'
          : 'O funcionário ainda não conferiu os valores devidos da semana no tablet.',
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
        title: `${p.name} · ${plural(p.ids.size, 'pagamento liberado', 'pagamentos liberados')} para pagar`,
        description:
          'Valores devidos, confirmados pelo funcionário (ou liberados por exceção administrativa) e ainda com saldo.',
        employee: { userId, displayName: p.name },
        priority: 'NORMAL',
        status: 'DISPONIVEL',
        statusLabel: 'Pagamento disponível',
        at: new Date(`${p.week}T12:00:00Z`).toISOString(),
        nextActions: ['Registrar o pagamento no Fechamento semanal'],
        link: closingLink(p.week, userId),
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
    // Rodada 3 (F10-04): serviços fechados e ainda não planejados — a mesma etapa "A planejar"
    // do pipeline da Produção (fonte única). Um item agregado; planejou, sai da contagem.
    const pipeline = await loadPipeline(prisma);
    const toPlan = pipeline.items.filter((i) => i.stage === 'A_PLANEJAR');
    if (toPlan.length)
      items.push({
        ...base,
        key: 'PLANEJAMENTO:a-planejar',
        type: 'PLANEJAMENTO',
        category: 'ACAO',
        title: `${plural(toPlan.length, 'serviço', 'serviços')} aguardando planejamento`,
        description: 'Serviços fechados, sem semana nem tarefas planejadas.',
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
        title: `Próximos 3 dias: ${plural(pickups, 'retirada', 'retiradas')} e ${plural(deliveries, 'entrega', 'entregas')}`,
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
    // 2026-11-26: OS aberta de serviço "No local" cujo dia foi cancelado e nenhum outro marcado.
    const lost = await prisma.serviceOrder.findMany({
      where: {
        status: 'ABERTA',
        order: {
          status: { not: 'CANCELADO' },
          pickups: {
            some: { kind: 'NO_LOCAL', status: 'CANCELADA' },
            none: { kind: 'NO_LOCAL', status: { not: 'CANCELADA' } },
          },
          items: { some: { receivedQuantity: 0 } },
        },
      },
      select: { id: true, number: true, updatedAt: true, customer: { select: { name: true } } },
      orderBy: { number: 'asc' },
      take: 50,
    });
    for (const so of lost)
      items.push({
        ...base,
        key: `LOGISTICA:no-local-sem-dia:${so.id}`,
        type: 'LOGISTICA',
        category: 'ATENCAO',
        title: `${serviceOrderCode(so.number)} · ${so.customer.name}: serviço no local sem dia marcado`,
        description: 'O dia do serviço no local foi cancelado e nenhum outro foi marcado.',
        serviceOrder: { id: so.id, code: serviceOrderCode(so.number) },
        priority: 'NORMAL',
        status: 'SEM_DIA',
        statusLabel: 'Sem dia marcado',
        at: so.updatedAt.toISOString(),
        nextActions: ['Marcar novo dia no pedido ou cancelar a OS'],
        link: `/painel/os/${so.id}`,
      });
  }

  if (pickupsView || deliveriesView) {
    // 2026-11-26: retirada ou entrega ainda por fazer com responsável desligado.
    const [pickups, deliveries] = await Promise.all([
      pickupsView
        ? prisma.pickupRequest.findMany({
            where: {
              status: {
                in: ['AGUARDANDO_AGENDAMENTO', 'AGENDADA', 'EM_EXECUCAO', 'COM_OCORRENCIA'],
              },
              logisticsUser: { active: false },
            },
            select: {
              id: true,
              number: true,
              updatedAt: true,
              logisticsUser: { select: { id: true, displayName: true } },
            },
            take: 50,
          })
        : [],
      deliveriesView
        ? prisma.delivery.findMany({
            where: {
              status: { in: ['PROVISORIA', 'AGENDADA', 'EM_TRANSPORTE', 'NO_DESTINO'] },
              responsible: { active: false },
            },
            select: {
              id: true,
              number: true,
              updatedAt: true,
              responsible: { select: { id: true, displayName: true } },
            },
            take: 50,
          })
        : [],
    ]);
    for (const p of pickups)
      items.push({
        ...base,
        key: `LOGISTICA:responsavel-desligado:retirada:${p.id}`,
        type: 'LOGISTICA',
        category: 'ACAO',
        title: `${pickupCode(p.number)} · responsável desligado (${p.logisticsUser!.displayName})`,
        description: 'Escolha outro responsável para a retirada.',
        priority: 'NORMAL',
        status: 'SEM_RESPONSAVEL',
        statusLabel: 'Sem responsável ativo',
        at: p.updatedAt.toISOString(),
        nextActions: ['Trocar o responsável na retirada'],
        link: `/painel/retiradas?foco=${p.id}`,
      });
    for (const d of deliveries)
      items.push({
        ...base,
        key: `LOGISTICA:responsavel-desligado:entrega:${d.id}`,
        type: 'LOGISTICA',
        category: 'ACAO',
        title: `${deliveryCode(d.number)} · responsável desligado (${d.responsible!.displayName})`,
        description: 'Escolha outro responsável para a entrega.',
        priority: 'NORMAL',
        status: 'SEM_RESPONSAVEL',
        statusLabel: 'Sem responsável ativo',
        at: d.updatedAt.toISOString(),
        nextActions: ['Trocar o responsável na entrega'],
        link: `/painel/entregas/${d.id}`,
      });
  }

  return items;
}
