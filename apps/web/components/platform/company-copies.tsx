'use client';

import type { PlatformCompanyDto } from '@cenario/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { Archive, ArrowRight, Download, History } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/field';
import { Alert, Card, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage, fieldErrors } from '@/lib/api';
import { formatDateTime } from '@/lib/format';

interface CopyItem {
  id: string;
  kind: 'diaria' | 'antes-de-recuperar';
  createdAt: string;
  sizeBytes: number;
  rows: number;
}
interface CopyPreview {
  id: string;
  createdAt: string;
  changes: { table: string; label: string; now: number; copy: number }[];
}

/**
 * Item 52 (lista de 53): recuperar os dados de UMA empresa. O dono escolhe a cópia (uma por dia,
 * 14 dias), vê o que muda e confirma digitando o nome. Antes de trocar, o sistema guarda como
 * está agora (aparece na lista como "Antes de recuperar"): dá para desfazer.
 */
export function RecoverCompanyDialog({
  company,
  onClose,
}: {
  company: PlatformCompanyDto;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [pick, setPick] = useState<string | null>(null);
  const [confirmName, setConfirmName] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const copies = useQuery({
    queryKey: ['platform-copies', company.id],
    queryFn: () => api<{ items: CopyItem[] }>(`/api/v1/platform/companies/${company.id}/copies`),
  });
  const preview = useQuery({
    queryKey: ['platform-copy', company.id, pick],
    queryFn: () => api<CopyPreview>(`/api/v1/platform/companies/${company.id}/copies/${pick}`),
    enabled: Boolean(pick),
  });
  const save = useMutation({
    mutationFn: () =>
      api<{ beforeCopyId: string }>(`/api/v1/platform/companies/${company.id}/recover`, {
        method: 'POST',
        body: { copyId: pick, confirmName },
      }),
    onSuccess: () => {
      toast(
        'ok',
        `${company.tradeName} voltou para a cópia de ${formatDateTime(preview.data!.createdAt)}. Como estava antes ficou guardado na lista.`,
      );
      void qc.invalidateQueries({ queryKey: ['platform-copies', company.id] });
      void qc.invalidateQueries({ queryKey: ['platform-companies'] });
      onClose();
    },
    onError: (e) => {
      setErrors(fieldErrors(e));
      toast('danger', errorMessage(e));
    },
  });
  const items = copies.data?.items ?? [];
  const chosen = items.find((x) => x.id === pick);
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={`Recuperar os dados da ${company.tradeName}`}
      description="Só esta empresa volta para como estava na cópia escolhida. As outras empresas não mudam."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            variant="danger"
            loading={save.isPending}
            disabled={!pick || !preview.data || confirmName !== company.tradeName}
            onClick={() => save.mutate()}
            data-testid="recuperar-confirmar"
          >
            Recuperar
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {copies.isLoading ? (
          <Spinner />
        ) : items.length === 0 ? (
          <p className="text-sm text-ink-soft">
            Ainda não há cópia desta empresa. A primeira sai sozinha depois das 3 h da manhã.
          </p>
        ) : (
          <div>
            <p className="mb-2 text-sm font-semibold text-ink">Escolha a cópia</p>
            <ul className="max-h-56 space-y-1.5 overflow-y-auto" data-testid="recuperar-copias">
              {items.map((x) => (
                <li key={x.id}>
                  <button
                    type="button"
                    onClick={() => setPick(x.id)}
                    className={clsx(
                      'flex w-full items-center justify-between gap-3 rounded-lg border px-3 py-2 text-left text-sm transition',
                      pick === x.id
                        ? 'border-brand-600 bg-brand-50 ring-2 ring-brand-100'
                        : 'border-line hover:bg-subtle',
                    )}
                  >
                    <span className="font-medium text-ink">{formatDateTime(x.createdAt)}</span>
                    <span className="text-ink-muted">
                      {x.kind === 'antes-de-recuperar'
                        ? 'Antes de recuperar (para desfazer)'
                        : 'Cópia do dia'}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
        {pick && (
          <div data-testid="recuperar-comparar">
            <p className="mb-2 text-sm font-semibold text-ink">
              O que muda{chosen ? ` (hoje × cópia de ${formatDateTime(chosen.createdAt)})` : ''}
            </p>
            {preview.isLoading || !preview.data ? (
              <Spinner />
            ) : (
              <div className="overflow-hidden rounded-lg border border-line">
                <table className="w-full text-sm">
                  <thead className="bg-subtle text-left text-ink-muted">
                    <tr>
                      <th className="px-3 py-1.5 font-medium">O quê</th>
                      <th className="px-3 py-1.5 text-right font-medium">Hoje</th>
                      <th className="w-6" />
                      <th className="px-3 py-1.5 text-right font-medium">Depois</th>
                    </tr>
                  </thead>
                  <tbody>
                    {preview.data.changes.map((c) => (
                      <tr key={c.table} className="border-t border-line">
                        <td className="px-3 py-1.5 text-ink-soft">{c.label}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{c.now}</td>
                        <td className="text-center text-ink-muted">
                          <ArrowRight className="inline size-3.5" aria-hidden />
                        </td>
                        <td
                          className={clsx(
                            'px-3 py-1.5 text-right font-semibold tabular-nums',
                            c.copy > c.now && 'text-ok-600',
                            c.copy < c.now && 'text-danger-600',
                          )}
                        >
                          {c.copy}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
        {pick && preview.data && (
          <>
            <Alert tone="warn">
              Tudo o que a empresa fez depois de {formatDateTime(preview.data.createdAt)} volta ao
              que era na cópia. Senhas, plano e cobrança continuam os de hoje. Todo mundo da empresa
              precisa entrar de novo. Como está agora fica guardado na lista, para desfazer se
              precisar.
            </Alert>
            <Field
              label={`Para confirmar, digite: ${company.tradeName}`}
              error={errors.confirmName}
            >
              {(p) => (
                <Input
                  {...p}
                  value={confirmName}
                  onChange={(e) => setConfirmName(e.target.value)}
                  data-testid="recuperar-nome"
                />
              )}
            </Field>
          </>
        )}
      </div>
    </Dialog>
  );
}

export function RecoverButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      size="sm"
      variant="secondary"
      icon={<History className="size-4" aria-hidden />}
      onClick={onClick}
      data-testid="empresa-recuperar"
    >
      Recuperar dados
    </Button>
  );
}

const sizeOf = (b: number) =>
  b >= 1_048_576
    ? `${(b / 1_048_576).toFixed(1).replace('.', ',')} MB`
    : `${Math.ceil(b / 1024)} KB`;

/** Empresas apagadas depois de 90 dias: as planilhas com todos os dados ficam aqui por 5 anos. */
export function ArchivesCard() {
  const q = useQuery({
    queryKey: ['platform-archives'],
    queryFn: () =>
      api<{
        items: { name: string; tradeName: string | null; sizeBytes: number; createdAt: string }[];
      }>('/api/v1/platform/archives'),
  });
  const items = q.data?.items ?? [];
  if (!items.length) return null;
  return (
    <Card className="mt-6 p-5" data-testid="arquivo-empresas">
      <h2 className="flex items-center gap-2 font-semibold">
        <Archive className="size-5 text-brand-700" aria-hidden />
        Empresas apagadas (arquivo)
      </h2>
      <p className="mt-1 text-sm text-ink-muted">
        Encerradas há mais de 90 dias e apagadas pelo sistema. As planilhas com todos os dados ficam
        guardadas aqui por 5 anos.
      </p>
      <ul className="mt-3 divide-y divide-line">
        {items.map((a) => (
          <li key={a.name} className="flex items-center justify-between gap-3 py-2 text-sm">
            <span className="min-w-0 truncate text-ink">
              {a.tradeName ?? a.name}
              <span className="text-ink-muted">
                {' '}
                · apagada em {formatDateTime(a.createdAt)} · {sizeOf(a.sizeBytes)}
              </span>
            </span>
            <a
              href={`/api/v1/platform/archives/${a.name}`}
              className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-2.5 font-semibold hover:bg-subtle"
            >
              <Download className="size-4" aria-hidden /> Baixar
            </a>
          </li>
        ))}
      </ul>
    </Card>
  );
}
