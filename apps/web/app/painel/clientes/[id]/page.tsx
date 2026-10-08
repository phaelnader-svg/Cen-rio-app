import type { Metadata } from 'next';
import { CustomerDetail } from '@/components/commercial/customer-detail';

export const metadata: Metadata = { title: 'Cliente' };

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <CustomerDetail id={id} />;
}
