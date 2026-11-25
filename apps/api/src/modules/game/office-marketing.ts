/**
 * Marketing do Escritório (2026-11-25).
 * - Post de antes e depois: serviço entregue nos últimos 14 dias com foto de antes e de depois.
 *   O agente separa as fotos e escreve a legenda (sem o nome do cliente). Aprovar é o dono dizer
 *   que o cliente deixou divulgar; o post fica pronto para postar (sozinho só com o Instagram
 *   ligado, na etapa da Meta).
 * - Promoção no mês fraco: nos dias 1 a 10, se este mês costuma fechar bem menos que os outros
 *   (anos anteriores), propõe o desconto e a mensagem para os clientes que sumiram há 6 meses.
 */
import {
  beforeAfterCaption,
  firstName,
  plural,
  slowMonthMessage,
  whatsappLink,
  whatsappNumber,
} from '@cenario/shared';
import type { PrismaClient, Tx } from '@cenario/db';
import type { ActorContext } from '../../core/types';
import { requireCompanyId } from '../../core/tenant';
import { Errors } from '../../lib/errors';
import { loadOsAlbum } from '../service-orders/album';
import type { ProposalDraft } from './agent-engines';

type Db = PrismaClient | Tx;

const MONTHS = [
  'janeiro',
  'fevereiro',
  'março',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
];
const brl = (c: number) =>
  (c / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
    maximumFractionDigits: 0,
  });
const daysAgo = (today: string, n: number) => {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d;
};
const phoneFmt = (p: string | null) => {
  const d = (p ?? '').replace(/\D/g, '');
  if (d.length === 11) return `(${d.slice(0, 2)}) ${d.slice(2, 7)}-${d.slice(7)}`;
  if (d.length === 10) return `(${d.slice(0, 2)}) ${d.slice(2, 6)}-${d.slice(6)}`;
  return p || null;
};

// ───────────────────────────── Antes e depois ─────────────────────────────

export async function beforeAfterProposals(
  db: Db,
  today: string,
  company: string,
): Promise<ProposalDraft[]> {
  const delivered = await db.deliveryItem.findMany({
    where: {
      delivery: { status: 'CONCLUIDA', completedAt: { gte: daysAgo(today, 14) } },
    },
    select: { serviceOrderItem: { select: { serviceOrderId: true } } },
    take: 200,
  });
  const ids = [...new Set(delivered.map((d) => d.serviceOrderItem.serviceOrderId))];
  if (!ids.length) return [];
  const s = await db.companySettings.findUnique({
    where: { id: requireCompanyId() },
    select: { phone: true },
  });
  const out: ProposalDraft[] = [];
  for (const id of ids) {
    const album = await loadOsAlbum(db, id, (fileId, thumb) =>
      thumb ? `/api/files/${fileId}/miniatura` : `/api/files/${fileId}`,
    );
    if (!album || !album.before.length || !album.after.length) continue;
    const before = album.before[0]!;
    const after = album.after.at(-1)!;
    const so = await db.serviceOrder.findUnique({
      where: { id },
      select: { order: { select: { contractedService: true } } },
    });
    const caption = beforeAfterCaption({
      companyName: company,
      pieces: album.pieces,
      service: so?.order.contractedService ?? null,
      phone: phoneFmt(s?.phone ?? null),
    });
    out.push({
      kind: 'PREPARAR_POST',
      title: `Post de antes e depois da ${album.code}`,
      detail: caption,
      payload: {
        task: 'POST_ANTES_DEPOIS',
        dedupe: `POST_ANTES_DEPOIS:${id}`,
        serviceOrderId: id,
        osCode: album.code,
        text: caption,
        photos: [
          { label: 'Antes', fileId: before.fileId, url: before.url, thumbUrl: before.thumbUrl },
          { label: 'Depois', fileId: after.fileId, url: after.url, thumbUrl: after.thumbUrl },
        ],
      },
      evidence: [{ type: 'OS', id, label: album.code, href: `/painel/os/${id}` }],
    });
    if (out.length >= 2) break;
  }
  return out;
}

/** Aprovar (o cliente deixou divulgar): o post fica salvo, pronto para postar. */
export async function saveApprovedPost(
  tx: Tx,
  actor: ActorContext,
  perms: ReadonlySet<string>,
  p: { agentId: string; payload: unknown; detail: string },
  editedText: string | undefined,
) {
  if (!perms.has('marketing.publicar'))
    throw Errors.forbidden('Aprovar post exige a permissão de publicar.');
  const pl = (p.payload ?? {}) as Record<string, unknown>;
  if (pl.postId) throw Errors.conflict('Este post já foi aprovado.');
  const caption = String(editedText ?? pl.text ?? p.detail)
    .trim()
    .slice(0, 2200);
  const photos = (pl.photos as { url: string }[] | undefined) ?? [];
  const post = await tx.marketingPost.create({
    data: { caption, mediaUrls: photos.map((f) => f.url), agentId: p.agentId },
  });
  await tx.agentAction.create({
    data: {
      agentId: p.agentId,
      channel: 'INSTAGRAM',
      accountLabel: null,
      kind: 'RASCUNHO_POST',
      summary: `Post de antes e depois da ${String(pl.osCode ?? '')} aprovado (cliente deixou divulgar)`,
      content: caption,
      status: 'RASCUNHO',
      approvedById: actor.userId,
      ref: { postId: post.id, serviceOrderId: String(pl.serviceOrderId ?? '') },
    },
  });
  return { postId: post.id, text: caption };
}

// ───────────────────────────── Mês fraco ─────────────────────────────

/** Fechado por mês (valor dos pedidos não cancelados), nos últimos 36 meses. */
async function monthlyClosed(db: Db, today: string) {
  const since = new Date(`${Number(today.slice(0, 4)) - 3}-${today.slice(5, 7)}-01T00:00:00Z`);
  const rows = await db.commercialOrder.findMany({
    where: { status: { not: 'CANCELADO' }, agreedValueCents: { gt: 0 }, createdAt: { gte: since } },
    select: { createdAt: true, agreedValueCents: true },
  });
  const by = new Map<string, number>();
  for (const r of rows) {
    const k = r.createdAt.toISOString().slice(0, 7);
    by.set(k, (by.get(k) ?? 0) + (r.agreedValueCents ?? 0));
  }
  return by;
}

/** Este mês costuma ser fraco? (pelo menos 12 meses fechados de histórico e 15% abaixo da média). */
export async function slowMonthInfo(db: Db, today: string) {
  const month = today.slice(0, 7);
  const by = await monthlyClosed(db, today);
  const past = [...by.entries()].filter(([k]) => k < month);
  if (past.length < 12) return null;
  const same = past.filter(([k]) => k.slice(5, 7) === month.slice(5, 7));
  const others = past.filter(([k]) => k.slice(5, 7) !== month.slice(5, 7));
  if (!same.length || !others.length) return null;
  const avg = (l: [string, number][]) => l.reduce((a, [, v]) => a + v, 0) / l.length;
  const sameAvg = avg(same);
  const otherAvg = avg(others);
  if (sameAvg >= otherAvg * 0.85) return null;
  return {
    month,
    monthName: MONTHS[Number(month.slice(5, 7)) - 1]!,
    sameAvgCents: Math.round(sameAvg),
    otherAvgCents: Math.round(otherAvg),
    dropPct: Math.round((1 - sameAvg / otherAvg) * 100),
    years: same.map(([k]) => k.slice(0, 4)),
  };
}

const lastDay = (month: string) => {
  const d = new Date(`${month}-01T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + 1);
  d.setUTCDate(0);
  return d.toISOString().slice(0, 10);
};

export async function slowMonthProposals(
  db: Db,
  today: string,
  company: string,
): Promise<ProposalDraft[]> {
  if (Number(today.slice(8, 10)) > 10) return [];
  const info = await slowMonthInfo(db, today);
  if (!info) return [];
  const s = await db.companySettings.findUnique({
    where: { id: requireCompanyId() },
    select: { customerDiscountPct: true },
  });
  const pct = s?.customerDiscountPct || 10;
  // Clientes que fizeram serviço e não fecham nada há 6 meses.
  const sixMonths = daysAgo(today, 182);
  const customers = await db.customer.findMany({
    where: {
      active: true,
      orders: {
        some: { status: { not: 'CANCELADO' } },
        none: { createdAt: { gte: sixMonths } },
      },
    },
    select: { id: true, name: true, phone: true, whatsapp: true },
    orderBy: { name: 'asc' },
    take: 60,
  });
  const recipients = customers
    .map((c) => ({ customerId: c.id, name: c.name, phone: whatsappNumber(c.whatsapp || c.phone) }))
    .filter((c) => c.phone)
    .slice(0, 30);
  if (!recipients.length) return [];
  const until = lastDay(info.month).split('-').reverse().slice(0, 2).join('/');
  const text = slowMonthMessage({ companyName: company, discountPct: pct, until });
  return [
    {
      kind: 'PROMOCAO',
      title: `${info.monthName[0]!.toUpperCase()}${info.monthName.slice(1)} costuma ser fraco: promoção de ${pct}% para ${plural(recipients.length, 'cliente antigo', 'clientes antigos')}`,
      detail: [
        `Em ${info.monthName} (${info.years.join(', ')}) fechou em média ${brl(info.sameAvgCents)}; nos outros meses, ${brl(info.otherAvgCents)} (${info.dropPct}% a menos).`,
        `Sugestão: ${pct}% de desconto nos serviços fechados até ${until}, mandado para quem fez serviço e não volta há mais de 6 meses.`,
        '',
        text,
      ].join('\n'),
      payload: {
        task: 'PROMOCAO_MES_FRACO',
        dedupe: `PROMOCAO_MES_FRACO:${info.month}`,
        month: info.month,
        discountPct: pct,
        text,
        recipients,
      },
      evidence: [],
    },
  ];
}

/** Aprovar: um link de WhatsApp por cliente, com o primeiro nome no lugar de {nome}. */
export function approvedPromo(
  p: { payload: unknown; detail: string },
  editedText: string | undefined,
) {
  const pl = (p.payload ?? {}) as Record<string, unknown>;
  const text = String(editedText ?? pl.text ?? '');
  if (!text.trim()) throw Errors.validation(undefined, 'Falta a mensagem da promoção.');
  const recipients = (pl.recipients as { customerId: string; name: string; phone: string }[]) ?? [];
  return {
    text,
    sendList: recipients.map((r) => ({
      customerId: r.customerId,
      name: r.name,
      href: whatsappLink(r.phone, text.replaceAll('{nome}', firstName(r.name) || r.name)),
    })),
  };
}
