/**
 * Emissão fiscal (NFS-e de São José dos Campos pelo padrão nacional — Emissor Nacional desde
 * 01/10/2026). O agente prepara a nota a partir do pedido e do perfil fiscal da OS; o gestor
 * revisa e autoriza. Perfis (reforma × fabricação) ficam configuráveis e só emitem depois de
 * validados pela contabilidade. Sem provedor configurado, nada é emitido: a tela diz o que falta.
 * Em TESTE_LOCAL a autorização é simulada (número "TESTE-…"), para validar o fluxo.
 */
import type { Prisma, Tx } from '@cenario/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorFrom, audit } from '../../core/audit';
import { Errors } from '../../lib/errors';
import { connectionOf } from '../integrations/connections';
import { orderRevenue } from '../finance/revenue';
import { idParams } from '../presenters';
import {
  type Db,
  OFFICE_FIN,
  OFFICE_FIN_VIEW,
  brl,
  officeEvent,
  orderCodeOf,
  storeOfficeFile,
} from './common';
import { textPdf } from './docs';

const REFORMA = [
  'REFORMA_COMPLETA',
  'TROCA_DE_TECIDO',
  'TROCA_DE_ESPUMA',
  'REPARO',
  'INSTALACAO',
  'OUTRO',
];
export const PROFILE_HINTS: Record<string, string> = {
  'Reforma de estofados (serviço)':
    'Sugestão a confirmar com a contabilidade: item 14.11 da LC 116/2003 (“Tapeçaria e reforma de estofamentos em geral”), NFS-e no padrão nacional; informe o código de tributação nacional e a alíquota de ISS de São José dos Campos.',
  'Fabricação sob encomenda':
    'A contabilidade deve definir se a fabricação sob encomenda sai como NF-e (produto: NCM/CFOP) ou NFS-e (industrialização por encomenda). Até lá, este perfil não emite.',
};

export async function ensureProfiles(db: Db) {
  if (await db.fiscalProfile.count()) return;
  await db.fiscalProfile.createMany({
    data: [
      {
        name: 'Reforma de estofados (serviço)',
        documentKind: 'NFSE',
        serviceTypes: REFORMA,
        descriptionTemplate:
          'Serviço de tapeçaria/reforma de estofados — {{servicos}}. Pedido {{pedido}}.',
      },
      {
        name: 'Fabricação sob encomenda',
        documentKind: 'NFE',
        serviceTypes: ['FABRICACAO'],
        descriptionTemplate: 'Fabricação sob encomenda — {{servicos}}. Pedido {{pedido}}.',
      },
    ],
  });
}

type Profile = Prisma.FiscalProfileGetPayload<object>;
function profileMissing(p: Profile) {
  const m: string[] = [];
  if (!p.validatedByAccountant) m.push('perfil fiscal validado pela contabilidade');
  if (p.documentKind === 'NFSE') {
    if (!p.serviceCode) m.push('código de tributação nacional do serviço');
    if (p.issRatePercent === null) m.push('alíquota de ISS');
  } else {
    if (!p.ncm) m.push('NCM');
    if (!p.cfop) m.push('CFOP');
  }
  return m;
}

async function missingFor(db: Db, doc: { profileId: string; customerData: unknown }) {
  const p = await db.fiscalProfile.findUniqueOrThrow({ where: { id: doc.profileId } });
  const c = doc.customerData as {
    document: string | null;
    address: string | null;
    email: string | null;
  };
  const conn = await connectionOf(db, 'FISCAL');
  const company = await db.companySettings.findUnique({ where: { id: 1 } });
  return [
    ...profileMissing(p),
    ...(c.document ? [] : ['CPF/CNPJ do cliente']),
    ...(c.address ? [] : ['endereço do cliente']),
    ...(company?.document ? [] : ['CNPJ da Cenário']),
    ...(conn?.status === 'CONECTADA' ? [] : ['conexão com o emissor fiscal (Central de Conexões)']),
  ];
}

export function fiscalDto(
  d: Prisma.FiscalDocumentGetPayload<{ include: { profile: true } }>,
  missing: string[],
) {
  return {
    id: d.id,
    orderId: d.orderId,
    serviceOrderId: d.serviceOrderId,
    profile: { id: d.profile.id, name: d.profile.name, documentKind: d.profile.documentKind },
    status: d.status,
    customerData: d.customerData,
    description: d.description,
    amountCents: d.amountCents,
    provider: d.provider,
    number: d.number,
    accessKey: d.accessKey,
    files: d.files as { name: string; url: string }[],
    rejectionReason: d.rejectionReason,
    issuedAt: d.issuedAt?.toISOString() ?? null,
    version: d.version,
    missing,
  };
}

async function prepare(tx: Tx, actor: Parameters<typeof audit>[1], orderId: string) {
  await ensureProfiles(tx);
  const rev = await orderRevenue(tx, orderId);
  if (rev.finalCents === null) throw Errors.business('Pedido sem valor contratado.');
  const open = await tx.fiscalDocument.findFirst({
    where: { orderId, status: { in: ['RASCUNHO', 'SOLICITADA', 'AUTORIZADA'] } },
    include: { profile: true },
  });
  if (open) return fiscalDto(open, open.status === 'RASCUNHO' ? await missingFor(tx, open) : []);
  const order = await tx.commercialOrder.findUniqueOrThrow({
    where: { id: orderId },
    include: {
      customer: {
        include: { addresses: { where: { archivedAt: null }, orderBy: { isPrimary: 'desc' } } },
      },
      items: { orderBy: { position: 'asc' } },
      serviceOrders: true,
    },
  });
  const kinds = order.items.map((i) => i.serviceType ?? 'OUTRO');
  const profiles = await tx.fiscalProfile.findMany({ where: { active: true } });
  const profile =
    profiles.find((p) => kinds.some((k) => p.serviceTypes.includes(k))) ?? profiles[0]!;
  const a = order.customer.addresses[0];
  const servicos = order.items.map((i) => `${i.quantity}× ${i.description}`).join('; ');
  const d = await tx.fiscalDocument.create({
    data: {
      orderId,
      serviceOrderId: order.serviceOrders[0]?.id ?? null,
      profileId: profile.id,
      customerData: {
        name: order.customer.name,
        document: order.customer.document,
        email: order.customer.email,
        address: a
          ? `${a.street}, ${a.number}${a.district ? `, ${a.district}` : ''}, ${a.city}/${a.state}${a.postalCode ? `, CEP ${a.postalCode}` : ''}`
          : null,
      },
      description: profile.descriptionTemplate
        .replace('{{servicos}}', servicos)
        .replace('{{pedido}}', orderCodeOf(order.number))
        .slice(0, 2000),
      amountCents: rev.finalCents,
      createdById: actor.userId,
    },
    include: { profile: true },
  });
  await tx.agentAction.create({
    data: {
      agentId: null,
      channel: 'FISCAL',
      accountLabel: null,
      kind: 'NOTA_PREPARADA',
      summary: `NFS-e de ${orderCodeOf(order.number)} preparada (${profile.name})`,
      content: d.description,
      status: 'RASCUNHO',
      ref: { fiscalId: d.id },
    },
  });
  await audit(tx, actor, {
    action: 'office.fiscal_prepared',
    entityType: 'fiscal_document',
    entityId: d.id,
    summary: `Nota de ${orderCodeOf(order.number)} preparada (${brl(d.amountCents)}).`,
  });
  await officeEvent(tx, actor, 'fiscal_document', d.id, { orderId });
  return fiscalDto(d, await missingFor(tx, d));
}

export async function fiscalRoutes(app: FastifyInstance) {
  const { prisma, storage } = app.ctx;

  app.get('/api/v1/office/fiscal/profiles', { config: { access: OFFICE_FIN_VIEW } }, async () => {
    await ensureProfiles(prisma);
    const rows = await prisma.fiscalProfile.findMany({ orderBy: { createdAt: 'asc' } });
    return rows.map((p) => ({
      ...p,
      issRatePercent: p.issRatePercent === null ? null : Number(p.issRatePercent),
      missing: profileMissing(p),
      hint: PROFILE_HINTS[p.name] ?? null,
    }));
  });

  app.put(
    '/api/v1/office/fiscal/profiles/:id',
    { config: { access: OFFICE_FIN, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const b = z
        .object({
          documentKind: z.enum(['NFSE', 'NFE']),
          serviceCode: z.string().trim().max(20).nullable(),
          municipalTaxCode: z.string().trim().max(20).nullable(),
          cnae: z.string().trim().max(20).nullable(),
          issRatePercent: z.number().min(0).max(10).nullable(),
          ncm: z.string().trim().max(10).nullable(),
          cfop: z.string().trim().max(10).nullable(),
          descriptionTemplate: z.string().trim().min(10).max(1000),
          validatedByAccountant: z.boolean(),
          version: z.number().int().positive(),
        })
        .parse(request.body);
      const actor = actorFrom(request);
      return prisma.$transaction(async (tx) => {
        const p = await tx.fiscalProfile.findUnique({ where: { id } });
        if (!p) throw Errors.notFound('Perfil fiscal');
        if (p.version !== b.version) throw Errors.conflict('O perfil mudou. Recarregue.');
        const { version: _v, ...data } = b;
        const u = await tx.fiscalProfile.update({
          where: { id },
          data: { ...data, version: { increment: 1 } },
        });
        await audit(tx, actor, {
          action: 'office.fiscal_profile_saved',
          entityType: 'fiscal_profile',
          entityId: id,
          summary: `Perfil fiscal "${p.name}" atualizado${b.validatedByAccountant ? ' (validado pela contabilidade)' : ''}.`,
          changes: data,
        });
        return {
          ...u,
          issRatePercent: u.issRatePercent === null ? null : Number(u.issRatePercent),
          missing: profileMissing(u),
        };
      });
    },
  );

  app.get(
    '/api/v1/office/orders/:id/fiscal',
    { config: { access: OFFICE_FIN_VIEW } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const rows = await prisma.fiscalDocument.findMany({
        where: { orderId: id },
        include: { profile: true },
        orderBy: { createdAt: 'desc' },
      });
      return Promise.all(
        rows.map(async (d) =>
          fiscalDto(d, d.status === 'RASCUNHO' ? await missingFor(prisma, d) : []),
        ),
      );
    },
  );

  app.post(
    '/api/v1/office/orders/:id/fiscal',
    { config: { access: OFFICE_FIN, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      return prisma.$transaction((tx) => prepare(tx, actorFrom(request), id));
    },
  );

  app.put(
    '/api/v1/office/fiscal/:id',
    { config: { access: OFFICE_FIN, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const b = z
        .object({
          description: z.string().trim().min(10).max(2000),
          amountCents: z.number().int().positive(),
          profileId: z.string().uuid(),
          version: z.number().int().positive(),
        })
        .parse(request.body);
      const actor = actorFrom(request);
      return prisma.$transaction(async (tx) => {
        const d = await tx.fiscalDocument.findUnique({ where: { id } });
        if (!d) throw Errors.notFound('Nota');
        if (d.status !== 'RASCUNHO')
          throw Errors.business('Só notas em revisão podem ser editadas.');
        if (d.version !== b.version) throw Errors.conflict('A nota mudou. Recarregue.');
        const u = await tx.fiscalDocument.update({
          where: { id },
          data: {
            description: b.description,
            amountCents: b.amountCents,
            profileId: b.profileId,
            version: { increment: 1 },
          },
          include: { profile: true },
        });
        await audit(tx, actor, {
          action: 'office.fiscal_edited',
          entityType: 'fiscal_document',
          entityId: id,
          summary: 'Nota revisada pelo gestor.',
        });
        return fiscalDto(u, await missingFor(tx, u));
      });
    },
  );

  /** Autorização: só com tudo configurado; arquivos e número ficam guardados na nota/OS. */
  app.post(
    '/api/v1/office/fiscal/:id/authorize',
    { config: { access: OFFICE_FIN, idempotent: true } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const { version } = z.object({ version: z.number().int().positive() }).parse(request.body);
      const actor = actorFrom(request);
      return prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM fiscal_documents WHERE id = ${id}::uuid FOR UPDATE`;
        const d = await tx.fiscalDocument.findUnique({
          where: { id },
          include: { profile: true, order: true },
        });
        if (!d) throw Errors.notFound('Nota');
        if (d.status !== 'RASCUNHO')
          throw Errors.business('Esta nota já foi enviada para autorização.');
        if (d.version !== version)
          throw Errors.conflict('A nota mudou desde a sua revisão. Recarregue.');
        const missing = await missingFor(tx, d);
        if (missing.length)
          throw Errors.business(`Para emitir falta: ${missing.join('; ')}.`, { missing });
        const conn = (await connectionOf(tx, 'FISCAL'))!;
        if (conn.mode !== 'TESTE_LOCAL')
          throw Errors.business(
            'Emissão real ainda não integrada: escolha o provedor (FISCAL_PROVIDER) compatível com o Emissor Nacional e homologue com a contabilidade.',
          );
        const seq = (await tx.fiscalDocument.count({ where: { status: 'AUTORIZADA' } })) + 1;
        const number = `TESTE-${String(seq).padStart(6, '0')}`;
        const c = d.customerData as { name: string; document: string; address: string };
        const pdf = textPdf(
          `NFS-e ${number} (HOMOLOGAÇÃO LOCAL — SEM VALOR FISCAL)`,
          `Prestador: Cenário Estofados\nTomador: ${c.name} — ${c.document}\n${c.address}\n\nDiscriminação: ${d.description}\n\nValor do serviço: ${brl(d.amountCents)}\nPerfil: ${d.profile.name} · código ${d.profile.serviceCode} · ISS ${d.profile.issRatePercent}%`,
        );
        const xml = Buffer.from(
          `<?xml version="1.0" encoding="UTF-8"?>\n<NFSeTeste numero="${number}" valor="${(d.amountCents / 100).toFixed(2)}" codigo="${d.profile.serviceCode}"><tomador>${c.name}</tomador><discriminacao>${d.description.replace(/[<&]/g, ' ')}</discriminacao></NFSeTeste>\n`,
        );
        const pdfId = await storeOfficeFile(tx, storage, actor, {
          name: `nfse-${number}.pdf`,
          mime: 'application/pdf',
          data: pdf,
        });
        const xmlId = await storeOfficeFile(tx, storage, actor, {
          name: `nfse-${number}.xml`,
          mime: 'application/xml',
          data: xml,
        });
        const files = [
          { name: `nfse-${number}.pdf`, url: `/api/files/${pdfId}` },
          { name: `nfse-${number}.xml`, url: `/api/files/${xmlId}` },
        ];
        const u = await tx.fiscalDocument.update({
          where: { id },
          data: {
            status: 'AUTORIZADA',
            provider: 'TESTE_LOCAL',
            providerRef: `teste-${id}`,
            number,
            files,
            issuedAt: new Date(),
            approvedById: actor.userId,
            fiscalData: {
              serviceCode: d.profile.serviceCode,
              issRatePercent: Number(d.profile.issRatePercent),
            },
            version: { increment: 1 },
          },
          include: { profile: true },
        });
        const month = new Date().toISOString().slice(0, 7);
        await tx.accountingDocument.create({
          data: {
            month,
            kind: 'NOTA_EMITIDA',
            title: `NFS-e ${number} — ${c.name} — ${brl(d.amountCents)}`,
            fileId: pdfId,
            refType: 'fiscal_document',
            refId: id,
          },
        });
        await tx.accountingDocument.create({
          data: {
            month,
            kind: 'NOTA_EMITIDA',
            title: `NFS-e ${number} (XML)`,
            fileId: xmlId,
            refType: 'fiscal_document',
            refId: id,
          },
        });
        await tx.agentAction.create({
          data: {
            agentId: null,
            channel: 'FISCAL',
            accountLabel: conn.accountLabel,
            kind: 'NOTA_AUTORIZADA',
            summary: `NFS-e ${number} autorizada (${orderCodeOf(d.order.number)})`,
            content: null,
            status: 'EXECUTADO_TESTE',
            approvedById: actor.userId,
            ref: { fiscalId: id },
          },
        });
        await audit(tx, actor, {
          action: 'office.fiscal_authorized',
          entityType: 'fiscal_document',
          entityId: id,
          summary: `Nota ${number} autorizada (homologação local) para ${orderCodeOf(d.order.number)}.`,
        });
        await officeEvent(tx, actor, 'fiscal_document', id, { orderId: d.orderId });
        return fiscalDto(u, []);
      });
    },
  );
}
