/**
 * Motores dos agentes do escritório. O Gerente raciocina sobre os dados do
 * Cenário Gestão com regras explícitas (sem modelo de linguagem externo): cada recomendação cita
 * os registros que a justificam (OS, tarefa, material, conta). Os demais papéis informam o que
 * falta configurar e trabalham apenas com as instruções e os dados liberados.
 *
 * Nenhuma ação é executada aqui: o agente devolve PROPOSTAS (pendentes de aprovação).
 */
import { requireCompanyId } from '../../core/tenant';
import {
  type AgentReference,
  DEADLINE_REASON_LABEL,
  DEADLINE_STATE_LABEL,
  formatServiceOrderItemCode,
} from '@cenario/shared';
import type { PrismaClient } from '@cenario/db';
import { now as clockNow } from '../../core/clock';
import { serviceOrderCode } from '../commercial/common';
import { serviceDeadlines } from '../deadlines/service';
import { buildClosingItems } from '../finance/closing';
import { dueContext, dueOf } from '../finance/revenue';
import { num } from './common';
import { purchaseNeeds } from './agent-office';

export interface AgentContext {
  prisma: PrismaClient;
  permissions: ReadonlySet<string>;
  dataScopes: string[];
  policies: Record<string, string>;
}

export interface ProposalDraft {
  kind: string;
  title: string;
  detail: string;
  payload: Record<string, unknown>;
  evidence: AgentReference[];
}

export interface AgentAnswer {
  content: string;
  references: AgentReference[];
  proposals: ProposalDraft[];
  tasks: { label: string; detail: string; tone: 'risco' | 'atencao' | 'ok' }[];
}

const money = (cents: number) =>
  (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** Próximos 7 dias a partir de hoje (no fuso da empresa): "a semana" do plano. */
function weekRange(timezone: string) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(clockNow());
  const end = new Date(`${today}T12:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 6);
  return { today, start: today, end: end.toISOString().slice(0, 10) };
}

const can = (ctx: AgentContext, scope: string, ...perms: string[]) =>
  ctx.dataScopes.includes(scope) && perms.some((p) => ctx.permissions.has(p));

const dedupe = (refs: AgentReference[]) =>
  refs.filter((r, i) => refs.findIndex((x) => x.type === r.type && x.id === r.id) === i);

/**
 * Gerente: cruza fila, capacidade, materiais, entregas e financeiro num plano semanal.
 * Responde: o que cada pessoa está fazendo, quais OS correm risco, o que comprar e quanto
 * receber para cobrir as contas da semana.
 */
export async function managerAnswer(ctx: AgentContext, question: string): Promise<AgentAnswer> {
  if (!can(ctx, 'producao', 'producao.ver', 'producao.planejar'))
    return blocked('Gerente', 'produção');
  const { prisma } = ctx;
  const settings = await prisma.companySettings.findUnique({ where: { id: requireCompanyId() } });
  const week = weekRange(settings?.timezone ?? 'America/Sao_Paulo');
  const refs: AgentReference[] = [];
  const tasks: AgentAnswer['tasks'] = [];
  const out: string[] = [
    `Plano dos próximos 7 dias (${week.start.split('-').reverse().join('/')} a ${week.end.split('-').reverse().join('/')}).`,
  ];

  // 1. Equipe: tarefa em execução e tamanho da fila.
  const people = await prisma.employee.findMany({
    where: {
      active: true,
      user: {
        active: true,
        roles: {
          some: { role: { key: { in: ['tapeceiro', 'ajudante', 'cabeceiras_qualidade'] } } },
        },
      },
    },
    orderBy: { displayName: 'asc' },
  });
  const open = await prisma.productionTask.findMany({
    where: {
      assigneeUserId: { in: people.map((p) => p.userId) },
      status: { in: ['EM_EXECUCAO', 'PAUSADA', 'LIBERADA', 'PROGRAMADA', 'BLOQUEADA'] },
    },
    include: {
      serviceOrder: { select: { number: true } },
      serviceOrderItem: { select: { position: true } },
    },
  });
  out.push('', 'Equipe agora:');
  for (const p of people) {
    const mine = open.filter((t) => t.assigneeUserId === p.userId);
    const run =
      mine.find((t) => t.status === 'EM_EXECUCAO') ?? mine.find((t) => t.status === 'PAUSADA');
    const ready = mine.filter((t) => t.status === 'LIBERADA').length;
    const waiting = mine.filter((t) => ['PROGRAMADA', 'BLOQUEADA'].includes(t.status)).length;
    const minutes = mine.reduce((s, t) => s + (t.estimatedMinutes ?? 0), 0);
    out.push(
      `• ${p.displayName}: ${run ? `${run.status === 'PAUSADA' ? 'pausado em' : 'fazendo'} ${run.title} (${serviceOrderCode(run.serviceOrder.number)}${run.serviceOrderItem ? `/${run.serviceOrderItem.position}` : ''})` : 'sem tarefa iniciada'}; fila: ${ready} pronta(s), ${waiting} aguardando${minutes ? `, ~${Math.round(minutes / 60)} h estimadas` : ''}.`,
    );
    if (run)
      refs.push({
        type: 'TAREFA',
        id: run.id,
        label: `TP-${String(run.number).padStart(5, '0')}`,
        href: `/painel/producao/tarefas/${run.id}`,
      });
    if (!run && !ready)
      tasks.push({
        label: `${p.displayName} sem trabalho liberado`,
        detail: 'Planeje ou libere a próxima etapa.',
        tone: 'atencao',
      });
  }

  // 2. Prazos: OS em risco (regra oficial de prazos).
  const deadlines = await serviceDeadlines(prisma, { status: 'ABERTA' });
  const so = await prisma.serviceOrder.findMany({
    where: { id: { in: [...deadlines.keys()] } },
    select: { id: true, number: true, customer: { select: { name: true } } },
  });
  const risky = [...deadlines.entries()]
    .filter(([, d]) => d.state === 'ATRASADO' || d.state === 'EM_RISCO' || d.state === 'PROXIMO')
    .sort((a, b) => (a[1].workingDays ?? 999) - (b[1].workingDays ?? 999));
  out.push('', risky.length ? 'OS que pedem atenção:' : 'Nenhuma OS em risco de prazo.');
  for (const [id, d] of risky.slice(0, 8)) {
    const s = so.find((x) => x.id === id);
    if (!s) continue;
    const code = serviceOrderCode(s.number);
    out.push(
      `• ${code}${ctx.permissions.has('os.ver') ? ` (${s.customer.name})` : ''}: ${DEADLINE_STATE_LABEL[d.state]}` +
        `${d.promisedDate ? `, prazo ${d.promisedDate.split('-').reverse().join('/')}` : ''}` +
        `${d.workingDays !== null ? ` (${d.workingDays} dia(s) útil(eis))` : ''}` +
        `${d.reasons.length ? ` — ${d.reasons.map((r) => DEADLINE_REASON_LABEL[r]).join(', ')}` : ''}.`,
    );
    refs.push({ type: 'OS', id, label: code, href: `/painel/os/${id}` });
    tasks.push({
      label: `${code} · ${DEADLINE_STATE_LABEL[d.state]}`,
      detail: d.reasons.map((r) => DEADLINE_REASON_LABEL[r]).join(', ') || 'Acompanhar',
      tone: d.state === 'ATRASADO' || d.state === 'EM_RISCO' ? 'risco' : 'atencao',
    });
  }

  // 3. Materiais das listas das OS que ainda faltam comprar.
  const proposals: ProposalDraft[] = [];
  if (ctx.dataScopes.includes('compras') || ctx.dataScopes.includes('estoque')) {
    const needs = await purchaseNeeds(prisma);
    out.push(
      '',
      needs.length
        ? `Materiais a comprar (${needs.length}):`
        : 'Materiais: nada a comprar nas listas das OS abertas.',
    );
    for (const n of needs.slice(0, 6)) {
      out.push(
        `• ${n.description}${n.quantity ? ` — ${n.quantity}` : ''} para ${n.osCode}${n.promisedDate ? ` (prazo ${n.promisedDate.split('-').reverse().join('/')})` : ''}.`,
      );
      refs.push({
        type: 'OS',
        id: n.serviceOrderId,
        label: n.osCode,
        href: `/painel/os/${n.serviceOrderId}?aba=materiais`,
      });
    }
    if (needs.length) out.push('O agente de Compras prepara o pedido de cada fornecedor.');
  }

  // 4. Dinheiro: contas da semana × recebimentos, separando o que é certo do que depende de algo.
  if (can(ctx, 'financeiro', 'financeiro.ver')) {
    const end = new Date(`${week.end}T00:00:00Z`);
    const [payables, receivables] = await Promise.all([
      prisma.accountPayable.findMany({
        where: { status: { in: ['ABERTO', 'PARCIAL'] }, dueDate: { lte: end } },
        orderBy: { dueDate: 'asc' },
      }),
      prisma.customerReceivable.findMany({
        where: { status: { in: ['ABERTO', 'PARCIAL'] } },
        include: { order: { select: { number: true } } },
        orderBy: { dueDate: 'asc' },
      }),
    ]);
    const dctx = await dueContext(
      prisma,
      receivables.map((r) => r.orderId),
    );
    const open = (r: (typeof receivables)[number]) => r.amountCents - r.receivedCents;
    const overdue = receivables.filter((r) => dueOf(r, dctx).overdue);
    const confirmed = receivables.filter(
      (r) => !overdue.includes(r) && r.dueTrigger === 'DATA' && r.dueDate && r.dueDate <= end,
    );
    const onEvent = receivables.filter((r) => !overdue.includes(r) && r.dueTrigger !== 'DATA');
    const sum = (xs: typeof receivables) => xs.reduce((s, r) => s + open(r), 0);
    const toPay = payables.reduce((s, p) => s + p.amountCents - p.paidCents, 0);
    const overduePay = payables.filter((p) => p.dueDate < new Date(`${week.start}T00:00:00Z`));
    // Pagamento por produção: fechamento oficial da semana (obrigações devidas aos profissionais).
    let labor = 0;
    let laborItems: { code: string; who: string; cents: number }[] = [];
    try {
      const monday = (() => {
        const d = new Date(`${week.start}T12:00:00Z`);
        d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
        return d.toISOString().slice(0, 10);
      })();
      const built = await buildClosingItems(prisma, monday);
      laborItems = built.items
        .filter((i) => i.kind === 'MAO_DE_OBRA' && i.state === 'DEVIDO' && i.currentOpenCents > 0)
        .map((i) => ({ code: i.code, who: i.beneficiary.displayName, cents: i.currentOpenCents }));
      labor = laborItems.reduce((s, i) => s + i.cents, 0);
    } catch {
      laborItems = [];
    }
    const certain = sum(overdue) + sum(confirmed);
    const totalOut = toPay + labor;
    out.push('', `Caixa da semana (até ${week.end.split('-').reverse().join('/')}):`);
    out.push(
      '• Saldo bancário inicial: não cadastrado — o cálculo abaixo é a diferença entre contas e recebimentos previstos, não o caixa real.',
    );
    out.push(
      `• A pagar: ${money(toPay)} em ${payables.length} conta(s)${overduePay.length ? `, das quais ${money(overduePay.reduce((s, p) => s + p.amountCents - p.paidCents, 0))} já vencidas` : ''}${labor ? ` + ${money(labor)} de produção devida (fechamento semanal)` : ''}.`,
    );
    out.push(`• A receber vencido (cobrar já): ${money(sum(overdue))} (${overdue.length}).`);
    out.push(
      `• A receber com data nesta semana (confirmado no cadastro): ${money(sum(confirmed))} (${confirmed.length}).`,
    );
    out.push(
      `• A receber condicionado à entrega/retirada: ${money(sum(onEvent))} (${onEvent.length}) — só entra se a entrega acontecer.`,
    );
    out.push(
      certain >= totalOut
        ? `• Diferença com o que é certo: sobra ${money(certain - totalOut)}.`
        : `• Diferença com o que é certo: faltam ${money(totalOut - certain)}${sum(onEvent) ? `; com as entregas previstas, ${certain + sum(onEvent) >= totalOut ? `sobra ${money(certain + sum(onEvent) - totalOut)}` : `ainda faltam ${money(totalOut - certain - sum(onEvent))}`}` : ''}. Cobre os vencidos primeiro e priorize entregas com saldo.`,
    );
    for (const p of payables.slice(0, 6))
      refs.push({
        type: 'CONTA',
        id: p.id,
        label: `Conta: ${p.description} (${money(p.amountCents - p.paidCents)}, vence ${p.dueDate.toISOString().slice(0, 10).split('-').reverse().join('/')})`,
        href: '/painel/financeiro?aba=contas',
      });
    for (const [kind, xs] of [
      ['vencido', overdue],
      ['data', confirmed],
      ['entrega', onEvent],
    ] as const)
      for (const r of xs.slice(0, 4))
        refs.push({
          type: 'RECEBIVEL',
          id: r.id,
          label: `Recebível (${kind}): PED-${String(r.order.number).padStart(5, '0')} ${r.description} (${money(open(r))})`,
          href: '/painel/financeiro?aba=receitas',
        });
    for (const l of laborItems.slice(0, 4))
      refs.push({
        type: 'CONTA',
        id: l.code,
        label: `Produção devida ${l.code}: ${l.who} (${money(l.cents)})`,
        href: '/painel/financeiro/fechamento',
      });
  } else if (ctx.dataScopes.includes('financeiro')) {
    out.push(
      '',
      'Caixa: sua conta não tem permissão de ver o financeiro; deixei essa parte de fora.',
    );
  }

  // 5. OS não planejadas com peças na oficina → proposta de planejamento (aprovação do gestor).
  const unplanned = await prisma.serviceOrder.findMany({
    where: { status: 'ABERTA', productionPlanItems: { none: {} }, productionTasks: { none: {} } },
    include: { items: { include: { upholsterer: { select: { displayName: true } } } } },
    orderBy: [{ priority: 'desc' }, { promisedDate: 'asc' }],
    take: 5,
  });
  if (unplanned.length) {
    out.push(
      '',
      `Ainda sem planejamento: ${unplanned.map((u) => serviceOrderCode(u.number)).join(', ')}.`,
    );
    if ((ctx.policies.atribuir_tarefa ?? 'PROPOR') !== 'NUNCA')
      for (const u of unplanned.slice(0, 3))
        proposals.push({
          kind: 'PLANEJAR_OS',
          title: `Planejar ${serviceOrderCode(u.number)}`,
          detail: `Escolher o tapeceiro de cada peça e a data de início no planejamento oficial. Peças: ${u.items.map((i) => `${formatServiceOrderItemCode(u.number, i.position)} ${i.description}${i.upholsterer ? ` (titular ${i.upholsterer.displayName})` : ''}`).join('; ')}.`,
          payload: { serviceOrderId: u.id, href: '/painel/producao/planejamento' },
          evidence: [
            { type: 'OS', id: u.id, label: serviceOrderCode(u.number), href: `/painel/os/${u.id}` },
          ],
        });
  }
  // 6. OS prontas: a ação atual é entregar e receber o saldo (conforme os registros).
  const ready = await prisma.serviceOrder.findMany({
    where: {
      status: 'ABERTA',
      items: {
        some: {
          fulfillmentStage: { in: ['PRONTA_ENTREGA', 'ENTREGA_AGENDADA', 'BLOQUEIO_EXPEDICAO'] },
        },
      },
    },
    include: { items: { select: { fulfillmentStage: true } } },
    take: 6,
  });
  if (ready.length) {
    out.push('', 'Prontas na expedição:');
    for (const so of ready) {
      let saldo = '';
      if (can(ctx, 'financeiro', 'financeiro.ver')) {
        const { orderRevenue } = await import('../finance/revenue');
        const rev = await orderRevenue(prisma, so.orderId);
        const open = Math.max(0, (rev.finalCents ?? 0) - rev.receivedCents);
        saldo = open > 0 ? `; cobrar saldo de ${money(open)} na entrega` : '; pedido quitado';
      }
      const scheduled = so.items.some((i) => i.fulfillmentStage === 'ENTREGA_AGENDADA');
      const blocked = so.items.some((i) => i.fulfillmentStage === 'BLOQUEIO_EXPEDICAO');
      out.push(
        `• ${serviceOrderCode(so.number)}: ${blocked ? 'expedição bloqueada — resolver o bloqueio' : scheduled ? 'entrega agendada — acompanhar' : 'agendar a entrega'}${saldo}.`,
      );
      refs.push({
        type: 'OS',
        id: so.id,
        label: serviceOrderCode(so.number),
        href: `/painel/os/${so.id}`,
      });
    }
  }
  if (/compr|falt|materia/i.test(question) && !ctx.dataScopes.includes('compras'))
    out.push(
      '',
      'Para detalhar compras, libere o escopo "compras" para mim ou pergunte ao agente de Compras.',
    );
  out.push('', 'Cada item acima vem dos registros citados; nada foi alterado.');
  return { content: out.join('\n'), references: dedupe(refs), proposals, tasks: tasks.slice(0, 8) };
}

function blocked(role: string, scope: string): AgentAnswer {
  return {
    content: `Como ${role}, preciso do escopo de dados "${scope}" liberado na minha configuração e de uma conta com permissão para vê-lo.`,
    references: [],
    proposals: [],
    tasks: [
      { label: 'Configuração incompleta', detail: `Liberar escopo ${scope}`, tone: 'atencao' },
    ],
  };
}

export function integrationPendingAnswer(
  roleLabel: string,
  integrations: string[],
  instructions: string,
): AgentAnswer {
  return {
    content: [
      `Sou o agente de ${roleLabel}. Ainda não consigo trabalhar sozinho: ${integrations.length ? `falta configurar ${integrations.join(', ')}` : 'minha função ainda não tem um motor de dados nesta versão'}.`,
      'Enquanto isso, guardo suas instruções e não envio, publico, compro, pago nem emito nada.',
      instructions
        ? `Instruções atuais: "${instructions.slice(0, 300)}${instructions.length > 300 ? '…' : ''}"`
        : 'Sem instruções ainda: edite minha configuração.',
    ].join('\n'),
    references: [],
    proposals: [],
    tasks: integrations.map((i) => ({
      label: `Configurar ${i}`,
      detail: 'Integração externa pendente',
      tone: 'atencao' as const,
    })),
  };
}

export { num };
