/**
 * Item 34 (lista de 53): "Experimentar o Firma Viva por 7 dias". Quem assina o plano de R$ 399
 * ganha um botão no painel; o primeiro clique do dono liga o ambiente interativo (o jogo, a
 * Conversar e os agentes) por 7 dias, uma vez por empresa. Depois disso o painel oferece o plano
 * Cenário Gestão + Firma Viva (R$ 599). Nada é cobrado pelo teste e nada muda no plano.
 */
import { GAME_TRIAL_DAYS, gameTrialOf } from '@cenario/shared';
import type { FastifyInstance } from 'fastify';
import { actorFrom, audit } from '../../core/audit';
import { now as clockNow } from '../../core/clock';
import { lockRow } from '../../core/locking';
import { whatsappLink } from '../../core/platform-config';
import { requireCompanyId } from '../../core/tenant';
import { Errors } from '../../lib/errors';

const OWNER = { session: 'WEB', permissions: ['empresa.configurar'] } as const;
const DAY = 86_400_000;

export async function firmaTrialRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;

  const read = async () => {
    const c = await prisma.companySettings.findUnique({
      where: { id: requireCompanyId() },
      select: { plan: true, gameTrialEndsAt: true, tradeName: true },
    });
    if (!c) throw Errors.notFound('Empresa');
    const t = gameTrialOf(c, clockNow());
    return {
      ...t,
      whatsappUrl:
        t.status === 'INCLUIDO'
          ? null
          : whatsappLink(
              `Olá! Quero mudar a ${c.tradeName} para o plano Cenário Gestão + Firma Viva.`,
            ),
    };
  };

  app.get('/api/v1/firma-viva/teste', { config: { access: OWNER } }, read);

  app.post(
    '/api/v1/firma-viva/teste',
    { config: { access: OWNER, idempotent: true } },
    async (request) => {
      const actor = actorFrom(request);
      const now = clockNow();
      await prisma.$transaction(async (tx) => {
        if (!(await lockRow(tx, 'company_settings', requireCompanyId())))
          throw Errors.notFound('Empresa');
        const c = await tx.companySettings.findUniqueOrThrow({
          where: { id: requireCompanyId() },
          select: { plan: true, gameTrialEndsAt: true },
        });
        const t = gameTrialOf(c, now);
        // Repetir o clique durante o teste não faz nada (nem estende).
        if (t.status === 'INCLUIDO' || t.status === 'ATIVO') return;
        if (t.status === 'ENCERRADO')
          throw Errors.business(
            'O teste de 7 dias do Firma Viva já foi usado. Para continuar, mude para o plano Cenário Gestão + Firma Viva.',
          );
        const endsAt = new Date(now.getTime() + GAME_TRIAL_DAYS * DAY);
        await tx.companySettings.update({
          where: { id: requireCompanyId() },
          data: { gameTrialEndsAt: endsAt },
        });
        await audit(tx, actor, {
          action: 'company.game_trial_started',
          entityType: 'company_settings',
          entityId: String(requireCompanyId()),
          summary: `Teste de ${GAME_TRIAL_DAYS} dias do Firma Viva começou (até ${endsAt.toISOString().slice(0, 10)}).`,
        });
      });
      return read();
    },
  );
}
