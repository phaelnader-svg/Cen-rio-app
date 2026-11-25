/**
 * Contrato do serviço fechado (Orçamentos do Escritório, 2026-11-25): o pedido com valor
 * combinado e sem contrato ganha a proposta de mandar o contrato. Aprovar prepara o contrato pelo
 * modelo da empresa (o mesmo do agente Documentos) e a mensagem leva o link do PDF para o cliente
 * ler. Faltando dado no cadastro, a proposta diz o quê, e aprovar não manda nada pela metade.
 */
import { contractMessage, whatsappLink, whatsappNumber } from '@cenario/shared';
import type { PrismaClient, Tx } from '@cenario/db';
import type { ActorContext } from '../../core/types';
import { Errors } from '../../lib/errors';
import { orderCodeOf } from '../office/common';
import { DEFAULT_TEMPLATE, fillContract, loadOrder, prepareContract } from '../office/contracts';
import type { ProposalDraft } from './agent-engines';

type Db = PrismaClient | Tx;

let contractLink: ((id: string) => string) | null = null;
export function setContractLinker(fn: (id: string) => string) {
  contractLink = fn;
}

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** Pedidos fechados nas últimas 2 semanas sem contrato (nem rascunho, nem enviado, nem assinado). */
export async function contractProposals(
  db: Db,
  today: string,
  company: string,
): Promise<ProposalDraft[]> {
  const orders = await db.commercialOrder.findMany({
    where: {
      agreedValueCents: { not: null },
      status: { not: 'CANCELADO' },
      createdAt: { gte: new Date(`${addDays(today, -14)}T00:00:00Z`) },
      contracts: { none: { status: { in: ['RASCUNHO', 'ENVIADO', 'ASSINADO'] } } },
    },
    select: { id: true },
    orderBy: { createdAt: 'asc' },
    take: 5,
  });
  if (!orders.length) return [];
  const t = await db.contractTemplate.findFirst({ where: { key: 'PADRAO', current: true } });
  const out: ProposalDraft[] = [];
  for (const { id } of orders) {
    const order = await loadOrder(db, id);
    if (!order) continue;
    const cu = order.customer;
    const phone = whatsappNumber(cu.whatsapp || cu.phone);
    if (!phone) continue;
    const { missing } = await fillContract(db, order, t?.body ?? DEFAULT_TEMPLATE, {
      emailOptional: true,
    });
    const code = orderCodeOf(order.number);
    const text = contractMessage({ customerName: cu.name, companyName: company, orderCode: code });
    out.push({
      kind: 'ENVIAR_MENSAGEM',
      title: `Mandar o contrato de ${code} para ${cu.name}`,
      detail: text,
      payload: {
        task: 'ENVIAR_CONTRATO',
        dedupe: `ENVIAR_CONTRATO:${order.id}`,
        orderId: order.id,
        orderCode: code,
        customerId: cu.id,
        customerName: cu.name,
        phone,
        text,
        channel: 'WHATSAPP',
        ...(missing.length ? { missing } : {}),
      },
      evidence: [{ type: 'OS', id: order.id, label: code, href: `/painel/pedidos/${order.id}` }],
    });
  }
  return out;
}

/** Aprovar: prepara o contrato e põe o link do PDF na mensagem (que sai pelo WhatsApp a seguir). */
export async function prepareApprovedContract(
  tx: Tx,
  actor: ActorContext,
  perms: ReadonlySet<string>,
  p: { payload: unknown; detail: string },
  editedText: string | undefined,
) {
  if (!perms.has('pedidos.gerenciar'))
    throw Errors.forbidden('Mandar contrato exige a permissão de pedidos.');
  const pl = (p.payload ?? {}) as Record<string, unknown>;
  if (pl.contractId) throw Errors.conflict('Este contrato já foi preparado.');
  const c = await prepareContract(tx, actor, String(pl.orderId), { emailOptional: true });
  // Faltou dado: desfaz tudo (a transação volta) e diz o que completar.
  if (c.missing.length)
    throw Errors.business(
      `Falta no cadastro para o contrato: ${c.missing.join(', ')}. Complete no pedido e aprove de novo.`,
      { missing: c.missing },
    );
  const link = contractLink ? contractLink(c.id) : '';
  const text = String(editedText ?? pl.text ?? p.detail).replace('{link}', link);
  return {
    contractId: c.id,
    link,
    text,
    href: pl.phone ? whatsappLink(String(pl.phone), text) : null,
  };
}
