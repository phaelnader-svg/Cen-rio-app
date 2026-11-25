/**
 * Escritório trabalhando sozinho (2026-11-25, pedido do Raphael).
 *
 * A cada rodada (meia hora, no horário da oficina) cada agente contratado olha os dados do Cenário
 * e deixa as tarefas prontas como propostas. O nível de cada tarefa decide o que acontece:
 * 1 fica na lista sem aviso; 2 avisa no celular e espera o dono; 3 faz sozinho até o limite;
 * 4 faz sozinho. Mensagem só sai sozinha pelo WhatsApp da empresa; sem ele, o dono aperta enviar.
 * O "parar tudo" volta todas as tarefas para "pede aprovação" sem apagar os níveis.
 *
 * Tarefas novas desta versão (Atendimento): agendar a entrega da peça pronta, confirmar retirada e
 * entrega na véspera, pedir avaliação depois da entrega e chamar o cliente que não volta há 1 ano.
 */
import {
  ALL_PERMISSIONS,
  AGENT_TEMPLATES,
  DEFAULT_OFFICE_LEVEL,
  EVENT_TYPES,
  LEVEL_UP_STREAK,
  OFFICE_ALSO_DOES,
  OFFICE_ROLES,
  OFFICE_TASKS,
  type OfficeAgentDto,
  type OfficeLevel,
  type OfficeOverviewDto,
  type OfficeProposalDto,
  type OfficeTask,
  type OfficeTaskKey,
  type OfficeTaskSetting,
  customerMessage,
  holidayOf,
  officeSettingsSchema,
  officeTask,
  officeTaskOf,
  plural,
  returningCustomerMessage,
  reviewRequestMessage,
  updateOfficeTaskSchema,
  whatsappLink,
  whatsappNumber,
  satisfactionMessage,
  birthdayMessage,
  referralMessage,
  referralThanksMessage,
} from '@cenario/shared';
import type { AiAgent, AiAgentProposal, Prisma, PrismaClient, Tx } from '@cenario/db';
import type { FastifyInstance } from 'fastify';
import { actorFrom, audit } from '../../core/audit';
import { now as clockNow } from '../../core/clock';
import { appendEvent } from '../../core/events/append';
import { assertModuleEnabled, moduleEnabled } from '../../core/modules';
import { requireCompanyId } from '../../core/tenant';
import type { ActorContext } from '../../core/types';
import { Errors } from '../../lib/errors';
import { serviceOrderCode } from '../commercial/common';
import { shopTimezone, todayIso } from '../finance/common';
import { orderRevenue } from '../finance/revenue';
import { connectionOf } from '../integrations/connections';
import { resolveNotifications } from '../notifications/notify';
import { notifyUsersWith } from '../quality/common';
import type { AgentContext, ProposalDraft } from './agent-engines';
import { managerAnswer } from './agent-engines';
import {
  aiAvailable,
  companyName,
  financeAnswer,
  purchasingAnswer,
  quotesAnswer,
  readyNoticeProposals,
} from './agent-office';
import { NotSentByAgent, decideProposal } from './agents';
import { refreshPending } from './proposal-validity';
import { deliveryText } from './office-delivery';
import { officeWeek, weeklyReportNotice } from './office-week';
import { stockShortageNotices } from './office-stock';
import { accountantPackageNotice, cashForecast, taxReminder } from './office-finance';
import { planEntryFor } from './office-plan';

type Db = PrismaClient | Tx;

const SYSTEM: ActorContext = { userId: null, sessionId: null, ip: null, requestId: null };
/** O agente trabalha com o que a empresa inteira vê; o escopo de dados dele continua valendo. */
const ALL = new Set<string>(ALL_PERMISSIONS);
const AUDIENCE = 'permission:agentes.usar|permission:agentes.gerenciar' as const;
export const OFFICE_ACCESS = {
  session: 'WEB',
  permissions: ['jogo.acessar', 'agentes.gerenciar'],
} as const;
/** Horário em que os agentes trabalham (hora local da oficina). */
const WORK_FROM = 7;
const WORK_UNTIL = 20;
const SUMMARY_HOUR = 18;
const MESSAGE_ROLES = ['ATENDIMENTO', 'WHATSAPP'];

const brl = (c: number) =>
  (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const br = (iso: string) => iso.split('-').reverse().join('/');
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const dateOf = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);
const localHour = (at: Date, timeZone: string) =>
  Number(new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', hour12: false }).format(at));

/** Próximo dia útil depois de `iso` (sem sábado, domingo e feriado nacional). */
export function nextWorkday(iso: string) {
  let d = addDays(iso, 1);
  for (let i = 0; i < 10; i++) {
    const wd = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (wd !== 0 && wd !== 6 && !holidayOf(d)) return d;
    d = addDays(d, 1);
  }
  return d;
}

// ───────────────────────────── Níveis ─────────────────────────────

export function taskSetting(agent: Pick<AiAgent, 'autonomy'>, key: string): OfficeTaskSetting {
  const all = (agent.autonomy ?? {}) as Record<string, OfficeTaskSetting | undefined>;
  const s = all[key];
  return { nivel: s?.nivel ?? DEFAULT_OFFICE_LEVEL, limiteCents: s?.limiteCents ?? null };
}

/** Nível mais alto possível agora (mensagem sem o WhatsApp da empresa fica em "pede"). */
export function maxLevelNow(
  t: OfficeTask,
  whatsapp: boolean,
): {
  level: OfficeLevel;
  reason: string | null;
} {
  if (t.maxLevel < 3) return { level: t.maxLevel, reason: t.maxReason ?? null };
  if (t.message && !whatsapp)
    return {
      level: 2,
      reason:
        'Para fazer sozinho, a mensagem precisa sair pelo WhatsApp da empresa (etapa da Meta). Até lá, você aperta enviar.',
    };
  return { level: t.maxLevel, reason: null };
}

/** Valor da proposta (o limite do nível 3 compara com ele). */
const amountOf = (p: { payload: unknown }) => {
  const pl = (p.payload ?? {}) as Record<string, unknown>;
  const v = Number(pl.openCents ?? pl.totalCents ?? 0);
  return Number.isFinite(v) ? v : 0;
};

/**
 * O que acontece com esta proposta: 'SOZINHO' (o agente faz), 'PEDE' (avisa e espera) ou
 * 'SUGERE' (fica na lista, sem aviso).
 */
export function routeOf(
  agent: Pick<AiAgent, 'autonomy'>,
  p: { kind: string; payload: unknown },
  ctx: { paused: boolean; whatsapp: boolean },
): 'SOZINHO' | 'PEDE' | 'SUGERE' {
  const key = officeTaskOf(p);
  const t = key ? officeTask(key) : null;
  if (!t || !key) return 'PEDE';
  const s = taskSetting(agent, key);
  if (s.nivel === 1) return 'SUGERE';
  // Planejar sem a proposta completa (material não comprado, sem tapeceiro): sempre pede.
  if (key === 'PLANEJAR_OS' && !(p.payload as Record<string, unknown> | null)?.entry) return 'PEDE';
  if (ctx.paused || s.nivel === 2) return 'PEDE';
  if (maxLevelNow(t, ctx.whatsapp).level < 3) return 'PEDE';
  if (s.nivel === 3) {
    if (!t.money) return 'SOZINHO';
    return s.limiteCents !== null && s.limiteCents !== undefined && amountOf(p) <= s.limiteCents
      ? 'SOZINHO'
      : 'PEDE';
  }
  return 'SOZINHO';
}

// ───────────────────────────── Tarefas do Atendimento ─────────────────────────────

interface AttendanceCtx {
  db: Db;
  company: string;
  today: string;
  reviewUrl: string | null;
  logistics: boolean;
  discountPct: number;
}

/** Peça pronta sem entrega marcada: propõe o próximo dia útil (manhã) e a mensagem ao cliente. */
async function scheduleDeliveryProposals(c: AttendanceCtx): Promise<ProposalDraft[]> {
  if (!c.logistics) return [];
  const ready = await c.db.serviceOrder.findMany({
    where: { status: 'ABERTA', items: { some: { fulfillmentStage: 'PRONTA_ENTREGA' } } },
    include: {
      customer: {
        select: {
          id: true,
          name: true,
          phone: true,
          whatsapp: true,
          addresses: { where: { archivedAt: null }, select: { id: true }, take: 1 },
        },
      },
      items: {
        where: { fulfillmentStage: 'PRONTA_ENTREGA' },
        select: { id: true, description: true },
      },
    },
    orderBy: { promisedDate: 'asc' },
    take: 5,
  });
  const date = nextWorkday(c.today);
  const out: ProposalDraft[] = [];
  for (const so of ready) {
    // Sem endereço cadastrado não dá para agendar: fica o aviso de peça pronta.
    if (!so.customer.addresses.length || !so.items.length) continue;
    const rev = await orderRevenue(c.db, so.orderId);
    const open = Math.max(0, (rev.finalCents ?? 0) - rev.receivedCents);
    const piece =
      so.items.length === 1 ? `o seu ${so.items[0]!.description.toLowerCase()}` : 'o seu pedido';
    const text = deliveryText(c.company, so.customer.name, piece, so.number, date, '09:00', open);
    const phone = so.customer.whatsapp || so.customer.phone;
    out.push({
      kind: 'ENVIAR_MENSAGEM',
      title: `Agendar a entrega de ${serviceOrderCode(so.number)} (${so.customer.name}) para ${br(date)}`,
      detail: text,
      payload: {
        task: 'AGENDAR_ENTREGA',
        subject: `AGENDAR_ENTREGA:${so.id}`,
        readyServiceOrderId: so.id,
        osNumber: so.number,
        customerId: so.customer.id,
        customerName: so.customer.name,
        piece,
        openCents: open,
        itemIds: so.items.map((i) => i.id),
        scheduledDate: date,
        windowStart: '09:00',
        windowEnd: '12:00',
        phone: whatsappNumber(phone),
        text,
        href: whatsappLink(phone, text),
        channel: 'WHATSAPP',
      },
      evidence: [
        {
          type: 'OS',
          id: so.id,
          label: serviceOrderCode(so.number),
          href: `/painel/os/${so.id}`,
        },
      ],
    });
  }
  return out;
}

/** Retiradas de amanhã: confirmar que vai ter alguém no local. */
async function confirmPickupProposals(c: AttendanceCtx): Promise<ProposalDraft[]> {
  const tomorrow = addDays(c.today, 1);
  const rows = await c.db.pickupRequest.findMany({
    where: { status: 'AGENDADA', scheduledDate: new Date(`${tomorrow}T00:00:00Z`) },
    include: {
      order: { include: { customer: { select: { name: true, phone: true, whatsapp: true } } } },
      items: { select: { orderItem: { select: { description: true } } } },
    },
    take: 10,
  });
  return rows.map((p) => {
    const cu = p.order.customer;
    const phone = cu.whatsapp || cu.phone;
    const piece =
      p.items.length === 1
        ? `o seu ${p.items[0]!.orderItem.description.toLowerCase()}`
        : 'as suas peças';
    const text = customerMessage({
      kind: 'RETIRADA_AMANHA',
      customerName: cu.name,
      companyName: c.company,
      piece,
      date: `${br(tomorrow)}${p.windowStart ? ` a partir das ${p.windowStart}` : ''}`,
    });
    return {
      kind: 'ENVIAR_MENSAGEM',
      title: `Confirmar a retirada de amanhã com ${cu.name}`,
      detail: text,
      payload: {
        task: 'CONFIRMAR_RETIRADA',
        dedupe: `CONFIRMAR_RETIRADA:${p.id}:${tomorrow}`,
        pickupId: p.id,
        date: tomorrow,
        customerName: cu.name,
        phone: whatsappNumber(phone),
        text,
        href: whatsappLink(phone, text),
        channel: 'WHATSAPP',
      },
      evidence: [
        { type: 'OS', id: p.id, label: `Retirada de ${cu.name}`, href: '/painel/retiradas' },
      ],
    };
  });
}

/** Entregas de amanhã: confirmar com o cliente e lembrar o saldo. */
async function confirmDeliveryProposals(c: AttendanceCtx): Promise<ProposalDraft[]> {
  const tomorrow = addDays(c.today, 1);
  const rows = await c.db.delivery.findMany({
    where: { status: 'AGENDADA', scheduledDate: new Date(`${tomorrow}T00:00:00Z`) },
    include: {
      customer: { select: { name: true, phone: true, whatsapp: true } },
      items: {
        where: { active: true },
        include: {
          serviceOrderItem: {
            select: {
              description: true,
              serviceOrder: { select: { number: true, orderId: true } },
            },
          },
        },
      },
    },
    take: 10,
  });
  const out: ProposalDraft[] = [];
  for (const d of rows) {
    const phone = d.contactPhone || d.customer.whatsapp || d.customer.phone;
    const first = d.items[0]?.serviceOrderItem;
    const orders = [...new Set(d.items.map((i) => i.serviceOrderItem.serviceOrder.orderId))];
    let open = 0;
    for (const o of orders) {
      const rev = await orderRevenue(c.db, o);
      open += Math.max(0, (rev.finalCents ?? 0) - rev.receivedCents);
    }
    const piece =
      d.items.length === 1 && first ? `o seu ${first.description.toLowerCase()}` : 'o seu pedido';
    const text = customerMessage({
      kind: 'ENTREGA_AGENDADA',
      customerName: d.customer.name,
      companyName: c.company,
      piece,
      code: first ? serviceOrderCode(first.serviceOrder.number) : null,
      date: `amanhã, ${br(tomorrow)}${d.windowStart ? `, a partir das ${d.windowStart}` : ''}`,
      balance: open > 0 ? brl(open) : null,
    });
    out.push({
      kind: 'ENVIAR_MENSAGEM',
      title: `Confirmar a entrega de amanhã com ${d.customer.name}`,
      detail: text,
      payload: {
        task: 'CONFIRMAR_ENTREGA',
        dedupe: `CONFIRMAR_ENTREGA:${d.id}:${tomorrow}`,
        deliveryId: d.id,
        date: tomorrow,
        customerName: d.customer.name,
        phone: whatsappNumber(phone),
        text,
        href: whatsappLink(phone, text),
        channel: 'WHATSAPP',
      },
      evidence: [
        { type: 'OS', id: d.id, label: `Entrega de ${d.customer.name}`, href: '/painel/entregas' },
      ],
    });
  }
  return out;
}

/** Dois a sete dias depois da entrega concluída: agradecer e pedir a avaliação (uma vez por cliente). */
async function reviewProposals(c: AttendanceCtx): Promise<ProposalDraft[]> {
  const from = new Date(`${addDays(c.today, -7)}T00:00:00Z`);
  // A partir do 2º dia (no 1º dia, o Atendimento só pergunta se ficou tudo certo).
  const to = new Date(`${addDays(c.today, -2)}T00:00:00Z`);
  const rows = await c.db.delivery.findMany({
    where: { status: 'CONCLUIDA', completedAt: { gte: from, lt: to } },
    include: { customer: { select: { id: true, name: true, phone: true, whatsapp: true } } },
    orderBy: { completedAt: 'asc' },
    take: 20,
  });
  const seen = new Set<string>();
  const out: ProposalDraft[] = [];
  for (const d of rows) {
    if (seen.has(d.customer.id)) continue;
    seen.add(d.customer.id);
    const phone = d.customer.whatsapp || d.customer.phone;
    if (!whatsappNumber(phone)) continue;
    const text = reviewRequestMessage({
      customerName: d.customer.name,
      companyName: c.company,
      reviewUrl: c.reviewUrl,
    });
    out.push({
      kind: 'ENVIAR_MENSAGEM',
      title: `Pedir a avaliação de ${d.customer.name}`,
      detail: text,
      payload: {
        task: 'PEDIR_AVALIACAO',
        dedupe: `PEDIR_AVALIACAO:${d.customer.id}`,
        customerId: d.customer.id,
        customerName: d.customer.name,
        phone: whatsappNumber(phone),
        text,
        href: whatsappLink(phone, text),
        channel: 'WHATSAPP',
      },
      evidence: [
        { type: 'OS', id: d.id, label: `Entrega de ${d.customer.name}`, href: '/painel/entregas' },
      ],
    });
    if (out.length >= 5) break;
  }
  return out;
}

/**
 * Cliente cuja última entrega fez um ano (entre 365 e 400 dias) e não tem nada aberto: oferta de
 * limpeza ou revisão. No máximo 3 por rodada; o mesmo cliente só de novo depois de um ano.
 */
async function returningProposals(c: AttendanceCtx): Promise<ProposalDraft[]> {
  const from = new Date(`${addDays(c.today, -400)}T00:00:00Z`);
  const to = new Date(`${addDays(c.today, -365)}T00:00:00Z`);
  const rows = await c.db.delivery.findMany({
    where: { status: 'CONCLUIDA', completedAt: { gte: from, lt: to } },
    include: {
      customer: { select: { id: true, name: true, phone: true, whatsapp: true, active: true } },
      items: {
        where: { active: true },
        include: { serviceOrderItem: { select: { description: true } } },
        take: 1,
      },
    },
    orderBy: { completedAt: 'asc' },
    take: 30,
  });
  const out: ProposalDraft[] = [];
  const seen = new Set<string>();
  for (const d of rows) {
    const cu = d.customer;
    if (seen.has(cu.id) || !cu.active) continue;
    seen.add(cu.id);
    const phone = cu.whatsapp || cu.phone;
    if (!whatsappNumber(phone)) continue;
    // Voltou depois (entrega mais nova) ou tem OS aberta: não é cliente sumido.
    const [newer, openOs] = await Promise.all([
      c.db.delivery.count({ where: { customerId: cu.id, completedAt: { gte: to } } }),
      c.db.serviceOrder.count({ where: { customerId: cu.id, status: 'ABERTA' } }),
    ]);
    if (newer || openOs) continue;
    const piece = d.items[0]?.serviceOrderItem.description ?? null;
    const text = returningCustomerMessage({ customerName: cu.name, companyName: c.company, piece });
    out.push({
      kind: 'ENVIAR_MENSAGEM',
      title: `Chamar ${cu.name} (serviço há 1 ano)`,
      detail: text,
      payload: {
        task: 'CLIENTE_ANTIGO',
        dedupe: `CLIENTE_ANTIGO:${cu.id}:${dateOf(d.completedAt)}`,
        customerId: cu.id,
        customerName: cu.name,
        phone: whatsappNumber(phone),
        text,
        href: whatsappLink(phone, text),
        channel: 'WHATSAPP',
      },
      evidence: [{ type: 'OS', id: cu.id, label: cu.name, href: `/painel/clientes/${cu.id}` }],
    });
    if (out.length >= 3) break;
  }
  return out;
}

type CustomerLite = { id: string; name: string; phone: string | null; whatsapp: string | null };
const CUSTOMER_LITE = { id: true, name: true, phone: true, whatsapp: true } as const;

function messageDraft(
  task: string,
  title: string,
  dedupe: string,
  cu: CustomerLite,
  text: string,
  extra: Record<string, unknown> = {},
): ProposalDraft | null {
  const phone = cu.whatsapp || cu.phone;
  if (!whatsappNumber(phone)) return null;
  return {
    kind: 'ENVIAR_MENSAGEM',
    title,
    detail: text,
    payload: {
      task,
      dedupe,
      customerId: cu.id,
      customerName: cu.name,
      phone: whatsappNumber(phone),
      text,
      href: whatsappLink(phone, text),
      channel: 'WHATSAPP',
      ...extra,
    },
    evidence: [{ type: 'OS', id: cu.id, label: cu.name, href: `/painel/clientes/${cu.id}` }],
  };
}

/** Entregas concluídas num intervalo de dias atrás (de `fromDays` a `toDays`, sem incluir `toDays`). */
async function deliveredBetween(c: AttendanceCtx, fromDays: number, toDays: number) {
  const rows = await c.db.delivery.findMany({
    where: {
      status: 'CONCLUIDA',
      completedAt: {
        gte: new Date(`${addDays(c.today, -fromDays)}T00:00:00Z`),
        lt: new Date(`${addDays(c.today, -toDays)}T00:00:00Z`),
      },
    },
    include: { customer: { select: { ...CUSTOMER_LITE, active: true } } },
    orderBy: { completedAt: 'asc' },
    take: 30,
  });
  const seen = new Set<string>();
  return rows.filter((d) => {
    if (seen.has(d.customer.id) || !d.customer.active) return false;
    seen.add(d.customer.id);
    return true;
  });
}

/** Dia seguinte à entrega: ficou tudo certo? (uma vez por entrega). */
async function satisfactionProposals(c: AttendanceCtx): Promise<ProposalDraft[]> {
  const out: ProposalDraft[] = [];
  for (const d of await deliveredBetween(c, 1, 0)) {
    const text = satisfactionMessage({ customerName: d.customer.name, companyName: c.company });
    const p = messageDraft(
      'PESQUISA_SATISFACAO',
      `Perguntar a ${d.customer.name} se ficou tudo certo`,
      `PESQUISA_SATISFACAO:${d.id}`,
      d.customer,
      text,
      { deliveryId: d.id },
    );
    if (p) out.push(p);
    if (out.length >= 5) break;
  }
  return out;
}

/** Aniversário de hoje: parabéns com o desconto (cliente que já fez serviço; uma vez por ano). */
async function birthdayProposals(c: AttendanceCtx): Promise<ProposalDraft[]> {
  const day = Number(c.today.slice(8, 10));
  const month = Number(c.today.slice(5, 7));
  const rows = await c.db.customer.findMany({
    where: {
      active: true,
      birthDay: day,
      birthMonth: month,
      OR: [{ orders: { some: {} } }, { serviceOrders: { some: {} } }],
    },
    select: CUSTOMER_LITE,
    take: 10,
  });
  const out: ProposalDraft[] = [];
  for (const cu of rows) {
    const text = birthdayMessage({
      customerName: cu.name,
      companyName: c.company,
      discountPct: c.discountPct,
    });
    const p = messageDraft(
      'ANIVERSARIO',
      `Parabéns de aniversário para ${cu.name}`,
      `ANIVERSARIO:${cu.id}:${c.today.slice(0, 4)}`,
      cu,
      text,
    );
    if (p) out.push(p);
  }
  return out;
}

/** Duas semanas depois da entrega: convite para indicar (uma vez por cliente). */
async function referralProposals(c: AttendanceCtx): Promise<ProposalDraft[]> {
  const out: ProposalDraft[] = [];
  for (const d of await deliveredBetween(c, 21, 14)) {
    const text = referralMessage({
      customerName: d.customer.name,
      companyName: c.company,
      discountPct: c.discountPct,
    });
    const p = messageDraft(
      'INDICACAO',
      `Pedir uma indicação a ${d.customer.name}`,
      `INDICACAO:${d.customer.id}`,
      d.customer,
      text,
    );
    if (p) out.push(p);
    if (out.length >= 3) break;
  }
  return out;
}

/** O cliente indicado fechou o primeiro pedido nos últimos 7 dias: agradecer quem indicou. */
async function referralThanksProposals(c: AttendanceCtx): Promise<ProposalDraft[]> {
  const since = new Date(`${addDays(c.today, -7)}T00:00:00Z`);
  const rows = await c.db.customer.findMany({
    where: {
      referredById: { not: null },
      orders: { some: { status: { not: 'CANCELADO' }, createdAt: { gte: since } } },
    },
    select: { id: true, name: true, referredBy: { select: { ...CUSTOMER_LITE, active: true } } },
    take: 10,
  });
  const out: ProposalDraft[] = [];
  for (const r of rows) {
    const by = r.referredBy;
    if (!by?.active) continue;
    const text = referralThanksMessage({
      customerName: by.name,
      companyName: c.company,
      referredName: r.name,
      discountPct: c.discountPct,
    });
    const p = messageDraft(
      'AGRADECER_INDICACAO',
      `Agradecer ${by.name} por indicar ${r.name}`,
      `AGRADECER_INDICACAO:${r.id}`,
      by,
      text,
      { referredId: r.id },
    );
    if (p) out.push(p);
  }
  return out;
}

/** O que o Atendimento deixa pronto numa rodada. */
export async function attendanceProposals(db: Db, today: string): Promise<ProposalDraft[]> {
  const s = await db.companySettings.findUnique({
    where: { id: requireCompanyId() },
    select: { googleReviewUrl: true, customerDiscountPct: true },
  });
  const c: AttendanceCtx = {
    db,
    company: await companyName(db),
    today,
    reviewUrl: s?.googleReviewUrl ?? null,
    discountPct: s?.customerDiscountPct ?? 10,
    logistics: await moduleEnabled(db, 'logistica'),
  };
  const schedule = await scheduleDeliveryProposals(c);
  const scheduled = new Set(schedule.map((p) => String(p.payload.readyServiceOrderId)));
  // Peça pronta que o agente já vai agendar não ganha o aviso solto.
  const ready = (await readyNoticeProposals(db)).filter(
    (p) => !scheduled.has(String(p.payload.serviceOrderId)),
  );
  return [
    ...schedule,
    ...ready.map((p) => ({ ...p, payload: { ...p.payload, task: 'AVISAR_PRONTO' } })),
    ...(await confirmPickupProposals(c)),
    ...(await confirmDeliveryProposals(c)),
    ...(await satisfactionProposals(c)),
    ...(await reviewProposals(c)),
    ...(await referralThanksProposals(c)),
    ...(await referralProposals(c)),
    ...(await birthdayProposals(c)),
    ...(await returningProposals(c)),
  ];
}

// ───────────────────────────── Rodada ─────────────────────────────

async function routine(db: PrismaClient, agent: AiAgent, today: string): Promise<ProposalDraft[]> {
  const ctx: AgentContext = {
    prisma: db,
    permissions: ALL,
    dataScopes: agent.dataScopes,
    policies: (agent.actionPolicies ?? {}) as Record<string, string>,
  };
  const tag = (ps: ProposalDraft[]) =>
    ps.map((p) => ({ ...p, payload: { ...p.payload, task: officeTaskOf(p) } }));
  switch (agent.roleKey) {
    case 'GERENTE':
      return withPlans(db, tag((await managerAnswer(ctx, '')).proposals), today);
    case 'COMPRAS':
      return tag((await purchasingAnswer(ctx, '')).proposals);
    case 'FINANCEIRO':
      return tag((await financeAnswer(ctx, '')).proposals);
    case 'ORCAMENTOS':
      return tag((await quotesAnswer(ctx, '')).proposals);
    case 'ATENDIMENTO':
    case 'WHATSAPP':
      return attendanceProposals(db, today);
    default:
      return [];
  }
}

/** Gerente: a OS sem planejamento ganha o início e o tapeceiro de cada peça (semana da produção). */
async function withPlans(db: PrismaClient, ps: ProposalDraft[], today: string) {
  const out: ProposalDraft[] = [];
  for (const p of ps) {
    if (p.kind !== 'PLANEJAR_OS') {
      out.push(p);
      continue;
    }
    const r = await planEntryFor(db, String(p.payload.serviceOrderId ?? ''), today);
    const code = p.title.replace(/^Planejar /, '');
    if ('problem' in r) {
      out.push({ ...p, payload: { ...p.payload, planProblem: r.problem } });
      continue;
    }
    out.push({
      ...p,
      title: `Encaixar ${code} na semana (começa ${br(r.entry.startDate).slice(0, 5)})`,
      detail: ['Quem fica com cada peça:', ...r.lines].join('\n'),
      payload: { ...p.payload, entry: r.entry, startDate: r.entry.startDate },
    });
  }
  return out;
}

/** Já existe uma proposta igual (pendente; ou a mesma tarefa única em qualquer estado). */
async function alreadyThere(tx: Tx, agentId: string, p: ProposalDraft) {
  const dedupe = p.payload.dedupe;
  if (typeof dedupe === 'string') {
    const any = await tx.aiAgentProposal.findFirst({
      where: { payload: { path: ['dedupe'], equals: dedupe } },
      select: { id: true },
    });
    if (any) return true;
  }
  // Mesmo assunto (ex.: a mesma OS a agendar, com outra data no título).
  const subject = p.payload.subject;
  const same =
    typeof subject === 'string'
      ? { payload: { path: ['subject'], equals: subject } }
      : { kind: p.kind, title: p.title };
  const pending = await tx.aiAgentProposal.findFirst({
    where: { agentId, status: 'PENDENTE', ...same },
    select: { id: true },
  });
  if (pending) return true;
  // Recusada há pouco: não volta a pedir a mesma coisa por 3 dias.
  const rejected = await tx.aiAgentProposal.findFirst({
    where: {
      agentId,
      status: 'REJEITADA',
      ...same,
      decidedAt: { gte: new Date(clockNow().getTime() - 3 * 86_400_000) },
    },
    select: { id: true },
  });
  return !!rejected;
}

export interface RoundResult {
  skipped?: 'MODULO' | 'FORA_DO_HORARIO';
  created: number;
  doneAlone: number;
  asking: number;
}

/**
 * Uma rodada do escritório na empresa atual: cada agente contratado deixa as tarefas prontas,
 * as liberadas são feitas sozinhas e o dono recebe um aviso com o que espera por ele.
 * `force` roda fora do horário (botão "Rodar agora" e testes).
 */
export async function runOfficeRound(
  prisma: PrismaClient,
  opts: { force?: boolean; at?: Date } = {},
): Promise<RoundResult> {
  const at = opts.at ?? clockNow();
  if (!(await moduleEnabled(prisma, 'ambiente_interativo')))
    return { skipped: 'MODULO', created: 0, doneAlone: 0, asking: 0 };
  const tz = await shopTimezone(prisma);
  const hour = localHour(at, tz);
  if (!opts.force && (hour < WORK_FROM || hour >= WORK_UNTIL))
    return { skipped: 'FORA_DO_HORARIO', created: 0, doneAlone: 0, asking: 0 };
  const today = todayIso(tz);
  const company = await prisma.companySettings.findUniqueOrThrow({
    where: { id: requireCompanyId() },
    select: { agentsPausedAt: true },
  });
  const conn = await connectionOf(prisma, 'WHATSAPP');
  const whatsapp = conn?.status === 'CONECTADA';
  const paused = !!company.agentsPausedAt;
  const agents = await prisma.aiAgent.findMany({
    where: { status: 'ATIVO', roleKey: { in: [...OFFICE_ROLES, 'WHATSAPP'] } },
    orderBy: { createdAt: 'asc' },
  });
  // Só um agente faz as mensagens ao cliente (Atendimento, ou o WhatsApp antigo).
  const messenger =
    agents.find((a) => a.roleKey === 'ATENDIMENTO') ??
    agents.find((a) => MESSAGE_ROLES.includes(a.roleKey));
  let created = 0;
  const newAsking: string[] = [];
  for (const agent of agents) {
    if (MESSAGE_ROLES.includes(agent.roleKey) && agent.id !== messenger?.id) continue;
    let drafts: ProposalDraft[] = [];
    try {
      drafts = await routine(prisma, agent, today);
    } catch {
      continue; // um agente com problema não para os outros
    }
    await prisma.$transaction(async (tx) => {
      await refreshPending(tx, agent.id);
      for (const p of drafts) {
        if (await alreadyThere(tx, agent.id, p)) continue;
        const row = await tx.aiAgentProposal.create({
          data: {
            agentId: agent.id,
            kind: p.kind,
            title: p.title.slice(0, 200),
            detail: p.detail.slice(0, 4000),
            payload: p.payload as Prisma.InputJsonValue,
            evidence: p.evidence as unknown as Prisma.InputJsonValue,
          },
        });
        created++;
        if (routeOf(agent, row, { paused, whatsapp }) === 'PEDE') newAsking.push(row.title);
      }
      if (drafts.length)
        await appendEvent(tx, SYSTEM, {
          type: EVENT_TYPES.GAME_PROPOSAL_CHANGED,
          aggregateType: 'ai_agent',
          aggregateId: agent.id,
          payload: { id: agent.id },
          audience: AUDIENCE,
        });
    });
  }
  // O que está liberado o agente faz sozinho (inclusive o que ficou pendente de rodadas antigas).
  let doneAlone = 0;
  if (!paused) {
    const pending = await prisma.aiAgentProposal.findMany({
      where: { status: 'PENDENTE', agentId: { in: agents.map((a) => a.id) } },
      orderBy: { createdAt: 'asc' },
      take: 50,
    });
    for (const p of pending) {
      const agent = agents.find((a) => a.id === p.agentId)!;
      if (routeOf(agent, p, { paused, whatsapp }) !== 'SOZINHO') continue;
      const pl = (p.payload ?? {}) as Record<string, unknown>;
      // Tentativa que falhou (ex.: fora da janela de 24 h da Meta) só volta no dia seguinte.
      if (typeof pl.autoTriedAt === 'string' && pl.autoTriedAt.slice(0, 10) === today) continue;
      if (await doAlone(prisma, p, agent, today)) doneAlone++;
      else newAsking.push(p.title);
    }
  }
  await notifyOwner(prisma, newAsking, today);
  await dailySummary(prisma, at, tz, today);
  // Compras: material do estoque que não dá para as OS abertas.
  if (agents.some((a) => a.roleKey === 'COMPRAS'))
    await stockShortageNotices(prisma, today).catch(() => 0);
  // Financeiro: DAS do mês (15 a 20) e pacote do contador (1 a 5), de manhã.
  if (hour >= 8 && agents.some((a) => a.roleKey === 'FINANCEIRO')) {
    await taxReminder(prisma, today).catch(() => false);
    await accountantPackageNotice(prisma, today).catch(() => false);
  }
  // Domingo à tarde: o relatório da semana do Gerente (só com o Gerente contratado).
  if (hour >= SUMMARY_HOUR && agents.some((a) => a.roleKey === 'GERENTE'))
    await weeklyReportNotice(prisma, today).catch(() => false);
  return { created, doneAlone, asking: newAsking.length };
}

/** O agente faz a tarefa liberada. Se a mensagem não sair, volta a pedir ao dono. */
export async function doAlone(
  prisma: PrismaClient,
  p: AiAgentProposal,
  agent: AiAgent,
  today: string,
) {
  try {
    await decideProposal(prisma, {
      id: p.id,
      decision: 'APROVAR',
      note: 'Feita sozinha pelo agente (tarefa liberada pelo dono).',
      actor: SYSTEM,
      perms: ALL,
      byAgent: true,
      // Confere de novo com a proposta travada: o dono pode ter parado tudo ou baixado o nível.
      before: async (tx) => {
        const [fresh, co] = await Promise.all([
          tx.aiAgent.findUniqueOrThrow({ where: { id: agent.id } }),
          tx.companySettings.findUniqueOrThrow({
            where: { id: requireCompanyId() },
            select: { agentsPausedAt: true },
          }),
        ]);
        const conn = await connectionOf(tx, 'WHATSAPP');
        if (
          routeOf(fresh, p, {
            paused: !!co.agentsPausedAt,
            whatsapp: conn?.status === 'CONECTADA',
          }) !== 'SOZINHO'
        )
          throw new NotSentByAgent('O nível da tarefa mudou.');
      },
    });
    return true;
  } catch (e) {
    const why = e instanceof NotSentByAgent ? e.message : e instanceof Error ? e.message : 'falha';
    await prisma.aiAgentProposal.updateMany({
      where: { id: p.id, status: 'PENDENTE' },
      data: {
        payload: {
          ...((p.payload ?? {}) as Record<string, unknown>),
          autoTriedAt: `${today}T`,
          autoError: why.slice(0, 300),
        } as Prisma.InputJsonValue,
      },
    });
    return false;
  }
}

/** Um aviso no sininho do dono com o que chegou para ele aprovar nesta rodada. */
async function notifyOwner(prisma: PrismaClient, titles: string[], today: string) {
  await prisma.$transaction(async (tx) => {
    const waiting = await tx.aiAgentProposal.count({ where: { status: 'PENDENTE' } });
    if (!waiting) {
      await resolveNotifications(tx, SYSTEM, 'AGENTES_PEDEM', ['AGENTES_PEDEM']);
      return;
    }
    if (!titles.length) return;
    const body = `${plural(waiting, 'pedido esperando', 'pedidos esperando')} você: ${titles
      .slice(0, 2)
      .join('; ')}${titles.length > 2 ? ` e mais ${titles.length - 2}` : ''}.`;
    await notifyUsersWith(
      tx,
      SYSTEM,
      'agentes.gerenciar',
      'AGENTES_PEDEM',
      `AGENTES_PEDEM:${today}:${waiting}:${titles.length}`,
      body,
    );
  });
}

/** Contagem do dia (do dono e dos agentes sozinhos). */
async function todayCounts(db: Db, today: string, tz: string) {
  const start = new Date(`${today}T00:00:00Z`);
  // Margem do fuso: o filtro fino é a data local.
  start.setUTCHours(start.getUTCHours() - 14);
  const rows = await db.aiAgentProposal.findMany({
    where: { decidedAt: { gte: start } },
    select: { status: true, decidedAt: true, decidedByAgent: true },
  });
  const local = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(d);
  const mine = rows.filter((r) => r.decidedAt && local(r.decidedAt) === today);
  const done = mine.filter((r) => r.status === 'APROVADA' || r.status === 'EXECUTADA_TESTE');
  return {
    done: done.length,
    doneAlone: done.filter((r) => r.decidedByAgent).length,
    rejected: mine.filter((r) => r.status === 'REJEITADA').length,
    waiting: await db.aiAgentProposal.count({ where: { status: 'PENDENTE' } }),
  };
}

/** Às 18 h: o resumo do dia no sininho (só se os agentes trabalharam). */
async function dailySummary(prisma: PrismaClient, at: Date, tz: string, today: string) {
  if (localHour(at, tz) < SUMMARY_HOUR) return;
  const c = await todayCounts(prisma, today, tz);
  if (!c.done && !c.waiting && !c.rejected) return;
  const stopped = await prisma.notification.count({
    where: { kind: 'SERVICO_PARADO', resolvedAt: null },
  });
  const parts = [
    c.done
      ? `${plural(c.done, 'tarefa feita', 'tarefas feitas')}${c.doneAlone ? ` (${c.doneAlone} sozinhos)` : ''}`
      : null,
    c.waiting ? `${plural(c.waiting, 'esperando você', 'esperando você')}` : null,
    stopped ? `${plural(stopped, 'aviso de OS parada', 'avisos de OS parada')}` : null,
  ].filter(Boolean);
  await prisma.$transaction((tx) =>
    notifyUsersWith(
      tx,
      SYSTEM,
      'agentes.gerenciar',
      'AGENTES_RESUMO',
      `AGENTES_RESUMO:${today}`,
      `Hoje no escritório: ${parts.join(', ')}.`,
    ),
  );
}

// ───────────────────────────── Tela do Escritório ─────────────────────────────

function proposalDto(
  p: AiAgentProposal,
  agent: Pick<AiAgent, 'name' | 'color' | 'autonomy'>,
  ctx: { paused: boolean; whatsapp: boolean },
): OfficeProposalDto {
  return {
    id: p.id,
    agentId: p.agentId,
    agentName: agent.name,
    agentColor: agent.color,
    task: officeTaskOf(p),
    kind: p.kind,
    title: p.title,
    detail: p.detail,
    payload: (p.payload ?? {}) as Record<string, unknown>,
    status: p.status,
    suggestion: p.status === 'PENDENTE' && routeOf(agent, p, ctx) === 'SUGERE',
    createdAt: p.createdAt.toISOString(),
    decidedAt: p.decidedAt?.toISOString() ?? null,
    decisionNote: p.decisionNote,
    decidedByAgent: p.decidedByAgent,
  };
}

/** Aprovações seguidas (as mais recentes primeiro) sem o dono mudar o texto nem recusar. */
function streakOf(rows: { status: string; payload: unknown }[]) {
  let n = 0;
  for (const r of rows) {
    if (r.status === 'OBSOLETA') continue;
    const edited = ((r.payload ?? {}) as Record<string, unknown>).edited === true;
    if ((r.status === 'APROVADA' || r.status === 'EXECUTADA_TESTE') && !edited) n++;
    else break;
  }
  return n;
}

export async function officeOverview(prisma: PrismaClient): Promise<OfficeOverviewDto> {
  const tz = await shopTimezone(prisma);
  const today = todayIso(tz);
  const [company, conn, agents] = await Promise.all([
    prisma.companySettings.findUniqueOrThrow({
      where: { id: requireCompanyId() },
      select: { agentsPausedAt: true, googleReviewUrl: true, customerDiscountPct: true },
    }),
    connectionOf(prisma, 'WHATSAPP'),
    prisma.aiAgent.findMany({
      where: { status: { not: 'DESATIVADO' } },
      orderBy: { createdAt: 'asc' },
    }),
  ]);
  const whatsapp = conn?.status === 'CONECTADA';
  const paused = !!company.agentsPausedAt;
  const ctx = { paused, whatsapp };
  const ids = agents.map((a) => a.id);
  const [pending, recent, decided] = await Promise.all([
    prisma.aiAgentProposal.findMany({
      where: { agentId: { in: ids }, status: 'PENDENTE' },
      orderBy: { createdAt: 'desc' },
      take: 100,
    }),
    prisma.aiAgentProposal.findMany({
      where: { agentId: { in: ids }, status: { not: 'PENDENTE' } },
      orderBy: { decidedAt: 'desc' },
      take: 30,
    }),
    prisma.aiAgentProposal.findMany({
      where: {
        agentId: { in: ids },
        status: { in: ['APROVADA', 'EXECUTADA_TESTE', 'REJEITADA'] },
        decidedAt: { gte: new Date(clockNow().getTime() - 180 * 86_400_000) },
      },
      select: {
        agentId: true,
        kind: true,
        payload: true,
        status: true,
        decidedAt: true,
        decidedByAgent: true,
      },
      orderBy: { decidedAt: 'desc' },
      take: 2000,
    }),
  ]);
  const byId = new Map(agents.map((a) => [a.id, a]));
  const monthAgo = clockNow().getTime() - 30 * 86_400_000;
  const office: OfficeAgentDto[] = OFFICE_ROLES.map((roleKey) => {
    const a =
      agents.find((x) => x.roleKey === roleKey) ??
      (roleKey === 'ATENDIMENTO' ? agents.find((x) => x.roleKey === 'WHATSAPP') : undefined);
    const t = AGENT_TEMPLATES.find((x) => x.roleKey === roleKey)!;
    const tasks = OFFICE_TASKS.filter((x) => x.roles.includes(roleKey)).map((task) => {
      const s = a ? taskSetting(a, task.key) : { nivel: DEFAULT_OFFICE_LEVEL, limiteCents: null };
      const rows = a
        ? decided.filter((d) => d.agentId === a.id && officeTaskOf(d) === task.key)
        : [];
      const max = maxLevelNow(task, whatsapp);
      const streak = streakOf(rows);
      return {
        key: task.key,
        label: task.label,
        what: task.what,
        level: s.nivel,
        limitCents: s.limiteCents ?? null,
        maxLevel: max.level,
        maxReason: max.reason,
        money: task.money,
        approved: rows.filter((r) => r.status !== 'REJEITADA').length,
        rejected: rows.filter((r) => r.status === 'REJEITADA').length,
        streak,
        suggestLevelUp: streak >= LEVEL_UP_STREAK && s.nivel < max.level,
        doneAlone: rows.filter(
          (r) => r.decidedByAgent && r.decidedAt && r.decidedAt.getTime() >= monthAgo,
        ).length,
      };
    });
    return {
      roleKey,
      name: a?.name ?? t.name,
      roleLabel: a?.roleLabel ?? t.roleLabel,
      agentId: a?.id ?? null,
      status: (a?.status as OfficeAgentDto['status']) ?? null,
      color: a?.color ?? t.color,
      tasks,
      alsoDoes: OFFICE_ALSO_DOES[roleKey] ?? [],
    };
  });
  return {
    paused,
    pausedAt: company.agentsPausedAt?.toISOString() ?? null,
    whatsappConnected: whatsapp,
    aiReady: aiAvailable(),
    googleReviewUrl: company.googleReviewUrl,
    customerDiscountPct: company.customerDiscountPct,
    agents: office,
    pending: pending.map((p) => proposalDto(p, byId.get(p.agentId)!, ctx)),
    recent: recent.map((p) => proposalDto(p, byId.get(p.agentId)!, ctx)),
    today: await todayCounts(prisma, today, tz),
  };
}

/** O Escritório só existe no plano com o jogo. */
export const officeGuard = (prisma: PrismaClient) =>
  assertModuleEnabled(prisma, 'ambiente_interativo');

/** Rota de uma proposta recém-criada, com o nível, o "parar tudo" e o WhatsApp de agora. */
export async function routeOfNow(
  prisma: PrismaClient,
  agentId: string,
  p: { kind: string; payload: unknown },
) {
  const [agent, co, conn] = await Promise.all([
    prisma.aiAgent.findUniqueOrThrow({ where: { id: agentId } }),
    prisma.companySettings.findUniqueOrThrow({
      where: { id: requireCompanyId() },
      select: { agentsPausedAt: true },
    }),
    connectionOf(prisma, 'WHATSAPP'),
  ]);
  return routeOf(agent, p, {
    paused: !!co.agentsPausedAt,
    whatsapp: conn?.status === 'CONECTADA',
  });
}

export async function officeRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;
  const guard = () => assertModuleEnabled(prisma, 'ambiente_interativo');

  app.get('/api/v1/office', { config: { access: OFFICE_ACCESS } }, async () => {
    await guard();
    return officeOverview(prisma);
  });

  // Nível de uma tarefa de um agente.
  app.put('/api/v1/office/tasks', { config: { access: OFFICE_ACCESS } }, async (request) => {
    await guard();
    const input = updateOfficeTaskSchema.parse(request.body);
    const task = officeTask(input.task)!;
    const actor = actorFrom(request);
    await prisma.$transaction(async (tx) => {
      const a = await tx.aiAgent.findUnique({ where: { id: input.agentId } });
      if (!a) throw Errors.notFound('Agente');
      if (!task.roles.includes(a.roleKey))
        throw Errors.validation(undefined, 'Esta tarefa não é deste agente.');
      const { nivel } = input.setting;
      if (nivel > task.maxLevel)
        throw Errors.validation(undefined, task.maxReason ?? 'Nível não disponível.');
      if (nivel === 3 && !task.money)
        throw Errors.validation(undefined, 'Esta tarefa não tem valor: use "Sozinho".');
      if (nivel === 3 && (input.setting.limiteCents ?? null) === null)
        throw Errors.validation(undefined, 'Informe até quanto o agente pode fazer sozinho.');
      const all = { ...((a.autonomy ?? {}) as unknown as Record<string, OfficeTaskSetting>) };
      const before = all[input.task]?.nivel ?? DEFAULT_OFFICE_LEVEL;
      all[input.task] = {
        nivel,
        limiteCents: nivel === 3 ? (input.setting.limiteCents ?? null) : null,
      };
      await tx.aiAgent.update({
        where: { id: a.id },
        data: { autonomy: all as unknown as Prisma.InputJsonValue },
      });
      await audit(tx, actor, {
        action: 'office.task_level',
        entityType: 'ai_agent',
        entityId: a.id,
        summary: `${a.name} — "${task.label}": nível ${before} → ${nivel}${nivel === 3 ? ` (até ${brl(input.setting.limiteCents ?? 0)})` : ''}.`,
      });
    });
    return officeOverview(prisma);
  });

  // Parar tudo / voltar a trabalhar e o link de avaliação do Google.
  app.put('/api/v1/office/settings', { config: { access: OFFICE_ACCESS } }, async (request) => {
    await guard();
    const input = officeSettingsSchema.parse(request.body);
    const actor = actorFrom(request);
    await prisma.$transaction(async (tx) => {
      const id = requireCompanyId();
      const data: Prisma.CompanySettingsUpdateInput = {};
      if (input.paused !== undefined) data.agentsPausedAt = input.paused ? clockNow() : null;
      if (input.googleReviewUrl !== undefined) data.googleReviewUrl = input.googleReviewUrl || null;
      if (input.customerDiscountPct !== undefined)
        data.customerDiscountPct = input.customerDiscountPct;
      await tx.companySettings.update({ where: { id }, data });
      if (input.paused !== undefined)
        await audit(tx, actor, {
          action: input.paused ? 'office.paused' : 'office.resumed',
          entityType: 'company',
          entityId: String(id),
          summary: input.paused
            ? 'Parar tudo: os agentes voltaram a pedir aprovação para tudo.'
            : 'Os agentes voltaram a trabalhar com os níveis de cada tarefa.',
        });
    });
    return officeOverview(prisma);
  });

  // Contratar um agente que ainda não existe (modelo pronto, sem mesa; a mesa se escolhe no jogo).
  app.post(
    '/api/v1/office/hire',
    { config: { access: OFFICE_ACCESS, idempotent: true } },
    async (request, reply) => {
      await guard();
      const { roleKey } = (request.body ?? {}) as { roleKey?: string };
      if (!roleKey || !(OFFICE_ROLES as readonly string[]).includes(roleKey))
        throw Errors.validation(undefined, 'Escolha um agente do escritório.');
      const t = AGENT_TEMPLATES.find((x) => x.roleKey === roleKey)!;
      const actor = actorFrom(request);
      await prisma.$transaction(async (tx) => {
        const exists = await tx.aiAgent.findFirst({
          where: {
            status: { not: 'DESATIVADO' },
            roleKey: roleKey === 'ATENDIMENTO' ? { in: MESSAGE_ROLES } : roleKey,
          },
        });
        if (exists) throw Errors.conflict(`${exists.name} já trabalha no escritório.`);
        const a = await tx.aiAgent.create({
          data: {
            name: t.name,
            roleKey: t.roleKey,
            roleLabel: t.roleLabel,
            instructions: t.instructions,
            dataScopes: t.dataScopes,
            actionPolicies: t.actionPolicies as Prisma.InputJsonValue,
            channelPolicies: (t.channelPolicies ?? {}) as Prisma.InputJsonValue,
            autoSendRules: (t.autoSendRules ?? []) as Prisma.InputJsonValue,
            color: t.color,
            createdById: actor.userId,
          },
        });
        await audit(tx, actor, {
          action: 'game.agent_created',
          entityType: 'ai_agent',
          entityId: a.id,
          summary: `Agente "${a.name}" contratado pelo Escritório.`,
        });
        await appendEvent(tx, actor, {
          type: EVENT_TYPES.GAME_PROPOSAL_CHANGED,
          aggregateType: 'ai_agent',
          aggregateId: a.id,
          payload: { id: a.id },
          audience: AUDIENCE,
        });
      });
      return reply.status(201).send(await officeOverview(prisma));
    },
  );

  // Relatório da semana (Gerente): os últimos 7 dias, com dinheiro (pede o financeiro).
  app.get(
    '/api/v1/office/week',
    {
      config: {
        access: { session: 'WEB', permissions: [...OFFICE_ACCESS.permissions, 'financeiro.ver'] },
      },
    },
    async () => {
      await guard();
      return officeWeek(prisma);
    },
  );

  // Previsão do caixa (Financeiro): o que entra e sai nas próximas 4 semanas.
  app.get(
    '/api/v1/office/forecast-weeks',
    {
      config: {
        access: { session: 'WEB', permissions: [...OFFICE_ACCESS.permissions, 'financeiro.ver'] },
      },
    },
    async () => {
      await guard();
      return cashForecast(prisma, todayIso(await shopTimezone(prisma)));
    },
  );

  // Rodar agora (sem esperar a próxima meia hora).
  app.post(
    '/api/v1/office/round',
    { config: { access: OFFICE_ACCESS, idempotent: true } },
    async () => {
      await guard();
      const r = await runOfficeRound(prisma, { force: true });
      return { ...r, overview: await officeOverview(prisma) };
    },
  );
}

export type { OfficeTaskKey };
