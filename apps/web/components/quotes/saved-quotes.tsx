'use client';

import { plural, pluralWord } from '@cenario/shared';
import {
  QUOTE_STATUSES,
  QUOTE_STATUS_LABEL,
  WORK_ORDER_CHOICES,
  WORK_ORDER_REPAIR_CHOICES,
  defaultWorkOrder,
  formatCents,
  formatPhoneBr,
  type QuoteCatalogItemDto,
  type QuoteDto,
  type QuoteSummaryDto,
  type QuoteWorkOrder,
} from '@cenario/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  ClipboardList,
  ClipboardPlus,
  Eye,
  FileText,
  Flag,
  Pencil,
  Printer,
  Save,
  Trash2,
} from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { buttonClass } from '@/components/ui/button-styles';
import { Dialog } from '@/components/ui/dialog';
import {
  DateField,
  FormActions,
  FormGrid,
  FormSection,
  MoneyField,
  SelectField,
  TextAreaField,
  TextField,
} from '@/components/ui/form';
import { Alert, Badge, Card, EmptyState, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage, newIdempotencyKey } from '@/lib/api';
import {
  localDay,
  printArea,
  qtyText,
  shrinkImage,
  useQuoteCatalog,
  useSavedQuote,
  useSavedQuotes,
} from '@/lib/quotes';
import { useFocusParam } from '@/lib/focus-param';
import { useCan } from '@/lib/hooks';
import { ContractDocument, ProposalDocument, WorkOrderDocument } from './documents';
import {
  QuoteFunnel,
  QuoteLinkButtons,
  QuoteStatusBadges,
  QuoteStatusDialog,
  quoteStatusLine,
} from './quote-tracking';

type Mode = { kind: 'list' } | { kind: 'view'; id: string } | { kind: 'os'; id: string };

export function SavedQuotes({
  manage,
  onEdit,
}: {
  manage: boolean;
  /** Reabre o orçamento no "Elaborar" para alterar (mesmo número e mesmo link). */
  onEdit?: (id: string) => void;
}) {
  const [mode, setMode] = useState<Mode>({ kind: 'list' });
  if (mode.kind === 'view')
    return <SavedQuoteView id={mode.id} onBack={() => setMode({ kind: 'list' })} />;
  if (mode.kind === 'os')
    return <WorkOrderEditor id={mode.id} onBack={() => setMode({ kind: 'list' })} />;
  return <SavedList manage={manage} onOpen={setMode} onEdit={onEdit} />;
}

function SavedList({
  manage,
  onOpen,
  onEdit,
}: {
  manage: boolean;
  onOpen: (m: Mode) => void;
  onEdit?: (id: string) => void;
}) {
  const list = useSavedQuotes();
  const qc = useQueryClient();
  const toast = useToast();
  const [phone, setPhone] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [removing, setRemoving] = useState<QuoteSummaryDto | null>(null);
  const [statusOf, setStatusOf] = useState<QuoteSummaryDto | null>(null);
  const [situation, setSituation] = useState('');
  const can = useCan();
  const canCloseService = can('pedidos.gerenciar') && can('retiradas.gerenciar');
  const focus = useFocusParam();
  const del = useMutation({
    mutationFn: (id: string) =>
      api(`/api/v1/quotes/${id}/delete`, {
        method: 'POST',
        body: {},
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: async () => {
      setRemoving(null);
      toast('ok', 'Orçamento excluído.');
      await qc.invalidateQueries({ queryKey: ['quotes'] });
    },
  });

  const badDates = Boolean(from && to && from > to);
  const digits = phone.replace(/\D/g, '');
  const filtered = useMemo(
    () =>
      badDates
        ? []
        : (list.data ?? []).filter((q) => {
            const day = localDay(q.createdAt);
            return (
              (q.id === focus ||
                !situation ||
                (situation === 'COBRAR' ? q.followUpDue : q.status === situation)) &&
              (!digits || (q.phone ?? '').replace(/\D/g, '').includes(digits)) &&
              (!from || day >= from) &&
              (!to || day <= to)
            );
          }),
    [list.data, digits, from, to, badDates, situation, focus],
  );

  return (
    <div className="space-y-4">
      <QuoteFunnel />
      <Card className="p-5">
        <h2 className="font-semibold">Orçamentos salvos</h2>
        <p className="text-sm text-ink-muted">
          Consulte propostas anteriores sem alterar o orçamento em elaboração.
        </p>
        <FormGrid className="mt-4">
          <TextField
            label="Pesquisar por telefone / WhatsApp"
            placeholder="(12) 99999-9999"
            type="tel"
            inputMode="numeric"
            maxLength={15}
            cols={3}
            value={phone}
            onChange={(e) => setPhone(formatPhoneBr(e.target.value))}
          />
          <SelectField
            label="Situação"
            cols={3}
            value={situation}
            onChange={(e) => setSituation(e.target.value)}
          >
            <option value="">Todas</option>
            <option value="COBRAR">Para cobrar hoje</option>
            {QUOTE_STATUSES.map((st) => (
              <option key={st} value={st}>
                {QUOTE_STATUS_LABEL[st]}
              </option>
            ))}
          </SelectField>
          <DateField
            label="Data de início"
            cols={3}
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
          <DateField
            label="Data de término"
            cols={3}
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </FormGrid>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
          <span className="text-sm text-ink-muted" aria-live="polite">
            {filtered.length} de{' '}
            {plural(list.data?.length ?? 0, 'orçamento encontrado', 'orçamentos encontrados')}
          </span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setPhone('');
              setFrom('');
              setTo('');
              setSituation('');
            }}
          >
            Limpar filtros
          </Button>
        </div>
        {badDates && (
          <Alert tone="danger" className="mt-3">
            A data de início não pode ser posterior à data de término.
          </Alert>
        )}
      </Card>

      {list.isPending ? (
        <Spinner />
      ) : list.isError ? (
        <Alert tone="danger">{list.error.message}</Alert>
      ) : !list.data.length ? (
        <Card>
          <EmptyState
            icon={<FileText className="size-6" aria-hidden />}
            title="Nenhum orçamento salvo ainda"
            description="Elabore um orçamento e clique em Salvar orçamento."
          />
        </Card>
      ) : !filtered.length ? (
        <Card>
          <EmptyState title="Nenhum orçamento encontrado para os filtros selecionados." />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line">
            {filtered.map((q) => (
              <li key={q.id} data-focus-id={q.id} className="flex flex-col gap-3 px-5 py-4">
                {/* Dados na horizontal, ocupando a largura, acima da linha de botões. */}
                <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1">
                  <p className="font-semibold">
                    {q.customerName || 'Cliente não informado'} <QuoteStatusBadges q={q} />
                    {q.hasWorkOrder && (
                      <Badge tone="brand" className="ml-1 align-middle">
                        OS gerada
                      </Badge>
                    )}
                  </p>
                  <p className="text-sm text-ink-muted">
                    Nº {q.number} • {new Date(q.createdAt).toLocaleDateString('pt-BR')} •{' '}
                    {q.phone || 'Telefone não informado'} • {q.service || 'Serviço não informado'} •{' '}
                    <span className="money">{formatCents(q.totalCents)}</span>
                  </p>
                  {quoteStatusLine(q) && (
                    <p className="text-xs text-ink-muted">{quoteStatusLine(q)}</p>
                  )}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<Eye className="size-4" aria-hidden />}
                    onClick={() => onOpen({ kind: 'view', id: q.id })}
                  >
                    Visualizar
                  </Button>
                  <QuoteLinkButtons q={q} />
                  {manage && (
                    <>
                      {onEdit && !q.orderId && (
                        <Button
                          size="sm"
                          variant="secondary"
                          icon={<Pencil className="size-4" aria-hidden />}
                          onClick={() => onEdit(q.id)}
                        >
                          Editar
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="secondary"
                        icon={<Flag className="size-4" aria-hidden />}
                        onClick={() => setStatusOf(q)}
                      >
                        Situação
                      </Button>
                      {q.orderId ? (
                        <Link
                          href={`/painel/pedidos/${q.orderId}`}
                          className={buttonClass('secondary', 'sm')}
                        >
                          Ver pedido
                        </Link>
                      ) : (
                        canCloseService &&
                        q.status !== 'RECUSADO' && (
                          <Link
                            href={`/painel/servicos/novo?orcamento=${q.id}`}
                            className={buttonClass('primary', 'sm')}
                          >
                            <ClipboardPlus className="size-4" aria-hidden />
                            Fechar serviço
                          </Link>
                        )
                      )}
                      <Button
                        size="sm"
                        variant="secondary"
                        icon={<ClipboardList className="size-4" aria-hidden />}
                        onClick={() => onOpen({ kind: 'os', id: q.id })}
                      >
                        {q.hasWorkOrder ? 'Editar OS' : 'Gerar OS'}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline-danger"
                        icon={<Trash2 className="size-4" aria-hidden />}
                        onClick={() => setRemoving(q)}
                      >
                        Excluir
                      </Button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <QuoteStatusDialog summary={statusOf} onClose={() => setStatusOf(null)} />

      <Dialog
        open={Boolean(removing)}
        onClose={() => setRemoving(null)}
        title="Excluir este orçamento salvo?"
        description={removing ? `Nº ${removing.number} — ${removing.customerName}` : undefined}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setRemoving(null)}>
              Cancelar
            </Button>
            <Button
              variant="danger"
              loading={del.isPending}
              onClick={() => removing && del.mutate(removing.id)}
            >
              Excluir
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-soft">
          O orçamento e a OS dele deixam de aparecer na lista. O registro fica guardado no histórico
          do sistema.
        </p>
        {del.error && (
          <Alert tone="danger" className="mt-3">
            {errorMessage(del.error)}
          </Alert>
        )}
      </Dialog>
    </div>
  );
}

function SavedQuoteView({ id, onBack }: { id: string; onBack: () => void }) {
  const q = useSavedQuote(id);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          icon={<ArrowLeft className="size-4" aria-hidden />}
          onClick={onBack}
        >
          Voltar à lista
        </Button>
        <Button
          icon={<Printer className="size-4" aria-hidden />}
          disabled={!q.data}
          onClick={() => printArea('orcamento-salvo')}
        >
          Imprimir / Salvar PDF
        </Button>
      </div>
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <Alert tone="danger">{q.error.message}</Alert>
      ) : (
        <div id="orcamento-salvo" className="space-y-6">
          <ProposalDocument s={q.data.snapshot} number={q.data.number} />
          <ContractDocument s={q.data.snapshot} number={q.data.number} />
        </div>
      )}
    </div>
  );
}

const todayLocal = () => localDay(new Date());

function WorkOrderEditor({ id, onBack }: { id: string; onBack: () => void }) {
  const q = useSavedQuote(id);
  const catalog = useQuoteCatalog();
  if (q.isPending || catalog.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{q.error.message}</Alert>;
  if (catalog.isError) return <Alert tone="danger">{catalog.error.message}</Alert>;
  return (
    <WorkOrderForm
      key={`${q.data.id}:${q.data.version}`}
      quote={q.data}
      upholsterers={catalog.data.filter((c) => c.kind === 'TAPECEIRO')}
      onBack={onBack}
    />
  );
}

function WorkOrderForm({
  quote,
  upholsterers,
  onBack,
}: {
  quote: QuoteDto;
  upholsterers: QuoteCatalogItemDto[];
  onBack: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [wo, setWo] = useState<QuoteWorkOrder>(
    () => quote.workOrder ?? defaultWorkOrder(quote.snapshot, todayLocal()),
  );
  const [photoNote, setPhotoNote] = useState(
    wo.photoDataUrl ? 'Foto cadastrada' : 'Nenhuma foto selecionada',
  );
  const [error, setError] = useState<string | null>(null);
  const set = (patch: Partial<QuoteWorkOrder>) => {
    setError(null);
    setWo((w) => ({ ...w, ...patch }));
  };
  const responsibleName =
    upholsterers.find((u) => u.id === wo.responsibleId)?.name ??
    (quote.workOrder?.responsibleId === wo.responsibleId ? quote.workOrder.responsibleName : '') ??
    '';

  const save = useMutation({
    mutationFn: () =>
      api<QuoteDto>(`/api/v1/quotes/${quote.id}/work-order`, {
        method: 'PUT',
        body: { version: quote.version, workOrder: { ...wo, responsibleName } },
      }),
    onSuccess: async () => {
      toast('ok', 'Ordem de serviço salva junto ao orçamento.');
      await qc.invalidateQueries({ queryKey: ['quotes'] });
    },
    onError: (e) => setError(errorMessage(e)),
  });

  const groups = ['Tecidos', 'Espumas', 'Insumos', 'Madeiramento'] as const;
  const groupTitle = (g: (typeof groups)[number]) =>
    g === 'Tecidos'
      ? 'Tecidos escolhidos pelo cliente'
      : g === 'Espumas'
        ? 'Espumas e medidas do orçamento'
        : g;

  return (
    <div className="space-y-6">
      <FormSection
        title="Ordem de Serviço • Custos reais"
        description="Confira os materiais previstos e informe os valores e quantidades efetivamente utilizados. Esta OS é um documento interno."
        actions={
          <Button
            variant="secondary"
            icon={<ArrowLeft className="size-4" aria-hidden />}
            onClick={onBack}
          >
            Voltar aos orçamentos
          </Button>
        }
      >
        <p className="mb-4 text-sm text-ink-soft">
          Orçamento nº <strong className="tabular-nums">{quote.number}</strong> —{' '}
          {quote.customerName} • {quote.service}
        </p>
        <FormGrid>
          <DateField
            label="Data da OS"
            cols={4}
            value={wo.date}
            onChange={(e) => set({ date: e.target.value })}
          />
          <MoneyField
            label="Mão de obra real do tapeceiro"
            cols={4}
            cents={wo.upholsteryCents}
            onCents={(v) => set({ upholsteryCents: v ?? 0 })}
          />
          <SelectField
            label="Tapeceiro responsável pela execução"
            cols={4}
            value={wo.responsibleId}
            onChange={(e) => set({ responsibleId: e.target.value })}
            hint={upholsterers.length ? undefined : 'Cadastre os tapeceiros na Base de dados.'}
          >
            <option value="">Selecione o tapeceiro</option>
            {quote.workOrder?.responsibleId &&
              !upholsterers.some((u) => u.id === quote.workOrder?.responsibleId) && (
                <option value={quote.workOrder.responsibleId}>
                  {quote.workOrder.responsibleName}
                </option>
              )}
            {upholsterers.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </SelectField>
          <TextField
            label="Nome do tecido escolhido"
            placeholder="Ex.: Linho bege"
            cols={8}
            value={wo.fabricName}
            onChange={(e) => set({ fabricName: e.target.value })}
          />
          <TextField
            label="Metragem do tecido (m)"
            placeholder="Ex.: 12,5"
            type="number"
            min={0}
            step="0.01"
            cols={4}
            value={wo.fabricMeters ?? ''}
            onChange={(e) =>
              set({
                fabricMeters:
                  e.target.value === '' ? null : Math.max(0, Number(e.target.value) || 0),
              })
            }
          />
        </FormGrid>

        <div className="mt-5 rounded-xl border border-line p-4">
          <p className="label">Foto do serviço (PNG ou JPEG)</p>
          <div className="flex flex-wrap items-center gap-3">
            <input
              type="file"
              accept="image/png,image/jpeg,.png,.jpg,.jpeg"
              aria-label="Foto do serviço"
              className="text-sm file:mr-3 file:h-9 file:rounded-lg file:border file:border-line-strong file:bg-surface file:px-3 file:text-sm file:font-medium"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                if (!['image/png', 'image/jpeg'].includes(f.type)) {
                  setPhotoNote('Escolha uma imagem PNG ou JPEG.');
                  e.target.value = '';
                  return;
                }
                try {
                  set({ photoDataUrl: await shrinkImage(f, 1100, 'image/jpeg') });
                  setPhotoNote(`Foto selecionada: ${f.name}`);
                } catch {
                  setPhotoNote('Não foi possível carregar a imagem.');
                }
                e.target.value = '';
              }}
            />
            <span className="text-sm text-ink-muted">{photoNote}</span>
            {wo.photoDataUrl && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  set({ photoDataUrl: null });
                  setPhotoNote('Nenhuma foto selecionada');
                }}
              >
                Remover foto
              </Button>
            )}
          </div>
          <p className="mt-1.5 text-xs text-ink-muted">
            A foto aparece ao lado das informações na primeira página da OS.
          </p>
        </div>

        <h3 className="mt-6 mb-3 font-semibold">Informações da execução</h3>
        <FormGrid>
          {(
            [
              ['keepOriginal', 'Manter original', WORK_ORDER_CHOICES],
              ['changeFoam', 'Trocar espumas', WORK_ORDER_CHOICES],
              ['changeFabric', 'Trocar tecido', WORK_ORDER_CHOICES],
              ['repairStructure', 'Reparar estrutura', WORK_ORDER_REPAIR_CHOICES],
            ] as const
          ).map(([k, label, options]) => (
            <SelectField
              key={k}
              label={label}
              cols={3}
              value={wo[k]}
              onChange={(e) => set({ [k]: e.target.value } as Partial<QuoteWorkOrder>)}
            >
              {options.map((o) => (
                <option key={o}>{o}</option>
              ))}
            </SelectField>
          ))}
        </FormGrid>

        {groups.map((g) => {
          const entries = wo.items
            .map((it, i) => ({ it, i }))
            .filter(({ it }) => it.category === g);
          if (!entries.length) return null;
          return (
            <div key={g} className="mt-6">
              <h3 className="mb-2 font-semibold">{groupTitle(g)}</h3>
              <div className="divide-y divide-line rounded-xl border border-line">
                {entries.map(({ it, i }) => {
                  const fabric = g === 'Tecidos';
                  const foam = g === 'Espumas';
                  return (
                    <div key={i} className="px-4 py-3">
                      <FormGrid>
                        <div className="flex flex-col justify-end sm:col-span-6">
                          <p className="font-medium">
                            {it.name} <span className="text-xs text-ink-muted">{it.category}</span>
                          </p>
                          {foam && (
                            <p className="text-xs text-ink-muted">
                              Medidas orçadas: {qtyText(it.heightCm)} × {qtyText(it.widthCm)} ×{' '}
                              {qtyText(it.lengthCm)} cm • {qtyText(it.qty)}{' '}
                              {pluralWord(it.qty, 'peça', 'peças')}
                            </p>
                          )}
                          {fabric && (
                            <p className="text-xs text-ink-muted">Tecido escolhido pelo cliente</p>
                          )}
                        </div>
                        <TextField
                          label={
                            fabric
                              ? 'Quantidade utilizada (m)'
                              : foam
                                ? 'Peças utilizadas'
                                : 'Quantidade utilizada'
                          }
                          type="number"
                          min={0}
                          step="any"
                          cols={3}
                          readOnly={!fabric}
                          value={it.realQty}
                          onChange={(e) =>
                            setWo((w) => ({
                              ...w,
                              items: w.items.map((x, j) =>
                                j === i
                                  ? { ...x, realQty: Math.max(0, Number(e.target.value) || 0) }
                                  : x,
                              ),
                            }))
                          }
                        />
                        <TextField
                          label="Custo do orçamento"
                          cols={3}
                          readOnly
                          value={formatCents(it.costCents)}
                        />
                      </FormGrid>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}

        <FormGrid className="mt-6">
          <TextAreaField
            label="Observações internas / execução"
            cols={12}
            rows={3}
            value={wo.notes}
            onChange={(e) => set({ notes: e.target.value })}
          />
        </FormGrid>
        {error && (
          <Alert tone="danger" className="mt-4">
            {error}
          </Alert>
        )}
        <FormActions className="mt-5">
          <Button
            variant="secondary"
            icon={<Printer className="size-4" aria-hidden />}
            onClick={() => printArea('os-orcamento')}
          >
            Imprimir / Salvar PDF
          </Button>
          <Button
            icon={<Save className="size-4" aria-hidden />}
            loading={save.isPending}
            onClick={() => {
              if (!wo.responsibleId)
                return setError('Selecione o tapeceiro responsável antes de salvar a OS.');
              save.mutate();
            }}
          >
            Salvar OS
          </Button>
        </FormActions>
      </FormSection>

      <div id="os-orcamento">
        <WorkOrderDocument
          s={quote.snapshot}
          number={quote.number}
          customerName={quote.customerName}
          service={quote.service}
          wo={{ ...wo, responsibleName }}
        />
      </div>
    </div>
  );
}
