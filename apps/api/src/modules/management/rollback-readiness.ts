import { OPERATIONAL_ALERT_KINDS, formatServiceOrderItemCode } from '@cenario/shared';
import type { PrismaClient, Tx } from '@cenario/db';
import type { FastifyInstance } from 'fastify';

/**
 * Homologação integrada — prontidão para voltar à VERSÃO DE RETORNO (3e0d2d0 + migrations das
 * Fases 2 e 3). Somente leitura.
 *
 * A versão de retorno não conhece a embalagem opcional (Fase 3): peça aprovada SEM embalagem e
 * ainda não entregue ficaria presa nela. A própria imagem de retorno recusa migrar/iniciar nesse
 * caso (infra/homolog/retorno-guarda.mjs, mesma regra); esta rota mostra ANTES, ao gestor, quais
 * peças impedem o retorno e quantos avisos da Fase 4 o retorno vai encerrar. Nenhuma regra de
 * embalagem, entrega ou financeiro muda por causa disso.
 */
export type RollbackReadinessDto = {
  ready: boolean;
  checkedAt: string;
  incompatiblePieces: {
    itemId: string;
    code: string;
    description: string;
    customer: string;
    serviceOrderId: string;
    stage: string;
  }[];
  openPhase4Alerts: { total: number; byKind: Record<string, number> };
  instructions: string;
};

export async function rollbackReadiness(db: Tx | PrismaClient): Promise<RollbackReadinessDto> {
  const rows = await db.$queryRaw<
    {
      id: string;
      number: number;
      position: number;
      description: string;
      fulfillment_stage: string;
      service_order_id: string;
      customer: string;
    }[]
  >`
    WITH ultima AS (
      SELECT DISTINCT ON (qi.service_order_item_id)
             qi.service_order_item_id, qi.status, qi.packaging_required
        FROM quality_inspections qi
       ORDER BY qi.service_order_item_id, qi.round DESC
    )
    SELECT i.id, so.number, i.position, i.description, i.fulfillment_stage,
           so.id AS service_order_id, c.name AS customer
      FROM ultima u
      JOIN service_order_items i ON i.id = u.service_order_item_id
      JOIN service_orders so ON so.id = i.service_order_id
      JOIN customers c ON c.id = so.customer_id
     WHERE u.status = 'APROVADA'
       AND NOT u.packaging_required
       AND i.fulfillment_stage NOT IN ('ENTREGUE', 'DEVOLVIDA', 'CANCELADA')
     ORDER BY so.number, i.position`;
  const alerts = await db.notification.groupBy({
    by: ['kind'],
    where: { resolvedAt: null, kind: { in: [...OPERATIONAL_ALERT_KINDS] } },
    _count: true,
  });
  const byKind = Object.fromEntries(alerts.map((a) => [a.kind, a._count]));
  const total = alerts.reduce((s, a) => s + a._count, 0);
  return {
    ready: rows.length === 0,
    checkedAt: new Date().toISOString(),
    incompatiblePieces: rows.map((r) => ({
      itemId: r.id,
      code: formatServiceOrderItemCode(r.number, r.position),
      description: r.description,
      customer: r.customer,
      serviceOrderId: r.service_order_id,
      stage: r.fulfillment_stage,
    })),
    openPhase4Alerts: { total, byKind },
    instructions: rows.length
      ? 'Retorno BLOQUEADO: entregue as peças listadas (aprovadas sem embalagem) antes de voltar para a versão de retorno. A imagem de retorno também recusa migrar e iniciar enquanto elas existirem.'
      : 'Sem peças incompatíveis. Ao migrar para a versão de retorno, os avisos internos da Fase 4 abertos serão encerrados automaticamente (com auditoria).',
  };
}

const ACCESS = { session: 'WEB', permissions: ['empresa.configurar'] } as const;

export async function rollbackReadinessRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;
  app.get('/api/v1/system/rollback-readiness', { config: { access: ACCESS } }, async () =>
    rollbackReadiness(prisma),
  );
}
