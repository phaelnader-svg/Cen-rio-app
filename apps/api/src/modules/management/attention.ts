import { purchaseOrderCode, valueChangeCode, type AttentionItemDto } from '@cenario/shared';
import type { PrismaClient } from '@cenario/db';
import { brDate, type AttendanceConfig, openShifts } from '../attendance/common';
import { serviceOrderCode } from '../commercial/common';
import { laborReviewCode } from '../finance/labor';
import { purchaseShortages } from '../purchasing/shortages';

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
      take: 100,
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
      take: 100,
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

  if (anyOf(perms, 'estoque.ver', 'compras.ver', 'estoque.gerenciar')) {
    const arrivals = await prisma.materialArrival.findMany({
      where: { status: 'PENDENTE_CONFERENCIA' },
      include: { purchaseOrder: { select: { number: true } } },
      orderBy: { receivedAt: 'asc' },
      take: 100,
    });
    if (arrivals.length)
      items.push({
        ...base,
        key: 'MATERIAL:conferencia',
        type: 'MATERIAL',
        category: 'ACAO',
        title: `${arrivals.length} chegada(s) de material aguardando conferência`,
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
