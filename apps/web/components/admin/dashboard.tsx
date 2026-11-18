'use client';

import { plural, pluralWord } from '@cenario/shared';
import type { Permission, QuoteFunnelDto } from '@cenario/shared';

import { useQuery } from '@tanstack/react-query';
import { Calculator } from 'lucide-react';
import Link from 'next/link';
import { api } from '@/lib/api';
import { useCan, useMe } from '@/lib/hooks';
import { useOrders } from '@/lib/commercial';
import { useAttention } from '@/lib/issues';
import { useOverview } from '@/lib/queries';
import { HomeCharts } from './home-charts';
import { TodayPanel, type TodayExtra } from './today-panel';

function greeting(timeZone: string) {
  const h = Number(
    new Intl.DateTimeFormat('pt-BR', { hour: 'numeric', hourCycle: 'h23', timeZone }).format(
      new Date(),
    ),
  );
  return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
}

const isoDaysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

/**
 * Revisão geral (2026-11-18): Início curto. "Precisa de você hoje" (cada contagem que pede ação
 * vira uma linha, só quando existe), as entregas da semana e os gráficos (o "Peças por etapa" já é a
 * oficina na ordem real; uma fileira de números repetiria o gráfico). Dinheiro só no gráfico "Entrou e saiu" (para quem vê o financeiro); os quadros em
 * reais, de equipe, tablets e sessões ficam nas próprias telas.
 */
export function Dashboard() {
  const me = useMe();
  const can = useCan();
  const awaiting = useOrders({ status: 'AGUARDANDO_RETIRADA' }, can('pedidos.ver'));
  const canQuotes = can('orcamentos.ver') || can('orcamentos.gerenciar');
  const funnel = useQuery({
    queryKey: ['quotes', 'funnel', 'inicio'],
    queryFn: () =>
      api<QuoteFunnelDto>(`/api/v1/quotes/funnel?from=${isoDaysAgo(90)}&to=${isoDaysAgo(-1)}`),
    enabled: canQuotes,
  });
  // Fase 10: visão do gestor pelas fontes canônicas (seção sem permissão = null, nunca zero).
  const overview = useOverview(
    can('os.ver') || can('entregas.ver') || can('entregas.gerenciar') || can('financeiro.ver'),
  );
  const ops = overview.data?.operations ?? null;
  const fin = overview.data?.finance ?? null;
  const tz = me.data?.company.timezone ?? 'America/Sao_Paulo';
  // Prazos: as MESMAS contagens da Central de atenção (mesma rota, mesma regra; nada é
  // recalculado aqui). Só para quem gerencia a Central.
  const deadlinesVisible = can('ocorrencias.gerenciar');
  const osDeadlines = useAttention({ type: 'PRAZO_OS' }, deadlinesVisible);
  const orderDeadlines = useAttention({ type: 'PRAZO_PEDIDO' }, deadlinesVisible);

  const todayLabel = new Intl.DateTimeFormat('pt-BR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: tz,
  }).format(new Date());

  const f = funnel.data;
  const approvedOpen = f ? Math.max(0, f.byStatus.APROVADO.count - f.converted.count) : null;

  // Contagens que pedem uma ação entram como linhas no "Precisa de você hoje" (só quando > 0).
  const extra: TodayExtra[] = [];
  if (approvedOpen)
    extra.push({
      key: 'approved',
      title: `${plural(approvedOpen, 'orçamento aprovado', 'orçamentos aprovados')} sem fechar serviço`,
      why: 'Feche o serviço para marcar a retirada.',
      link: '/painel/orcamentos?tab=salvos',
    });
  if (f?.followUpDue)
    extra.push({
      key: 'follow-up',
      title: `${plural(f.followUpDue, 'orçamento', 'orçamentos')} para cobrar resposta do cliente`,
      link: '/painel/orcamentos?tab=salvos',
    });
  if (awaiting.data?.total)
    extra.push({
      key: 'no-pickup',
      title: `${plural(awaiting.data.total, 'pedido', 'pedidos')} sem retirada marcada`,
      link: '/painel/pedidos?status=AGUARDANDO_RETIRADA',
    });
  if (ops?.awaitingMaterials)
    extra.push({
      key: 'material',
      title: `${plural(ops.awaitingMaterials, 'OS', 'OS')} esperando material`,
      why: 'Quando o material chegar, marque “Material comprado” para a OS entrar na semana.',
      link: '/painel/os?situacao=AGUARDANDO_MATERIAL',
    });
  if (ops?.preProduction.toPlan)
    extra.push({
      key: 'to-plan',
      title: `${plural(ops.preProduction.toPlan, 'OS', 'OS')} para pôr na semana`,
      link: '/painel/producao/programacao',
    });
  if (ops?.blockedTasks)
    extra.push({
      key: 'blocked',
      title: `${pluralWord(ops.blockedTasks, 'Tarefa parada', 'Tarefas paradas')}: ${ops.blockedTasks}`,
      why: 'Algum tapeceiro avisou que não consegue seguir.',
      link: '/painel/producao?status=BLOQUEADA',
      tone: 'warn',
    });
  if (fin && fin.decisions.valueRequests + fin.decisions.laborReviews > 0)
    extra.push({
      key: 'fin-decisions',
      title: `${plural(fin.decisions.valueRequests + fin.decisions.laborReviews, 'pedido', 'pedidos')} de valor da equipe para decidir`,
      link: '/painel/atencao?type=FINANCEIRO',
    });
  if (fin?.decisions.paymentReports)
    extra.push({
      key: 'fin-reports',
      title: `${plural(fin.decisions.paymentReports, 'pagamento informado', 'pagamentos informados')} pela equipe para conferir`,
      link: '/painel/financeiro?tab=receitas',
    });

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-sm font-medium text-ink-muted first-letter:uppercase">{todayLabel}</p>
          <h1 className="mt-1 text-3xl font-semibold tracking-tight">
            {greeting(tz)}, {me.data?.user.displayName}.
          </h1>
        </div>
        <div className="flex flex-wrap gap-2">
          {['os.ver', 'entregas.ver', 'financeiro.ver', 'pedidos.ver'].some((p) =>
            can(p as Permission),
          ) && (
            <Link
              href="/painel/resumo"
              className="inline-flex h-11 items-center gap-2 rounded-xl border border-line-strong bg-surface px-4 text-[15px] font-medium hover:bg-subtle"
              data-testid="dashboard-week"
            >
              Resumo da semana
            </Link>
          )}
          {can('orcamentos.gerenciar') && (
            <Link
              href="/painel/orcamentos"
              className="inline-flex h-11 items-center gap-2 rounded-xl bg-brand-700 px-4 text-[15px] font-medium text-white shadow-sm hover:bg-brand-800"
              data-testid="dashboard-new-quote"
            >
              <Calculator className="size-4" aria-hidden />
              Novo orçamento
            </Link>
          )}
        </div>
      </div>

      <TodayPanel
        extra={extra}
        deadlines={
          deadlinesVisible ? (
            <Link
              href="/painel/atencao?type=PRAZO_OS"
              className="block text-sm text-ink-soft hover:underline"
              data-testid="dashboard-deadlines"
            >
              Prazos de OS:{' '}
              <span
                className="font-semibold text-ink tabular-nums"
                data-testid="dashboard-deadlines-late"
              >
                {osDeadlines.data?.counts.CRITICO ?? '—'}
              </span>{' '}
              {pluralWord(osDeadlines.data?.counts.CRITICO ?? 0, 'atrasada', 'atrasadas')} ·{' '}
              <span
                className="font-semibold text-ink tabular-nums"
                data-testid="dashboard-deadlines-risk"
              >
                {osDeadlines.data?.counts.ACAO ?? '—'}
              </span>{' '}
              em risco
              {(orderDeadlines.data?.items.length ?? 0) > 0 && (
                <span className="block text-ink-muted" data-testid="dashboard-deadlines-orders">
                  {plural(orderDeadlines.data!.items.length, 'pedido', 'pedidos')} com peça ainda
                  não recebida
                </span>
              )}
            </Link>
          ) : null
        }
      />

      <HomeCharts />
    </div>
  );
}
