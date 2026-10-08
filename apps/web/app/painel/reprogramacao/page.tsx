import type { Metadata } from 'next';
import { ReschedulePage } from '@/components/help/pages';

export const metadata: Metadata = { title: 'Reprogramação' };

export default function Page() {
  return <ReschedulePage />;
}
