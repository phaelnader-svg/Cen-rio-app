'use client';

import {
  buildQuoteSnapshot,
  calcQuote,
  quoteDraftFromSnapshot,
  formatPhoneBr,
  quoteSaveBlocker,
  type QuoteCustomerLookupDto,
  type QuoteDto,
} from '@cenario/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Printer, Save } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useRef, useState } from 'react';
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
  const [editAsk, setEditAsk] = useState<QuoteDto | null>(null);
  const [editNote, setEditNote] = useState<string | null>(null);

  // Revisão geral (item 5): "Novo orçamento" na ficha do cliente abre com o cliente preenchido.
  const clienteId = useSearchParams().get('cliente');
  const filled = useRef(false);
  useEffect(() => {
    if (!clienteId || filled.current || draftApi.editing) return;
    if (draftApi.draft.customerName.trim() !== '') return;
    filled.current = true;
    api<QuoteCustomerLookupDto[]>(`/api/v1/quotes/customer-lookup?id=${clienteId}`)
      .then(([c]) => {
        if (!c) return;
        draftApi.update({
          customerName: c.name,
          ...(c.phone ? { phone: formatPhoneBr(c.phone) } : {}),
          ...(c.city ? { city: c.city } : {}),
        });
      })
      .catch(() => undefined);
  }, [clienteId, draftApi]);

  // Perguntas do começo: o prazo de entrega de costume entra sozinho no orçamento novo.
  const defaultDays = settings.data?.defaultDeliveryDays ?? null;
  const pristine =
    !draftApi.editing &&
    draftApi.draft.customerName === '' &&
    draftApi.draft.items.length === 0 &&
    draftApi.draft.deliveryDays === null;
  useEffect(() => {
    if (defaultDays && pristine) draftApi.update({ deliveryDays: defaultDays });
  }, [defaultDays, pristine, draftApi]);

  /** Abre o orçamento salvo no "Elaborar" (o que estava em elaboração é substituído). */
  const openForEdit = (q: QuoteDto) => {
    if (!catalog.data) return;
    const { draft, missing } = quoteDraftFromSnapshot(q.snapshot, catalog.data);
    draftApi.load(draft, { id: q.id, number: q.number, version: q.version });
    setSaveError(null);
    setEditNote(
      missing.length
        ? `Não estão mais na base de dados e ficaram de fora: ${missing.join(', ')}. Escolha de novo, se precisar.`
        : null,
    );
    setEditAsk(null);
    setTab('elaborar');
  };
  const askEdit = async (id: string) => {
    const q = await qc.fetchQuery({
      queryKey: ['quotes', 'detail', id],
      queryFn: () => api<QuoteDto>(`/api/v1/quotes/${id}`),
      staleTime: 0,
    });
    const d = draftApi.draft;
    const dirty =
      !draftApi.editing && (d.customerName.trim() !== '' || d.items.length > 0 || d.service !== '');
    if (dirty || (draftApi.editing && draftApi.editing.id !== q.id)) setEditAsk(q);
    else openForEdit(q);
  };

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
      draftApi.editing
        ? api<QuoteDto>(`/api/v1/quotes/${draftApi.editing.id}`, {
            method: 'PUT',
            body: { version: draftApi.editing.version, draft: draftApi.draft },
          })
        : api<QuoteDto>('/api/v1/quotes', {
            method: 'POST',
            body: draftApi.draft,
            idempotencyKey: newIdempotencyKey(),
          }),
    onSuccess: async (q) => {
      setSaveError(null);
      toast(
        'ok',
        draftApi.editing
          ? `Orçamento nº ${q.number} atualizado.`
          : `Orçamento nº ${q.number} salvo. Ele já está em Orçamentos salvos.`,
      );
      // Salvo: o "Elaborar" volta a ficar livre para um orçamento novo.
      if (draftApi.editing) draftApi.reset();
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
        help="Escolha o cliente, a peça e o tecido: o material, a mão de obra, o frete, o imposto e a taxa da maquininha entram sozinhos, puxados da aba Base. Salve, mande pelo WhatsApp e, quando o cliente aprovar, use “Fechar serviço”. Os preços da sua mão de obra ficam na aba Base."
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
              note={editNote}
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
            <SavedQuotes
              key={savedKey}
              manage={manage}
              onEdit={(id) =>
                void askEdit(id).catch((e: unknown) => toast('danger', errorMessage(e)))
              }
            />
          )}
        </div>
      </Tabs>

      <Dialog
        open={Boolean(editAsk)}
        onClose={() => setEditAsk(null)}
        title={editAsk ? `Editar o orçamento nº ${editAsk.number}?` : ''}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditAsk(null)}>
              Cancelar
            </Button>
            <Button onClick={() => editAsk && openForEdit(editAsk)}>Editar este orçamento</Button>
          </>
        }
      >
        <p className="text-sm text-ink-soft">
          Há outro orçamento em elaboração. Ele será substituído por este para você alterar.
        </p>
      </Dialog>

      <Dialog
        open={confirmClear}
        onClose={() => setConfirmClear(false)}
        title={
          draftApi.editing
            ? `Cancelar a edição do orçamento nº ${draftApi.editing.number}?`
            : 'Limpar o orçamento em elaboração?'
        }
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
                setEditNote(null);
                setConfirmClear(false);
                setTab('elaborar');
              }}
            >
              {draftApi.editing ? 'Cancelar edição' : 'Limpar orçamento'}
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-soft">
          {draftApi.editing
            ? 'As alterações não salvas são descartadas. O orçamento salvo continua como estava.'
            : 'Todos os dados do orçamento em elaboração serão apagados. A base de dados e os orçamentos salvos continuam como estão.'}
        </p>
      </Dialog>
    </>
  );
}
