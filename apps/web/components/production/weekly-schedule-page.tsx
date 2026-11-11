'use client';

import Link from 'next/link';
import { PageHeader, Spinner } from '@/components/ui/misc';
import { Tabs } from '@/components/ui/tabs';
import { useCan, useMe } from '@/lib/hooks';
import { useTabParam } from '@/lib/tab-param';
import { ProductionPlanningPage } from './planning-page';
import { PreplanningPage } from './preplanning-page';

/**
 * Reformulação, Fase 3 — programação semanal numa tela só.
 *
 * "Serviços" é a antiga "Produção — A planejar" (escolher tapeceiro e data, acompanhar o que já
 * foi planejado) e "Semana detalhada" é o antigo "Planejamento de produção" (responsáveis, dias,
 * dependências, filas). As duas abas trabalham sobre o MESMO plano semanal e publicam pelo MESMO
 * diálogo (`PublishWeekDialog`) — não há mais dois caminhos de publicação. Regras de prioridade,
 * responsáveis e datas são as do servidor, que não mudaram; os tablets recebem o mesmo plano.
 * Os endereços antigos continuam abrindo a aba correspondente.
 */
const TABS = ['servicos', 'semana'] as const;
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
  const allowed: readonly Tab[] = can('producao.planejar') ? TABS : ['servicos'];
  const [tab, setTab] = useTabParam(allowed.includes(initial) ? initial : 'servicos', allowed, {
    'a-planejar': 'servicos',
    planejamento: 'semana',
  });
  return (
    <>
      <PageHeader
        title="Programação semanal"
        description="Escolha o tapeceiro e a data de início de cada serviço, ajuste responsáveis, dias e dependências e publique a semana — tudo aqui. Material disponível não inicia a produção: só a programação publicada libera as tarefas."
        actions={
          <span className="flex flex-wrap gap-3 text-sm font-medium">
            <Link href="/painel/producao" className="text-brand-700 hover:underline">
              Quadro de produção →
            </Link>
            <Link href="/painel/competencias" className="text-brand-700 hover:underline">
              Competências da equipe →
            </Link>
          </span>
        }
      />
      <Tabs
        tabs={[
          { key: 'servicos', label: 'Serviços' },
          ...(allowed.length > 1 ? [{ key: 'semana', label: 'Semana detalhada' }] : []),
        ]}
        active={tab}
        onChange={setTab}
      >
        <div className="pt-4" data-testid={`schedule-${tab}`}>
          {tab === 'servicos' && <PreplanningPage embedded />}
          {tab === 'semana' && <ProductionPlanningPage embedded />}
        </div>
      </Tabs>
    </>
  );
}
