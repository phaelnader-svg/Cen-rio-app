import { QUOTE_UNITS, createCustomerSchema, type QuoteMaterialCategory } from '@cenario/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { actorFrom, audit } from '../../core/audit';
import { Errors } from '../../lib/errors';
import { MAX_SHEET_ROWS, readSheet } from '../../lib/sheet';
import { createCustomer } from './service';

/**
 * Melhoria 75: importar clientes e preços de uma planilha (Excel ou CSV).
 *
 * 1. A tela envia o arquivo; a API devolve as linhas (nada é gravado).
 * 2. A pessoa confere qual coluna é o quê e confirma; a API grava linha a linha com as MESMAS
 *    regras do cadastro manual (telefone, CPF/CNPJ, duplicidade). Linha com problema não trava as
 *    outras: volta numa lista para corrigir.
 */
const importRow = z.object({
  line: z.number().int().min(1),
  name: z.string().max(200),
  kind: z.enum(['PF', 'PJ']).optional(),
  document: z.string().max(40).optional(),
  phone: z.string().max(40).optional(),
  whatsapp: z.string().max(40).optional(),
  email: z.string().max(254).optional(),
  street: z.string().max(200).optional(),
  number: z.string().max(40).optional(),
  district: z.string().max(120).optional(),
  city: z.string().max(120).optional(),
  state: z.string().max(40).optional(),
  postalCode: z.string().max(20).optional(),
  notes: z.string().max(2000).optional(),
});

const priceRow = z.object({
  line: z.number().int().min(1),
  name: z.string().max(200),
  category: z.string().max(40).optional(),
  unit: z.string().max(20).optional(),
  price: z.string().max(40),
});

/** "R$ 1.234,56", "1234.56" ou "1234,5" → centavos. */
export function parsePriceCents(text: string): number | null {
  let t = text.replace(/[R$\s]/gi, '');
  if (!t) return null;
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0 || n > 100_000_000) return null;
  return Math.round(n * 100);
}

const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

function categoryOf(text: string | undefined): QuoteMaterialCategory {
  const t = fold(text ?? '');
  if (t.startsWith('tecid')) return 'Tecidos';
  if (t.startsWith('espum')) return 'Espumas';
  if (t.startsWith('madeir')) return 'Madeiramento';
  return 'Insumos';
}

function unitOf(text: string | undefined): (typeof QUOTE_UNITS)[number] {
  const t = fold(text ?? '');
  const found = QUOTE_UNITS.find((u) => fold(u) === t);
  if (found) return found;
  if (t.startsWith('metro q') || t === 'm2') return 'm²';
  if (t.startsWith('metro c') || t === 'm3') return 'm³';
  if (t.startsWith('metro') || t === 'mt' || t === 'mts') return 'm';
  if (t.startsWith('quilo') || t === 'kilo') return 'kg';
  if (t.startsWith('litro')) return 'L';
  if (t.startsWith('caixa')) return 'cx';
  if (t.startsWith('pacote')) return 'pct';
  return 'un';
}

export async function importRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;

  app.post(
    '/api/v1/import/planilha',
    {
      config: {
        access: { session: 'WEB', anyPermissions: ['clientes.gerenciar', 'orcamentos.gerenciar'] },
      },
    },
    async (request) => {
      if (!request.isMultipart())
        throw Errors.unsupportedMedia('Envie a planilha como multipart/form-data.');
      const file = await request.file({ limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
      if (!file) throw Errors.validation(undefined, 'Nenhum arquivo enviado.');
      const data = await file.toBuffer().catch((error: unknown) => {
        if ((error as { code?: string }).code === 'FST_REQ_FILE_TOO_LARGE')
          throw Errors.payloadTooLarge('A planilha deve ter no máximo 10 MB.');
        throw error;
      });
      let rows: string[][];
      try {
        rows = readSheet(data);
      } catch {
        throw Errors.business(
          'Não foi possível ler este arquivo. Salve a planilha como .xlsx ou .csv e tente de novo.',
        );
      }
      if (rows.length > MAX_SHEET_ROWS + 1)
        throw Errors.business(`A planilha tem mais de ${MAX_SHEET_ROWS} linhas. Divida em partes.`);
      return { rows };
    },
  );

  app.post(
    '/api/v1/customers/import',
    {
      config: { access: { session: 'WEB', permissions: ['clientes.gerenciar'] } },
      bodyLimit: 8 * 1024 * 1024,
    },
    async (request) => {
      const { rows } = z
        .object({ rows: z.array(importRow).min(1).max(MAX_SHEET_ROWS) })
        .parse(request.body);
      const actor = actorFrom(request);
      const created: number[] = [];
      const problems: { line: number; name: string; reason: string }[] = [];
      for (const r of rows) {
        const digits = (r.document ?? '').replace(/\D/g, '');
        const hasAddress = Boolean(r.street && r.number && r.city && r.state);
        const parsed = createCustomerSchema.safeParse({
          kind: r.kind ?? (digits.length === 14 ? 'PJ' : 'PF'),
          name: r.name,
          document: r.document ?? '',
          phone: r.phone ?? '',
          whatsapp: r.whatsapp || r.phone || '',
          email: r.email ?? '',
          notes: r.notes || null,
          addresses: hasAddress
            ? [
                {
                  label: 'Principal',
                  street: r.street,
                  number: r.number,
                  district: r.district || null,
                  city: r.city,
                  state: (r.state ?? '').toUpperCase().slice(0, 2),
                  postalCode: r.postalCode ?? '',
                  isPrimary: true,
                },
              ]
            : [],
          allowSimilar: false,
        });
        if (!parsed.success) {
          problems.push({
            line: r.line,
            name: r.name,
            reason: parsed.error.issues[0]?.message ?? 'Dados inválidos.',
          });
          continue;
        }
        try {
          await prisma.$transaction((tx) => createCustomer(tx, actor, parsed.data));
          created.push(r.line);
        } catch (err) {
          const e = err as { code?: string; message?: string };
          problems.push({
            line: r.line,
            name: r.name,
            reason:
              e.code === 'DUPLICATE_CUSTOMER' ||
              /duplic|semelhante|já existe/i.test(e.message ?? '')
                ? 'Já existe um cliente com este nome, telefone, e-mail ou documento.'
                : (e.message ?? 'Não foi possível cadastrar.'),
          });
        }
      }
      if (created.length)
        await audit(prisma, actor, {
          action: 'customer.imported',
          entityType: 'customer',
          summary: `${created.length} cliente(s) importado(s) de planilha${problems.length ? ` (${problems.length} linha(s) com problema)` : ''}.`,
        });
      return { created: created.length, problems };
    },
  );

  app.post(
    '/api/v1/quotes/catalog/import-prices',
    {
      config: { access: { session: 'WEB', permissions: ['orcamentos.gerenciar'] } },
      bodyLimit: 4 * 1024 * 1024,
    },
    async (request) => {
      const { rows } = z
        .object({ rows: z.array(priceRow).min(1).max(MAX_SHEET_ROWS) })
        .parse(request.body);
      const actor = actorFrom(request);
      let created = 0;
      let updated = 0;
      const problems: { line: number; name: string; reason: string }[] = [];
      await prisma.$transaction(async (tx) => {
        const existing = await tx.quoteCatalogItem.findMany({ where: { kind: 'MATERIAL' } });
        const byName = new Map(existing.map((e) => [fold(e.name), e]));
        let position = existing.reduce((m, e) => Math.max(m, e.position), 0) + 1;
        for (const r of rows) {
          const name = r.name.trim().slice(0, 160);
          const cents = parsePriceCents(r.price);
          if (name.length < 1) {
            problems.push({ line: r.line, name, reason: 'Falta o nome do material.' });
            continue;
          }
          if (cents === null) {
            problems.push({ line: r.line, name, reason: `Preço "${r.price}" não entendido.` });
            continue;
          }
          const found = byName.get(fold(name));
          if (found) {
            await tx.quoteCatalogItem.update({
              where: { id: found.id },
              data: {
                priceCents: cents,
                ...(r.unit ? { unit: unitOf(r.unit) } : {}),
                ...(r.category ? { category: categoryOf(r.category) } : {}),
                version: { increment: 1 },
              },
            });
            updated++;
          } else {
            const item = await tx.quoteCatalogItem.create({
              data: {
                kind: 'MATERIAL',
                category: categoryOf(r.category),
                name,
                priceCents: cents,
                unit: unitOf(r.unit),
                position: position++,
              },
            });
            byName.set(fold(name), item);
            created++;
          }
        }
        await audit(tx, actor, {
          action: 'quotes.prices_imported',
          entityType: 'quote_catalog_item',
          summary: `Orçamento — preços importados de planilha: ${created} material(is) novo(s), ${updated} preço(s) atualizado(s).`,
        });
      });
      return { created, updated, problems };
    },
  );
}
