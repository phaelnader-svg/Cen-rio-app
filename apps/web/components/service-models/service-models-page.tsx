'use client';

import {
  PIECE_TYPES,
  PIECE_TYPE_LABEL,
  SERVICE_TYPES,
  SERVICE_TYPE_LABEL,
  type PieceType,
  type ServiceModelMaterialDto,
  type ServiceType,
} from '@cenario/shared';
import { Archive, Check, Pencil, Plus, X } from 'lucide-react';
import { useState } from 'react';
import { Section } from '@/components/commercial/section';
import { ProductionTemplatesPanel } from '@/components/production/templates-page';
import { QualityChecklistsPanel } from '@/components/quality/quality-pages';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/field';
import { Alert, Badge, EmptyState, PageHeader, Spinner } from '@/components/ui/misc';
import { Tabs } from '@/components/ui/tabs';
import { useCan } from '@/lib/hooks';
import {
  SERVICE_MODELS_KEY,
  useModelMaterials,
  useServiceModel,
  useServiceModelsOverview,
} from '@/lib/service-models';
import { useAction } from '@/lib/simple-materials';
import { useTabParam } from '@/lib/tab-param';

/**
 * Reformulação, Fase 2 — "Modelos de serviço": num só lugar, por tipo de peça × tipo de serviço,
 * as etapas de produção, o checklist de qualidade e a lista padrão de materiais.
 *
 * Nada é duplicado: as abas "Etapas" e "Checklists" são os MESMOS editores de antes (que
 * continuam também em seus lugares originais), e a visão por serviço mostra o efeito combinado
 * pelas mesmas regras do planejamento e da inspeção. Cada parte só aparece para quem já podia vê-la.
 */
const TABS = ['servico', 'etapas', 'checklists', 'materiais'] as const;

export function ServiceModelsPage() {
  const can = useCan();
  const show = {
    servico: true,
    etapas: can('producao.ver') || can('producao.planejar'),
    checklists: can('qualidade.gerenciar'),
    materiais: can('producao.planejar') || can('os.gerenciar') || can('qualidade.gerenciar'),
  };
  const allowed = TABS.filter((t) => show[t]);
  const [tab, setTab] = useTabParam('servico', allowed);
  const [pieceType, setPieceType] = useState<PieceType>('SOFA');
  const [focus, setFocus] = useState<string | null>(null);
  const go = (t: (typeof TABS)[number], id: string | null = null) => {
    setFocus(id);
    setTab(t);
  };
  return (
    <>
      <PageHeader
        title="Modelos de serviço"
        description="Para cada tipo de peça e de serviço: as etapas de produção, o checklist de qualidade e os materiais que costumam ser usados. Os modelos só sugerem — em cada OS o gestor revisa e altera."
      />
      <Tabs
        tabs={[
          { key: 'servico', label: 'Por serviço' },
          ...(show.etapas ? [{ key: 'etapas', label: 'Etapas de produção' }] : []),
          ...(show.checklists ? [{ key: 'checklists', label: 'Checklists de qualidade' }] : []),
          ...(show.materiais ? [{ key: 'materiais', label: 'Materiais padrão' }] : []),
        ]}
        active={tab}
        onChange={(k) => go(k as (typeof TABS)[number])}
      >
        {tab === 'servico' && (
          <ByService pieceType={pieceType} onPieceType={setPieceType} onGo={go} />
        )}
        {tab === 'etapas' && <ProductionTemplatesPanel focusId={focus} />}
        {tab === 'checklists' && <QualityChecklistsPanel focusId={focus} />}
        {tab === 'materiais' && (
          <DefaultMaterials pieceType={pieceType} onPieceType={setPieceType} />
        )}
      </Tabs>
    </>
  );
}

function PieceTypeSelect({
  value,
  onChange,
}: {
  value: PieceType;
  onChange: (p: PieceType) => void;
}) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="text-ink-muted">Tipo de peça</span>
      <Select
        aria-label="Tipo de peça"
        className="w-48"
        value={value}
        onChange={(e) => onChange(e.target.value as PieceType)}
      >
        {PIECE_TYPES.map((p) => (
          <option key={p} value={p}>
            {PIECE_TYPE_LABEL[p]}
          </option>
        ))}
      </Select>
    </label>
  );
}

// ─────────────────────────── Por serviço ───────────────────────────

function ByService({
  pieceType,
  onPieceType,
  onGo,
}: {
  pieceType: PieceType;
  onPieceType: (p: PieceType) => void;
  onGo: (tab: (typeof TABS)[number], id?: string | null) => void;
}) {
  const ov = useServiceModelsOverview();
  const [service, setService] = useState<ServiceType | null>(null);
  if (ov.isPending) return <Spinner />;
  if (ov.isError) return <Alert tone="danger">{ov.error.message}</Alert>;
  const rows = ov.data.rows.filter((r) => r.pieceType === pieceType);
  const c = ov.data.can;
  return (
    <div className="space-y-4" data-testid="service-models-overview">
      <PieceTypeSelect
        value={pieceType}
        onChange={(p) => {
          onPieceType(p);
          setService(null);
        }}
      />
      <div className="overflow-x-auto rounded-xl border border-line">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-ink-muted">
            <tr className="border-b border-line">
              <th className="px-4 py-2 font-medium">Serviço</th>
              {c.production && <th className="px-3 py-2 font-medium">Etapas de produção</th>}
              {c.quality && <th className="px-3 py-2 font-medium">Checklist de qualidade</th>}
              <th className="px-3 py-2 font-medium">Materiais padrão</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.serviceType}
                className={`cursor-pointer border-b border-line last:border-0 hover:bg-subtle ${service === r.serviceType ? 'bg-brand-50' : ''}`}
                onClick={() => setService(r.serviceType)}
                data-testid={`service-model-row-${r.serviceType}`}
              >
                <td className="px-4 py-2.5">
                  <button
                    type="button"
                    className="font-medium text-brand-700 hover:underline"
                    onClick={() => setService(r.serviceType)}
                  >
                    {SERVICE_TYPE_LABEL[r.serviceType]}
                  </button>
                </td>
                {c.production && (
                  <td className="px-3 py-2.5">
                    {r.productionTemplate ? (
                      <>
                        {r.productionTemplate.name}{' '}
                        {r.productionTemplate.general && <Badge tone="neutral">geral</Badge>}
                      </>
                    ) : (
                      <Badge tone="warn">sem modelo</Badge>
                    )}
                  </td>
                )}
                {c.quality && (
                  <td className="px-3 py-2.5">
                    {r.qualityTemplate ? (
                      `${r.qualityTemplate.name} · ${r.qualityTemplate.items} item(ns)`
                    ) : (
                      <Badge tone="neutral">checklist mínimo</Badge>
                    )}
                  </td>
                )}
                <td className="px-3 py-2.5">
                  {r.materials ? (
                    `${r.materials} material(is)`
                  ) : (
                    <span className="text-ink-muted">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {service && <ServiceDetail pieceType={pieceType} serviceType={service} onGo={onGo} />}
    </div>
  );
}

function ServiceDetail({
  pieceType,
  serviceType,
  onGo,
}: {
  pieceType: PieceType;
  serviceType: ServiceType;
  onGo: (tab: (typeof TABS)[number], id?: string | null) => void;
}) {
  const q = useServiceModel(pieceType, serviceType);
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{q.error.message}</Alert>;
  const d = q.data;
  return (
    <div className="grid gap-4 lg:grid-cols-3" data-testid="service-model-detail">
      {d.production && (
        <Section
          title="Etapas de produção"
          actions={
            <Button
              size="sm"
              variant="secondary"
              onClick={() => onGo('etapas', d.production!.template?.id ?? null)}
            >
              {d.production.template ? 'Abrir modelo' : 'Criar modelo'}
            </Button>
          }
        >
          {d.production.template ? (
            <>
              <p className="mb-2 text-sm text-ink-muted">
                {d.production.template.name}
                {d.production.template.general && ' (modelo geral — vale para os demais serviços)'}
              </p>
              <ol className="list-decimal space-y-1 pl-5 text-sm">
                {d.production.steps.map((s) => (
                  <li key={s.position}>
                    {s.name}
                    {s.optional && <span className="text-ink-muted"> (opcional)</span>}
                  </li>
                ))}
              </ol>
            </>
          ) : (
            <p className="text-sm text-ink-muted">
              Nenhum modelo de etapas para esta peça e serviço: as etapas são montadas à mão no
              planejamento.
            </p>
          )}
        </Section>
      )}
      {d.quality && (
        <Section
          title="Checklist de qualidade"
          actions={
            <Button
              size="sm"
              variant="secondary"
              onClick={() => onGo('checklists', d.quality!.template?.id ?? null)}
            >
              {d.quality.template ? 'Abrir checklist' : 'Criar checklist'}
            </Button>
          }
        >
          <p className="mb-2 text-sm text-ink-muted">
            {d.quality.template
              ? `${d.quality.template.name} — só os itens deste serviço`
              : 'Sem checklist para esta peça: a inspeção usa o checklist mínimo.'}
          </p>
          <ol className="list-decimal space-y-1 pl-5 text-sm">
            {d.quality.items.map((i, n) => (
              <li key={n}>
                {i.label}
                {!i.required && <span className="text-ink-muted"> (opcional)</span>}
              </li>
            ))}
          </ol>
        </Section>
      )}
      <Section
        title="Materiais padrão"
        actions={
          <Button size="sm" variant="secondary" onClick={() => onGo('materiais')}>
            Editar materiais
          </Button>
        }
      >
        {d.materials.length ? (
          <ul className="space-y-1 text-sm">
            {d.materials.map((m) => (
              <li key={m.id}>
                {m.description}
                {m.quantity !== null && (
                  <span className="text-ink-muted">
                    {' '}
                    — {fmtQty(m.quantity)} {m.unit ?? ''} por peça
                  </span>
                )}
                {m.serviceType === null && (
                  <span className="text-ink-muted"> (todos os serviços)</span>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-ink-muted">Nenhum material padrão para esta peça e serviço.</p>
        )}
      </Section>
    </div>
  );
}

const fmtQty = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 3 });
const parseQty = (s: string) => (s.trim() ? Number(s.replace(',', '.')) : null);

// ─────────────────────────── Materiais padrão ───────────────────────────

function DefaultMaterials({
  pieceType,
  onPieceType,
}: {
  pieceType: PieceType;
  onPieceType: (p: PieceType) => void;
}) {
  const can = useCan();
  const manage = can('producao.planejar') || can('os.gerenciar');
  const q = useModelMaterials(pieceType);
  const act = useAction(
    [SERVICE_MODELS_KEY, ['os-material-suggestions']],
    'Materiais padrão salvos.',
  );
  const base = '/api/v1/service-models/materials';
  const groups: (ServiceType | null)[] = [null, ...SERVICE_TYPES];
  return (
    <div className="space-y-4" data-testid="service-model-materials">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <PieceTypeSelect value={pieceType} onChange={onPieceType} />
        <p className="max-w-xl text-sm text-ink-muted">
          Quantidade por peça. Na OS, “Sugerir do modelo” cria linhas sem custo, não compradas e não
          disponíveis — nada é comprado, lançado ou baixado do estoque.
        </p>
      </div>
      {act.error && <Alert tone="danger">{act.error}</Alert>}
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <Alert tone="danger">{q.error.message}</Alert>
      ) : (
        <>
          {q.data.length === 0 && (
            <EmptyState
              title={`Nenhum material padrão para ${PIECE_TYPE_LABEL[pieceType]}`}
              description="Cadastre os materiais que este tipo de peça costuma usar."
            />
          )}
          {groups
            .filter((g) => q.data.some((m) => m.serviceType === g))
            .map((g) => (
              <Section key={g ?? 'todos'} title={g ? SERVICE_TYPE_LABEL[g] : 'Todos os serviços'}>
                <ul className="divide-y divide-line">
                  {q.data
                    .filter((m) => m.serviceType === g)
                    .map((m) => (
                      <MaterialLine
                        key={`${m.id}-${m.version}`}
                        m={m}
                        manage={manage}
                        busy={act.isPending}
                        onSave={(body, done) =>
                          act.mutate(
                            {
                              path: `${base}/${m.id}`,
                              method: 'PATCH',
                              body: { ...body, version: m.version },
                            },
                            { onSuccess: done },
                          )
                        }
                        onArchive={() =>
                          act.mutate({
                            path: `${base}/${m.id}/archive`,
                            body: { version: m.version },
                          })
                        }
                      />
                    ))}
                </ul>
              </Section>
            ))}
          {manage && (
            <AddDefault
              busy={act.isPending}
              onAdd={(body, done) =>
                act.mutate({ path: base, body: { ...body, pieceType } }, { onSuccess: done })
              }
            />
          )}
        </>
      )}
    </div>
  );
}

type DraftDefault = { description: string; quantity: string; unit: string; serviceType: string };
const draftOf = (m?: ServiceModelMaterialDto): DraftDefault => ({
  description: m?.description ?? '',
  quantity:
    m?.quantity === null || m?.quantity === undefined ? '' : String(m.quantity).replace('.', ','),
  unit: m?.unit ?? '',
  serviceType: m?.serviceType ?? '',
});
const bodyOf = (d: DraftDefault) => ({
  description: d.description,
  quantity: parseQty(d.quantity),
  unit: d.unit,
  serviceType: (d.serviceType || null) as ServiceType | null,
});
const draftValid = (d: DraftDefault) => {
  const q = parseQty(d.quantity);
  return d.description.trim().length >= 2 && (q === null || (Number.isFinite(q) && q > 0));
};

function DefaultFields({ d, onChange }: { d: DraftDefault; onChange: (d: DraftDefault) => void }) {
  return (
    <>
      <Input
        aria-label="Material padrão"
        placeholder="Material (ex.: Espuma D33)"
        className="min-w-56 flex-[3_1_14rem]"
        value={d.description}
        onChange={(e) => onChange({ ...d, description: e.target.value })}
      />
      <Input
        aria-label="Quantidade por peça"
        placeholder="Qtd./peça"
        inputMode="decimal"
        className="w-28 flex-none"
        value={d.quantity}
        onChange={(e) => onChange({ ...d, quantity: e.target.value })}
      />
      <Input
        aria-label="Unidade"
        placeholder="Unid."
        className="w-24 flex-none"
        value={d.unit}
        onChange={(e) => onChange({ ...d, unit: e.target.value })}
      />
      <Select
        aria-label="Serviço"
        className="w-52 flex-none"
        value={d.serviceType}
        onChange={(e) => onChange({ ...d, serviceType: e.target.value })}
      >
        <option value="">Todos os serviços</option>
        {SERVICE_TYPES.map((s) => (
          <option key={s} value={s}>
            {SERVICE_TYPE_LABEL[s]}
          </option>
        ))}
      </Select>
    </>
  );
}

function MaterialLine({
  m,
  manage,
  busy,
  onSave,
  onArchive,
}: {
  m: ServiceModelMaterialDto;
  manage: boolean;
  busy: boolean;
  onSave: (body: Record<string, unknown>, done: () => void) => void;
  onArchive: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [d, setD] = useState(draftOf(m));
  if (editing)
    return (
      <li className="flex flex-wrap items-center gap-2 py-2">
        <DefaultFields d={d} onChange={setD} />
        <Button
          size="sm"
          disabled={busy || !draftValid(d)}
          onClick={() => onSave(bodyOf(d), () => setEditing(false))}
        >
          <Check className="size-4" /> Salvar
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setD(draftOf(m));
            setEditing(false);
          }}
        >
          <X className="size-4" /> Cancelar
        </Button>
      </li>
    );
  return (
    <li
      className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm"
      data-testid="model-material"
    >
      <span>
        <span className="font-medium">{m.description}</span>
        {m.quantity !== null && (
          <span className="text-ink-muted">
            {' '}
            — {fmtQty(m.quantity)} {m.unit ?? ''} por peça
          </span>
        )}
        {m.inventoryItemName && (
          <span className="text-ink-muted"> · estoque: {m.inventoryItemName}</span>
        )}
      </span>
      {manage && (
        <span className="flex gap-1">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setEditing(true)}
            aria-label={`Editar ${m.description}`}
          >
            <Pencil className="size-4" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={onArchive}
            aria-label={`Arquivar ${m.description}`}
          >
            <Archive className="size-4" />
          </Button>
        </span>
      )}
    </li>
  );
}

function AddDefault({
  busy,
  onAdd,
}: {
  busy: boolean;
  onAdd: (body: Record<string, unknown>, done: () => void) => void;
}) {
  const [d, setD] = useState(draftOf());
  return (
    <form
      className="flex flex-wrap items-center gap-2 rounded-xl border border-line px-4 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (draftValid(d)) onAdd(bodyOf(d), () => setD(draftOf()));
      }}
      data-testid="model-material-add"
    >
      <DefaultFields d={d} onChange={setD} />
      <Button type="submit" className="flex-none" disabled={busy || !draftValid(d)}>
        <Plus className="size-4" /> Adicionar
      </Button>
    </form>
  );
}
