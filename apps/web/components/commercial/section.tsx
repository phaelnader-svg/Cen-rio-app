import clsx from 'clsx';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { Card } from '@/components/ui/misc';

export function Section({
  title,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title: string;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <Card className={className}>
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3.5">
        <h2 className="font-semibold">{title}</h2>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
      <div className={clsx('p-5', bodyClassName)}>{children}</div>
    </Card>
  );
}

export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-ink-soft hover:text-ink"
    >
      <ArrowLeft className="size-4" aria-hidden /> {label}
    </Link>
  );
}

export function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-sm text-ink-muted">{label}</dt>
      <dd className="mt-0.5 text-[15px] whitespace-pre-line text-ink">{children || '—'}</dd>
    </div>
  );
}
