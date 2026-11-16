import { periodQuerySchema } from '@cenario/shared';
import type { FastifyInstance } from 'fastify';
import { productivity } from '../finance/results';
import { PLAN } from './common';

/**
 * Reformulação, Fase 4 (D6) — produtividade para quem planeja a produção.
 *
 * É o MESMO cálculo do financeiro (`productivity`), que só tem contagens, minutos e percentuais:
 * nenhum salário, valor combinado, custo ou pagamento entra nele. A rota do financeiro continua
 * como estava (financeiro.ver); esta exige `producao.planejar` e não dá acesso a nada financeiro.
 */
export async function productionProductivityRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;
  app.get('/api/v1/production/productivity', { config: { access: PLAN } }, async (request) =>
    productivity(prisma, periodQuerySchema.parse(request.query)),
  );
}
