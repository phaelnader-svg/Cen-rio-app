'use client';

import { plural } from '@cenario/shared';
import { PRICE_IMPORT_FIELDS, SheetImportButton } from '@/components/improvements/sheet-import';
import {
  QUOTE_UNITS,
  parseMoneyToCents,
  QUOTE_UNIT_LABEL,
  type QuoteBackup,
  type QuoteCatalogItemDto,
  type QuoteCatalogKind,
  type QuoteMaterialCategory,
  type QuoteSettingsDto,
  DEFAULT_PROPOSAL_TEXTS,
} from '@cenario/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Download, ImagePlus, Plus, Save, Trash2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { MoneyInput } from '@/components/commercial/money-input';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Input, Select } from '@/components/ui/field';
import {
  FieldAction,
  FormGrid,
  FormSection,
  MoneyField,
  SelectField,
  TextAreaField,
  TextField,
} from '@/components/ui/form';
import { Alert } from '@/components/ui/misc';
import { Tabs } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage, newIdempotencyKey } from '@/lib/api';
import { pct, shrinkImage } from '@/lib/quotes';

type BaseTab =
  | QuoteMaterialCategory
  | 'LOGISTICA'
  | 'MAO_TAPECEIRO'
  | 'MAO_AJUDANTE'
  | 'TAPECEIRO'
  | 'ALIQUOTA'
  | 'TAXA_MAQUINA';

const TABS: [BaseTab, string][] = [
  ['Tecidos', 'Tecidos'],
  ['Espumas', 'Espumas'],
  ['Insumos', 'Insumos'],
  ['Madeiramento', 'Madeiramento'],
  ['LOGISTICA', 'Logística'],
  ['MAO_TAPECEIRO', 'Mão de obra - Tapeceiro'],
  ['MAO_AJUDANTE', 'Mão de obra - Ajudante'],
  ['TAPECEIRO', 'Cadastro de tapeceiros'],
  ['ALIQUOTA', 'Alíquota do serviço'],
  ['TAXA_MAQUINA', 'Taxas da máquina'],
];

const isMaterialTab = (t: BaseTab): t is QuoteMaterialCategory =>
  t === 'Tecidos' || t === 'Espumas' || t === 'Insumos' || t === 'Madeiramento';

/** Texto "2,5" → pontos-base (250); vazio → null; inválido → NaN. */
const parsePctBps = (s: string) => {
  const t = s.trim().replace(',', '.');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 && n < 100 ? Math.round(n * 100) : NaN;
};
const bpsText = (b: number | null) =>
  b === null ? '' : (b / 100).toLocaleString('pt-BR', { maximumFractionDigits: 2 });

function useCatalogAction(success?: string) {
  const qc = useQueryClient();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: (req: { path: string; method?: 'POST' | 'PATCH'; body?: unknown }) =>
      api<unknown>(req.path, {
        method: req.method ?? 'POST',
        body: req.body ?? {},
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: async () => {
      setError(null);
      if (success) toast('ok', success);
      await qc.invalidateQueries({ queryKey: ['quotes'] });
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return { ...m, error };
}

export function QuoteBase({
  catalog,
  settings,
}: {
  catalog: QuoteCatalogItemDto[];
  settings: QuoteSettingsDto;
}) {
  const [tab, setTab] = useState<BaseTab>('Tecidos');
  return (
    <div className="space-y-6">
      <CompanyCard key={settings.nextNumber} settings={settings} />
      <ProposalTextsCard key={`textos-${settings.version}`} settings={settings} />
      <FormSection
        title="Base de dados"
        description="Alterações de preços passam a valer na hora nos cálculos dos orçamentos. Os orçamentos já salvos guardam os valores da época e não mudam."
        actions={
          <div className="flex flex-wrap gap-2">
            <SheetImportButton
              title="Importar preços de uma planilha"
              description="Materiais com o mesmo nome têm o preço atualizado; os novos entram na base."
              fields={PRICE_IMPORT_FIELDS}
              endpoint="/api/v1/quotes/catalog/import-prices"
              invalidate={['quotes']}
              resultText={(r) =>
                `${plural(r.created, 'material novo', 'materiais novos')} e ${plural(r.updated ?? 0, 'preço atualizado', 'preços atualizados')}.${r.problems.length ? ` ${plural(r.problems.length, 'linha', 'linhas')} com problema.` : ''}`
              }
            />
            <BackupButtons />
          </div>
        }
      >
        <Tabs
          tabs={TABS.map(([key, label]) => ({ key, label }))}
          active={tab}
          onChange={(k) => setTab(k as BaseTab)}
        >
          <div className="pt-5">
            {tab === 'ALIQUOTA' ? (
              <TaxRate settings={settings} />
            ) : tab === 'TAPECEIRO' ? (
              <Upholsterers items={catalog.filter((c) => c.kind === 'TAPECEIRO')} />
            ) : (
              <CatalogTable
                key={tab}
                tab={tab}
                items={catalog.filter((c) =>
                  isMaterialTab(tab) ? c.kind === 'MATERIAL' && c.category === tab : c.kind === tab,
                )}
              />
            )}
          </div>
        </Tabs>
      </FormSection>
    </div>
  );
}

/** Melhoria 141: textos fixos da proposta, do jeito da empresa. Vazio = texto padrão. */
function ProposalTextsCard({ settings }: { settings: QuoteSettingsDto }) {
  const act = useCatalogAction();
  const toast = useToast();
  const [title, setTitle] = useState(settings.proposalTitle ?? '');
  const [intro, setIntro] = useState(settings.proposalIntro ?? '');
  const [thanks, setThanks] = useState(settings.proposalThanks ?? '');
  return (
    <FormSection
      title="Textos da proposta"
      description="O título, a abertura e o agradecimento que o cliente lê. Deixe vazio para usar o texto padrão."
    >
      <FormGrid>
        <TextField
          label="Título"
          placeholder={DEFAULT_PROPOSAL_TEXTS.title}
          maxLength={120}
          cols={12}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <TextAreaField
          label="Abertura"
          placeholder={DEFAULT_PROPOSAL_TEXTS.intro}
          maxLength={400}
          rows={3}
          cols={12}
          value={intro}
          onChange={(e) => setIntro(e.target.value)}
          hint="{nome} vira o primeiro nome do cliente."
        />
        <TextAreaField
          label="Agradecimento"
          placeholder={DEFAULT_PROPOSAL_TEXTS.thanks}
          maxLength={600}
          rows={3}
          cols={12}
          value={thanks}
          onChange={(e) => setThanks(e.target.value)}
        />
        <FieldAction cols={12}>
          <Button
            variant="secondary"
            loading={act.isPending}
            onClick={() =>
              act.mutate(
                {
                  path: '/api/v1/quotes/settings',
                  method: 'PATCH',
                  body: {
                    version: settings.version,
                    proposalTitle: title.trim() || null,
                    proposalIntro: intro.trim() || null,
                    proposalThanks: thanks.trim() || null,
                  },
                },
                {
                  onSuccess: () => toast('ok', 'Textos salvos. Valem para as próximas propostas.'),
                },
              )
            }
          >
            Salvar textos
          </Button>
        </FieldAction>
      </FormGrid>
    </FormSection>
  );
}

function CompanyCard({ settings }: { settings: QuoteSettingsDto }) {
  const act = useCatalogAction();
  const toast = useToast();
  const [name, setName] = useState(settings.companyNameOverride ?? '');
  const [nextText, setNextText] = useState(String(settings.nextNumber));
  const next = /^\d{1,9}$/.test(nextText.trim()) ? Number(nextText.trim()) : NaN;
  const [logoNote, setLogoNote] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const patch = (body: Record<string, unknown>, ok: string) =>
    act.mutate(
      {
        path: '/api/v1/quotes/settings',
        method: 'PATCH',
        body: { version: settings.version, ...body },
      },
      { onSuccess: () => toast('ok', ok) },
    );
  return (
    <FormSection
      title="Dados da empresa na proposta"
      description="Nome, logotipo e numeração que aparecem na proposta, no contrato e na OS do orçamento."
    >
      <FormGrid>
        <TextField
          label="Nome da empresa"
          placeholder={settings.companyName}
          maxLength={90}
          cols={8}
          value={name}
          onChange={(e) => setName(e.target.value)}
          hint="Vazio = o nome cadastrado em Empresa."
        />
        <FieldAction cols={4}>
          <Button
            className="w-full"
            variant="secondary"
            loading={act.isPending}
            onClick={() =>
              patch(
                { companyNameOverride: name.trim() || null },
                'Nome da empresa atualizado na proposta.',
              )
            }
          >
            Salvar nome da empresa
          </Button>
        </FieldAction>
      </FormGrid>
      <FormGrid className="mt-4">
        <TextField
          label="Número do próximo orçamento"
          inputMode="numeric"
          cols={8}
          value={nextText}
          onChange={(e) => setNextText(e.target.value.replace(/\D/g, ''))}
          error={Number.isNaN(next) || next < 1 ? 'Informe um número inteiro.' : undefined}
          hint={`O próximo orçamento salvo recebe o nº ${settings.nextNumber}. Os seguintes continuam a partir dele.`}
        />
        <FieldAction cols={4}>
          <Button
            className="w-full"
            variant="secondary"
            loading={act.isPending}
            disabled={Number.isNaN(next) || next < 1 || next === settings.nextNumber}
            onClick={() =>
              patch(
                { nextNumber: next },
                `Numeração ajustada. O próximo orçamento será o nº ${next}.`,
              )
            }
          >
            Salvar numeração
          </Button>
        </FieldAction>
      </FormGrid>
      <div className="mt-5 flex flex-wrap items-center gap-4">
        <div className="grid size-24 place-items-center overflow-hidden rounded-xl border border-dashed border-line-strong bg-subtle">
          {settings.logoDataUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={settings.logoDataUrl}
              alt="Prévia do logotipo"
              className="max-h-full max-w-full object-contain p-1"
            />
          ) : (
            <span className="px-2 text-center text-xs text-ink-muted">
              Nenhum logotipo cadastrado
            </span>
          )}
        </div>
        <div className="space-y-2">
          <p className="text-sm font-medium text-ink-soft">Logotipo da empresa (PNG ou JPEG)</p>
          <div className="flex flex-wrap gap-2">
            <label className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-3 text-sm font-semibold hover:bg-subtle">
              <ImagePlus className="size-4" aria-hidden /> Escolher imagem
              <input
                type="file"
                className="sr-only"
                accept="image/png,image/jpeg,.png,.jpg,.jpeg"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (!f) return;
                  if (!['image/png', 'image/jpeg'].includes(f.type))
                    return setLogoNote('Escolha um arquivo PNG ou JPEG.');
                  if (f.size > 12 * 1024 * 1024)
                    return setLogoNote('Imagem muito grande. Utilize um arquivo de até 12 MB.');
                  try {
                    const data = await shrinkImage(f, 640, 'image/png');
                    setLogoNote(null);
                    patch({ logoDataUrl: data }, 'Logotipo salvo. Ele já aparece na proposta.');
                  } catch {
                    setLogoNote('Não foi possível carregar o logotipo.');
                  }
                }}
              />
            </label>
            {settings.logoDataUrl && (
              <Button size="sm" variant="secondary" onClick={() => setConfirmRemove(true)}>
                Remover logotipo
              </Button>
            )}
          </div>
          <p className="text-xs text-ink-muted">
            Recomendamos uma imagem quadrada ou com fundo transparente.
          </p>
        </div>
      </div>
      {(logoNote || act.error) && (
        <Alert tone="danger" className="mt-4">
          {logoNote ?? act.error}
        </Alert>
      )}
      <Dialog
        open={confirmRemove}
        onClose={() => setConfirmRemove(false)}
        title="Remover o logotipo da empresa?"
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmRemove(false)}>
              Cancelar
            </Button>
            <Button
              variant="danger"
              onClick={() => {
                setConfirmRemove(false);
                patch({ logoDataUrl: null }, 'Logotipo removido.');
              }}
            >
              Remover
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-soft">
          As propostas já salvas continuam com o logotipo da época.
        </p>
      </Dialog>
    </FormSection>
  );
}

function TaxRate({ settings }: { settings: QuoteSettingsDto }) {
  const act = useCatalogAction('Alíquota atualizada na Base de dados.');
  const [text, setText] = useState(bpsText(settings.taxRateBps));
  const bps = parsePctBps(text);
  return (
    <div className="max-w-xl">
      <FormGrid>
        <TextField
          label="Imposto sobre serviços (%)"
          inputMode="decimal"
          placeholder="Informe o percentual"
          cols={8}
          value={text}
          onChange={(e) => setText(e.target.value)}
          error={Number.isNaN(bps) ? 'Informe uma alíquota entre 0 e 99,99%.' : undefined}
          hint={
            settings.taxRateBps === null
              ? 'Ainda não cadastrada: o total do orçamento fica provisório.'
              : `Atual: ${pct(settings.taxRateBps / 100)}`
          }
        />
        <FieldAction cols={4}>
          <Button
            className="w-full"
            loading={act.isPending}
            disabled={Number.isNaN(bps)}
            onClick={() =>
              act.mutate({
                path: '/api/v1/quotes/settings',
                method: 'PATCH',
                body: { version: settings.version, taxRateBps: bps },
              })
            }
          >
            Salvar alíquota
          </Button>
        </FieldAction>
      </FormGrid>
      {act.error && (
        <Alert tone="danger" className="mt-3">
          {act.error}
        </Alert>
      )}
    </div>
  );
}

function CatalogTable({
  tab,
  items,
}: {
  tab: Exclude<BaseTab, 'ALIQUOTA' | 'TAPECEIRO'>;
  items: QuoteCatalogItemDto[];
}) {
  const material = isMaterialTab(tab);
  const log = tab === 'LOGISTICA';
  const fee = tab === 'TAXA_MAQUINA';
  const kind: QuoteCatalogKind = material ? 'MATERIAL' : tab;
  const [removing, setRemoving] = useState<QuoteCatalogItemDto | null>(null);
  const del = useCatalogAction('Cadastro excluído.');
  const nameLabel = log ? 'Cidade' : fee ? 'Nome / modalidade' : material ? 'Material' : 'Serviço';
  return (
    <div className="space-y-6">
      {tab === 'MAO_AJUDANTE' && (
        <p className="text-sm text-ink-muted">
          Cada serviço do tapeceiro ganha aqui o serviço do ajudante com o mesmo nome. O preço do
          ajudante é independente.
        </p>
      )}
      <div className="table-wrap rounded-xl border border-line">
        <table className="data-table data-table-compact">
          <thead>
            <tr>
              <th>{nameLabel}</th>
              {log && <th>Km ida e volta</th>}
              <th>
                {fee ? 'Taxa (%)' : log ? 'Valor (R$)' : material ? 'Preço (R$)' : 'Custo (R$)'}
              </th>
              {material && <th>Unidade</th>}
              <th className="actions">
                <span className="sr-only">Ações</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.length === 0 && (
              <tr>
                <td colSpan={5} className="text-ink-muted">
                  Nenhum cadastro nesta categoria.
                </td>
              </tr>
            )}
            {items.map((it) => (
              <CatalogRow
                key={`${it.id}:${it.name}:${it.priceCents}:${it.rateBps}:${it.km}:${it.unit}`}
                it={it}
                log={log}
                fee={fee}
                material={material}
                onDelete={() => setRemoving(it)}
              />
            ))}
          </tbody>
        </table>
      </div>
      <NewCatalogItem
        kind={kind}
        category={material ? tab : null}
        log={log}
        fee={fee}
        nameLabel={nameLabel}
      />
      <Dialog
        open={Boolean(removing)}
        onClose={() => setRemoving(null)}
        title="Excluir este cadastro?"
        description={removing?.name}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setRemoving(null)}>
              Cancelar
            </Button>
            <Button
              variant="danger"
              loading={del.isPending}
              onClick={() =>
                removing &&
                del.mutate(
                  { path: `/api/v1/quotes/catalog/${removing.id}/delete` },
                  { onSuccess: () => setRemoving(null) },
                )
              }
            >
              Excluir
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-soft">
          {removing?.kind === 'MAO_TAPECEIRO'
            ? 'O serviço do ajudante com o mesmo nome também é excluído. '
            : ''}
          Os orçamentos já salvos não mudam.
        </p>
        {del.error && (
          <Alert tone="danger" className="mt-3">
            {del.error}
          </Alert>
        )}
      </Dialog>
    </div>
  );
}

function CatalogRow({
  it,
  log,
  fee,
  material,
  onDelete,
}: {
  it: QuoteCatalogItemDto;
  log: boolean;
  fee: boolean;
  material: boolean;
  onDelete: () => void;
}) {
  const act = useCatalogAction();
  const [name, setName] = useState(it.name);
  const [km, setKm] = useState(it.km === null ? '' : String(it.km));
  const [rate, setRate] = useState(bpsText(it.rateBps));
  const patch = (body: Record<string, unknown>) =>
    act.mutate({ path: `/api/v1/quotes/catalog/${it.id}`, method: 'PATCH', body });
  const rateBps = parsePctBps(rate);
  const linked = it.kind === 'MAO_AJUDANTE' && it.linkedItemId !== null;
  return (
    <tr>
      <td className="min-w-48">
        <Input
          className="input-sm"
          aria-label="Nome"
          value={name}
          readOnly={linked}
          title={linked ? 'O nome acompanha o serviço do tapeceiro.' : undefined}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name.trim() !== it.name && patch({ name: name.trim() })}
        />
        {act.error && <p className="mt-1 text-xs text-danger-600">{act.error}</p>}
      </td>
      {log && (
        <td className="w-32">
          <Input
            className="input-sm"
            aria-label="Km ida e volta"
            type="number"
            min={0}
            step="any"
            value={km}
            onChange={(e) => setKm(e.target.value)}
            onBlur={() => {
              const n = km === '' ? 0 : Math.max(0, Number(km) || 0);
              if (n !== (it.km ?? 0)) patch({ km: n });
            }}
          />
        </td>
      )}
      <td className="w-44">
        {fee ? (
          <Input
            className="input-sm"
            aria-label="Taxa (%)"
            inputMode="decimal"
            placeholder="Preencher"
            aria-invalid={Number.isNaN(rateBps) || undefined}
            value={rate}
            onChange={(e) => setRate(e.target.value)}
            onBlur={() => !Number.isNaN(rateBps) && rateBps !== it.rateBps && patch({ rateBps })}
          />
        ) : (
          <MoneyInput
            className="input-sm"
            aria-label="Preço"
            placeholder="Preencher"
            cents={it.priceCents}
            onCents={() => undefined}
            onBlurCapture={(e) => {
              const raw = (e.target as HTMLInputElement).value;
              const v = parseMoneyToCents(raw);
              if (raw.trim() && v === null) return;
              if (v !== it.priceCents) patch({ priceCents: v });
            }}
          />
        )}
      </td>
      {material && (
        <td className="w-36">
          <Select
            className="input-sm"
            aria-label="Unidade"
            value={it.unit ?? 'un'}
            onChange={(e) => patch({ unit: e.target.value })}
          >
            {QUOTE_UNITS.map((u) => (
              <option key={u} value={u}>
                {u}
              </option>
            ))}
          </Select>
        </td>
      )}
      <td className="actions">
        <Button
          size="sm"
          variant="outline-danger"
          icon={<Trash2 className="size-4" aria-hidden />}
          onClick={onDelete}
        >
          Excluir
        </Button>
      </td>
    </tr>
  );
}

function NewCatalogItem({
  kind,
  category,
  log,
  fee,
  nameLabel,
}: {
  kind: QuoteCatalogKind;
  category: QuoteMaterialCategory | null;
  log: boolean;
  fee: boolean;
  nameLabel: string;
}) {
  const act = useCatalogAction('Cadastro incluído.');
  const empty = { name: '', km: '', price: null as number | null, rate: '', unit: 'un' };
  const [d, setD] = useState(empty);
  const [round, setRound] = useState(0);
  const rateBps = parsePctBps(d.rate);
  const material = kind === 'MATERIAL';
  return (
    <div className="rounded-xl border border-line p-4">
      <h3 className="mb-3 font-semibold">Novo cadastro</h3>
      <FormGrid>
        <TextField
          label={nameLabel}
          placeholder="Nome"
          cols={material || log ? 4 : 6}
          value={d.name}
          onChange={(e) => setD({ ...d, name: e.target.value })}
        />
        {log && (
          <TextField
            label="Distância ida e volta (km)"
            type="number"
            min={0}
            step="any"
            cols={3}
            value={d.km}
            onChange={(e) => setD({ ...d, km: e.target.value })}
          />
        )}
        {fee ? (
          <TextField
            label="Taxa (%)"
            inputMode="decimal"
            placeholder="Informe a taxa (%)"
            cols={3}
            value={d.rate}
            onChange={(e) => setD({ ...d, rate: e.target.value })}
            error={Number.isNaN(rateBps) ? 'A taxa deve ser inferior a 100%.' : undefined}
          />
        ) : (
          <MoneyField
            key={`p:${round}`}
            label="Preço / valor"
            placeholder="Opcional"
            cols={3}
            cents={d.price}
            onCents={(v) => setD((x) => ({ ...x, price: v }))}
          />
        )}
        {material && (
          <SelectField
            label="Unidade"
            cols={3}
            value={d.unit}
            onChange={(e) => setD({ ...d, unit: e.target.value })}
          >
            {QUOTE_UNITS.map((u) => (
              <option key={u} value={u}>
                {QUOTE_UNIT_LABEL[u]}
              </option>
            ))}
          </SelectField>
        )}
        <FieldAction cols={material || log ? 2 : 3}>
          <Button
            className="w-full"
            icon={<Plus className="size-4" aria-hidden />}
            loading={act.isPending}
            disabled={!d.name.trim() || Number.isNaN(rateBps)}
            onClick={() =>
              act.mutate(
                {
                  path: '/api/v1/quotes/catalog',
                  body: {
                    kind,
                    category,
                    name: d.name.trim(),
                    ...(fee ? { rateBps } : { priceCents: d.price }),
                    ...(log ? { km: Math.max(0, Number(d.km) || 0) } : {}),
                    ...(material ? { unit: d.unit } : {}),
                  },
                },
                {
                  onSuccess: () => {
                    setD(empty);
                    setRound((r) => r + 1);
                  },
                },
              )
            }
          >
            Cadastrar
          </Button>
        </FieldAction>
      </FormGrid>
      {act.error && (
        <Alert tone="danger" className="mt-3">
          {act.error}
        </Alert>
      )}
    </div>
  );
}

function Upholsterers({ items }: { items: QuoteCatalogItemDto[] }) {
  const add = useCatalogAction('Tapeceiro cadastrado.');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [removing, setRemoving] = useState<QuoteCatalogItemDto | null>(null);
  const del = useCatalogAction('Tapeceiro excluído do cadastro.');
  return (
    <div className="space-y-5">
      <p className="text-sm text-ink-muted">
        Cadastre os funcionários que poderão ser selecionados na OS do orçamento.
      </p>
      <FormGrid>
        <TextField
          label="Nome do tapeceiro"
          placeholder="Nome completo"
          cols={6}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <TextField
          label="Telefone (opcional)"
          placeholder="Contato"
          cols={3}
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
        <FieldAction cols={3}>
          <Button
            className="w-full"
            icon={<Plus className="size-4" aria-hidden />}
            disabled={!name.trim()}
            loading={add.isPending}
            onClick={() =>
              add.mutate(
                {
                  path: '/api/v1/quotes/catalog',
                  body: { kind: 'TAPECEIRO', name: name.trim(), phone: phone.trim() || null },
                },
                {
                  onSuccess: () => {
                    setName('');
                    setPhone('');
                  },
                },
              )
            }
          >
            Cadastrar tapeceiro
          </Button>
        </FieldAction>
      </FormGrid>
      {add.error && <Alert tone="danger">{add.error}</Alert>}
      {items.length === 0 ? (
        <p className="text-sm text-ink-muted">Nenhum tapeceiro cadastrado.</p>
      ) : (
        <div className="divide-y divide-line rounded-xl border border-line">
          {items.map((t) => (
            <UpholstererRow
              key={`${t.id}:${t.name}:${t.phone}`}
              t={t}
              onDelete={() => setRemoving(t)}
            />
          ))}
        </div>
      )}
      <Dialog
        open={Boolean(removing)}
        onClose={() => setRemoving(null)}
        title="Excluir este tapeceiro do cadastro?"
        description={removing?.name}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setRemoving(null)}>
              Cancelar
            </Button>
            <Button
              variant="danger"
              loading={del.isPending}
              onClick={() =>
                removing &&
                del.mutate(
                  { path: `/api/v1/quotes/catalog/${removing.id}/delete` },
                  { onSuccess: () => setRemoving(null) },
                )
              }
            >
              Excluir
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-soft">As OS já salvas continuam com o nome dele.</p>
      </Dialog>
    </div>
  );
}

function UpholstererRow({ t, onDelete }: { t: QuoteCatalogItemDto; onDelete: () => void }) {
  const act = useCatalogAction('Tapeceiro atualizado.');
  const [name, setName] = useState(t.name);
  const [phone, setPhone] = useState(t.phone ?? '');
  return (
    <div className="px-4 py-3">
      <FormGrid>
        <TextField label="Nome" cols={5} value={name} onChange={(e) => setName(e.target.value)} />
        <TextField
          label="Telefone"
          cols={3}
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
        />
        <FieldAction cols={2}>
          <Button
            className="w-full"
            variant="secondary"
            icon={<Save className="size-4" aria-hidden />}
            loading={act.isPending}
            disabled={!name.trim()}
            onClick={() =>
              act.mutate({
                path: `/api/v1/quotes/catalog/${t.id}`,
                method: 'PATCH',
                body: { name: name.trim(), phone: phone.trim() || null },
              })
            }
          >
            Salvar
          </Button>
        </FieldAction>
        <FieldAction cols={2}>
          <Button
            className="w-full"
            variant="outline-danger"
            icon={<Trash2 className="size-4" aria-hidden />}
            onClick={onDelete}
          >
            Excluir
          </Button>
        </FieldAction>
      </FormGrid>
      {act.error && (
        <Alert tone="danger" className="mt-2">
          {act.error}
        </Alert>
      )}
    </div>
  );
}

/**
 * Converte o backup do modelo antigo em HTML (materiais, rotas, maoObra, maoAjudante, tapeceiros,
 * taxasMaquina, aliquotaServico; valores em reais) para o formato do sistema. Assim a base usada
 * antes no navegador pode ser trazida sem redigitar.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fromLegacyBackup(o: any): QuoteBackup | null {
  if (!o || !Array.isArray(o.materiais) || !Array.isArray(o.rotas)) return null;
  const cents = (v: unknown) =>
    v === null || v === undefined || v === '' || !Number.isFinite(Number(v))
      ? null
      : Math.max(0, Math.round(Number(v) * 100));
  const bps = (v: unknown) => {
    const c = cents(v);
    return c === null || c >= 10000 ? null : c;
  };
  const str = (v: unknown, max: number) =>
    String(v ?? '')
      .trim()
      .slice(0, max);
  const items: QuoteBackup['items'] = [];
  const cats = ['Tecidos', 'Espumas', 'Insumos', 'Madeiramento'];
  for (const m of o.materiais)
    if (cats.includes(m?.cat) && str(m?.nome, 160))
      items.push({
        kind: 'MATERIAL',
        category: m.cat,
        name: str(m.nome, 160),
        priceCents: cents(m.preco),
        unit: (QUOTE_UNITS as readonly string[]).includes(m.un) ? m.un : 'un',
        km: null,
        rateBps: null,
        phone: null,
      });
  for (const r of o.rotas)
    if (str(r?.nome, 160))
      items.push({
        kind: 'LOGISTICA',
        category: null,
        name: str(r.nome, 160),
        priceCents: cents(r.preco),
        unit: null,
        km: Math.max(0, Number(r.km) || 0),
        rateBps: null,
        phone: null,
      });
  const tapIndex = new Map<string, number>();
  for (const t of Array.isArray(o.maoObra) ? o.maoObra : [])
    if (str(t?.nome, 160)) {
      tapIndex.set(String(t.id), items.length);
      items.push({
        kind: 'MAO_TAPECEIRO',
        category: null,
        name: str(t.nome, 160),
        priceCents: cents(t.preco),
        unit: null,
        km: null,
        rateBps: null,
        phone: null,
      });
    }
  for (const a of Array.isArray(o.maoAjudante) ? o.maoAjudante : [])
    if (str(a?.nome, 160)) {
      const byOrigin =
        a.origemTapeceiroId !== null && a.origemTapeceiroId !== undefined
          ? tapIndex.get(String(a.origemTapeceiroId))
          : undefined;
      const byName = [...tapIndex.values()].find(
        (i) =>
          items[i]!.name.toLocaleLowerCase('pt-BR') === str(a.nome, 160).toLocaleLowerCase('pt-BR'),
      );
      items.push({
        kind: 'MAO_AJUDANTE',
        category: null,
        name: str(a.nome, 160),
        priceCents: cents(a.preco),
        unit: null,
        km: null,
        rateBps: null,
        phone: null,
        linkedIndex: byOrigin ?? byName ?? null,
      });
    }
  for (const f of Array.isArray(o.taxasMaquina) ? o.taxasMaquina : [])
    if (str(f?.nome, 160))
      items.push({
        kind: 'TAXA_MAQUINA',
        category: null,
        name: str(f.nome, 160),
        priceCents: null,
        unit: null,
        km: null,
        rateBps: bps(f.preco),
        phone: null,
      });
  for (const t of Array.isArray(o.tapeceiros) ? o.tapeceiros : [])
    if (str(t?.nome, 160))
      items.push({
        kind: 'TAPECEIRO',
        category: null,
        name: str(t.nome, 160),
        priceCents: null,
        unit: null,
        km: null,
        rateBps: null,
        phone: str(t.telefone, 40) || null,
      });
  const aliquota = o.aliquotaServico?.percentual;
  return {
    items,
    ...(aliquota !== undefined ? { taxRateBps: aliquota === null ? null : bps(aliquota) } : {}),
  };
}

function BackupButtons() {
  const qc = useQueryClient();
  const toast = useToast();
  const file = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<QuoteBackup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const imp = useMutation({
    mutationFn: (b: QuoteBackup) =>
      api('/api/v1/quotes/catalog/import', { method: 'POST', body: b }),
    onSuccess: async () => {
      setPending(null);
      toast('ok', 'Base de dados substituída pelo backup.');
      await qc.invalidateQueries({ queryKey: ['quotes'] });
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <>
      <Button
        size="sm"
        variant="secondary"
        icon={<Download className="size-4" aria-hidden />}
        onClick={async () => {
          try {
            const data = await api<QuoteBackup>('/api/v1/quotes/catalog/export');
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = 'cenario_gestao_base_orcamento.json';
            a.click();
            URL.revokeObjectURL(a.href);
          } catch (e) {
            toast('danger', errorMessage(e));
          }
        }}
      >
        Exportar backup
      </Button>
      <Button
        size="sm"
        variant="secondary"
        icon={<Upload className="size-4" aria-hidden />}
        onClick={() => file.current?.click()}
      >
        Importar backup
      </Button>
      <input
        ref={file}
        type="file"
        accept="application/json,.json"
        className="sr-only"
        aria-label="Arquivo de backup"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          setError(null);
          try {
            const obj = JSON.parse(await f.text());
            const b: QuoteBackup | null = Array.isArray(obj?.items) ? obj : fromLegacyBackup(obj);
            if (!b) throw new Error();
            setPending(b);
          } catch {
            toast('danger', 'Arquivo de backup inválido.');
          }
        }}
      />
      <Dialog
        open={Boolean(pending)}
        onClose={() => setPending(null)}
        title="Substituir a base de dados pelo backup?"
        description={pending ? `${pending.items.length} cadastros no arquivo.` : undefined}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setPending(null)}>
              Cancelar
            </Button>
            <Button loading={imp.isPending} onClick={() => pending && imp.mutate(pending)}>
              Substituir
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-soft">
          Todos os materiais, cidades, serviços, taxas e tapeceiros atuais serão trocados pelos do
          arquivo
          {pending?.taxRateBps !== undefined
            ? `, e a alíquota passa a ${pending.taxRateBps === null ? 'não cadastrada' : pct(pending.taxRateBps / 100)}`
            : ''}
          . Os orçamentos já salvos não mudam. Também aceita o backup exportado do modelo antigo em
          HTML.
        </p>
        {error && (
          <Alert tone="danger" className="mt-3">
            {error}
          </Alert>
        )}
      </Dialog>
    </>
  );
}
