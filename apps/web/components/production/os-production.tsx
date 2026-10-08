'use client';

import { Factory } from 'lucide-react';
import Link from 'next/link';
import { Card, EmptyState, Spinner, Alert } from '@/components/ui/misc';
import { useCan } from '@/lib/hooks';
import { useOsProduction } from '@/lib/production';
import { BoardRow } from './board-page';

/** Aba "Produção" da OS: tarefas planejadas e o andamento de cada uma. */
export function OsProduction({ serviceOrderId }: { serviceOrderId: string }) {
  const q = useOsProduction(serviceOrderId);
  const can = useCan();
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{q.error.message}</Alert>;
  if (q.data.length === 0)
    return (
      <Card>
        <EmptyState
          icon={<Factory className="size-6" aria-hidden />}
          title="Nenhuma tarefa programada"
          description="A produção desta OS começa somente depois de incluída e publicada no planejamento semanal."
          action={
            can('producao.planejar') ? (
              <Link
                href="/painel/producao/planejamento"
                className="text-sm font-medium text-brand-700 hover:underline"
              >
                Abrir planejamento semanal →
              </Link>
            ) : undefined
          }
        />
      </Card>
    );
  return (
    <Card className="p-0">
      <ul className="divide-y divide-line" data-testid="os-production">
        {q.data.map((t) => (
          <li key={t.id}>
            <BoardRow t={t} />
          </li>
        ))}
      </ul>
    </Card>
  );
}
