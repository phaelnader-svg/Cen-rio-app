import {
  RELEASE_BLOCKER_LABEL,
  TASK_STATUS_LABEL,
  type ReleaseBlocker,
  type TaskStatus,
} from '@cenario/shared';
import { Badge } from '@/components/ui/misc';

type Tone = 'neutral' | 'brand' | 'ok' | 'warn' | 'danger' | 'info' | 'bronze';
const TONE: Record<TaskStatus, Tone> = {
  RASCUNHO: 'neutral',
  BLOQUEADA: 'danger',
  PROGRAMADA: 'info',
  LIBERADA: 'brand',
  EM_EXECUCAO: 'bronze',
  PAUSADA: 'warn',
  CONCLUIDA: 'ok',
  CANCELADA: 'neutral',
};

export const TaskStatusBadge = ({ status }: { status: TaskStatus }) => (
  <Badge tone={TONE[status]} dot>
    {TASK_STATUS_LABEL[status]}
  </Badge>
);

export const blockersText = (b: ReleaseBlocker[]) =>
  b.map((x) => RELEASE_BLOCKER_LABEL[x]).join(' · ');
