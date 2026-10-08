import type { Metadata } from 'next';
import { SkillsPage } from '@/components/help/pages';

export const metadata: Metadata = { title: 'Competências da equipe' };

export default function Page() {
  return <SkillsPage />;
}
