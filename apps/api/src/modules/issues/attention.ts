import {
  ATTENDANCE_SITUATION_LABEL,
  ATTENTION_CATEGORIES,
  CATEGORY_ORDER,
  HELP_KIND_LABEL,
  HELP_STATUS_LABEL,
  ISSUE_IMPACT_LABEL,
  ISSUE_KIND_LABEL,
  ISSUE_STATUS_LABEL,
  PROPOSAL_KIND_LABEL,
  attentionQuerySchema,
  helpRequestCode,
  localParts,
  proposalCode,
  taskCode,
  type AttentionCategory,
  type AttentionDto,
  type AttentionItemDto,
  type HelpKind,
  type IssueImpact,
  type IssueKind,
  type ProposalKind,
} from '@cenario/shared';
import type { FastifyInstance } from 'fastify';
import { attendanceConfig, clock, dbDate } from '../attendance/common';
import { dateOnly, serviceOrderCode } from '../commercial/common';
import { WAIT_ALERT_MINUTES } from '../help/engine';
import { qualityAttention } from '../quality/attention';
import { OPEN_STATUSES, VIEW, issueDto, issueInclude } from './common';

const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/**
 * Central de atenção: reúne só as EXCEÇÕES que pedem atenção do gestor — ocorrências,
 * pedidos de ajuda atrasados ou escalados, propostas aguardando decisão, ausências com
 * impacto, pausas por impedimento sem ocorrência e prazos vencidos. A operação normal não
 * aparece. Cada fato gera um único item (chave estável), sem repetir.
 */
export async function attentionRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;

  app.get(
    '/api/v1/attention',
    { config: { access: VIEW } },
    async (request): Promise<AttentionDto> => {
      const q = attentionQuerySchema.parse(request.query);
      const now = clock();
      const cfg = await attendanceConfig(prisma, now);
      const realToday = localParts(new Date(), cfg.timezone).date;
      const items: AttentionItemDto[] = [];
      const coveredTasks = new Set<string>();

      // 1. Ocorrências (abertas e as encerradas nas últimas 24 h, como informativo).
      const issues = await prisma.productionIssue.findMany({
        where: {
          OR: [
            { status: { in: OPEN_STATUSES } },
            { updatedAt: { gte: new Date(Date.now() - 24 * 3_600_000) } },
          ],
        },
        include: issueInclude,
        orderBy: { createdAt: 'desc' },
        take: 300,
      });
      for (const r of issues) {
        const d = issueDto(r, cfg.today);
        if ((OPEN_STATUSES as string[]).includes(r.status)) coveredTasks.add(r.taskId);
        const next: string[] = [];
        if (r.status === 'ABERTA') next.push('Delegar a solução');
        if (r.status === 'ATRIBUIDA') next.push(`Aguardar ${d.assignee?.displayName} iniciar`);
        if (r.status === 'EM_RESOLUCAO') next.push(`Acompanhar ${d.assignee?.displayName}`);
        if (r.status === 'AGUARDANDO_VERIFICACAO') next.push('Verificar e confirmar a resolução');
        if (r.kind === 'MATERIAL' && (OPEN_STATUSES as string[]).includes(r.status))
          next.push('Decidir: usar estoque, comprar ou outra solução');
        items.push({
          key: `OCORRENCIA:${r.id}`,
          type: 'OCORRENCIA',
          category: d.category,
          title: `${d.code} · ${ISSUE_KIND_LABEL[r.kind as IssueKind]}`,
          description: r.description,
          serviceOrder: { id: r.serviceOrder.id, code: d.serviceOrder.code },
          task: { id: r.task.id, code: d.task.code, title: r.task.title },
          employee: { userId: r.reporter.id, displayName: r.reporter.displayName },
          priority: r.priority,
          status: r.status,
          statusLabel: ISSUE_STATUS_LABEL[r.status],
          at: r.createdAt.toISOString(),
          deadline: r.dueAt?.toISOString() ?? dateOnly(r.task.dueDate),
          solver: d.assignee,
          impacts: [
            ISSUE_IMPACT_LABEL[r.impact as IssueImpact],
            ...(r.blocksTask ? [`${d.task.code} parada até a resolução`] : []),
            ...(d.deadlineRisk ? ['Prazo em risco'] : []),
            ...(d.material ? [`Material: ${d.material.description} (${d.material.quantity})`] : []),
          ],
          nextActions: next,
          link: `/painel/ocorrencias/${r.id}`,
        });
      }

      // 2. Ajuda: só escalada ou esperando além do limite.
      const helps = await prisma.helpRequest.findMany({
        where: { status: { in: ['PENDENTE', 'ESCALADA'] } },
        include: {
          task: { select: { id: true, number: true, title: true } },
          serviceOrder: { select: { id: true, number: true } },
          requester: { select: { id: true, displayName: true } },
        },
      });
      for (const h of helps) {
        const minutes = Math.floor((now.getTime() - h.createdAt.getTime()) / 60_000);
        const limit = h.urgent ? WAIT_ALERT_MINUTES.urgent : WAIT_ALERT_MINUTES.normal;
        if (h.status === 'PENDENTE' && minutes < limit && !h.urgent) continue;
        const category: AttentionCategory =
          h.status === 'ESCALADA' ? 'ACAO' : h.urgent && minutes >= limit ? 'CRITICO' : 'ATENCAO';
        items.push({
          key: `AJUDA:${h.id}`,
          type: 'AJUDA',
          category,
          title: `${helpRequestCode(h.number)} · ${HELP_KIND_LABEL[h.kind as HelpKind]}${h.urgent ? ' (urgente)' : ''}`,
          description: h.justification ?? h.note ?? `${h.requester.displayName} aguarda ajudante.`,
          serviceOrder: { id: h.serviceOrder.id, code: serviceOrderCode(h.serviceOrder.number) },
          task: { id: h.task.id, code: taskCode(h.task.number), title: h.task.title },
          employee: { userId: h.requester.id, displayName: h.requester.displayName },
          priority: h.urgent ? 'URGENTE' : 'NORMAL',
          status: h.status,
          statusLabel: HELP_STATUS_LABEL[h.status],
          at: h.createdAt.toISOString(),
          deadline: null,
          solver: null,
          impacts: [`Aguardando há ${minutes} min`],
          nextActions:
            h.status === 'ESCALADA'
              ? ['Decidir a proposta em Reprogramação']
              : ['Escolher o ajudante manualmente ou aguardar'],
          link: '/painel/ajuda',
        });
      }

      // 3. Propostas aguardando decisão.
      const proposals = await prisma.rescheduleProposal.findMany({
        where: { status: 'PENDENTE' },
        orderBy: { createdAt: 'desc' },
      });
      for (const p of proposals) {
        items.push({
          key: `PROPOSTA:${p.id}`,
          type: 'PROPOSTA',
          category: p.critical ? 'CRITICO' : 'ACAO',
          title: `${proposalCode(p.number)} · ${PROPOSAL_KIND_LABEL[p.kind as ProposalKind]}`,
          description: p.problem,
          serviceOrder: null,
          task: null,
          employee: null,
          priority: p.critical ? 'ALTA' : 'NORMAL',
          status: p.status,
          statusLabel: 'Aguardando decisão',
          at: p.createdAt.toISOString(),
          deadline: null,
          solver: null,
          impacts: [p.situation],
          nextActions: ['Aprovar, ajustar ou rejeitar'],
          link: '/painel/reprogramacao',
        });
      }

      // 4. Ausências com impacto ainda não encaminhado (um item por pessoa e dia).
      const impacts = await prisma.attendanceImpact.findMany({
        where: { resolvedAt: null, attendance: { date: dbDate(cfg.today) } },
        include: {
          attendance: { include: { employee: true } },
        },
      });
      const byAttendance = new Map<string, typeof impacts>();
      for (const i of impacts) {
        byAttendance.set(i.attendanceId, [...(byAttendance.get(i.attendanceId) ?? []), i]);
      }
      for (const [attendanceId, list] of byAttendance) {
        const att = list[0]!.attendance;
        items.push({
          key: `PRESENCA:${attendanceId}`,
          type: 'PRESENCA',
          category: 'ACAO',
          title: `${att.employee.displayName} · ${ATTENDANCE_SITUATION_LABEL[att.situation]}`,
          description: `${list.length} impacto(s) em tarefas a encaminhar.`,
          serviceOrder: null,
          task: null,
          employee: { userId: att.employee.userId, displayName: att.employee.displayName },
          priority: 'ALTA',
          status: att.situation,
          statusLabel: ATTENDANCE_SITUATION_LABEL[att.situation],
          at: (att.presumedAbsentAt ?? att.updatedAt).toISOString(),
          deadline: null,
          solver: null,
          impacts: list.slice(0, 5).map((i) => i.detail),
          nextActions: ['Confirmar a ausência ou reprogramar em Presença da equipe'],
          link: '/painel/presenca',
        });
      }

      // 5. Pausa por impedimento sem ocorrência registrada, e 6. prazos vencidos/bloqueados.
      const tasks = await prisma.productionTask.findMany({
        where: {
          OR: [
            { status: 'PAUSADA', pauseImpediment: true },
            {
              status: { in: ['BLOQUEADA', 'PROGRAMADA', 'LIBERADA', 'EM_EXECUCAO', 'PAUSADA'] },
              dueDate: { lte: dbDate(addDays(realToday, 1)) },
            },
          ],
        },
        include: {
          serviceOrder: { select: { id: true, number: true } },
          assignee: { select: { id: true, displayName: true } },
        },
        take: 300,
      });
      for (const t of tasks) {
        if (coveredTasks.has(t.id)) continue;
        const due = dateOnly(t.dueDate);
        const impediment = t.status === 'PAUSADA' && t.pauseImpediment;
        const overdue = Boolean(due && due < realToday);
        if (!impediment && !(overdue || t.status === 'BLOQUEADA')) continue;
        items.push({
          key: `${impediment ? 'IMPEDIMENTO' : 'PRAZO'}:${t.id}`,
          type: impediment ? 'IMPEDIMENTO' : 'PRAZO',
          category: overdue ? 'CRITICO' : impediment ? 'ACAO' : 'ATENCAO',
          title: `${taskCode(t.number)} · ${t.title}`,
          description: impediment
            ? (t.pauseNote ?? 'Pausada por impedimento, sem ocorrência registrada.')
            : overdue
              ? `Prazo interno vencido (${due!.split('-').reverse().join('/')}).`
              : `Bloqueada com prazo em ${due!.split('-').reverse().join('/')}: ${t.blockers.join(', ').toLowerCase()}.`,
          serviceOrder: { id: t.serviceOrder.id, code: serviceOrderCode(t.serviceOrder.number) },
          task: { id: t.id, code: taskCode(t.number), title: t.title },
          employee: t.assignee
            ? { userId: t.assignee.id, displayName: t.assignee.displayName }
            : null,
          priority: t.priority,
          status: t.status,
          statusLabel: t.status,
          at: t.updatedAt.toISOString(),
          deadline: due,
          solver: null,
          impacts: t.blockers,
          nextActions: impediment
            ? ['Falar com o responsável e registrar a ocorrência']
            : ['Reprogramar ou remover o bloqueio'],
          link: `/painel/producao/tarefas/${t.id}`,
        });
      }

      // Fase 10: qualidade (inspeção sem inspetor, correções, embalagem sem responsável, peças
      // prontas sem entrega) e logística (ocorrências, entregas frustradas).
      items.push(...(await qualityAttention(prisma, realToday)));

      // Filtros.
      const dayOf = (iso: string) => localParts(new Date(iso), cfg.timezone).date;
      const filtered = items.filter(
        (i) =>
          (!q.category || i.category === q.category) &&
          (!q.type || i.type === q.type) &&
          (!q.status || i.status === q.status) &&
          (!q.employeeUserId || i.employee?.userId === q.employeeUserId) &&
          (!q.solverUserId || i.solver?.userId === q.solverUserId) &&
          (!q.serviceOrderId || i.serviceOrder?.id === q.serviceOrderId) &&
          (!q.date || dayOf(i.at) === q.date || (i.deadline ?? '').slice(0, 10) === q.date),
      );
      filtered.sort(
        (a, b) =>
          CATEGORY_ORDER[a.category] - CATEGORY_ORDER[b.category] || b.at.localeCompare(a.at),
      );
      const counts = Object.fromEntries(ATTENTION_CATEGORIES.map((c) => [c, 0])) as Record<
        AttentionCategory,
        number
      >;
      for (const i of filtered) counts[i.category] += 1;
      return { generatedAt: now.toISOString(), counts, items: filtered };
    },
  );
}
