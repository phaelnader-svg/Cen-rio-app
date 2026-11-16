/**
 * Perguntas sobre o Quadro de Metas no "Falar com a Cenário" e no Gerente. A resposta traz os
 * números e abre os lançamentos que a justificam; projeções mostram as premissas, separando
 * confirmado, vencido e o que depende de entrega.
 */
import { addDaysIso, brlCents, signedBrl, signedPct, weekStartOf } from '@cenario/shared';
import type { AgentReference, CommandEffect } from '@cenario/shared';
import { type Db } from './common';
import { cashBoard, obligations } from './cash';

const norm = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const br = (iso: string) => iso.split('-').reverse().join('/');
export const isGoalsQuestion = (text: string) =>
  /\b(metas?|bater|bato|cresci|crescemos|crescimento|caixa|\d+\s*mil)\b/.test(norm(text));

export interface GoalsAnswer {
  reply: string;
  effect: CommandEffect;
  references: AgentReference[];
}

export async function goalsAnswer(db: Db, text: string): Promise<GoalsAnswer> {
  const t = norm(text);
  const b = await cashBoard(db);
  const open = (filter: string): CommandEffect => ({
    kind: 'ABRIR_PAINEL',
    panel: 'METAS',
    filter,
  });
  if (!b.startedAt)
    return {
      reply:
        'O caixa ainda não tem ponto de partida: informe o saldo de hoje de cada conta no Quadro de Metas (aba Contas).',
      effect: open('TAB:CONTAS'),
      references: [],
    };
  const mil = /(\d+)\s*mil/.exec(t);
  const goal =
    (mil ? b.goals.find((g) => g.targetCents === Number(mil[1]) * 100_000) : null) ??
    b.goals.find((g) => g.id === b.nextGoalId) ??
    b.goals[0];
  const week = b.weeks[0];
  const refsOf = (moves: { id: string; description: string; amountCents: number }[]) =>
    moves.slice(0, 6).map((m) => ({
      type: 'CONTA' as const,
      id: m.id,
      label: `${signedBrl(m.amountCents)} · ${m.description}`.slice(0, 120),
      href: `/jogo?caixa=moves:ids=${encodeURIComponent(m.id)}`,
    }));

  // 4. Projeção até o prazo da meta.
  if (
    /\b(bato|bater|consigo|da pra|vou bater)\b/.test(t) &&
    /\b(receber|pagar|prazo|ate)\b/.test(t) &&
    goal
  ) {
    const until = goal.deadline ?? addDaysIso(weekStartOf(b.today), 6);
    const ob = await obligations(db, until);
    const conf = goal.balanceCents + ob.totals.confirmedInCents - ob.totals.outCents;
    const overdue = conf + ob.totals.overdueInCents;
    const cond = overdue + ob.totals.conditionalInCents;
    const verdict =
      conf >= goal.targetCents
        ? 'Sim, só com o que está confirmado.'
        : overdue >= goal.targetCents
          ? 'Só se você cobrar os vencidos.'
          : cond >= goal.targetCents
            ? 'Só se as entregas previstas acontecerem e forem pagas.'
            : `Não: mesmo recebendo tudo, faltariam ${brlCents(goal.targetCents - cond)}.`;
    return {
      reply: [
        `${goal.name} (${brlCents(goal.targetCents)}) até ${br(until)}${goal.deadline ? '' : ' (sem prazo definido: usei o fim da semana)'}: ${verdict}`,
        `• Saldo hoje ${brlCents(goal.balanceCents)}.`,
        `• Confirmado (com data até o prazo): +${brlCents(ob.totals.confirmedInCents)} → ${brlCents(conf)} depois de pagar ${brlCents(ob.totals.outCents)} em contas e mão de obra liberada.`,
        `• Vencido a cobrar: +${brlCents(ob.totals.overdueInCents)} → ${brlCents(overdue)}.`,
        `• Depende de entrega/retirada: +${brlCents(ob.totals.conditionalInCents)} → ${brlCents(cond)}.`,
        ob.totals.laborForecastCents
          ? `• Mão de obra prevista (ainda não liberada), fora da conta: ${brlCents(ob.totals.laborForecastCents)}.`
          : '',
        'Abri "A receber / pagar" com cada item usado no cálculo.',
      ]
        .filter(Boolean)
        .join('\n'),
      effect: open('TAB:RECEBER'),
      references: [
        ...ob.receivable.confirmed,
        ...ob.receivable.overdue,
        ...ob.receivable.conditional,
        ...ob.payable.due,
      ]
        .slice(0, 8)
        .map((x) => ({
          type: 'RECEBIVEL' as const,
          id: x.id,
          label: `${x.label} (${brlCents(x.amountCents)})`,
          href: x.links[0]?.href ?? '/painel/financeiro',
        })),
    };
  }
  // 3. Por que o caixa caiu.
  if (/\b(caiu|caindo|desceu|diminuiu|baixou|por que)\b/.test(t) && week) {
    const outs = week.topOut;
    const ins = week.topIn;
    const fell = week.deltaCents < 0;
    return {
      reply: [
        `Desde segunda (${br(week.weekStart)}): de ${brlCents(week.openingCents)} para ${brlCents(week.closingCents)} = ${signedBrl(week.deltaCents)}${week.openingCents > 0 ? ` (${signedPct(week.pct)})` : ''}. ${fell ? 'O caixa caiu.' : 'O caixa não caiu nesta semana.'}`,
        `Saiu ${brlCents(week.outCents)}: ${
          outs
            .slice(0, 3)
            .map(
              (m) => `${brlCents(-m.amountCents)} ${m.category.toLowerCase()} (${m.description})`,
            )
            .join('; ') || 'nada'
        }.`,
        `Entrou ${brlCents(week.inCents)}: ${
          ins
            .slice(0, 3)
            .map((m) => `${brlCents(m.amountCents)} (${m.description})`)
            .join('; ') || 'nada'
        }.`,
        week.withdrawalsCents || week.contributionsCents
          ? `Sem aportes/retiradas, a operação variou ${signedBrl(week.operationalDeltaCents)}.`
          : '',
        fell || outs.length ? 'Abri as saídas da semana.' : 'Abri os lançamentos da semana.',
      ]
        .filter(Boolean)
        .join('\n'),
      effect: open(
        fell || outs.length
          ? `MOVES:week=${week.weekStart}&sign=out|Saídas desde ${br(week.weekStart)}`
          : `MOVES:week=${week.weekStart}|Lançamentos desde ${br(week.weekStart)}`,
      ),
      references: refsOf(outs),
    };
  }
  // 2. Crescimento da semana.
  if (/\b(cresci|crescemos|crescimento|semana)\b/.test(t) && week) {
    return {
      reply: `Semana de ${br(week.weekStart)} (parcial até hoje): abertura ${brlCents(week.openingCents)}, agora ${brlCents(week.closingCents)} — ${signedBrl(week.deltaCents)} (${week.openingCents > 0 ? signedPct(week.pct) : '% sobre a abertura não se aplica'}). Entrou ${brlCents(week.inCents)} e saiu ${brlCents(week.outCents)}${week.contributionsCents || week.withdrawalsCents ? `; da operação: ${signedBrl(week.operationalDeltaCents)}` : ''}. Abri os lançamentos da semana.`,
      effect: open(`MOVES:week=${week.weekStart}|Lançamentos da semana de ${br(week.weekStart)}`),
      references: refsOf([...week.topIn, ...week.topOut]),
    };
  }
  // 1. Quanto falta para a meta.
  if (goal)
    return {
      reply: `${goal.name}: saldo ${brlCents(goal.balanceCents)} de ${brlCents(goal.targetCents)} (${goal.pctOfGoal.toLocaleString('pt-BR', { maximumFractionDigits: 1 })}% da meta) — faltam ${brlCents(goal.missingCents)}${goal.daysLeft !== null ? `, ${goal.daysLeft >= 0 ? `${goal.daysLeft} dia(s) até ${br(goal.deadline!)}` : 'prazo vencido'}` : ''}.${goal.achieved ? ` Conquistada em ${br(goal.achieved.at.slice(0, 10))}${goal.belowAfterAchieved ? `, mas o saldo caiu abaixo do patamar` : ''}.` : ''} Abri os lançamentos que formam o saldo.`,
      effect: open(`MOVES:goalId=${goal.id}|Saldo da meta "${goal.name}"`),
      references: [],
    };
  return { reply: 'Ainda não há metas cadastradas.', effect: open('TAB:METAS'), references: [] };
}
