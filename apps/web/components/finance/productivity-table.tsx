import type { ProductivityDto } from '@cenario/shared';
import { Alert } from '@/components/ui/misc';
import { Table } from './common';

/**
 * Tabela de produtividade (só contagens, minutos e percentuais — nenhum valor financeiro).
 * Reformulação, Fase 4: a mesma tabela serve ao Financeiro e à Programação semanal (quem planeja).
 */
export function ProductivityTable({ data }: { data: ProductivityDto }) {
  const min = (v: number | null) => (v === null ? '—' : `${v} min`);
  return (
    <div className="space-y-4">
      <Alert tone="info">{data.notes.join(' ')}</Alert>
      <Table
        testId="productivity-table"
        head={[
          'Funcionário',
          'Concluídas',
          'Apoios',
          'Retrabalhos',
          'Execução média',
          'Espera média',
          'No prazo',
          'Atrasos',
          'Atrasos c/ impedimento',
          'Impedimentos',
          'Ocorrências',
          'Peças reprovadas',
        ]}
      >
        {data.rows.map((r) => (
          <tr key={r.userId}>
            <td className="px-4 py-2.5 font-medium">{r.displayName}</td>
            <td className="px-4 py-2.5 tabular-nums">{r.tasksCompleted}</td>
            <td className="px-4 py-2.5 tabular-nums">{r.supportTasks}</td>
            <td className="px-4 py-2.5 tabular-nums">{r.reworkTasks}</td>
            <td className="px-4 py-2.5 tabular-nums">{min(r.avgExecutionMinutes)}</td>
            <td className="px-4 py-2.5 tabular-nums">{min(r.avgWaitingMinutes)}</td>
            <td className="px-4 py-2.5 tabular-nums">
              {r.withDueDate ? `${r.onTime}/${r.withDueDate}` : '—'}
            </td>
            <td className="px-4 py-2.5 tabular-nums">{r.late - r.lateWithImpediment}</td>
            <td className="px-4 py-2.5 tabular-nums">{r.lateWithImpediment}</td>
            <td className="px-4 py-2.5 tabular-nums">{r.impediments}</td>
            <td className="px-4 py-2.5 tabular-nums">{r.issuesReported}</td>
            <td className="px-4 py-2.5 tabular-nums">{r.rejectedPieces}</td>
          </tr>
        ))}
      </Table>
    </div>
  );
}
