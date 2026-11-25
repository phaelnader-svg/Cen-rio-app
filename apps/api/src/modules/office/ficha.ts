/**
 * Ficha do sofá no escritório: junta, com estados SEPARADOS, orçamento aprovado, contrato,
 * entrada, saldo, nota, materiais, retirada e entrega — cada um vindo do seu registro oficial.
 */
import { pickupStatusLabel } from '@cenario/shared';
import type { FastifyInstance } from 'fastify';
import { Errors } from '../../lib/errors';
import { orderRevenue } from '../finance/revenue';
import { idParams } from '../presenters';
import { chargeDto } from './charges';
import { OFFICE_VIEW, type Db, brl, orderCodeOf, osCodeOf } from './common';

type Tone = 'ok' | 'atencao' | 'risco' | 'info' | 'neutro';
export interface FichaStep {
  key:
    | 'ORCAMENTO'
    | 'CONTRATO'
    | 'ENTRADA'
    | 'SALDO'
    | 'NOTA'
    | 'MATERIAIS'
    | 'RETIRADA'
    | 'ENTREGA';
  label: string;
  state: string;
  tone: Tone;
  detail: string;
  ref?: Record<string, unknown>;
}

const fmt = (d: Date | null | undefined) =>
  d ? d.toISOString().slice(0, 10).split('-').reverse().join('/') : '—';

export async function fichaOf(db: Db, serviceOrderId: string) {
  const so = await db.serviceOrder.findUnique({
    where: { id: serviceOrderId },
    include: { customer: true, order: true, items: { select: { id: true } } },
  });
  if (!so) throw Errors.notFound('OS');
  const orderId = so.orderId;
  const [rev, contract, receivables, fiscal, pickups, deliveries, receipts] = await Promise.all([
    orderRevenue(db, orderId),
    db.contract.findFirst({ where: { orderId }, orderBy: { revision: 'desc' } }),
    db.customerReceivable.findMany({
      where: { orderId, status: { not: 'CANCELADO' } },
      include: { charges: { orderBy: { createdAt: 'desc' } } },
      orderBy: { createdAt: 'asc' },
    }),
    db.fiscalDocument.findFirst({
      where: { orderId, status: { not: 'CANCELADA' } },
      orderBy: { createdAt: 'desc' },
    }),
    db.pickupRequest.findMany({
      where: { orderId, status: { not: 'CANCELADA' } },
      orderBy: { createdAt: 'desc' },
    }),
    db.delivery.findMany({
      where: {
        items: { some: { serviceOrderItemId: { in: so.items.map((i) => i.id) }, active: true } },
        status: { not: 'CANCELADA' },
      },
      orderBy: { scheduledDate: 'desc' },
    }),
    db.receipt.findMany({ where: { orderId }, orderBy: { createdAt: 'asc' }, take: 1 }),
  ]);
  const steps: FichaStep[] = [];
  const final = rev.finalCents;
  steps.push(
    final === null
      ? {
          key: 'ORCAMENTO',
          label: 'Orçamento',
          state: 'Sem valor aprovado',
          tone: 'risco',
          detail: 'Registre o valor contratado no pedido.',
        }
      : {
          key: 'ORCAMENTO',
          label: 'Orçamento',
          state: 'Aprovado',
          tone: 'ok',
          detail: `${brl(final)} (${orderCodeOf(rev.order.number)})`,
          ref: { orderId },
        },
  );
  steps.push(
    !contract
      ? {
          key: 'CONTRATO',
          label: 'Contrato',
          state: 'Não preparado',
          tone: final === null ? 'neutro' : 'atencao',
          detail: 'O agente Documentos prepara pelo modelo da empresa.',
        }
      : {
          key: 'CONTRATO',
          label: 'Contrato',
          state:
            {
              RASCUNHO: 'Em revisão',
              ENVIADO: 'Enviado para assinatura',
              ASSINADO: 'Assinado',
              RECUSADO: 'Recusado',
              CANCELADO: 'Cancelado',
              SUBSTITUIDO: 'Substituído',
            }[contract.status] ?? contract.status,
          tone:
            contract.status === 'ASSINADO'
              ? 'ok'
              : contract.status === 'RECUSADO'
                ? 'risco'
                : 'atencao',
          detail: `Revisão ${contract.revision}${contract.sentAt ? ` · enviado ${fmt(contract.sentAt)}` : ''}${contract.signedAt ? ` · assinado ${fmt(contract.signedAt)}` : ''}`,
          ref: {
            contractId: contract.id,
            signedFileUrl: contract.signedFileId ? `/api/files/${contract.signedFileId}` : null,
          },
        },
  );
  const entrada =
    receivables.find((r) => /^entrada/i.test(r.description)) ??
    (receivables.length > 1 ? receivables[0] : undefined);
  const chargeState = (r: (typeof receivables)[number]) => {
    const ch = r.charges[0];
    if (r.status === 'RECEBIDO')
      return {
        state: 'Pago',
        tone: 'ok' as Tone,
        detail: `${brl(r.receivedCents)} recebido${ch?.paidAt ? ` em ${fmt(ch.paidAt)}` : ''}${ch?.paymentId ? ' · baixa pelo provedor' : ''}`,
      };
    if (!ch)
      return {
        state: 'Sem cobrança',
        tone: 'atencao' as Tone,
        detail: `${brl(r.amountCents)} lançado${r.dueDate ? `, vence ${fmt(r.dueDate)}` : r.dueTrigger === 'ENTREGA' ? ', vence na entrega' : ''}`,
      };
    const map: Record<string, [string, Tone]> = {
      ABERTA: ['Cobrança enviada', 'atencao'],
      VENCIDA: ['Vencida', 'risco'],
      CANCELADA: ['Cobrança cancelada', 'neutro'],
      ESTORNADA: ['Estornada', 'risco'],
      PAGA: ['Pago', 'ok'],
    };
    const [s, t] = map[ch.status] ?? [ch.status, 'info'];
    return {
      state: s,
      tone: t,
      detail: `${brl(ch.amountCents)} · ${ch.billingType} · vence ${fmt(ch.dueDate)}`,
    };
  };
  steps.push(
    entrada
      ? {
          key: 'ENTRADA',
          label: 'Entrada',
          ...chargeState(entrada),
          ref: {
            receivableId: entrada.id,
            charge: entrada.charges[0] ? chargeDto(entrada.charges[0]) : null,
          },
        }
      : {
          key: 'ENTRADA',
          label: 'Entrada',
          state: 'Não gerada',
          tone: final === null ? 'neutro' : 'atencao',
          detail: 'Gere o plano de cobrança (ex.: 50% de entrada).',
        },
  );
  const others = receivables.filter((r) => r !== entrada);
  const received = receivables.reduce((a, r) => a + r.receivedCents, 0);
  const saldo = final === null ? null : final - received;
  steps.push(
    saldo === null
      ? { key: 'SALDO', label: 'Saldo', state: '—', tone: 'neutro', detail: '' }
      : saldo <= 0
        ? {
            key: 'SALDO',
            label: 'Saldo',
            state: 'Quitado',
            tone: 'ok',
            detail: `${brl(received)} recebido de ${brl(final!)}`,
          }
        : {
            key: 'SALDO',
            label: 'Saldo',
            state: `${brl(saldo)} a receber`,
            tone: 'atencao',
            detail: others.length
              ? others
                  .map((r) => `${r.description}: ${chargeState(r).state.toLowerCase()}`)
                  .join(' · ')
              : `${brl(final! - rev.billedCents)} ainda não lançado`,
            ref: {
              receivableIds: others.map((r) => r.id),
              receivedCents: received,
              finalCents: final,
            },
          },
  );
  steps.push(
    !fiscal
      ? {
          key: 'NOTA',
          label: 'Nota fiscal',
          state: 'Não emitida',
          tone: 'neutro',
          detail: 'O agente prepara a NFS-e pelo perfil fiscal da OS.',
        }
      : {
          key: 'NOTA',
          label: 'Nota fiscal',
          state:
            {
              RASCUNHO: 'Em revisão',
              SOLICITADA: 'Aguardando autorização',
              AUTORIZADA: `Autorizada nº ${fiscal.number ?? ''}`,
              REJEITADA: 'Rejeitada',
            }[fiscal.status] ?? fiscal.status,
          tone:
            fiscal.status === 'AUTORIZADA'
              ? 'ok'
              : fiscal.status === 'REJEITADA'
                ? 'risco'
                : 'atencao',
          detail:
            fiscal.rejectionReason ??
            `${brl(fiscal.amountCents)}${fiscal.issuedAt ? ` · ${fmt(fiscal.issuedAt)}` : ''}`,
          ref: { fiscalId: fiscal.id },
        },
  );
  const pk = pickups[0];
  steps.push(
    rev.order.customerDropOff
      ? {
          key: 'RETIRADA',
          label: 'Retirada',
          state: 'Cliente entrega na oficina',
          tone: 'info',
          detail: '',
        }
      : pk
        ? {
            key: 'RETIRADA',
            label: pk.kind === 'NO_LOCAL' ? 'No local' : 'Retirada',
            state: pickupStatusLabel(pk.status, pk.kind),
            tone: ['RETIRADA_REALIZADA', 'RECEBIDA_NA_OFICINA'].includes(pk.status)
              ? 'ok'
              : pk.status === 'COM_OCORRENCIA'
                ? 'risco'
                : 'atencao',
            detail: pk.scheduledDate ? `agendada ${fmt(pk.scheduledDate)}` : 'sem data',
          }
        : receipts[0]
          ? {
              key: 'RETIRADA',
              label: 'Retirada',
              state: 'Peças recebidas na oficina',
              tone: 'ok',
              detail: `recebimento em ${fmt(receipts[0].createdAt)}`,
            }
          : {
              key: 'RETIRADA',
              label: 'Retirada',
              state: 'Não agendada',
              tone: 'atencao',
              detail: '',
            },
  );
  const dv = deliveries[0];
  steps.push(
    dv
      ? {
          key: 'ENTREGA',
          label: 'Entrega',
          state:
            (
              {
                PROVISORIA: 'Provisória',
                AGENDADA: 'Agendada',
                EM_TRANSPORTE: 'Em transporte',
                NO_DESTINO: 'No destino',
                CONCLUIDA: 'Entregue',
                FRUSTRADA: 'Frustrada',
              } as Record<string, string>
            )[dv.status] ?? dv.status,
          tone: dv.status === 'CONCLUIDA' ? 'ok' : dv.status === 'FRUSTRADA' ? 'risco' : 'atencao',
          detail: `${fmt(dv.scheduledDate)}${saldo && saldo > 0 ? ` · cobrar saldo de ${brl(saldo)}` : ''}`,
          ref: { deliveryId: dv.id },
        }
      : { key: 'ENTREGA', label: 'Entrega', state: 'Não agendada', tone: 'neutro', detail: '' },
  );
  return {
    serviceOrderId,
    osCode: osCodeOf(so.number),
    orderId,
    orderCode: orderCodeOf(rev.order.number),
    customer: so.customer.name,
    finalCents: final,
    receivedCents: received,
    balanceCents: saldo,
    steps,
  };
}

export async function fichaRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;
  app.get(
    '/api/v1/office/service-orders/:id/ficha',
    { config: { access: OFFICE_VIEW } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      return fichaOf(prisma, id);
    },
  );
}
