/**
 * Despesa pela foto (Financeiro, 2026-11-25): o dono tira a foto do comprovante (nota, cupom,
 * recibo, Pix) no Escritório; a IA lê o valor, a data, quem recebeu e sugere a categoria; o
 * Financeiro deixa a despesa pronta para aprovar (ou lança sozinho, conforme o nível da tarefa).
 * A foto fica guardada junto com o pedido (finalidade "office-document").
 */
import { randomUUID } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import {
  EVENT_TYPES,
  EXPENSE_CATEGORIES,
  PAYMENT_METHODS,
  PAYMENT_METHOD_LABEL,
} from '@cenario/shared';
import type { Prisma, PrismaClient } from '@cenario/db';
import type { FastifyInstance } from 'fastify';
import { actorFrom, audit } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import { processImage } from '../../core/storage/image';
import { sha256Hex } from '../../lib/crypto';
import { readImageUpload } from '../../core/storage/upload';
import { Errors } from '../../lib/errors';
import { listExpenseCategories } from '../finance/categories';
import { shopTimezone, todayIso } from '../finance/common';
import { aiAvailable } from './agent-office';
import { OFFICE_ACCESS, doAlone, officeGuard, officeOverview, routeOfNow } from './office';

export interface ReceiptReading {
  /** Dá para ler um comprovante na foto. */
  ok: boolean;
  amountCents: number | null;
  date: string | null;
  beneficiary: string | null;
  description: string | null;
  category: string | null;
  paid: boolean;
  method: string | null;
  /** Materiais da nota com o preço de cada um (vazio quando não é nota de material). */
  items?: {
    description: string;
    quantity: number | null;
    unit: string | null;
    unitPriceCents: number;
  }[];
  /** Por que não deu para ler (foto ruim, não é comprovante). */
  problem: string | null;
}

type Reader = (
  image: { data: Buffer; mime: string },
  ctx: { categories: { value: string; label: string }[]; today: string },
) => Promise<ReceiptReading>;

const RECEIPT_TOOL = {
  name: 'registrar_comprovante',
  description: 'Registra o que foi lido no comprovante de despesa da foto.',
  input_schema: {
    type: 'object' as const,
    properties: {
      ok: { type: 'boolean', description: 'true se a foto mostra um comprovante legível' },
      valor_reais: { type: ['number', 'null'], description: 'valor total pago, em reais' },
      data: { type: ['string', 'null'], description: 'data do comprovante, AAAA-MM-DD' },
      quem_recebeu: { type: ['string', 'null'], description: 'empresa ou pessoa que recebeu' },
      descricao: { type: ['string', 'null'], description: 'o que foi comprado, curto' },
      categoria: { type: ['string', 'null'], description: 'valor exato de uma das categorias' },
      pago: { type: 'boolean', description: 'true se o comprovante mostra que já foi pago' },
      forma: { type: ['string', 'null'], enum: [...PAYMENT_METHODS, null] },
      itens: {
        type: 'array',
        description:
          'itens da nota com preço unitário (tecido, espuma, cola, grampo, madeira...); vazio se não tiver itens',
        items: {
          type: 'object',
          properties: {
            descricao: { type: 'string' },
            quantidade: { type: ['number', 'null'] },
            unidade: { type: ['string', 'null'], description: 'm, kg, un, rolo, folha, l' },
            preco_unitario_reais: { type: ['number', 'null'] },
          },
          required: ['descricao', 'preco_unitario_reais'],
        },
      },
      problema: { type: ['string', 'null'], description: 'se não deu para ler, por quê' },
    },
    required: ['ok', 'valor_reais', 'data', 'quem_recebeu', 'descricao', 'categoria', 'pago'],
  },
};

const anthropicReader: Reader = async (image, ctx) => {
  const client = new Anthropic({ timeout: 45_000, maxRetries: 1 });
  const r = await client.messages.create({
    model: process.env.GAME_AI_MODEL || 'claude-opus-5-5',
    max_tokens: 800,
    tools: [RECEIPT_TOOL],
    tool_choice: { type: 'tool', name: RECEIPT_TOOL.name },
    system: [
      'Você lê comprovantes de despesa de uma tapeçaria brasileira (nota fiscal, cupom, recibo, comprovante de Pix ou boleto).',
      `Hoje é ${ctx.today}. Datas sem ano são deste ano.`,
      `Categorias (use o valor exato): ${ctx.categories.map((c) => `${c.value} (${c.label})`).join('; ')}.`,
      `Formas de pagamento: ${PAYMENT_METHODS.map((m) => `${m} (${PAYMENT_METHOD_LABEL[m]})`).join('; ')}.`,
      'Em nota de material, liste os itens com quantidade, unidade e preço de cada unidade.',
      'Não invente: o que não estiver legível vai como null.',
    ].join('\n'),
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: image.mime as 'image/jpeg' | 'image/png' | 'image/webp',
              data: image.data.toString('base64'),
            },
          },
          { type: 'text', text: 'Leia este comprovante.' },
        ],
      },
    ],
  });
  const block = r.content.find((b) => b.type === 'tool_use');
  const i = (block && 'input' in block ? block.input : {}) as Record<string, unknown>;
  const reais = typeof i.valor_reais === 'number' ? i.valor_reais : null;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  return {
    ok: i.ok === true,
    amountCents: reais && reais > 0 ? Math.round(reais * 100) : null,
    date: str(i.data),
    beneficiary: str(i.quem_recebeu),
    description: str(i.descricao),
    category: str(i.categoria),
    paid: i.pago === true,
    method: str(i.forma),
    items: (Array.isArray(i.itens) ? (i.itens as Record<string, unknown>[]) : [])
      .map((x) => ({
        description: str(x.descricao) ?? '',
        quantity: typeof x.quantidade === 'number' && x.quantidade > 0 ? x.quantidade : null,
        unit: str(x.unidade),
        unitPriceCents:
          typeof x.preco_unitario_reais === 'number' ? Math.round(x.preco_unitario_reais * 100) : 0,
      }))
      .filter((x) => x.description && x.unitPriceCents > 0)
      .slice(0, 40),
    problem: str(i.problema),
  };
};

let reader: Reader = anthropicReader;
/** Testes: troca a leitura da IA por uma resposta fixa (null volta ao normal). */
export function setReceiptReader(r: Reader | null) {
  reader = r ?? anthropicReader;
}

const brl = (c: number) =>
  (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const br = (iso: string) => iso.split('-').reverse().join('/');

export async function receiptRoutes(app: FastifyInstance) {
  const { prisma, storage, env } = app.ctx;

  app.post(
    '/api/v1/office/receipt',
    {
      config: {
        access: {
          session: 'WEB',
          permissions: [...OFFICE_ACCESS.permissions, 'financeiro.gerenciar'],
        },
      },
    },
    async (request, reply) => {
      await officeGuard(prisma);
      const agent = await prisma.aiAgent.findFirst({
        where: { status: 'ATIVO', roleKey: 'FINANCEIRO' },
        orderBy: { createdAt: 'asc' },
      });
      if (!agent)
        throw Errors.conflict('Contrate o Financeiro no Escritório para lançar pela foto.');
      if (!aiAvailable() && reader === anthropicReader)
        throw Errors.conflict('A leitura da foto precisa da IA ligada no servidor.');
      const upload = await readImageUpload(request, env.MAX_UPLOAD_MB);
      const image = await processImage(upload.data, upload.mime);
      const tz = await shopTimezone(prisma);
      const today = todayIso(tz);
      const categories = (await listExpenseCategories(prisma)).filter((c) => c.active);
      let read: ReceiptReading;
      try {
        read = await reader({ data: image.data, mime: image.mime }, { categories, today });
      } catch {
        throw Errors.business('A IA não conseguiu ler agora. Tente de novo em instantes.');
      }
      if (!read.ok)
        throw Errors.business(
          read.problem
            ? `Não deu para ler o comprovante: ${read.problem}`
            : 'Não deu para ler o comprovante. Tire a foto de novo, de perto e com luz.',
        );
      const category = categories.some((c) => c.value === read.category)
        ? read.category!
        : (EXPENSE_CATEGORIES as readonly string[]).includes(read.category ?? '')
          ? read.category!
          : 'OUTRAS';
      const date = read.date && /^\d{4}-\d{2}-\d{2}$/.test(read.date) ? read.date : today;
      const label = categories.find((c) => c.value === category)?.label ?? category;

      const fileId = randomUUID();
      const storageKey = `office-document/${fileId}`;
      const thumbKey = `office-document-thumb/${fileId}`;
      await storage.put(storageKey, image.data);
      await storage.put(thumbKey, image.thumb);
      const actor = actorFrom(request);
      const row = await prisma.$transaction(async (tx) => {
        await tx.storedFile.create({
          data: {
            id: fileId,
            storageKey,
            purpose: 'office-document',
            originalName: upload.filename,
            mimeType: image.mime,
            sizeBytes: image.data.length,
            sha256: sha256Hex(image.data),
            uploadedById: actor.userId,
            processedAt: new Date(),
            width: image.width,
            height: image.height,
            thumbKey,
            thumbSizeBytes: image.thumb.length,
            originalSizeBytes: upload.data.length,
          },
        });
        const who = read.beneficiary ?? 'quem recebeu (não deu para ler)';
        const value = read.amountCents ? brl(read.amountCents) : 'valor não lido';
        const p = await tx.aiAgentProposal.create({
          data: {
            agentId: agent.id,
            kind: 'LANCAR_DESPESA',
            title: `Lançar despesa: ${who} · ${value}`.slice(0, 200),
            detail: [
              `${br(date)} · ${label}${read.paid ? ' · já pago' : ' · a pagar'}`,
              read.description ?? '',
            ]
              .filter(Boolean)
              .join('\n'),
            payload: {
              task: 'LANCAR_DESPESA',
              fileId,
              photoUrl: `/api/files/${fileId}`,
              thumbUrl: `/api/files/${fileId}/miniatura`,
              totalCents: read.amountCents ?? 0,
              date,
              beneficiary: read.beneficiary ?? '',
              description: read.description ?? '',
              category,
              categoryLabel: label,
              paid: read.paid,
              method: read.method,
              items: read.items ?? [],
            } as Prisma.InputJsonValue,
            evidence: [] as Prisma.InputJsonValue,
          },
        });
        await audit(tx, actor, {
          action: 'game.receipt_read',
          entityType: 'ai_agent_proposal',
          entityId: p.id,
          summary: `Foto de comprovante lida pelo Financeiro: ${who}, ${value}.`,
        });
        await appendEvent(tx, actor, {
          type: EVENT_TYPES.GAME_PROPOSAL_CHANGED,
          aggregateType: 'ai_agent',
          aggregateId: agent.id,
          payload: { id: agent.id },
          audience: 'permission:agentes.usar|permission:agentes.gerenciar',
        });
        return p;
      });
      // Liberada para fazer sozinho (nível 4, ou 3 até o limite): lança na hora.
      let doneAlone = false;
      if ((await routeOfNow(prisma, agent.id, row)) === 'SOZINHO')
        doneAlone = await doAlone(prisma, row, agent, today);
      return reply.status(201).send({
        proposalId: row.id,
        title: row.title,
        doneAlone,
        overview: await officeOverview(prisma),
      });
    },
  );
}

export type { PrismaClient };
