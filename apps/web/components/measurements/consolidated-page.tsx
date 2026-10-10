'use client';

import type { ConsolidatedLine, MaterialKind } from '@cenario/shared';
import {
  MATERIAL_KINDS,
  MATERIAL_UNIT_LABEL,
  describeMaterial,
  formatQuantity,
} from '@cenario/shared';
import { Copy, Download, PackageSearch } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Section } from '@/components/commercial/section';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/field';
import { Alert, Card, EmptyState, PageHeader, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { formatDateTime } from '@/lib/format';
import { useConsolidated } from '@/lib/measurements';

const TITLE: Record<MaterialKind, string> = {
  TECIDO: 'Tecidos (sempre por OS)',
  ESPUMA: 'Espumas',
  OUTRO: 'Outros materiais',
};

const destination = (l: ConsolidatedLine) =>
  l.serviceOrder ? `Exclusivo ${l.serviceOrder.code}` : 'Estoque comum';

/** Texto simples para colar em mensagem ao fornecedor/compras. */
function asText(lines: ConsolidatedLine[]): string {
  const out: string[] = [];
  for (const kind of MATERIAL_KINDS) {
    const group = lines.filter((l) => l.kind === kind);
    if (!group.length) continue;
    out.push(`== ${TITLE[kind]} ==`);
    for (const l of group) {
      out.push(
        `- ${describeMaterial(l)}: ${formatQuantity(l.totalQuantity)} ${MATERIAL_UNIT_LABEL[l.unit]} (${destination(l)})`,
      );
    }
    out.push('');
  }
  return out.join('\n').trim();
}

export function ConsolidatedPage() {
  const toast = useToast();
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const list = useConsolidated(from || undefined, to || undefined);
  const params = new URLSearchParams();
  if (from) params.set('from', from);
  if (to) params.set('to', to);
  const csvHref = `/api/v1/materials/consolidated.csv${params.size ? `?${params}` : ''}`;

  async function copy() {
    if (!list.data) return;
    try {
      await navigator.clipboard.writeText(asText(list.data.lines));
      toast('ok', 'Lista copiada.');
    } catch {
      toast('danger', 'Não foi possível copiar. Use a exportação CSV.');
    }
  }

  return (
    <>
      <PageHeader
        title="Materiais aprovados"
        description="Lista consolidada das solicitações aprovadas para compra (quantidades conferidas). Tecidos ficam separados por OS; materiais comuns são somados entre OS com a origem de cada quantidade."
        actions={
          <>
            <Button
              variant="secondary"
              icon={<Copy className="size-4" aria-hidden />}
              disabled={!list.data?.lines.length}
              onClick={() => void copy()}
            >
              Copiar lista
            </Button>
            {list.data?.lines.length ? (
              <a
                href={csvHref}
                download
                className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand-700 px-4 text-[15px] font-semibold text-white shadow-sm hover:bg-brand-800"
              >
                <Download className="size-4" aria-hidden /> Exportar CSV
              </a>
            ) : null}
          </>
        }
      />
      <Card className="mb-6 flex flex-wrap items-end gap-3 p-4">
        <label>
          <span className="label">Aprovadas de</span>
          <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
        </label>
        <label>
          <span className="label">até</span>
          <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        </label>
        {list.data && (
          <p className="ml-auto text-sm text-ink-muted">
            {list.data.requestCount} solicitação(ões) · gerada em{' '}
            {formatDateTime(list.data.generatedAt)}
          </p>
        )}
      </Card>
      <Alert tone="info" className="mb-6">
        Aprovado para compra não significa comprado nem recebido. Compre pela central de{' '}
        <Link href="/painel/compras" className="font-medium text-brand-700 hover:underline">
          Compras
        </Link>
        ; a chegada é conferida em Recebimento de materiais.
      </Alert>
      {list.isPending ? (
        <Spinner />
      ) : list.isError ? (
        <Alert tone="danger">{list.error.message}</Alert>
      ) : list.data.lines.length === 0 ? (
        <Card>
          <EmptyState
            icon={<PackageSearch className="size-6" aria-hidden />}
            title="Nenhum material aprovado"
            description="Aprove as solicitações em Medições → Aguardando revisão."
          />
        </Card>
      ) : (
        <div className="space-y-6" data-testid="consolidated">
          {MATERIAL_KINDS.map((kind) => {
            const group = list.data.lines.filter((l) => l.kind === kind);
            if (!group.length) return null;
            return (
              <Section key={kind} title={TITLE[kind]} bodyClassName="p-0">
                <div className="overflow-x-auto">
                  <table
                    className="data-table data-table-compact min-w-[560px]"
                    data-testid={`consolidated-${kind}`}
                  >
                    <thead>
                      <tr>
                        <th>Material</th>
                        <th>Destino</th>
                        <th>Origens</th>
                        <th className="text-right">Total</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {group.map((l) => (
                        <tr key={l.key}>
                          <td className="font-medium">{describeMaterial(l)}</td>
                          <td className="text-ink-soft">{destination(l)}</td>
                          <td className="text-xs text-ink-muted">
                            {l.origins
                              .map(
                                (o) =>
                                  `${o.itemCode ?? o.serviceOrderCode}${o.measurementCode ? ` (${o.measurementCode})` : ''}: ${formatQuantity(o.quantity)}`,
                              )
                              .join(' · ')}
                          </td>
                          <td className="text-right font-semibold tabular-nums">
                            {formatQuantity(l.totalQuantity)} {MATERIAL_UNIT_LABEL[l.unit]}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Section>
            );
          })}
        </div>
      )}
    </>
  );
}
