'use client';

import type { AuditLogDto } from '@cenario/shared';
import { useInfiniteQuery } from '@tanstack/react-query';
import { ScrollText } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/field';
import { Alert, Badge, Card, EmptyState, PageHeader, Spinner } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';

const ENTITY_LABELS: Record<string, string> = {
  employee: 'Funcionário',
  role: 'Função',
  device: 'Dispositivo',
  session: 'Sessão',
  user: 'Usuário',
  company_settings: 'Empresa',
};

function Changes({ changes }: { changes: unknown }) {
  if (!changes || typeof changes !== 'object' || Object.keys(changes).length === 0) return null;
  return (
    <details className="mt-2 text-sm">
      <summary className="cursor-pointer text-brand-700">Ver alterações</summary>
      <pre className="mt-2 overflow-x-auto rounded-lg bg-subtle p-3 text-xs text-ink-soft">
        {JSON.stringify(changes, null, 2)}
      </pre>
    </details>
  );
}

export function AuditPage() {
  const [entityType, setEntityType] = useState('');
  const q = useInfiniteQuery({
    queryKey: ['audit', 'list', entityType],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams({ limit: '50' });
      if (pageParam) params.set('cursor', pageParam);
      if (entityType) params.set('entityType', entityType);
      return api<{ items: AuditLogDto[]; nextCursor: string | null }>(`/api/audit?${params}`);
    },
    getNextPageParam: (last) => last.nextCursor,
  });
  const items = q.data?.pages.flatMap((p) => p.items) ?? [];

  return (
    <>
      <PageHeader
        title="Auditoria"
        description="Registro imutável das ações críticas: quem fez, o quê, quando e de onde."
        actions={
          <Select
            aria-label="Filtrar por tipo"
            value={entityType}
            onChange={(e) => setEntityType(e.target.value)}
            className="w-52"
          >
            <option value="">Todos os registros</option>
            {Object.entries(ENTITY_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        }
      />
      <Card className="overflow-hidden">
        {q.isPending ? (
          <Spinner className="p-5" />
        ) : q.isError ? (
          <Alert tone="danger" className="m-4">
            {q.error.message}
          </Alert>
        ) : items.length === 0 ? (
          <EmptyState
            icon={<ScrollText className="size-6" aria-hidden />}
            title="Nenhum registro"
          />
        ) : (
          <ol className="divide-y divide-line">
            {items.map((a) => (
              <li key={a.id} className="px-5 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone="neutral">{ENTITY_LABELS[a.entityType] ?? a.entityType}</Badge>
                  <code className="text-xs text-ink-muted">{a.action}</code>
                </div>
                <p className="mt-1.5 text-[15px] text-ink">{a.summary}</p>
                <p className="mt-0.5 text-xs text-ink-muted">
                  {formatDateTime(a.createdAt)} · {a.actor?.displayName ?? 'Sistema'}
                  {a.ipAddress ? ` · IP ${a.ipAddress}` : ''}
                </p>
                <Changes changes={a.changes} />
              </li>
            ))}
          </ol>
        )}
      </Card>
      {q.hasNextPage && (
        <div className="mt-4 flex justify-center">
          <Button
            variant="secondary"
            loading={q.isFetchingNextPage}
            onClick={() => void q.fetchNextPage()}
          >
            Carregar mais
          </Button>
        </div>
      )}
    </>
  );
}
