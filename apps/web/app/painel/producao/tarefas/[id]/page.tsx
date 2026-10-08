import type { Metadata } from 'next';
import { TaskAdminDetail } from '@/components/production/task-detail';

export const metadata: Metadata = { title: 'Tarefa de produção' };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <TaskAdminDetail id={id} />;
}
