/**
 * Motores dos agentes do escritório. Nesta versão, Gerente e Compras raciocinam sobre os dados do
 * Cenário Gestão com regras explícitas (sem modelo de linguagem externo): cada recomendação cita
 * os registros que a justificam (OS, tarefa, material, conta). Os demais papéis informam o que
 * falta configurar e trabalham apenas com as instruções e os dados liberados.
 *
 * Nenhuma ação é executada aqui: o agente devolve PROPOSTAS (pendentes de aprovação).
 */
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
import { requirementsWithProgress, specOf, stockSpecKey } from '../purchasing/common';
import { num } from './common';

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
const q = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 3 });
const UNIT: Record<string, string> = {
  METRO: 'm',
  METRO_QUADRADO: 'm²',
  PLACA: 'placa(s)',
  PECA: 'peça(s)',
  UNIDADE: 'un.',
  EMBALAGEM: 'emb.',
};

/** Próximos 7 dias a partir de hoje (no fuso da empresa): "a semana" do plano. */
function weekRange(timezone: string) {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(clockNow());
  const end = new Date(`${today}T12:00:00Z`);
  end.setUTCDate(end.getUTCDate() + 6);
  return { today, start: today, end: end.toISOString().slice(0, 10) };
}

const can = (ctx: AgentContext, scope: string, ...perms: string[]) =>
  ctx.dataScopes.includes(scope) && perms.some((p) => ctx.permissions.has(p));

/** Faltas de material das OS abertas (necessidade aprovada − coberto), da regra oficial. */
export async function shortages(prisma: PrismaClient) {
  const heads = await requirementsWithProgress(prisma, {
    status: 'ATIVA',
    serviceOrder: { status: 'ABERTA' },
    origin: { in: ['SOLICITACAO_APROVADA', 'PREVISAO_COMPRA'] },
  });
  const so = await prisma.serviceOrder.findMany({
    where: { id: { in: heads.map((h) => h.r.serviceOrderId!).filter(Boolean) } },
    select: {
      id: true,
      number: true,
      promisedDate: true,
      priority: true,
      materialsReadiness: true,
    },
  });
  const tasks = await prisma.productionTask.findMany({
    where: {
      serviceOrderId: { in: so.map((s) => s.id) },
      status: { in: ['BLOQUEADA', 'PROGRAMADA'] },
      blockers: { has: 'MATERIAIS' },
    },
    select: { serviceOrderId: true },
  });
  const blocked = new Set(tasks.map((t) => t.serviceOrderId));
  // Saldo livre no estoque para necessidades de estoque (mesma especificação do catálogo).
  const stock = await prisma.stockItem.findMany({ where: { active: true } });
  const freeByKey = new Map(
    stock.map((it) => [
      stockSpecKey(specOf(it, it.unit)),
      { id: it.id, free: num(it.onHand) - num(it.reserved) },
    ]),
  );
  return heads
    .map(({ r, p }) => {
      const s = so.find((x) => x.id === r.serviceOrderId);
      const missing = Math.max(0, Math.round((p.need - p.covered - p.awaiting) * 1000) / 1000);
      return {
        requirementId: r.id,
        serviceOrderId: r.serviceOrderId!,
        osCode: s ? serviceOrderCode(s.number) : '—',
        promisedDate: s?.promisedDate?.toISOString().slice(0, 10) ?? null,
        priority: s?.priority ?? 'NORMAL',
        description: [
          r.description,
          r.color,
          r.foamDensity && !r.description.includes(r.foamDensity) ? r.foamDensity : null,
        ]
          .filter(Boolean)
          .join(' '),
        kind: r.kind,
        sourcing: r.sourcing,
        unit: r.unitCode ?? 'UNIDADE',
        missing,
        awaiting: p.awaiting,
        blocksProduction: blocked.has(r.serviceOrderId!),
        stock:
          r.sourcing === 'ESTOQUE' && r.unitCode
            ? (freeByKey.get(stockSpecKey(specOf(r, r.unitCode))) ?? null)
            : null,
      };
    })
    .filter((x) => x.missing > 0 || x.awaiting > 0);
}

/** Compras: prioriza o que libera OS (tarefa bloqueada por material) e evita atraso. */
export async function purchasingAnswer(ctx: AgentContext, question: string): Promise<AgentAnswer> {
  if (!can(ctx, 'compras', 'compras.ver', 'compras.gerenciar', 'estoque.ver'))
    return blocked('Compras', 'compras');
  const all = await shortages(ctx.prisma);
  // Primeiro o que o estoque já cobre (reservar), depois o que precisa comprar.
  const free = new Map<string, number>();
  for (const s of all) if (s.stock) free.set(s.stock.id, Math.max(0, s.stock.free));
  const reserve: ((typeof all)[number] & { qty: number })[] = [];
  const toBuy: ((typeof all)[number] & { qty: number })[] = [];
  const prio = (s: (typeof all)[number]) =>
    (s.blocksProduction ? 0 : 1000) +
    (s.priority === 'URGENTE' ? 0 : s.priority === 'ALTA' ? 100 : 300) +
    (s.promisedDate ? Math.max(0, (Date.parse(s.promisedDate) - Date.now()) / 86_400_000) : 500);
  for (const s of [...all].filter((x) => x.missing > 0).sort((a, b) => prio(a) - prio(b))) {
    const avail = s.stock ? (free.get(s.stock.id) ?? 0) : 0;
    const take = Math.min(avail, s.missing);
    if (take > 0) {
      reserve.push({ ...s, qty: take });
      free.set(s.stock!.id, avail - take);
    }
    if (s.missing - take > 1e-9)
      toBuy.push({ ...s, qty: Math.round((s.missing - take) * 1000) / 1000 });
  }
  const refs: AgentReference[] = [];
  const lines: string[] = [];
  if (!toBuy.length && !reserve.length) {
    lines.push(
      'Nada para comprar agora: todas as necessidades aprovadas estão cobertas ou a caminho.',
    );
  }
  if (reserve.length) {
    lines.push('Já tem no estoque (reserve antes de comprar):');
    for (const s of reserve)
      lines.push(
        `• ${s.description}: reservar ${q(s.qty)} ${UNIT[s.unit] ?? s.unit} para ${s.osCode}.`,
      );
  }
  if (toBuy.length) {
    lines.push(
      `${reserve.length ? '\n' : ''}Comprar (${toBuy.length}), primeiro o que destrava produção ou vence antes:`,
    );
    toBuy.slice(0, 12).forEach((s, i) => {
      lines.push(
        `${i + 1}. ${s.description}: ${q(s.qty)} ${UNIT[s.unit] ?? s.unit} para ${s.osCode}` +
          `${s.promisedDate ? ` (prazo ${s.promisedDate.split('-').reverse().join('/')})` : ''}` +
          `${s.blocksProduction ? ' — trava uma etapa já planejada' : ''}` +
          `${s.sourcing === 'EXCLUSIVO_OS' ? ' — compra exclusiva da OS' : ''}.`,
      );
    });
    lines.push(
      'Ao aprovar uma proposta, abro o pedido de compra oficial já preenchido (rascunho). Confirmar continua com você.',
    );
  }
  const awaiting = all.filter((s) => s.awaiting > 0);
  if (awaiting.length)
    lines.push(`A caminho: ${awaiting.map((a) => `${a.description} (${a.osCode})`).join('; ')}.`);
  for (const s of [...reserve, ...toBuy])
    refs.push({
      type: 'OS',
      id: s.serviceOrderId,
      label: s.osCode,
      href: `/painel/os/${s.serviceOrderId}`,
    });
  for (const s of reserve)
    if (s.stock)
      refs.push({
        type: 'MATERIAL',
        id: s.stock.id,
        label: s.description,
        href: '/painel/estoque',
      });
  void question;
  const buyPolicy = ctx.policies.criar_compra ?? 'PROPOR';
  const reservePolicy = ctx.policies.reservar_estoque ?? 'PROPOR';
  const proposals: ProposalDraft[] = [];
  if (reservePolicy !== 'NUNCA')
    for (const s of reserve.slice(0, 5))
      proposals.push({
        kind: 'RESERVAR_ESTOQUE',
        title: `Reservar ${s.description} para ${s.osCode}`,
        detail: `${q(s.qty)} ${UNIT[s.unit] ?? s.unit} do estoque livre. A reserva é feita pelo fluxo oficial (estante no mapa ou Estoque do painel).`,
        payload: {
          requirementId: s.requirementId,
          stockItemId: s.stock?.id,
          quantity: s.qty,
          href: '/painel/estoque',
        },
        evidence: [
          {
            type: 'OS',
            id: s.serviceOrderId,
            label: s.osCode,
            href: `/painel/os/${s.serviceOrderId}`,
          },
        ],
      });
  if (buyPolicy !== 'NUNCA')
    for (const g of groupByOs(toBuy).slice(0, 5))
      proposals.push({
        kind: 'CRIAR_COMPRA',
        title: `Comprar materiais de ${g.osCode}`,
        detail: g.items
          .map((s) => `${s.description}: ${q(s.qty)} ${UNIT[s.unit] ?? s.unit}`)
          .join('; '),
        payload: {
          requirementIds: g.items.map((s) => s.requirementId),
          href: `/painel/compras/novo?req=${g.items.map((s) => s.requirementId).join(',')}`,
        },
        evidence: [
          {
            type: 'OS',
            id: g.serviceOrderId,
            label: g.osCode,
            href: `/painel/os/${g.serviceOrderId}`,
          },
        ],
      });
  return {
    content: lines.join('\n'),
    references: dedupe(refs),
    proposals,
    tasks: [
      ...reserve.slice(0, 3).map((s) => ({
        label: `Reservar ${s.description} · ${s.osCode}`,
        detail: `${q(s.qty)} ${UNIT[s.unit] ?? s.unit} já no estoque`,
        tone: 'atencao' as const,
      })),
      ...toBuy.slice(0, 5).map((s) => ({
        label: `Comprar ${s.description} · ${s.osCode}`,
        detail: `${q(s.qty)} ${UNIT[s.unit] ?? s.unit}${s.blocksProduction ? ' (trava produção)' : ''}`,
        tone: (s.blocksProduction ? 'risco' : 'atencao') as 'risco' | 'atencao',
      })),
    ],
  };
}

function groupByOs<T extends { serviceOrderId: string; osCode: string }>(rows: T[]) {
  const out: { serviceOrderId: string; osCode: string; items: T[] }[] = [];
  for (const r of rows) {
    const g = out.find((x) => x.serviceOrderId === r.serviceOrderId);
    if (g) g.items.push(r);
    else out.push({ serviceOrderId: r.serviceOrderId, osCode: r.osCode, items: [r] });
  }
  return out;
}

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
  const settings = await prisma.companySettings.findUnique({ where: { id: 1 } });
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

  // 3. Compras que destravam a semana.
  const proposals: ProposalDraft[] = [];
  if (ctx.dataScopes.includes('compras') || ctx.dataScopes.includes('estoque')) {
    const sh = (await shortages(prisma)).filter((s) => s.missing > 0);
    out.push(
      '',
      sh.length ? 'Materiais que faltam:' : 'Materiais: nada faltando nas necessidades aprovadas.',
    );
    for (const s of sh.slice(0, 6)) {
      const fromStock = s.stock ? Math.min(Math.max(0, s.stock.free), s.missing) : 0;
      out.push(
        `• ${s.description}: ${q(s.missing)} ${UNIT[s.unit] ?? s.unit} para ${s.osCode}` +
          `${fromStock > 0 ? ` (${q(fromStock)} já no estoque: reservar${fromStock < s.missing ? `; comprar ${q(s.missing - fromStock)}` : ''})` : ' (comprar)'}` +
          `${s.blocksProduction ? ' — trava produção' : ''}.`,
      );
      refs.push({
        type: 'OS',
        id: s.serviceOrderId,
        label: s.osCode,
        href: `/painel/os/${s.serviceOrderId}`,
      });
    }
  }

  // 4. Dinheiro: contas da semana × recebimentos previstos.
  if (can(ctx, 'financeiro', 'financeiro.ver')) {
    const end = new Date(`${week.end}T00:00:00Z`);
    const [payables, receivables] = await Promise.all([
      prisma.accountPayable.findMany({
        where: { status: { in: ['ABERTO', 'PARCIAL'] }, dueDate: { lte: end } },
        orderBy: { dueDate: 'asc' },
      }),
      prisma.customerReceivable.findMany({
        where: { status: { in: ['ABERTO', 'PARCIAL'] } },
        orderBy: { dueDate: 'asc' },
      }),
    ]);
    const toPay = payables.reduce((s, p) => s + p.amountCents - p.paidCents, 0);
    const dueRec = receivables.filter((r) => !r.dueDate || r.dueDate <= end);
    const toReceive = dueRec.reduce((s, r) => s + r.amountCents - r.receivedCents, 0);
    out.push('', 'Caixa da semana:');
    out.push(
      `• Contas a pagar até ${week.end.split('-').reverse().join('/')}: ${money(toPay)} (${payables.length} conta(s)).`,
    );
    out.push(
      `• Recebimentos previstos (vencidos, da semana ou na entrega/retirada): ${money(toReceive)} (${dueRec.length}).`,
    );
    out.push(
      toReceive >= toPay
        ? `• Cobre as contas com folga de ${money(toReceive - toPay)} — se receber tudo.`
        : `• Faltam ${money(toPay - toReceive)} para cobrir as contas: antecipe cobranças ou entregas que liberam pagamento.`,
    );
    for (const p of payables.slice(0, 3))
      refs.push({
        type: 'CONTA',
        id: p.id,
        label: `${p.description} (${money(p.amountCents - p.paidCents)})`,
        href: '/painel/financeiro?aba=contas',
      });
    for (const r of dueRec.slice(0, 3))
      refs.push({
        type: 'RECEBIVEL',
        id: r.id,
        label: `${r.description} (${money(r.amountCents - r.receivedCents)})`,
        href: '/painel/financeiro?aba=receitas',
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
