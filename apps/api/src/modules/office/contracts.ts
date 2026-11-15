/**
 * Contratos (agente Documentos): modelo versionado da Cenário, preenchido com os dados do pedido
 * aprovado; revisão do gestor; envio para assinatura (Clicksign) só com aprovação; retorno do
 * provedor atualiza o status e arquiva o PDF assinado na OS. Revisões preservam as anteriores.
 */
import type { PrismaClient, Tx } from '@cenario/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorFrom, audit } from '../../core/audit';
import { Errors } from '../../lib/errors';
import {
  clicksignSignature,
  officeWebhookSecret,
  onOfficeWebhook,
} from '../integrations/office-webhooks';
import { requireConnection } from '../integrations/connections';
import { idParams } from '../presenters';
import {
  OFFICE_DOCS,
  OFFICE_VIEW,
  PROVIDER_ACTOR,
  brl,
  officeEvent,
  orderCodeOf,
  osCodeOf,
  storeOfficeFile,
} from './common';
import { textPdf } from './docs';
import { type Signer, clicksignSend } from './providers';

const SERVICE: Record<string, string> = {
  REFORMA_COMPLETA: 'reforma completa',
  TROCA_DE_TECIDO: 'troca de tecido',
  TROCA_DE_ESPUMA: 'troca de espuma',
  REPARO: 'reparo',
  FABRICACAO: 'fabricação sob medida',
  INSTALACAO: 'instalação',
  OUTRO: 'serviço',
};

export const DEFAULT_TEMPLATE = `CONTRATO DE PRESTAÇÃO DE SERVIÇOS DE TAPEÇARIA — {{pedido}}

CONTRATADA: {{empresa}}, CNPJ {{empresa_cnpj}}, {{empresa_endereco}}.
CONTRATANTE: {{cliente}}, CPF/CNPJ {{cliente_documento}}, {{cliente_endereco}}, telefone {{cliente_telefone}}, e-mail {{cliente_email}}.

1. OBJETO. A CONTRATADA executará os serviços abaixo, conforme orçamento aprovado:
{{servicos}}

2. MATERIAIS. Tecido e espuma conforme a descrição acima. Diferenças de tonalidade entre lotes de tecido são inerentes ao material.

3. PREÇO E PAGAMENTO. Valor total de {{valor}}. Condições: {{parcelas}}.

4. PRAZO. Previsão de conclusão em {{prazo}}, contado a partir da retirada das peças e da confirmação do pagamento da entrada.

5. RETIRADA E ENTREGA. {{retirada}} {{entrega}} O saldo deve estar quitado até a entrega.

6. GARANTIA. 90 (noventa) dias para defeitos de execução, não cobrindo mau uso, animais, umidade ou exposição ao sol.

7. CANCELAMENTO. Após o início da produção, materiais já adquiridos e serviços executados não são reembolsáveis.

São José dos Campos, {{data}}.

______________________________          ______________________________
{{empresa}}                              {{cliente}}`;

type OrderFull = NonNullable<Awaited<ReturnType<typeof loadOrder>>>;
async function loadOrder(db: Tx | PrismaClient, id: string) {
  return db.commercialOrder.findUnique({
    where: { id },
    include: {
      customer: {
        include: { addresses: { where: { archivedAt: null }, orderBy: { isPrimary: 'desc' } } },
      },
      items: { orderBy: { position: 'asc' } },
      serviceOrders: { orderBy: { number: 'asc' } },
      receivables: { where: { status: { not: 'CANCELADO' } }, orderBy: { createdAt: 'asc' } },
    },
  });
}

const addr = (
  a:
    | {
        street: string;
        number: string;
        complement: string | null;
        district: string | null;
        city: string;
        state: string;
      }
    | undefined,
) =>
  a
    ? `${a.street}, ${a.number}${a.complement ? ` ${a.complement}` : ''}${a.district ? `, ${a.district}` : ''}, ${a.city}/${a.state}`
    : null;
const fmt = (d: Date | null) =>
  d ? d.toISOString().slice(0, 10).split('-').reverse().join('/') : null;
const docFmt = (d: string | null) =>
  !d
    ? null
    : d.length === 11
      ? d.replace(/(\d{3})(\d{3})(\d{3})(\d{2})/, '$1.$2.$3-$4')
      : d.replace(/(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})/, '$1.$2.$3/$4-$5');

/** Preenche o modelo; devolve o texto e a lista do que falta para assinar. */
export async function fillContract(db: Tx | PrismaClient, order: OrderFull, template: string) {
  const company = await db.companySettings.findUnique({ where: { id: 1 } });
  const c = order.customer;
  const missing: string[] = [];
  const val = <T>(v: T | null | undefined, label: string) => {
    if (v === null || v === undefined || v === '') {
      missing.push(label);
      return `[${label.toUpperCase()}]`;
    }
    return String(v);
  };
  const items = order.items
    .map((i) => {
      const fabric = [i.fabricName, i.fabricColor, i.fabricReference].filter(Boolean).join(' · ');
      return `- ${i.quantity}× ${i.description} — ${SERVICE[i.serviceType ?? 'OUTRO']}${fabric ? `; tecido: ${fabric}` : ''}${i.technicalNotes ? `; ${i.technicalNotes}` : ''}${i.agreedValueCents ? ` (${brl(i.agreedValueCents)})` : ''}`;
    })
    .join('\n');
  const planned = order.receivables.length
    ? order.receivables
        .map(
          (r) =>
            `${r.description}: ${brl(r.amountCents)}${r.dueDate ? ` até ${fmt(r.dueDate)}` : r.dueTrigger === 'ENTREGA' ? ' na entrega' : r.dueTrigger === 'RETIRADA' ? ' na retirada' : ''}`,
        )
        .join('; ')
    : order.paymentTerms;
  const map: Record<string, string> = {
    pedido: orderCodeOf(order.number),
    empresa: company?.legalName || company?.tradeName || 'Cenário Estofados',
    empresa_cnpj: val(company?.document, 'CNPJ da Cenário'),
    empresa_endereco: val(company?.address, 'endereço da Cenário'),
    cliente: c.name,
    cliente_documento: val(docFmt(c.document), 'CPF/CNPJ do cliente'),
    cliente_endereco: val(addr(c.addresses[0]), 'endereço do cliente'),
    cliente_telefone: c.whatsapp ?? c.phone ?? '—',
    cliente_email: val(c.email, 'e-mail do cliente (assinatura)'),
    servicos: items || val(null, 'itens do pedido'),
    valor: val(
      order.agreedValueCents !== null ? brl(order.agreedValueCents) : null,
      'valor aprovado',
    ),
    parcelas: val(planned, 'condições de pagamento'),
    prazo: val(fmt(order.promisedDate), 'prazo prometido'),
    retirada: order.customerDropOff
      ? 'O CONTRATANTE entregará as peças na oficina.'
      : `Retirada no endereço ${addr(c.addresses[0]) ?? '[a combinar]'}.`,
    entrega: 'A entrega será agendada pela CONTRATADA ao fim do serviço.',
    data: new Intl.DateTimeFormat('pt-BR', {
      dateStyle: 'long',
      timeZone: 'America/Sao_Paulo',
    }).format(new Date()),
  };
  const body = template.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => map[k] ?? `{{${k}}}`);
  return { body, missing: [...new Set(missing)] };
}

async function currentTemplate(tx: Tx, actorId: string | null) {
  const t = await tx.contractTemplate.findFirst({ where: { key: 'PADRAO', current: true } });
  if (t) return t;
  return tx.contractTemplate.create({
    data: {
      key: 'PADRAO',
      version: 1,
      name: 'Contrato padrão da Cenário',
      body: DEFAULT_TEMPLATE,
      createdById: actorId,
    },
  });
}

function contractDto(
  c: {
    id: string;
    number: number;
    orderId: string;
    serviceOrderId: string | null;
    revision: number;
    body: string;
    status: string;
    signers: unknown;
    provider: string | null;
    sentAt: Date | null;
    signedAt: Date | null;
    signedFileId: string | null;
    version: number;
    createdAt: Date;
    templateId: string;
  },
  missing: string[] = [],
) {
  return {
    id: c.id,
    number: c.number,
    orderId: c.orderId,
    serviceOrderId: c.serviceOrderId,
    revision: c.revision,
    body: c.body,
    status: c.status,
    signers: c.signers as unknown as Signer[],
    provider: c.provider,
    sentAt: c.sentAt?.toISOString() ?? null,
    signedAt: c.signedAt?.toISOString() ?? null,
    signedFileUrl: c.signedFileId ? `/api/files/${c.signedFileId}` : null,
    version: c.version,
    createdAt: c.createdAt.toISOString(),
    templateId: c.templateId,
    missing,
  };
}
const missingIn = (body: string) =>
  [...body.matchAll(/\[([^\]]+)\]/g)]
    .map((m) => m[1]!.toLowerCase())
    .filter((x) => !/^a combinar$/.test(x));

/** Agente Documentos: prepara (ou revisa) o contrato do pedido aprovado. */
export async function prepareContract(
  tx: Tx,
  actor: { userId: string | null } & Parameters<typeof audit>[1],
  orderId: string,
) {
  await tx.$queryRaw`SELECT id FROM commercial_orders WHERE id = ${orderId}::uuid FOR UPDATE`;
  const order = await loadOrder(tx, orderId);
  if (!order) throw Errors.notFound('Pedido');
  if (order.status === 'CANCELADO') throw Errors.business('Pedido cancelado.');
  if (order.agreedValueCents === null)
    throw Errors.business('O pedido ainda não tem orçamento aprovado (valor contratado).');
  const prev = await tx.contract.findFirst({
    where: { orderId, status: { in: ['RASCUNHO', 'ENVIADO', 'ASSINADO'] } },
  });
  if (prev?.status === 'ASSINADO')
    throw Errors.business(
      'O contrato deste pedido já está assinado. Para mudar, gere um aditivo/revisão explícita.',
    );
  if (prev)
    await tx.contract.update({
      where: { id: prev.id },
      data: { status: 'SUBSTITUIDO', version: { increment: 1 } },
    });
  const last = await tx.contract.findFirst({ where: { orderId }, orderBy: { revision: 'desc' } });
  const template = await currentTemplate(tx, actor.userId);
  const { body, missing } = await fillContract(tx, order, template.body);
  const company = await tx.companySettings.findUnique({ where: { id: 1 } });
  const signers: Signer[] = [
    {
      name: order.customer.name,
      email: order.customer.email ?? '',
      phone: order.customer.whatsapp ?? order.customer.phone,
      role: 'CONTRATANTE',
    },
    {
      name: company?.legalName || company?.tradeName || 'Cenário Estofados',
      email: company?.email ?? '',
      phone: null,
      role: 'CONTRATADA',
    },
  ];
  const c = await tx.contract.create({
    data: {
      orderId,
      serviceOrderId: order.serviceOrders[0]?.id ?? null,
      templateId: template.id,
      revision: (last?.revision ?? 0) + 1,
      body,
      signers: signers as never,
      supersedesId: prev?.id ?? null,
      createdById: actor.userId,
    },
  });
  const agent = await tx.aiAgent.findFirst({ where: { roleKey: 'DOCUMENTOS', status: 'ATIVO' } });
  await tx.agentAction.create({
    data: {
      agentId: agent?.id ?? null,
      channel: 'DOCUMENTOS',
      accountLabel: null,
      kind: 'CONTRATO_PREPARADO',
      summary: `Contrato ${orderCodeOf(order.number)} rev. ${c.revision} preparado${missing.length ? ` (faltam: ${missing.join(', ')})` : ''}`,
      content: null,
      status: 'RASCUNHO',
      ref: { contractId: c.id, orderId },
    },
  });
  await audit(tx, actor, {
    action: 'office.contract_prepared',
    entityType: 'contract',
    entityId: c.id,
    summary: `Contrato de ${orderCodeOf(order.number)} (rev. ${c.revision}) preparado pelo modelo v${template.version}.`,
  });
  await officeEvent(tx, actor, 'contract', c.id, { orderId });
  return contractDto(c, missing);
}

export async function contractRoutes(app: FastifyInstance) {
  const { prisma, storage } = app.ctx;

  app.get('/api/v1/office/contract-templates', { config: { access: OFFICE_VIEW } }, async () => {
    const rows = await prisma.contractTemplate.findMany({
      orderBy: [{ key: 'asc' }, { version: 'desc' }],
    });
    return rows.length
      ? rows
      : [
          {
            id: null,
            key: 'PADRAO',
            version: 0,
            name: 'Contrato padrão da Cenário (ainda não salvo)',
            body: DEFAULT_TEMPLATE,
            current: true,
          },
        ];
  });

  /** Nova versão do modelo (a anterior fica no histórico; contratos antigos mantêm a sua). */
  app.post(
    '/api/v1/office/contract-templates',
    { config: { access: OFFICE_DOCS, idempotent: true } },
    async (request) => {
      const b = z
        .object({
          name: z.string().trim().min(3).max(120),
          body: z.string().trim().min(50).max(40000),
        })
        .parse(request.body);
      const actor = actorFrom(request);
      return prisma.$transaction(async (tx) => {
        const cur = await currentTemplate(tx, actor.userId);
        await tx.contractTemplate.update({ where: { id: cur.id }, data: { current: false } });
        const t = await tx.contractTemplate.create({
          data: {
            key: 'PADRAO',
            version: cur.version + 1,
            name: b.name,
            body: b.body,
            createdById: actor.userId,
          },
        });
        await audit(tx, actor, {
          action: 'office.contract_template_saved',
          entityType: 'contract_template',
          entityId: t.id,
          summary: `Modelo de contrato v${t.version} salvo.`,
        });
        return t;
      });
    },
  );

  app.get(
    '/api/v1/office/orders/:id/contracts',
    { config: { access: OFFICE_VIEW } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const rows = await prisma.contract.findMany({
        where: { orderId: id },
        orderBy: { revision: 'desc' },
      });
      return rows.map((c) =>
        contractDto(c, ['RASCUNHO'].includes(c.status) ? missingIn(c.body) : []),
      );
    },
  );

  app.post(
    '/api/v1/office/orders/:id/contract',
    { config: { access: OFFICE_DOCS, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      return prisma.$transaction((tx) => prepareContract(tx, actorFrom(request), id));
    },
  );

  /** Revisão do gestor: corrige o texto e os signatários antes do envio. */
  app.put(
    '/api/v1/office/contracts/:id',
    { config: { access: OFFICE_DOCS, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const b = z
        .object({
          body: z.string().trim().min(50).max(40000),
          signers: z
            .array(
              z.object({
                name: z.string().trim().min(2).max(160),
                email: z.string().trim().email().max(254),
                phone: z.string().max(20).nullable().optional(),
                role: z.enum(['CONTRATANTE', 'CONTRATADA', 'TESTEMUNHA']),
              }),
            )
            .min(1)
            .max(6),
          version: z.number().int().positive(),
        })
        .parse(request.body);
      const actor = actorFrom(request);
      return prisma.$transaction(async (tx) => {
        const c = await tx.contract.findUnique({ where: { id } });
        if (!c) throw Errors.notFound('Contrato');
        if (c.status !== 'RASCUNHO')
          throw Errors.business('Só contratos em rascunho podem ser editados.');
        if (c.version !== b.version)
          throw Errors.conflict('O contrato mudou desde que você abriu. Recarregue.');
        const u = await tx.contract.update({
          where: { id },
          data: { body: b.body, signers: b.signers as never, version: { increment: 1 } },
        });
        await audit(tx, actor, {
          action: 'office.contract_edited',
          entityType: 'contract',
          entityId: id,
          summary: `Contrato revisado pelo gestor (rev. ${c.revision}).`,
        });
        await officeEvent(tx, actor, 'contract', id);
        return contractDto(u, missingIn(u.body));
      });
    },
  );

  /** Envio para assinatura: exige revisão completa (nada faltando) e aprovação explícita. */
  app.post(
    '/api/v1/office/contracts/:id/send',
    { config: { access: OFFICE_DOCS, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const { version } = z.object({ version: z.number().int().positive() }).parse(request.body);
      const actor = actorFrom(request);
      const c = await prisma.contract.findUnique({ where: { id }, include: { order: true } });
      if (!c) throw Errors.notFound('Contrato');
      if (c.status !== 'RASCUNHO') throw Errors.business('Este contrato já foi enviado.');
      if (c.version !== version)
        throw Errors.conflict('O contrato mudou desde que você revisou. Recarregue.');
      const missing = missingIn(c.body);
      const signers = c.signers as unknown as Signer[];
      if (missing.length)
        throw Errors.business(`Complete antes de enviar: ${missing.join(', ')}.`, { missing });
      if (signers.some((s) => !s.email))
        throw Errors.business('Todos os signatários precisam de e-mail.');
      const conn = await requireConnection(prisma, 'ASSINATURA');
      const pdf = textPdf(`Contrato ${orderCodeOf(c.order.number)} — rev. ${c.revision}`, c.body);
      const sent = await clicksignSend(
        { mode: conn.mode, secret: conn.secret as never },
        { name: `Contrato ${orderCodeOf(c.order.number)} rev ${c.revision}`, pdf, signers },
      );
      return prisma.$transaction(async (tx) => {
        const u = await tx.contract.update({
          where: { id },
          data: {
            status: 'ENVIADO',
            provider: sent.test ? 'CLICKSIGN_TESTE' : 'CLICKSIGN',
            providerEnvelopeId: sent.envelopeId,
            sentAt: new Date(),
            version: { increment: 1 },
          },
        });
        await tx.agentAction.create({
          data: {
            agentId: null,
            channel: 'ASSINATURA',
            accountLabel: conn.accountLabel,
            kind: 'CONTRATO_ENVIADO',
            summary: `Contrato ${orderCodeOf(c.order.number)} enviado para ${signers.map((s) => s.name).join(', ')}`,
            content: null,
            status: sent.test ? 'ENVIADO_TESTE' : 'ENVIADO',
            approvedById: actor.userId,
            ref: { contractId: id, envelopeId: sent.envelopeId },
          },
        });
        await audit(tx, actor, {
          action: 'office.contract_sent',
          entityType: 'contract',
          entityId: id,
          summary: `Contrato enviado para assinatura${sent.test ? ' (teste)' : ''}.`,
        });
        await officeEvent(tx, actor, 'contract', id);
        return contractDto(u);
      });
    },
  );

  /** Modo de teste: simula o retorno da Clicksign (assinado/recusado) pelo MESMO webhook com HMAC. */
  app.post(
    '/api/v1/office/contracts/:id/simulate',
    { config: { access: OFFICE_DOCS } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const { event } = z
        .object({ event: z.enum(['auto_close', 'refusal']).default('auto_close') })
        .parse(request.body ?? {});
      const c = await prisma.contract.findUnique({ where: { id } });
      if (!c?.providerEnvelopeId?.startsWith('env-teste-'))
        throw Errors.business('Simulação só para contratos enviados em modo de teste.');
      const raw = JSON.stringify({
        event: { name: event, occurred_at: new Date().toISOString() },
        envelope: {
          id: c.providerEnvelopeId,
          status: event === 'auto_close' ? 'closed' : 'canceled',
        },
      });
      const res = await app.inject({
        method: 'POST',
        url: '/api/webhooks/clicksign',
        payload: raw,
        headers: {
          'content-type': 'application/json',
          'content-hmac': clicksignSignature(officeWebhookSecret('CLICKSIGN')!, raw),
        },
      });
      return res.json();
    },
  );

  // Retorno da Clicksign: envelope fechado (todos assinaram) ou recusado.
  onOfficeWebhook('CLICKSIGN', async (db, payload) => {
    const ev = (payload.event ?? {}) as { name?: string };
    const env = (payload.envelope ?? payload.document ?? {}) as { id?: string; key?: string };
    const envId = env.id ?? env.key;
    if (!envId) return 'sem envelope';
    return db.$transaction(async (tx) => {
      const c = await tx.contract.findUnique({
        where: { providerEnvelopeId: envId },
        include: { order: true },
      });
      if (!c) return 'envelope desconhecido';
      if (c.status !== 'ENVIADO') return `já ${c.status.toLowerCase()}`;
      if (ev.name === 'auto_close' || ev.name === 'close' || ev.name === 'document_closed') {
        const pdf = textPdf(
          `Contrato ${orderCodeOf(c.order.number)} — rev. ${c.revision} (ASSINADO)`,
          `${c.body}\n\n— Assinado eletronicamente via Clicksign em ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}. Envelope ${envId}.`,
        );
        const fileId = await storeOfficeFile(tx, storage, PROVIDER_ACTOR, {
          name: `contrato-${orderCodeOf(c.order.number)}-rev${c.revision}-assinado.pdf`,
          mime: 'application/pdf',
          data: pdf,
        });
        await tx.contract.update({
          where: { id: c.id },
          data: {
            status: 'ASSINADO',
            signedAt: new Date(),
            signedFileId: fileId,
            version: { increment: 1 },
          },
        });
        await tx.accountingDocument.create({
          data: {
            month: new Date().toISOString().slice(0, 7),
            kind: 'OUTRO',
            title: `Contrato assinado ${orderCodeOf(c.order.number)}${c.serviceOrderId ? '' : ''}`,
            fileId,
            refType: 'contract',
            refId: c.id,
          },
        });
        await audit(tx, PROVIDER_ACTOR, {
          action: 'office.contract_signed',
          entityType: 'contract',
          entityId: c.id,
          summary: `Contrato ${orderCodeOf(c.order.number)} assinado (retorno da Clicksign); PDF arquivado.`,
        });
        await officeEvent(tx, PROVIDER_ACTOR, 'contract', c.id);
        return 'assinado';
      }
      if (ev.name === 'refusal' || ev.name === 'cancel') {
        await tx.contract.update({
          where: { id: c.id },
          data: {
            status: ev.name === 'refusal' ? 'RECUSADO' : 'CANCELADO',
            version: { increment: 1 },
          },
        });
        await audit(tx, PROVIDER_ACTOR, {
          action: 'office.contract_refused',
          entityType: 'contract',
          entityId: c.id,
          summary: `Contrato ${orderCodeOf(c.order.number)} ${ev.name === 'refusal' ? 'recusado' : 'cancelado'} na Clicksign.`,
        });
        await officeEvent(tx, PROVIDER_ACTOR, 'contract', c.id);
        return 'recusado';
      }
      return `evento ${ev.name} ignorado`;
    });
  });
  void osCodeOf;
}
