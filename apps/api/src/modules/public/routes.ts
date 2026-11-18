import {
  EVENT_TYPES,
  PICKUP_CHOICE_DAYS,
  PICKUP_SHIFT_LABEL,
  PICKUP_SHIFT_WINDOW,
  holidayOf,
  isQuoteStatus,
  publicPickupChoiceSchema,
  type AddressSnapshot,
  type PickupShift,
  type PublicPickupDto,
  type PublicQuoteDto,
  type PublicStatusDto,
  type QuoteSnapshot,
  type SystemNoticeDto,
} from '@cenario/shared';
import { followPickupDate } from '../deadlines/promise';
import type { PrismaClient, Tx } from '@cenario/db';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { audit } from '../../core/audit';
import { runAsCompany } from '../../core/tenant';
import type { ActorContext } from '../../core/types';
import { validPublicLink } from '../../core/public-links';
import { thumbnail } from '../../core/storage/image';
import { Errors } from '../../lib/errors';
import { dateOnly, lockOrder, pickupCode } from '../commercial/common';
import { refreshOrderStatus } from '../commercial/status';
import { notifyUsersWith } from '../quality/common';
import { emitPickupEvent } from '../pickups/routes';
import { emitOrderEvent } from '../orders/routes';
import { albumHasFile, loadOsAlbum } from '../service-orders/album';
import { todaySaoPaulo } from '../billing/routes';

/**
 * Páginas que o CLIENTE da tapeçaria abre sem login (melhorias 79, 82, 100, 130 e 131).
 *
 * Toda rota confere a assinatura do link (core/public-links.ts) antes de ler qualquer dado e só
 * então passa a trabalhar como a empresa dona do registro (a busca inicial usa o banco do
 * sistema, como a confirmação de e-mail). O cliente vê só o que já está na proposta impressa,
 * nas fotos do serviço ou na própria retirada — nada de valores internos, custos ou equipe.
 */
const idParam = z.object({ id: z.guid() });
const tokenQuery = z.object({ t: z.string().max(64).optional() });
const PUBLIC = { public: true } as const;
const PICKUP_OPEN = ['AGUARDANDO_AGENDAMENTO', 'AGENDADA'];
const CUSTOMER: ActorContext = { userId: null, sessionId: null, ip: null, requestId: null };

const noStore = (reply: FastifyReply) =>
  reply.header('cache-control', 'no-store').header('x-robots-tag', 'noindex, nofollow');

function addDays(iso: string, days: number) {
  const d = new Date(`${iso}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Dias que o cliente pode escolher: de amanhã até 14 dias, sem domingos e feriados nacionais. */
export function pickupChoiceDays(today: string): string[] {
  const out: string[] = [];
  for (let i = 1; i <= PICKUP_CHOICE_DAYS; i++) {
    const day = addDays(today, i);
    const weekday = new Date(`${day}T12:00:00.000Z`).getUTCDay();
    if (weekday === 0) continue;
    const h = holidayOf(day);
    if (h && !h.optional) continue;
    out.push(day);
  }
  return out;
}

function shiftOf(windowStart: string | null): PickupShift | null {
  if (!windowStart) return null;
  return windowStart < '12:00' ? 'MANHA' : 'TARDE';
}

export async function publicRoutes(app: FastifyInstance) {
  const { prisma, system, hashToken } = app.ctx;

  // ---------------- proposta (79)
  async function quoteFor(id: string, t: string | undefined) {
    if (!validPublicLink(hashToken, 'proposta', id, t)) throw Errors.notFound('Proposta');
    const q = await system.quote.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, companyId: true },
    });
    if (!q) throw Errors.notFound('Proposta');
    return q;
  }

  async function publicQuote(db: Tx | PrismaClient, id: string): Promise<PublicQuoteDto> {
    const q = await db.quote.findUniqueOrThrow({
      where: { id },
      include: { company: { select: { phone: true } } },
    });
    const s = q.snapshot as unknown as QuoteSnapshot;
    const issued = s.issuedAt.slice(0, 10);
    const validUntil = s.validityDays ? addDays(issued, s.validityDays) : null;
    return {
      number: q.number,
      companyName: s.companyName,
      logoDataUrl: s.logoDataUrl,
      issuedAt: s.issuedAt,
      customerName: s.customerName,
      customerPhone: s.phone,
      city: s.city,
      service: s.service,
      fabrics: s.fabrics,
      foamChange: s.foamChange,
      fabricChange: s.fabricChange,
      sofaCount: s.sofaCount,
      totalCents: s.totals.totalCents,
      installmentTotalCents: s.totals.installmentTotalCents,
      paymentOptionName: s.fee?.name ?? null,
      installments: s.fee?.installments ?? null,
      deliveryDays: s.deliveryDays,
      validityDays: s.validityDays,
      validUntil,
      expired: Boolean(validUntil && validUntil < todaySaoPaulo()),
      paymentTerms: s.paymentTerms,
      notes: s.notes,
      status: isQuoteStatus(q.status) ? q.status : 'ENVIADO',
      approvedAt: q.approvedAt?.toISOString() ?? null,
      companyPhone: q.company.phone,
      texts: s.texts ?? null,
      pickupDate: q.pickupDate?.toISOString().slice(0, 10) ?? null,
      pickupShift: q.pickupShift === 'MANHA' || q.pickupShift === 'TARDE' ? q.pickupShift : null,
      canChoosePickup: q.status === 'APROVADO' && !q.orderId,
      pickupDays:
        q.status === 'APROVADO' && !q.orderId ? pickupChoiceDays(todaySaoPaulo()) : [],
    };
  }

  app.get('/api/public/proposta/:id', { config: { access: PUBLIC } }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const { t } = tokenQuery.parse(request.query);
    const q = await quoteFor(id, t);
    noStore(reply);
    return runAsCompany(q.companyId, async () => {
      // Primeira abertura do link: a tapeçaria vê "o cliente abriu a proposta".
      await prisma.quote.updateMany({
        where: { id, linkViewedAt: null },
        data: { linkViewedAt: new Date() },
      });
      return publicQuote(prisma, id);
    });
  });

  app.post(
    '/api/public/proposta/:id/aprovar',
    { config: { access: PUBLIC } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const { t } = z.object({ t: z.string().max(64) }).parse(request.body ?? {});
      const q = await quoteFor(id, t);
      noStore(reply);
      return runAsCompany(q.companyId, () =>
        prisma.$transaction(async (tx) => {
          const cur = await tx.quote.findUniqueOrThrow({ where: { id } });
          const dto = await publicQuote(tx, id);
          if (cur.status === 'APROVADO') return dto;
          if (dto.expired)
            throw Errors.business(
              'Esta proposta passou da validade. Fale com a tapeçaria para receber uma nova.',
            );
          if (cur.status === 'RECUSADO')
            throw Errors.business('Esta proposta foi encerrada. Fale com a tapeçaria.');
          const actor = { ...CUSTOMER, ip: request.ip ?? null, requestId: request.id };
          await tx.quote.update({
            where: { id },
            data: {
              status: 'APROVADO',
              statusChangedAt: new Date(),
              approvedAt: new Date(),
              approvedVia: 'LINK',
              followUpAt: null,
              lostReason: null,
              version: { increment: 1 },
            },
          });
          await audit(tx, actor, {
            action: 'quotes.approved_by_customer',
            entityType: 'quote',
            entityId: id,
            summary: `Orçamento nº ${cur.number} aprovado pelo cliente (${cur.customerName}) no link da proposta.`,
          });
          await notifyUsersWith(
            tx,
            actor,
            'orcamentos.gerenciar',
            'ORCAMENTO_APROVADO',
            `orcamento-aprovado:${id}`,
            `${cur.customerName} aprovou o orçamento nº ${cur.number} pelo link. Abra Orçamentos para fechar o serviço.`,
          );
          return publicQuote(tx, id);
        }),
      );
    },
  );

  // Revisão geral (item 10): logo depois de aprovar, o cliente escolhe o dia de buscar a peça.
  // Fica gravado no orçamento; o "Fechar serviço" já abre com esse dia.
  app.post(
    '/api/public/proposta/:id/retirada',
    { config: { access: PUBLIC } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const input = publicPickupChoiceSchema.parse(request.body);
      const q = await quoteFor(id, input.t);
      noStore(reply);
      if (!pickupChoiceDays(todaySaoPaulo()).includes(input.date))
        throw Errors.business('Escolha um dos dias da lista.');
      return runAsCompany(q.companyId, () =>
        prisma.$transaction(async (tx) => {
          const cur = await tx.quote.findUniqueOrThrow({ where: { id } });
          if (cur.status !== 'APROVADO' || cur.orderId)
            throw Errors.business('O dia da retirada já foi combinado. Fale com a tapeçaria.');
          const changed = Boolean(cur.pickupDate);
          await tx.quote.update({
            where: { id },
            data: {
              pickupDate: new Date(`${input.date}T00:00:00.000Z`),
              pickupShift: input.shift,
              version: { increment: 1 },
            },
          });
          const day = input.date.split('-').reverse().join('/');
          const shift = PICKUP_SHIFT_LABEL[input.shift].toLowerCase();
          const actor = { ...CUSTOMER, ip: request.ip ?? null, requestId: request.id };
          await audit(tx, actor, {
            action: 'quotes.pickup_chosen_by_customer',
            entityType: 'quote',
            entityId: id,
            summary: `${cur.customerName} escolheu a retirada do orçamento nº ${cur.number}: ${day}, ${shift}.`,
          });
          await notifyUsersWith(
            tx,
            actor,
            'orcamentos.gerenciar',
            'ORCAMENTO_APROVADO',
            `orcamento-retirada:${id}:${input.date}:${input.shift}`,
            `${cur.customerName} ${changed ? 'trocou' : 'escolheu'} o dia de buscar a peça (orçamento nº ${cur.number}): ${day}, ${shift}. Feche o serviço para agendar.`,
          );
          return publicQuote(tx, id);
        }),
      );
    },
  );

  // ---------------- álbum de antes e depois (82)
  async function albumCompany(id: string, t: string | undefined) {
    if (!validPublicLink(hashToken, 'album', id, t)) throw Errors.notFound('Álbum');
    const os = await system.serviceOrder.findUnique({
      where: { id },
      select: { companyId: true, status: true },
    });
    if (!os || os.status === 'CANCELADA') throw Errors.notFound('Álbum');
    return os.companyId;
  }

  app.get('/api/public/album/:id', { config: { access: PUBLIC } }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const { t } = tokenQuery.parse(request.query);
    const companyId = await albumCompany(id, t);
    noStore(reply);
    return runAsCompany(companyId, async () => {
      const album = await loadOsAlbum(
        prisma,
        id,
        (fileId, thumb) => `/api/public/album/${id}/foto/${fileId}?t=${t}${thumb ? '&m=1' : ''}`,
      );
      if (!album) throw Errors.notFound('Álbum');
      return album;
    });
  });

  app.get(
    '/api/public/album/:id/foto/:fileId',
    { config: { access: PUBLIC } },
    async (request, reply) => {
      const { id, fileId } = z.object({ id: z.guid(), fileId: z.guid() }).parse(request.params);
      const { t, m } = z
        .object({ t: z.string().max(64).optional(), m: z.string().optional() })
        .parse(request.query);
      const companyId = await albumCompany(id, t);
      return runAsCompany(companyId, async () => {
        if (!(await albumHasFile(prisma, id, fileId))) throw Errors.notFound('Foto');
        const file = await prisma.storedFile.findUniqueOrThrow({ where: { id: fileId } });
        const key = m && file.thumbKey ? file.thumbKey : file.storageKey;
        const { stream } = await app.ctx.storage.read(key);
        const parts: Buffer[] = [];
        for await (const c of stream) parts.push(c as Buffer);
        let data: Buffer = Buffer.concat(parts);
        let mime = m && file.thumbKey ? 'image/webp' : file.mimeType;
        if (m && !file.thumbKey) {
          data = await thumbnail(data);
          mime = 'image/webp';
        }
        return reply
          .header('cache-control', 'private, max-age=3600')
          .header('x-content-type-options', 'nosniff')
          .header('content-security-policy', "default-src 'none'; sandbox")
          .header('content-type', mime)
          .header('content-length', data.length)
          .send(data);
      });
    },
  );

  // ---------------- cliente escolhe o dia da retirada (130)
  async function pickupCompany(id: string, t: string | undefined) {
    if (!validPublicLink(hashToken, 'agendar', id, t)) throw Errors.notFound('Retirada');
    const p = await system.pickupRequest.findUnique({
      where: { id },
      select: { companyId: true },
    });
    if (!p) throw Errors.notFound('Retirada');
    return p.companyId;
  }

  async function publicPickup(db: Tx | PrismaClient, id: string): Promise<PublicPickupDto> {
    const p = await db.pickupRequest.findUniqueOrThrow({
      where: { id },
      include: {
        company: { select: { tradeName: true } },
        order: { select: { customer: { select: { name: true } } } },
        items: { include: { orderItem: { select: { description: true } } } },
      },
    });
    const a = p.addressSnapshot as unknown as AddressSnapshot | null;
    const canChoose = PICKUP_OPEN.includes(p.status);
    return {
      code: pickupCode(p.number),
      companyName: p.company.tradeName,
      customerName: p.order.customer.name,
      address: a ? [`${a.street}, ${a.number}`, a.district].filter(Boolean).join(' — ') : null,
      pieces: p.items.map((i) => i.orderItem.description),
      scheduledDate: dateOnly(p.scheduledDate),
      shift: shiftOf(p.windowStart),
      canChoose,
      days: canChoose ? pickupChoiceDays(todaySaoPaulo()) : [],
    };
  }

  app.get('/api/public/agendar/:id', { config: { access: PUBLIC } }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const { t } = tokenQuery.parse(request.query);
    const companyId = await pickupCompany(id, t);
    noStore(reply);
    return runAsCompany(companyId, () => publicPickup(prisma, id));
  });

  app.post('/api/public/agendar/:id', { config: { access: PUBLIC } }, async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const input = publicPickupChoiceSchema.parse(request.body);
    const companyId = await pickupCompany(id, input.t);
    noStore(reply);
    if (!pickupChoiceDays(todaySaoPaulo()).includes(input.date))
      throw Errors.business('Escolha um dos dias da lista.');
    return runAsCompany(companyId, () =>
      prisma.$transaction(async (tx) => {
        const current = await tx.pickupRequest.findUniqueOrThrow({ where: { id } });
        await lockOrder(tx, current.orderId);
        const before = await tx.pickupRequest.findUniqueOrThrow({ where: { id } });
        if (!PICKUP_OPEN.includes(before.status))
          throw Errors.business(
            'Esta retirada já não pode ser remarcada pelo link. Fale com a tapeçaria.',
          );
        const window = PICKUP_SHIFT_WINDOW[input.shift];
        const beforeDate = dateOnly(before.scheduledDate);
        const actor = { ...CUSTOMER, ip: request.ip ?? null, requestId: request.id };
        await tx.pickupRequest.update({
          where: { id },
          data: {
            scheduledDate: new Date(`${input.date}T00:00:00.000Z`),
            windowStart: window.start,
            windowEnd: window.end,
            ...(beforeDate !== input.date ? { routeSequence: null } : {}),
            status: 'AGENDADA',
            customerScheduledAt: new Date(),
            version: { increment: 1 },
          },
        });
        if (beforeDate !== input.date) await followPickupDate(tx, before.orderId, input.date);
        await tx.pickupEvent.create({
          data: {
            pickupId: id,
            kind: beforeDate ? 'REAGENDADA' : 'AGENDADA',
            fromStatus: before.status,
            toStatus: 'AGENDADA',
            note: `Escolhido pelo cliente no link: ${input.date.split('-').reverse().join('/')}, ${PICKUP_SHIFT_LABEL[input.shift].toLowerCase()}`,
            recordedById: null,
          },
        });
        await refreshOrderStatus(tx, before.orderId);
        await audit(tx, actor, {
          action: 'pickup.customer_scheduled',
          entityType: 'pickup_request',
          entityId: id,
          summary: `Retirada ${pickupCode(before.number)}: o cliente escolheu ${input.date.split('-').reverse().join('/')} (${PICKUP_SHIFT_LABEL[input.shift].toLowerCase()}) pelo link.`,
        });
        await emitPickupEvent(
          tx,
          actor,
          id,
          before.status !== 'AGENDADA'
            ? EVENT_TYPES.PICKUP_STATUS_CHANGED
            : EVENT_TYPES.PICKUP_UPDATED,
        );
        await emitOrderEvent(tx, actor, before.orderId);
        await notifyUsersWith(
          tx,
          actor,
          'retiradas.gerenciar',
          'RETIRADA_ESCOLHIDA_CLIENTE',
          `retirada-cliente:${id}:${input.date}:${input.shift}`,
          `Retirada ${pickupCode(before.number)}: o cliente escolheu ${input.date.split('-').reverse().join('/')}, ${PICKUP_SHIFT_LABEL[input.shift].toLowerCase()}.`,
        );
        return publicPickup(tx, id);
      }),
    );
  });

  // ---------------- aviso de manutenção (131) e página de status (100)
  async function currentNotice(): Promise<SystemNoticeDto | null> {
    const now = new Date();
    const n = await system.systemNotice.findFirst({
      where: { showFrom: { lte: now }, showUntil: { gt: now } },
      orderBy: { showFrom: 'desc' },
    });
    return n
      ? {
          id: n.id,
          message: n.message,
          showFrom: n.showFrom.toISOString(),
          showUntil: n.showUntil.toISOString(),
        }
      : null;
  }

  app.get('/api/public/aviso', { config: { access: PUBLIC } }, async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    return { notice: await currentNotice() };
  });

  app.get('/api/public/status', { config: { access: PUBLIC } }, async (_request, reply) => {
    reply.header('cache-control', 'no-store');
    const started = Date.now();
    let ok = true;
    try {
      await system.$queryRaw`SELECT 1`;
    } catch {
      ok = false;
    }
    const latencyMs = Date.now() - started;
    const since = new Date(Date.now() - 90 * 86_400_000);
    const rows = ok
      ? await system.$queryRaw<{ day: string; total: bigint; up: bigint }[]>`
          SELECT to_char(checked_at AT TIME ZONE 'America/Sao_Paulo', 'YYYY-MM-DD') AS day,
                 count(*) AS total, count(*) FILTER (WHERE db_ok) AS up
          FROM status_samples WHERE checked_at >= ${since}
          GROUP BY 1 ORDER BY 1`
      : [];
    const byDay = new Map(rows.map((r) => [r.day, r]));
    const today = todaySaoPaulo();
    const days = Array.from({ length: 90 }, (_, i) => addDays(today, i - 89)).map((day) => {
      const r = byDay.get(day);
      // Uma amostra a cada 5 minutos: 288 por dia. Amostra faltando = sistema fora do ar.
      const expected = day === today ? Math.max(Number(r?.total ?? 0), 1) : 288;
      return {
        day,
        uptimeBps: r ? Math.min(10_000, Math.round((Number(r.up) * 10_000) / expected)) : null,
      };
    });
    const dto: PublicStatusDto = {
      ok,
      checkedAt: new Date().toISOString(),
      latencyMs: ok ? latencyMs : null,
      notice: ok ? await currentNotice() : null,
      days,
    };
    return dto;
  });
}

/** Amostra da página de status (chamada pela manutenção periódica a cada 5 minutos). */
export async function recordStatusSample(system: PrismaClient): Promise<void> {
  const started = Date.now();
  await system.$queryRaw`SELECT 1`;
  await system.statusSample.create({ data: { dbOk: true, latencyMs: Date.now() - started } });
  // Guarda 120 dias.
  await system.statusSample.deleteMany({
    where: { checkedAt: { lt: new Date(Date.now() - 120 * 86_400_000) } },
  });
}
