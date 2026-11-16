'use client';

import { buildQuoteSnapshot, calcQuote, quoteSaveBlocker, type QuoteDto } from '@cenario/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Printer, Save } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Alert, PageHeader, Spinner } from '@/components/ui/misc';
import { Tabs } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage, newIdempotencyKey } from '@/lib/api';
import { useCan } from '@/lib/hooks';
import { printArea, useQuoteCatalog, useQuoteDraft, useQuoteSettings } from '@/lib/quotes';
import { useTabParam } from '@/lib/tab-param';
import { ProposalDocument } from './documents';
import { QuoteEditor } from './draft-editor';
import { QuoteBase } from './quote-base';
import { SavedQuotes } from './saved-quotes';

const TABS = ['elaborar', 'proposta', 'salvos', 'base'] as const;

/**
 * Módulo Orçamentos: elaborar a proposta com materiais automáticos, visualizar e imprimir,
 * consultar orçamentos salvos (com contrato de garantia e O.S.) e manter a base de dados.
 */
export function QuotesPage() {
  const can = useCan();
  const manage = can('orcamentos.gerenciar');
  const [tab, setTab] = useTabParam(manage ? 'elaborar' : 'salvos', manage ? TABS : ['salvos']);
  const catalog = useQuoteCatalog();
  const settings = useQuoteSettings();
  const draftApi = useQuoteDraft();
  const qc = useQueryClient();
  const toast = useToast();
  const [saveError, setSaveError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [savedKey, setSavedKey] = useState(0);

  const totals = useMemo(
    () =>
      catalog.data && settings.data
        ? calcQuote(draftApi.draft, catalog.data, settings.data.taxRateBps)
        : null,
    [draftApi.draft, catalog.data, settings.data],
  );
  const preview = useMemo(
    () =>
      catalog.data && settings.data
        ? buildQuoteSnapshot(draftApi.draft, catalog.data, settings.data, new Date())
        : null,
    [draftApi.draft, catalog.data, settings.data],
  );

  const save = useMutation({
    mutationFn: () =>
      api<QuoteDto>('/api/v1/quotes', {
        method: 'POST',
        body: draftApi.draft,
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: async (q) => {
      setSaveError(null);
      toast('ok', `Orçamento nº ${q.number} salvo. Ele já está em Orçamentos salvos.`);
      await qc.invalidateQueries({ queryKey: ['quotes'] });
      setSavedKey((k) => k + 1);
      setTab('salvos');
    },
    onError: (e) => setSaveError(errorMessage(e)),
  });
  const trySave = () => {
    if (!totals) return;
    const blocker = quoteSaveBlocker(draftApi.draft, totals);
    if (blocker) return setSaveError(blocker);
    save.mutate();
  };

  const tabs = manage
    ? [
        { key: 'elaborar', label: 'Elaborar orçamento' },
        { key: 'proposta', label: 'Visualizar proposta' },
        { key: 'salvos', label: 'Orçamentos salvos' },
        { key: 'base', label: 'Base de dados' },
      ]
    : [{ key: 'salvos', label: 'Orçamentos salvos' }];

  const loading = catalog.isPending || settings.isPending || (manage && !draftApi.loaded);
  const failure = catalog.error ?? settings.error;
  const printable =
    totals !== null &&
    totals.total !== null &&
    !totals.pending &&
    !(totals.feePct !== null && totals.installmentTotal === null);

  return (
    <>
      <PageHeader
        title="Orçamentos"
        description="Proposta comercial com materiais, mão de obra, logística, imposto e taxas calculados automaticamente pela base de dados."
      />
      <Tabs tabs={tabs} active={tab} onChange={setTab}>
        <div className="pt-6">
          {failure ? (
            <Alert tone="danger">{failure.message}</Alert>
          ) : loading || !catalog.data || !settings.data ? (
            <Spinner />
          ) : tab === 'elaborar' ? (
            <QuoteEditor
              api={draftApi}
              catalog={catalog.data}
              settings={settings.data}
              onPreview={() => setTab('proposta')}
              onSave={trySave}
              saving={save.isPending}
              saveError={saveError}
              onClear={() => setConfirmClear(true)}
            />
          ) : tab === 'proposta' && preview ? (
            <div className="space-y-4">
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  icon={<ArrowLeft className="size-4" aria-hidden />}
                  onClick={() => setTab('elaborar')}
                >
                  Editar orçamento
                </Button>
                <Button
                  icon={<Save className="size-4" aria-hidden />}
                  loading={save.isPending}
                  onClick={trySave}
                >
                  Salvar orçamento
                </Button>
                <Button
                  variant="secondary"
                  icon={<Printer className="size-4" aria-hidden />}
                  disabled={!printable}
                  title={printable ? undefined : 'Complete os valores pendentes para imprimir.'}
                  onClick={() => printArea('proposta-orcamento')}
                >
                  Imprimir / Salvar PDF
                </Button>
              </div>
              {saveError && <Alert tone="danger">{saveError}</Alert>}
              <div id="proposta-orcamento">
                <ProposalDocument s={preview} pendingWarning={Boolean(totals?.pending)} />
              </div>
            </div>
          ) : tab === 'base' ? (
            <QuoteBase catalog={catalog.data} settings={settings.data} />
          ) : (
            <SavedQuotes key={savedKey} manage={manage} />
          )}
        </div>
      </Tabs>

      <Dialog
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        title="Limpar o orçamento em elaboração?"
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmClear(false)}>
              Cancelar
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                draftApi.reset();
                setSaveError(null);
                setConfirmClear(false);
                setTab('elaborar');
              }}
            >
              Limpar orçamento
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-soft">
          Todos os dados do orçamento em elaboração serão apagados. A base de dados e os orçamentos
          salvos continuam como estão.
        </p>
      </Dialog>
    </>
  );
}
