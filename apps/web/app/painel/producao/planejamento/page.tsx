import type { Metadata } from 'next';
import { WeeklySchedulePage } from '@/components/production/weekly-schedule-page';

// Reformulação, Fase 3: endereço antigo preservado — abre a programação semanal em "Semana
// detalhada".
export const metadata: Metadata = { title: 'Programação semanal' };

export default function Page() {
  return <WeeklySchedulePage initial="semana" />;
}
