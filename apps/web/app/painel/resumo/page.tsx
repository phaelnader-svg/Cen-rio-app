import type { Metadata } from 'next';
import { WeekSummaryPage } from '@/components/improvements/panel-pages';

export const metadata: Metadata = { title: 'Resumo da semana' };

export default function Page() {
  return <WeekSummaryPage />;
}
