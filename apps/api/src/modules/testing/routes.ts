import { testClockSchema } from '@cenario/shared';
import type { FastifyInstance } from 'fastify';
import { actorFrom, audit } from '../../core/audit';
import { detectAbsences } from '../attendance/absence';
import { clock, setAttendanceClock } from '../attendance/common';
import { processHelpQueue } from '../help/queue';
import { processIssueRisks } from '../issues/service';
import { releaseDueTasks } from '../production/common';

/**
 * Fase 8 — relógio de teste. Registrado somente com ENABLE_TEST_CLOCK=true e APP_ENV=test
 * (a validação do ambiente recusa a combinação em qualquer outro ambiente). Não altera o
 * relógio do sistema operacional nem do banco: apenas desloca o relógio operacional da
 * aplicação (presença, ausência presumida, fila de ajuda e — Evolução Fase 2 — liberação e
 * execução da produção, via core/clock), que continua andando.
 */
const ACCESS = { session: 'WEB', permissions: ['presenca.gerenciar'] } as const;

export async function testClockRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;

  app.post('/api/test/clock', { config: { access: ACCESS } }, async (request) => {
    const input = testClockSchema.parse(request.body);
    if (input.now === null) setAttendanceClock();
    else {
      const offset = new Date(input.now).getTime() - Date.now();
      setAttendanceClock(() => new Date(Date.now() + offset));
    }
    await prisma.$transaction((tx) =>
      audit(tx, actorFrom(request), {
        action: 'test.clock_set',
        entityType: 'system',
        summary: `Relógio de teste ${input.now ? `ajustado para ${input.now}` : 'restaurado'}.`,
      }),
    );
    return { now: clock().toISOString(), controlled: input.now !== null };
  });

  /** Executa já a verificação de ausência e a fila (sem esperar os timers). */
  app.post('/api/test/attendance/check', { config: { access: ACCESS } }, async () => ({
    flagged: await detectAbsences(prisma),
    assigned: await processHelpQueue(prisma),
    issueRisks: await processIssueRisks(prisma),
    // O relógio de teste também vale para a liberação por horário (planos LEGADO).
    released: await releaseDueTasks(prisma),
  }));
}
