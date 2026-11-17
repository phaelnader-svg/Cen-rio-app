'use client';

import { pluralWord } from '@cenario/shared';
import {
  QUOTE_DELIVERY_DAYS,
  QUOTE_MATERIAL_CATEGORIES,
  QUOTE_OTHER_SERVICE,
  QUOTE_SERVICES,
  calcQuote,
  foamVolumeM3,
  formatCents,
  formatPhoneBr,
  normalizeQuoteName,
  quoteCategoryEnabled,
  quoteItemCost,
  type QuoteCatalogItemDto,
  type QuoteDraft,
  type QuoteMaterialCategory,
  type QuoteSettingsDto,
} from '@cenario/shared';
import clsx from 'clsx';
import { Eye, Plus, Save, Trash2, X } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import {
  FieldAction,
  FormActions,
  FormGrid,
  FormSection,
  MoneyField,
  SelectField,
  SummaryRow,
  TextAreaField,
  TextField,
  span,
} from '@/components/ui/form';
import { Alert } from '@/components/ui/misc';
import { brl, pct, qtyText, type useQuoteDraft } from '@/lib/quotes';
import { BR_CITIES } from '@/lib/br-cities';

type DraftApi = ReturnType<typeof useQuoteDraft>;

const numOr = (v: string, fallback = 0) => {
  const n = Number(v.replace(',', '.'));
  return Number.isFinite(n) && n >= 0 ? n : fallback;
};

/** Seletor de opções em "pílulas" (mesmo estilo dos seletores do painel). */
export function Segmented<K extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly (readonly [K, string])[];
  value: K;
  onChange: (k: K) => void;
}) {
  return (
    <div
      className="inline-flex max-w-full flex-wrap gap-1 rounded-xl bg-subtle p-1"
      role="radiogroup"
      aria-label={label}
    >
      {options.map(([k, text]) => (
        <button
          key={k}
          type="button"
          role="radio"
          aria-checked={value === k}
          onClick={() => onChange(k)}
          className="h-9 rounded-lg px-3 text-sm font-medium text-ink-soft aria-checked:bg-surface aria-checked:text-ink aria-checked:shadow-sm"
        >
          {text}
        </button>
      ))}
    </div>
  );
}

export function QuoteEditor({
  api,
  catalog,
  settings,
  onPreview,
  onSave,
  saving,
  saveError,
  onClear,
  note = null,
}: {
  api: DraftApi;
  catalog: QuoteCatalogItemDto[];
  settings: QuoteSettingsDto;
  onPreview: () => void;
  onSave: () => void;
  saving: boolean;
  saveError: string | null;
  onClear: () => void;
  /** Aviso ao reabrir um orçamento salvo (cadastros que não existem mais na base). */
  note?: string | null;
}) {
  const { draft: d, update } = api;
  const t = useMemo(() => calcQuote(d, catalog, settings.taxRateBps), [d, catalog, settings]);
  const byKind = (k: QuoteCatalogItemDto['kind']) => catalog.filter((c) => c.kind === k);
  const routes = byKind('LOGISTICA');
  const upholstery = byKind('MAO_TAPECEIRO');
  const helpers = byKind('MAO_AJUDANTE');
  const fees = byKind('TAXA_MAQUINA');
  const find = (id: string | null) => (id ? catalog.find((c) => c.id === id) : undefined);
  const route = find(d.logisticsId);
  const ups = find(d.upholsteryServiceId);
  const help = find(d.helperServiceId);

  /** O mesmo serviço do tapeceiro busca o serviço correspondente do ajudante. */
  const helperFor = (upsId: string | null) => {
    const u = upsId ? catalog.find((c) => c.id === upsId) : undefined;
    if (!u) return null;
    return (
      helpers.find((h) => h.linkedItemId === u.id) ??
      helpers.find((h) => normalizeQuoteName(h.name) === normalizeQuoteName(u.name)) ??
      null
    );
  };
  const helperMatch = helperFor(d.upholsteryServiceId);
  const helperNote = !d.upholsteryServiceId
    ? 'Ao escolher o serviço do tapeceiro, buscamos o mesmo serviço do ajudante.'
    : helperMatch
      ? helperMatch.priceCents === null
        ? 'Este serviço do ajudante ainda não tem preço. Cadastre-o na Base de dados.'
        : 'Valor do ajudante preenchido automaticamente pelo mesmo serviço do tapeceiro.'
      : 'Não há serviço correspondente do ajudante na Base de dados. Cadastre-o para vincular automaticamente.';

  // Mantém o ajudante coerente com o tapeceiro (inclusive depois de mudanças na base).
  useEffect(() => {
    const id = helperFor(d.upholsteryServiceId)?.id ?? null;
    if (id !== d.helperServiceId) update({ helperServiceId: id });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.upholsteryServiceId, d.helperServiceId, catalog]);

  const installments = t.installments;
  const alert =
    t.taxPct >= 100
      ? 'A alíquota do serviço deve ser inferior a 100%.'
      : t.pending
        ? 'Existem materiais, serviços, logística ou alíquota sem valor cadastrado na Base de dados. O total é provisório.'
        : t.feePct !== null && t.feePct >= 100
          ? 'Taxa de máquina inválida.'
          : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold tracking-[0.12em] text-ink-muted uppercase">
            {api.editing ? `Editando o orçamento nº ${api.editing.number}` : 'Novo orçamento'}
          </p>
          <h2 className="text-lg font-semibold">Elaboração da proposta</h2>
          <p className="text-sm text-ink-muted">
            Preencha os dados para preparar a proposta do cliente. O orçamento em elaboração fica
            guardado neste navegador até ser salvo.
          </p>
        </div>
        {/* Melhoria 168: nada destrutivo antes do primeiro campo; "Limpar" fica no fim. */}
        {api.editing && (
          <Button variant="secondary" onClick={onClear} icon={<X className="size-4" aria-hidden />}>
            Cancelar edição
          </Button>
        )}
      </div>
      {api.editing && (
        <Alert tone="info">
          Você está alterando o orçamento nº {api.editing.number}. Ao salvar, ele é atualizado com o
          mesmo número e o mesmo link do cliente; os valores são recalculados com os preços atuais
          da base de dados.
        </Alert>
      )}
      {api.editing && note && <Alert tone="warn">{note}</Alert>}

      <FormSection step={1} title="Dados do cliente">
        <FormGrid>
          <TextField
            label="Nome do cliente"
            placeholder="Nome ou empresa"
            cols={6}
            value={d.customerName}
            onChange={(e) => update({ customerName: e.target.value })}
          />
          <TextField
            label="Telefone / WhatsApp"
            placeholder="(12) 99999-9999"
            type="tel"
            inputMode="numeric"
            autoComplete="tel"
            maxLength={15}
            cols={6}
            value={d.phone}
            onChange={(e) => update({ phone: formatPhoneBr(e.target.value) })}
          />
          <CityField
            value={d.city}
            onChange={(city) => {
              // A rota de logística é cadastrada só com o nome ("Taubaté"); a busca devolve "Taubaté - SP".
              const bare = city.replace(/\s+-\s+[A-Z]{2}$/, '');
              const match = routes.find(
                (r) =>
                  normalizeQuoteName(r.name) === normalizeQuoteName(city) ||
                  normalizeQuoteName(r.name) === normalizeQuoteName(bare),
              );
              update(match ? { city, logisticsId: match.id } : { city });
            }}
          />
          <SelectField
            label="Serviço"
            cols={6}
            value={d.service}
            onChange={(e) => update({ service: e.target.value })}
          >
            <option value="">Selecione o serviço</option>
            {QUOTE_SERVICES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </SelectField>
          {d.service === QUOTE_OTHER_SERVICE && (
            <TextField
              label="Outro serviço"
              placeholder="Informe o outro serviço"
              cols={12}
              required
              value={d.serviceOther}
              onChange={(e) => update({ serviceOther: e.target.value })}
            />
          )}
          <SelectField
            label="Troca de tecido?"
            cols={6}
            value={d.fabricChange ? 'Sim' : 'Não'}
            onChange={(e) => update({ fabricChange: e.target.value === 'Sim' })}
          >
            <option>Não</option>
            <option>Sim</option>
          </SelectField>
          <SelectField
            label="Troca de espuma?"
            cols={6}
            value={d.foamChange ? 'Sim' : 'Não'}
            onChange={(e) => update({ foamChange: e.target.value === 'Sim' })}
          >
            <option>Não</option>
            <option>Sim</option>
          </SelectField>
        </FormGrid>
      </FormSection>

      <MaterialsSection api={api} catalog={catalog} />

      <FormSection
        step={3}
        title="Logística"
        description="Valor da logística definido exclusivamente na Base de dados."
      >
        <FormGrid>
          <SelectField
            label="Local de atendimento"
            cols={8}
            value={d.logisticsId ?? ''}
            onChange={(e) => update({ logisticsId: e.target.value || null })}
            hint={
              route
                ? `${qtyText(route.km ?? 0, 2)} km (ida e volta)`
                : 'Sem deslocamento cadastrado'
            }
          >
            <option value="">Sem logística</option>
            {routes.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name} — {qtyText(r.km ?? 0, 2)} km ida e volta
              </option>
            ))}
          </SelectField>
          <TextField
            label="Valor"
            cols={4}
            readOnly
            placeholder="A preencher"
            value={
              route
                ? route.priceCents === null
                  ? 'Não cadastrado'
                  : formatCents(route.priceCents)
                : ''
            }
          />
        </FormGrid>
      </FormSection>

      <FormSection step={4} title="Mão de obra e precificação">
        <FormGrid>
          <SelectField
            label="Serviço do tapeceiro"
            cols={8}
            value={d.upholsteryServiceId ?? ''}
            onChange={(e) => update({ upholsteryServiceId: e.target.value || null })}
          >
            <option value="">Selecione um serviço</option>
            {upholstery.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name} — {x.priceCents === null ? 'Sem preço' : formatCents(x.priceCents)}
              </option>
            ))}
          </SelectField>
          <TextField
            label="Quantidade de sofás"
            type="number"
            min={1}
            step={1}
            cols={4}
            value={String(d.sofaCount)}
            onChange={(e) => {
              const v = Math.floor(Number(e.target.value));
              update({ sofaCount: Number.isFinite(v) && v >= 1 ? v : 1 });
            }}
            hint="Multiplica a mão de obra do tapeceiro e do ajudante."
          />
          <TextField
            label="Custo do tapeceiro"
            cols={4}
            readOnly
            placeholder="Selecione o serviço"
            value={
              ups ? (ups.priceCents === null ? 'Não cadastrado' : formatCents(ups.priceCents)) : ''
            }
            hint="Valor definido na Base de dados."
          />
          <SelectField
            label="Serviço do ajudante"
            cols={4}
            disabled
            value={d.helperServiceId ?? ''}
            onChange={() => undefined}
          >
            <option value="">Sem ajudante</option>
            {helpers.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name} —{' '}
                {x.priceCents === null ? 'Preço não cadastrado' : formatCents(x.priceCents)}
              </option>
            ))}
          </SelectField>
          <TextField
            label="Custo do ajudante"
            cols={4}
            readOnly
            placeholder="Selecione o serviço"
            value={
              help
                ? help.priceCents === null
                  ? 'Não cadastrado'
                  : formatCents(help.priceCents)
                : ''
            }
            hint={helperNote}
          />
          <MoneyField
            label="Lucro bruto desejado"
            cols={4}
            placeholder="Informe o lucro em reais"
            cents={d.profitCents || null}
            onCents={(v) => update({ profitCents: v ?? 0 })}
          />
          <TextField
            label="Alíquota do serviço / imposto"
            cols={4}
            readOnly
            placeholder="Cadastre na Base de dados"
            value={settings.taxRateBps === null ? '' : pct(settings.taxRateBps / 100)}
            hint="Definida na Base de dados."
          />
          <TextField
            label="Lucro bruto sobre custos (automático)"
            cols={4}
            readOnly
            value={t.profitPct === null ? '—' : pct(t.profitPct)}
          />
        </FormGrid>
        <p className="mt-4 text-sm text-ink-muted">
          O lucro desejado é somado aos custos. O imposto é calculado sobre o preço de venda, com a
          alíquota embutida para preservar o valor líquido previsto. O parcelamento utiliza o valor
          à vista já com imposto.
        </p>

        <div className="mt-5 rounded-xl bg-subtle/70 p-4 ring-1 ring-line ring-inset sm:p-5">
          <dl className="divide-y divide-line">
            <SummaryRow label="Materiais" value={brl(t.materials)} />
            <SummaryRow label="Logística" value={brl(t.logistics)} />
            <SummaryRow label="Tapeceiro" value={brl(t.upholstery)} />
            <SummaryRow label="Ajudante" value={brl(t.helper)} />
            <SummaryRow label="Mão de obra total" value={brl(t.labor)} />
            <SummaryRow label="Custo total" value={brl(t.cost)} strong />
            <SummaryRow label="Lucro bruto desejado" value={brl(t.profit)} />
            <SummaryRow label="Alíquota do serviço" value={pct(t.taxPct)} />
            <SummaryRow
              label="Imposto estimado sobre o valor à vista"
              value={t.tax === null ? 'Alíquota inválida' : brl(t.tax)}
            />
          </dl>
          <div className="mt-3 flex flex-wrap items-baseline justify-between gap-2 border-t border-line-strong pt-3">
            <span className="font-semibold">Valor à vista (com imposto)</span>
            <span className="money text-2xl font-semibold text-brand-700" data-testid="quote-total">
              {t.total === null ? 'Alíquota inválida' : brl(t.total)}
            </span>
          </div>

          <h3 className="mt-5 font-semibold">Preço parcelado</h3>
          <FormGrid className="mt-3">
            <SelectField
              label="Forma de pagamento"
              cols={8}
              value={d.feeId ?? ''}
              onChange={(e) => update({ feeId: e.target.value || null })}
            >
              <option value="">Selecione a forma de pagamento</option>
              {fees.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                </option>
              ))}
            </SelectField>
            <TextField
              label="Taxa aplicada"
              cols={4}
              readOnly
              value={t.feePct === null ? '—' : pct(t.feePct)}
            />
          </FormGrid>
          <dl className="mt-2 divide-y divide-line">
            <SummaryRow
              label="Valor com taxa da máquina"
              strong
              value={
                !d.feeId
                  ? 'Selecione a forma de pagamento'
                  : t.installmentTotal === null
                    ? 'Taxa inválida'
                    : brl(t.installmentTotal)
              }
            />
            {installments > 1 && t.installmentTotal !== null && (
              <SummaryRow
                label="Valor de cada parcela"
                value={`${installments}x de ${brl(t.installmentTotal / installments)}`}
              />
            )}
          </dl>
          <p className="mt-2 text-xs text-ink-muted">
            A taxa é embutida para preservar o valor líquido da venda: preço parcelado = valor à
            vista ÷ (1 − taxa). Taxas de 100% ou mais são inválidas.
          </p>
          {alert && (
            <Alert tone="warn" className="mt-3">
              {alert}
            </Alert>
          )}
        </div>
      </FormSection>

      <FormSection step={5} title="Condições comerciais">
        <FormGrid>
          <SelectField
            label="Prazo de entrega do serviço"
            cols={6}
            value={d.deliveryDays ?? ''}
            onChange={(e) =>
              update({ deliveryDays: e.target.value ? Number(e.target.value) : null })
            }
          >
            <option value="">Selecione o prazo</option>
            {QUOTE_DELIVERY_DAYS.map((n) => (
              <option key={n} value={n}>
                {n} dias úteis
              </option>
            ))}
          </SelectField>
          <TextField
            label="Validade da proposta (dias)"
            type="number"
            min={0}
            cols={6}
            value={d.validityDays ?? ''}
            onChange={(e) =>
              update({
                validityDays: e.target.value === '' ? null : Math.floor(numOr(e.target.value)),
              })
            }
          />
          <TextAreaField
            label="Condições de pagamento"
            cols={12}
            rows={3}
            value={d.paymentTerms}
            onChange={(e) => update({ paymentTerms: e.target.value })}
          />
          <TextAreaField
            label="Observações"
            cols={12}
            rows={6}
            value={d.notes}
            onChange={(e) => update({ notes: e.target.value })}
          />
        </FormGrid>
        {saveError && (
          <Alert tone="danger" className="mt-4">
            {saveError}
          </Alert>
        )}
        <FormActions className="mt-5">
          <Button
            variant="secondary"
            onClick={onSave}
            loading={saving}
            icon={<Save className="size-4" aria-hidden />}
          >
            {api.editing ? 'Salvar alterações' : 'Salvar orçamento'}
          </Button>
          <Button onClick={onPreview} icon={<Eye className="size-4" aria-hidden />}>
            Visualizar proposta comercial
          </Button>
        </FormActions>
        {!api.editing && (
          <div className="mt-6 border-t border-line pt-4">
            <Button
              variant="ghost"
              size="sm"
              onClick={onClear}
              icon={<X className="size-4" aria-hidden />}
            >
              Limpar orçamento
            </Button>
          </div>
        )}
      </FormSection>
    </div>
  );
}

/** Cidade com busca nos municípios do Brasil inteiro (teclado: setas, Enter e Esc). */
function CityField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const listId = useId();
  const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const found = useMemo(() => {
    const q = norm(value.trim());
    return q.length < 2 ? [] : BR_CITIES.filter((c) => norm(c).includes(q)).slice(0, 30);
  }, [value]);
  const choose = (c: string) => {
    onChange(c);
    setOpen(false);
    setActive(-1);
  };
  return (
    <Field
      label="Cidade"
      className={span(6)}
      hint="Todos os municípios do Brasil. Digite parte do nome para buscar."
    >
      {(p) => (
        <div className="relative">
          <Input
            {...p}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={open}
            aria-controls={listId}
            autoComplete="off"
            placeholder="Digite para buscar a cidade"
            value={value}
            onFocus={() => setOpen(true)}
            onBlur={() => setTimeout(() => setOpen(false), 120)}
            onChange={(e) => {
              onChange(e.target.value);
              setOpen(true);
              setActive(-1);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Escape') return setOpen(false);
              if (!open || !found.length) return;
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                setActive((a) =>
                  e.key === 'ArrowDown'
                    ? (a + 1) % found.length
                    : (a - 1 + found.length) % found.length,
                );
              } else if (e.key === 'Enter' && active >= 0) {
                e.preventDefault();
                choose(found[active]!);
              }
            }}
          />
          {open && value.trim().length >= 2 && (
            <div
              id={listId}
              role="listbox"
              className="absolute inset-x-0 top-full z-20 mt-1 max-h-64 overflow-y-auto rounded-xl border border-line bg-surface p-1 shadow-[var(--shadow-pop)]"
            >
              {found.length === 0 ? (
                <p className="px-3 py-2 text-sm text-ink-muted">Nenhuma cidade encontrada</p>
              ) : (
                found.map((c, i) => (
                  <button
                    key={c}
                    type="button"
                    role="option"
                    aria-selected={i === active}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => choose(c)}
                    className={clsx(
                      'block w-full rounded-lg px-3 py-2 text-left text-sm hover:bg-subtle',
                      i === active && 'bg-brand-50 text-brand-700',
                    )}
                  >
                    {c}
                  </button>
                ))
              )}
            </div>
          )}
        </div>
      )}
    </Field>
  );
}

function MaterialsSection({ api, catalog }: { api: DraftApi; catalog: QuoteCatalogItemDto[] }) {
  const { draft: d, update } = api;
  const cats = QUOTE_MATERIAL_CATEGORIES.filter((c) => quoteCategoryEnabled(c, d));
  const [cat, setCat] = useState<QuoteMaterialCategory>('Insumos');
  const current: QuoteMaterialCategory = cats.includes(cat) ? cat : (cats[0] ?? 'Insumos');
  // Ao ligar uma troca, abre a categoria correspondente.
  useEffect(() => {
    if (d.fabricChange) setCat('Tecidos');
  }, [d.fabricChange]);
  useEffect(() => {
    if (d.foamChange) setCat(d.fabricChange ? 'Tecidos' : 'Espumas');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.foamChange]);

  const materials = catalog.filter((c) => c.kind === 'MATERIAL');
  const byId = new Map(catalog.map((c) => [c.id, c]));
  const visibleItems = d.items.filter((i) => {
    const m = byId.get(i.catalogItemId);
    return !m || quoteCategoryEnabled(m.category, d);
  });
  const add = (item: Omit<QuoteDraft['items'][number], 'id'>) =>
    update((x) => ({ items: [...x.items, { ...item, id: crypto.randomUUID() }] }));

  return (
    <FormSection
      step={2}
      title="Materiais utilizados"
      description="Abra uma categoria para selecionar os materiais. Tecidos e espumas aparecem quando a troca está marcada como Sim."
    >
      <Segmented
        label="Categoria de material"
        options={cats.map((c) => [c, c] as const)}
        value={current}
        onChange={setCat}
      />
      <div className="mt-4">
        {current === 'Madeiramento' ? (
          <WoodPicker
            materials={materials.filter((m) => m.category === 'Madeiramento')}
            onAdd={add}
          />
        ) : (
          <MaterialPicker
            key={current}
            materials={materials.filter((m) => m.category === current)}
            onAdd={add}
          />
        )}
      </div>

      {visibleItems.length > 0 && (
        <div className="mt-6">
          <h3 className="mb-2 font-semibold">Materiais adicionados</h3>
          <ul className="divide-y divide-line rounded-xl border border-line">
            {visibleItems.map((i) => {
              const m = byId.get(i.catalogItemId);
              const v = quoteItemCost(i, m);
              const foam = m?.category === 'Espumas';
              return (
                <li key={i.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="font-medium">{m?.name ?? 'Material excluído'}</p>
                    <p className="text-sm text-ink-muted">
                      {qtyText(i.qty)}{' '}
                      {foam
                        ? `${pluralWord(i.qty, 'peça', 'peças')} — ${qtyText(i.heightCm)} × ${qtyText(i.widthCm)} × ${qtyText(i.lengthCm)} cm • ${qtyText(foamVolumeM3(i.heightCm, i.widthCm, i.lengthCm, i.qty), 6)} m³`
                        : (m?.unit ?? 'un')}
                    </p>
                  </div>
                  <span
                    className={clsx('money text-sm font-semibold', v === null && 'text-warn-600')}
                  >
                    {v === null ? 'Preço pendente' : brl(v)}
                  </span>
                  <Button
                    size="sm"
                    variant="outline-danger"
                    aria-label={`Excluir ${m?.name ?? 'material'}`}
                    icon={<Trash2 className="size-4" aria-hidden />}
                    onClick={() => update((x) => ({ items: x.items.filter((y) => y.id !== i.id) }))}
                  >
                    Excluir
                  </Button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </FormSection>
  );
}

function MaterialPicker({
  materials,
  onAdd,
}: {
  materials: QuoteCatalogItemDto[];
  onAdd: (i: Omit<QuoteDraft['items'][number], 'id'>) => void;
}) {
  const [id, setId] = useState(materials[0]?.id ?? '');
  const [qty, setQty] = useState('1');
  const [dims, setDims] = useState({ h: '', w: '', l: '' });
  const [error, setError] = useState<string | null>(null);
  const m = materials.find((x) => x.id === id);
  const foam = m?.category === 'Espumas';
  const h = numOr(dims.h);
  const w = numOr(dims.w);
  const l = numOr(dims.l);
  const q = numOr(qty);
  const vol1 = foamVolumeM3(h, w, l);
  const volT = foamVolumeM3(h, w, l, q);
  return (
    <div className="space-y-4">
      <FormGrid>
        <SelectField
          label="Material"
          cols={6}
          value={id}
          onChange={(e) => {
            setId(e.target.value);
            setError(null);
          }}
        >
          {materials.length === 0 && <option value="">Nenhum material cadastrado</option>}
          {materials.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </SelectField>
        <TextField
          label={foam ? 'Quantidade de peças' : `Quantidade (${m?.unit ?? 'un'})`}
          type="number"
          min={0}
          step="any"
          cols={3}
          value={qty}
          onChange={(e) => setQty(e.target.value)}
        />
        <TextField
          label="Preço unitário cadastrado"
          cols={3}
          readOnly
          value={
            m
              ? m.priceCents === null
                ? 'Não cadastrado'
                : `${formatCents(m.priceCents)} / ${m.unit}`
              : ''
          }
        />
      </FormGrid>
      {foam && (
        <div className="rounded-xl border border-line p-4">
          <h3 className="mb-3 text-sm font-semibold">Dimensões da espuma (cm)</h3>
          <FormGrid>
            {(
              [
                ['h', 'Altura'],
                ['w', 'Largura'],
                ['l', 'Comprimento'],
              ] as const
            ).map(([k, label]) => (
              <TextField
                key={k}
                label={label}
                type="number"
                min={0}
                step="any"
                cols={4}
                value={dims[k]}
                onChange={(e) => setDims({ ...dims, [k]: e.target.value })}
              />
            ))}
          </FormGrid>
          <p className="mt-2 text-sm text-ink-muted">Volume por peça: {qtyText(vol1, 6)} m³</p>
          <dl className="mt-2 divide-y divide-line rounded-lg bg-subtle/70 px-4">
            <SummaryRow label="Volume total" value={`${qtyText(volT, 6)} m³`} />
            <SummaryRow
              label="Preço da espuma por m³"
              value={
                (m?.priceCents ?? null) === null
                  ? 'Preço pendente'
                  : `${formatCents(m.priceCents)}/m³`
              }
            />
            <SummaryRow
              label="Custo calculado da espuma"
              strong
              value={
                (m?.priceCents ?? null) === null
                  ? 'Preço pendente'
                  : brl((volT * (m?.priceCents ?? 0)) / 100)
              }
            />
          </dl>
        </div>
      )}
      {m?.priceCents === null && (
        <p className="text-sm text-warn-600">
          Material sem preço: preencha na Base de dados antes de finalizar.
        </p>
      )}
      {error && <Alert tone="danger">{error}</Alert>}
      <Button
        icon={<Plus className="size-4" aria-hidden />}
        disabled={!m}
        onClick={() => {
          if (!m || q <= 0)
            return setError('Selecione um material e informe uma quantidade válida.');
          if (foam && (h <= 0 || w <= 0 || l <= 0))
            return setError('Informe as três dimensões da espuma.');
          onAdd({
            catalogItemId: m.id,
            qty: q,
            heightCm: foam ? h : 0,
            widthCm: foam ? w : 0,
            lengthCm: foam ? l : 0,
          });
          setQty('1');
          setDims({ h: '', w: '', l: '' });
          setError(null);
        }}
      >
        Adicionar material
      </Button>
    </div>
  );
}

/** Madeiramento: escolher Sim só para o que será usado (itens em Não não entram no cálculo). */
function WoodPicker({
  materials,
  onAdd,
}: {
  materials: QuoteCatalogItemDto[];
  onAdd: (i: Omit<QuoteDraft['items'][number], 'id'>) => void;
}) {
  return (
    <div>
      <p className="mb-3 text-sm text-ink-muted">
        Escolha Sim apenas para os materiais de madeira que serão utilizados. Itens marcados como
        Não não entram no cálculo.
      </p>
      {materials.length === 0 && (
        <p className="text-sm text-ink-muted">Nenhum madeiramento cadastrado na Base de dados.</p>
      )}
      <div className="divide-y divide-line rounded-xl border border-line">
        {materials.map((m) => (
          <WoodRow key={m.id} m={m} onAdd={onAdd} />
        ))}
      </div>
    </div>
  );
}

function WoodRow({
  m,
  onAdd,
}: {
  m: QuoteCatalogItemDto;
  onAdd: (i: Omit<QuoteDraft['items'][number], 'id'>) => void;
}) {
  const [use, setUse] = useState(false);
  const [qty, setQty] = useState('1');
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="px-4 py-3">
      <FormGrid>
        <div className={clsx(span(4), 'flex flex-col justify-end')}>
          <p className="font-medium">{m.name}</p>
          <p className="text-xs text-ink-muted">
            {m.priceCents === null
              ? 'Preço não cadastrado'
              : `${formatCents(m.priceCents)} / ${m.unit}`}
          </p>
        </div>
        <SelectField
          label="Utilizar?"
          cols={3}
          value={use ? 'sim' : 'nao'}
          onChange={(e) => setUse(e.target.value === 'sim')}
        >
          <option value="nao">Não</option>
          <option value="sim">Sim</option>
        </SelectField>
        {use && (
          <>
            <TextField
              label={`Quantidade (${m.unit ?? 'un'})`}
              type="number"
              min={0}
              step="any"
              cols={3}
              value={qty}
              onChange={(e) => setQty(e.target.value)}
              error={error ?? undefined}
            />
            <FieldAction cols={2}>
              <Button
                className="w-full"
                onClick={() => {
                  const q = numOr(qty);
                  if (q <= 0) return setError('Informe uma quantidade válida.');
                  onAdd({ catalogItemId: m.id, qty: q, heightCm: 0, widthCm: 0, lengthCm: 0 });
                  setUse(false);
                  setQty('1');
                  setError(null);
                }}
              >
                Adicionar
              </Button>
            </FieldAction>
          </>
        )}
      </FormGrid>
    </div>
  );
}
