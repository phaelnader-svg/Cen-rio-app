/**
 * Categorias de despesa da empresa (2026-11-18). As fixas (Aluguel, Energia…) continuam no código;
 * cada empresa cadastra as suas (a trava do banco deixa cada empresa ver só as próprias). A
 * despesa, a recorrente e a conta a pagar guardam o NOME da categoria cadastrada: esconder uma
 * categoria só a tira dos menus, nada do que já foi lançado muda.
 */
import {
  EXPENSE_CATEGORIES,
  EXPENSE_CATEGORY_LABEL,
  PAYABLE_CATEGORIES,
  categoryKey,
  clashesWithFixedCategory,
  expenseCategoryCreateSchema,
  expenseCategoryUpdateSchema,
  type ExpenseCategoryDto,
} from '@cenario/shared';
import type { PrismaClient, Tx } from '@cenario/db';
import type { FastifyInstance } from 'fastify';
import { actorFrom, audit } from '../../core/audit';
import { Errors } from '../../lib/errors';
import { idParams } from '../presenters';
import { FIN_MANAGE, FIN_VIEW } from './common';

type Db = PrismaClient | Tx;

export async function listExpenseCategories(db: Db): Promise<ExpenseCategoryDto[]> {
  const custom = await db.expenseCategory.findMany({ orderBy: { name: 'asc' } });
  const fixed = EXPENSE_CATEGORIES.filter((c) => c !== 'OUTRAS');
  return [
    ...fixed.map((c) => ({
      value: c,
      label: EXPENSE_CATEGORY_LABEL[c],
      custom: false,
      id: null,
      active: true,
    })),
    ...custom.map((c) => ({
      value: c.name,
      label: c.name,
      custom: true,
      id: c.id,
      active: c.active,
    })),
    // "Outras despesas" fica sempre por último no menu.
    {
      value: 'OUTRAS',
      label: EXPENSE_CATEGORY_LABEL.OUTRAS,
      custom: false,
      id: null,
      active: true,
    },
  ];
}

/**
 * Confere a categoria escolhida: uma fixa (de despesa ou, nas contas a pagar, também as de
 * material/logística/serviços) ou uma cadastrada e ativa nesta empresa. `keep` aceita a categoria
 * que o registro já tinha (ex.: recorrente com categoria escondida depois).
 */
export async function assertCategory(
  db: Db,
  value: string,
  kind: 'expense' | 'payable',
  keep?: string | null,
) {
  const fixed: readonly string[] = kind === 'expense' ? EXPENSE_CATEGORIES : PAYABLE_CATEGORIES;
  if (fixed.includes(value) || (keep && value === keep)) return;
  const found = await db.expenseCategory.findFirst({ where: { name: value, active: true } });
  if (!found) throw Errors.validation(undefined, 'Categoria inválida: escolha uma da lista.');
}

export async function expenseCategoryRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;
  const tx = <T>(fn: (t: Tx) => Promise<T>) => prisma.$transaction(fn);

  app.get('/api/v1/finance/expense-categories', { config: { access: FIN_VIEW } }, async () =>
    listExpenseCategories(prisma),
  );

  app.post(
    '/api/v1/finance/expense-categories',
    { config: { access: FIN_MANAGE, idempotent: true } },
    async (request, reply) => {
      const { name: raw } = expenseCategoryCreateSchema.parse(request.body);
      const name = raw.replace(/\s+/g, ' ');
      if (clashesWithFixedCategory(name))
        throw Errors.business(`"${name}" já existe na lista de categorias.`);
      const row = await tx(async (t) => {
        await t.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('expense-categories'))`;
        const all = await t.expenseCategory.findMany();
        const same = all.find((c) => categoryKey(c.name) === categoryKey(name));
        // Mesmo nome (sem diferença de acento/maiúscula): reaproveita, e volta a mostrar se estava escondida.
        if (same)
          return same.active
            ? same
            : t.expenseCategory.update({ where: { id: same.id }, data: { active: true } });
        const c = await t.expenseCategory.create({
          data: { name, createdById: request.auth!.userId },
        });
        await audit(t, actorFrom(request), {
          action: 'finance.expense_category_created',
          entityType: 'expense_category',
          entityId: c.id,
          summary: `Categoria de despesa "${name}" cadastrada.`,
        });
        return c;
      });
      return reply.status(201).send({
        value: row.name,
        label: row.name,
        custom: true,
        id: row.id,
        active: row.active,
      } satisfies ExpenseCategoryDto);
    },
  );

  app.put(
    '/api/v1/finance/expense-categories/:id',
    { config: { access: FIN_MANAGE } },
    async (request) => {
      const { id } = idParams.parse(request.params);
      const { active } = expenseCategoryUpdateSchema.parse(request.body);
      const row = await tx(async (t) => {
        const cur = await t.expenseCategory.findUnique({ where: { id } });
        if (!cur) throw Errors.notFound('Categoria');
        const c = await t.expenseCategory.update({ where: { id }, data: { active } });
        await audit(t, actorFrom(request), {
          action: 'finance.expense_category_updated',
          entityType: 'expense_category',
          entityId: id,
          summary: `Categoria de despesa "${c.name}" ${active ? 'mostrada' : 'escondida'} nos menus.`,
        });
        return c;
      });
      return {
        value: row.name,
        label: row.name,
        custom: true,
        id: row.id,
        active: row.active,
      } satisfies ExpenseCategoryDto;
    },
  );
}
