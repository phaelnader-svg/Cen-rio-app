'use client';

import { Sparkles } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Badge, EmptyState, Spinner } from '@/components/ui/misc';
import { osMaterialSuggestionsKey, useOsMaterialSuggestions } from '@/lib/service-models';
import { osMaterialListKey, useAction } from '@/lib/simple-materials';

const fmtQty = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 3 });

/**
 * Reformulação, Fase 2 — "Sugerir do modelo" na lista de materiais da OS.
 *
 * Mostra o que os modelos de serviço sugerem para as peças desta OS (quantidade por peça × peças)
 * e adiciona os escolhidos como linhas comuns da lista: sem custo, não compradas e não
 * disponíveis. O gestor revisa e altera depois, como qualquer linha. Nada é comprado, lançado no
 * financeiro ou baixado do estoque; o que já foi sugerido (e não removido) não se repete.
 */
export function SuggestFromModel({ serviceOrderId }: { serviceOrderId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        onClick={() => setOpen(true)}
        data-testid="os-material-suggest"
      >
        <Sparkles className="size-4" aria-hidden /> Sugerir do modelo
      </Button>
      {open && <SuggestDialog serviceOrderId={serviceOrderId} onClose={() => setOpen(false)} />}
    </>
  );
}

function SuggestDialog({
  serviceOrderId,
  onClose,
}: {
  serviceOrderId: string;
  onClose: () => void;
}) {
  const q = useOsMaterialSuggestions(serviceOrderId, true);
  const act = useAction<{ added: number; skipped: number }>(
    [osMaterialListKey(serviceOrderId), osMaterialSuggestionsKey(serviceOrderId), ['os-state']],
    'Materiais sugeridos adicionados à lista.',
  );
  // Por padrão, tudo o que ainda não está na lista vem marcado; guarda só os desmarcados.
  const [unchecked, setUnchecked] = useState<Set<string>>(new Set());
  const pending = q.data?.suggestions.filter((s) => !s.alreadyAdded) ?? [];
  const picked = pending.filter((s) => !unchecked.has(s.modelMaterialId));
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title="Sugerir materiais do modelo"
      description="Linhas entram sem custo, não compradas e não disponíveis. Revise quantidades e custos depois. Nada é comprado nem sai do estoque."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Fechar
          </Button>
          <Button
            disabled={act.isPending || picked.length === 0}
            onClick={() =>
              act.mutate(
                {
                  path: `/api/v1/service-orders/${serviceOrderId}/material-suggestions/apply`,
                  body: { modelMaterialIds: picked.map((s) => s.modelMaterialId) },
                },
                { onSuccess: onClose },
              )
            }
            data-testid="os-material-suggest-apply"
          >
            Adicionar {picked.length || ''} à lista
          </Button>
        </>
      }
    >
      {act.error && (
        <Alert tone="danger" className="mb-3">
          {act.error}
        </Alert>
      )}
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <Alert tone="danger">{q.error.message}</Alert>
      ) : q.data.suggestions.length === 0 ? (
        <EmptyState
          title="Nenhum material padrão para as peças desta OS"
          description="Cadastre materiais padrão em Modelos de serviço › Materiais padrão."
        />
      ) : (
        <ul className="divide-y divide-line" data-testid="os-material-suggestions">
          {q.data.suggestions.map((s) => (
            <li key={s.modelMaterialId} className="flex items-start gap-3 py-2.5">
              <input
                type="checkbox"
                className="mt-0.5 size-5 accent-brand-700"
                aria-label={`Adicionar ${s.description}`}
                disabled={s.alreadyAdded}
                checked={s.alreadyAdded || !unchecked.has(s.modelMaterialId)}
                onChange={(e) => {
                  const next = new Set(unchecked);
                  if (e.target.checked) next.delete(s.modelMaterialId);
                  else next.add(s.modelMaterialId);
                  setUnchecked(next);
                }}
              />
              <div className="min-w-0 flex-1 text-sm">
                <p className="font-medium">
                  {s.description}
                  {s.quantity !== null && (
                    <span className="font-normal text-ink-muted">
                      {' '}
                      — {fmtQty(s.quantity)} {s.unit ?? ''}
                    </span>
                  )}{' '}
                  {s.alreadyAdded && <Badge tone="ok">já na lista</Badge>}
                </p>
                <p className="text-xs text-ink-muted">{s.sources.join(' · ')}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
      {q.data && q.data.withoutModel.length > 0 && (
        <p className="mt-3 text-xs text-ink-muted">
          Sem material padrão: {q.data.withoutModel.join('; ')}.
        </p>
      )}
    </Dialog>
  );
}
