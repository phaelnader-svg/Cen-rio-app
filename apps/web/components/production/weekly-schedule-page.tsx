'use client';

import Link from 'next/link';
import { PageHeader, Spinner } from '@/components/ui/misc';
import { Tabs } from '@/components/ui/tabs';
import { useCan, useMe } from '@/lib/hooks';
import { useTabParam } from '@/lib/tab-param';
import { ProductionPlanningPage } from './planning-page';
import { PreplanningPage } from './preplanning-page';
import { ProductivityTab } from './productivity-tab';

/**
 * Reformulação, Fase 3 — programação semanal numa tela só.
 *
 * "Serviços" é a antiga "Produção — A planejar" (escolher tapeceiro e data, acompanhar o que já
 * foi planejado) e "Semana detalhada" é o antigo "Planejamento de produção" (responsáveis, dias,
 * dependências, filas). As duas abas trabalham sobre o MESMO plano semanal e publicam pelo MESMO
 * diálogo (`PublishWeekDialog`) — não há mais dois caminhos de publicação. Regras de prioridade,
 * responsáveis e datas são as do servidor, que não mudaram; os tablets recebem o mesmo plano.
 * Os endereços antigos continuam abrindo a aba correspondente. Fase 4: aba "Produtividade"
 * (mesmos indicadores do Financeiro, sem valores) para quem tem producao.planejar.
 */
const TABS = ['servicos', 'semana', 'produtividade'] as const;
type Tab = (typeof TABS)[number];

export function WeeklySchedulePage({ initial = 'servicos' }: { initial?: Tab }) {
  // As abas dependem das permissões: espera o usuário carregar antes de escolher a aba inicial.
  const me = useMe();
  if (me.isPending) return <Spinner />;
  return <Schedule initial={initial} />;
}

function Schedule({ initial }: { initial: Tab }) {
  const can = useCan();
  // "Semana detalhada" mantém a permissão de antes (só quem planeja).
  // Revisão geral (item 8): quem vê o financeiro já tem "Produtividade" em Equipe; a aba aqui
  // fica só para quem planeja sem acesso ao financeiro.
  const allowed: readonly Tab[] = can('producao.planejar')
    ? can('financeiro.ver')
      ? ['servicos', 'semana']
      : TABS
    : ['servicos'];
  const [tab, setTab] = useTabParam(allowed.includes(initial) ? initial : 'servicos', allowed, {
    'a-planejar': 'servicos',
    planejamento: 'semana',
  });
  return (
    <>
      <PageHeader
        title="Semana da oficina"
        description="Monte a semana e publique para liberar as tarefas no tablet."
        help="Escolha o tapeceiro e a data de início de cada serviço, ajuste responsáveis, dias e dependências e publique a semana — tudo aqui. Material disponível não inicia a produção: só a programação publicada libera as tarefas."
        actions={
          <Link
            href="/painel/competencias"
            className="text-sm font-medium text-brand-700 hover:underline"
          >
            Competências da equipe →
          </Link>
        }
      />
      <Tabs
        tabs={[
          { key: 'servicos', label: 'Serviços' },
          ...(allowed.includes('semana') ? [{ key: 'semana', label: 'Semana detalhada' }] : []),
          // Fase 4: produtividade operacional (sem valores) para quem planeja.
          ...(allowed.includes('produtividade')
            ? [{ key: 'produtividade', label: 'Produtividade' }]
            : []),
        ]}
        active={tab}
        onChange={setTab}
      >
        <div className="pt-4" data-testid={`schedule-${tab}`}>
          {tab === 'servicos' && <PreplanningPage embedded />}
          {tab === 'semana' && <ProductionPlanningPage embedded />}
          {tab === 'produtividade' && <ProductivityTab />}
        </div>
      </Tabs>
    </>
  );
}
