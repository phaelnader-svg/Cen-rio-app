'use client';

import type { FabricRollDto, InventoryCategoryDto, InventoryItemDto } from '@cenario/shared';
import { formatCents } from '@cenario/shared';
import { Archive, ArchiveRestore, History, Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { MoneyInput } from '@/components/commercial/money-input';
import { Button } from '@/components/ui/button';
import { Input, Select } from '@/components/ui/field';
import { Alert, Badge, EmptyState, PageHeader, Spinner } from '@/components/ui/misc';
import { formatDateTime } from '@/lib/format';
import { useCan } from '@/lib/hooks';
import {
  useAction,
  useInventoryAdjustments,
  useInventoryCategories,
  useInventoryItems,
} from '@/lib/simple-materials';

/**
 * Reformulação, Fase 1 — estoque simples da oficina.
 * Independente da OS: nada aqui é baixado ou reservado automaticamente. A quantidade só muda por
 * ajuste manual, que fica registrado (anterior → novo, quem, quando e motivo). Itens com histórico
 * ou em uso são arquivados, nunca apagados; a exclusão só existe para cadastro sem nenhum uso.
 */
const INV = [['inventory'], ['os-material-list']] as const;

const qty = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 3 });
const parseQty = (s: string) => {
  const t = s.trim().replace(/\./g, '').replace(',', '.');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? n : NaN;
};

export function InventoryPage() {
  const can = useCan();
  const manage = can('estoque.gerenciar');
  const [show, setShow] = useState<'false' | 'all'>('false');
  const [category, setCategory] = useState('');
  const [search, setSearch] = useState('');
  const cats = useInventoryCategories();
  const items = useInventoryItems(show);

  return (
    <>
      <PageHeader
        title="Estoque da oficina"
        description="Controle simples do que há na oficina: categorias próprias, materiais e rolos de tecido. Não é baixado pelas OS — a quantidade muda só por ajuste, com histórico."
      />
      <p className="mb-4 text-sm text-ink-muted">
        O estoque formal (reservas por OS, sobras e movimentações) continua em{' '}
        <Link className="text-brand-700 hover:underline" href="/painel/estoque">
          Estoque
        </Link>
        .
      </p>
      <div className="grid gap-6 lg:grid-cols-[1fr_18rem]">
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              aria-label="Buscar"
              placeholder="Buscar material ou rolo"
              className="max-w-xs"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <Select
              aria-label="Categoria"
              className="max-w-xs"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
            >
              <option value="">Todas as categorias</option>
              <option value="-">Sem categoria</option>
              {cats.data
                ?.filter((c) => !c.archived)
                .map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
            </Select>
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-brand-700"
                checked={show === 'all'}
                onChange={(e) => setShow(e.target.checked ? 'all' : 'false')}
              />
              Mostrar arquivados
            </label>
          </div>
          {manage && <NewItem categories={cats.data ?? []} />}
          {items.isPending ? (
            <Spinner />
          ) : items.isError ? (
            <Alert tone="danger">{items.error.message}</Alert>
          ) : (
            <ItemList
              manage={manage}
              items={items.data.filter((i) => {
                if (category === '-' && i.categoryId) return false;
                if (category && category !== '-' && i.categoryId !== category) return false;
                const s = search.trim().toLowerCase();
                return (
                  !s ||
                  i.name.toLowerCase().includes(s) ||
                  i.rolls.some((r) => r.code.toLowerCase().includes(s))
                );
              })}
            />
          )}
        </div>
        <Categories manage={manage} />
      </div>
    </>
  );
}

function NewItem({ categories }: { categories: InventoryCategoryDto[] }) {
  const empty = { name: '', unit: 'un', categoryId: '', quantity: '' };
  const [d, setD] = useState(empty);
  const act = useAction(INV, 'Material cadastrado.');
  const q = parseQty(d.quantity);
  const valid = d.name.trim().length >= 2 && d.unit.trim() && !Number.isNaN(q);
  return (
    <form
      className="grid items-end gap-2 rounded-xl border border-line p-3 sm:grid-cols-12"
      data-testid="inventory-new-item"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        act.mutate(
          {
            path: '/api/v1/inventory/items',
            body: {
              name: d.name,
              unit: d.unit,
              categoryId: d.categoryId || null,
              ...(q !== null ? { quantity: q } : {}),
            },
          },
          { onSuccess: () => setD(empty) },
        );
      }}
    >
      <Input
        aria-label="Novo material"
        placeholder="Novo material (ex.: Espuma D33 5cm)"
        className="sm:col-span-5"
        value={d.name}
        onChange={(e) => setD({ ...d, name: e.target.value })}
      />
      <Select
        aria-label="Categoria do material"
        className="sm:col-span-3"
        value={d.categoryId}
        onChange={(e) => setD({ ...d, categoryId: e.target.value })}
      >
        <option value="">Sem categoria</option>
        {categories
          .filter((c) => !c.archived)
          .map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
      </Select>
      <Input
        aria-label="Quantidade inicial"
        placeholder="Qtd."
        inputMode="decimal"
        className="sm:col-span-1"
        value={d.quantity}
        onChange={(e) => setD({ ...d, quantity: e.target.value })}
      />
      <Input
        aria-label="Unidade do material"
        placeholder="Unid."
        className="sm:col-span-1"
        value={d.unit}
        onChange={(e) => setD({ ...d, unit: e.target.value })}
      />
      <Button type="submit" className="sm:col-span-2" disabled={!valid} loading={act.isPending}>
        <Plus className="size-4" aria-hidden /> Cadastrar
      </Button>
      {act.error && (
        <Alert tone="danger" className="sm:col-span-12">
          {act.error}
        </Alert>
      )}
    </form>
  );
}

function ItemList({ items, manage }: { items: InventoryItemDto[]; manage: boolean }) {
  if (!items.length)
    return (
      <EmptyState
        title="Nenhum material"
        description="Cadastre o que a oficina guarda. A quantidade é só uma referência do que há na prateleira."
      />
    );
  return (
    <ul
      className="divide-y divide-line rounded-xl border border-line"
      data-testid="inventory-items"
    >
      {items.map((i) => (
        <ItemRow key={i.id} item={i} manage={manage} />
      ))}
    </ul>
  );
}

/** Ajuste inline: informa a quantidade NOVA e o motivo. */
function AdjustForm({
  path,
  version,
  current,
  unit,
  onDone,
}: {
  path: string;
  version: number;
  current: number;
  unit: string;
  onDone: () => void;
}) {
  const [value, setValue] = useState(qty(current));
  const [reason, setReason] = useState('');
  const act = useAction(INV, 'Ajuste registrado.');
  const n = parseQty(value);
  return (
    <form
      className="mt-2 flex flex-wrap items-center gap-2"
      data-testid="inventory-adjust"
      onSubmit={(e) => {
        e.preventDefault();
        if (n === null || Number.isNaN(n)) return;
        act.mutate(
          { path, body: { newQuantity: n, reason: reason.trim() || null, version } },
          { onSuccess: onDone },
        );
      }}
    >
      <span className="text-sm text-ink-muted">
        De {qty(current)} {unit} para
      </span>
      <Input
        aria-label="Nova quantidade"
        inputMode="decimal"
        className="w-28"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        autoFocus
      />
      <Input
        aria-label="Motivo do ajuste"
        placeholder="Motivo (ex.: contagem, uso na OS-12)"
        className="min-w-48 flex-1"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <Button
        size="sm"
        type="submit"
        loading={act.isPending}
        disabled={n === null || Number.isNaN(n)}
      >
        Salvar ajuste
      </Button>
      <Button size="sm" variant="secondary" onClick={onDone}>
        Cancelar
      </Button>
      {act.error && (
        <Alert tone="danger" className="w-full">
          {act.error}
        </Alert>
      )}
    </form>
  );
}

function AdjustmentHistory({ itemId, rollId }: { itemId?: string; rollId?: string }) {
  const q = useInventoryAdjustments(itemId ? { itemId } : { rollId });
  if (q.isPending) return <Spinner className="mt-2" />;
  if (q.isError) return <Alert tone="danger">{q.error.message}</Alert>;
  if (!q.data.length)
    return <p className="mt-2 text-xs text-ink-muted">Nenhum ajuste registrado.</p>;
  return (
    <ul className="mt-2 space-y-1 text-xs text-ink-soft" data-testid="inventory-history">
      {q.data.map((a) => (
        <li key={a.id}>
          {formatDateTime(a.createdAt)} · {a.actor?.displayName ?? 'usuário removido'}:{' '}
          <span className="tabular-nums">
            {qty(a.previousQuantity)} → {qty(a.newQuantity)}
          </span>
          {a.reason && ` — ${a.reason}`}
        </li>
      ))}
    </ul>
  );
}

/** Arquivar/reativar e excluir (só sem uso), com confirmação na própria linha. */
function LifecycleButtons({
  base,
  archived,
  deletable,
  version,
  what,
}: {
  base: string;
  archived: boolean;
  deletable: boolean;
  version: number;
  what: string;
}) {
  const [confirm, setConfirm] = useState(false);
  const act = useAction(INV, archived ? `${what} reativado.` : `${what} atualizado.`);
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      <Button
        size="sm"
        variant="ghost"
        icon={
          archived ? (
            <ArchiveRestore className="size-4" aria-hidden />
          ) : (
            <Archive className="size-4" aria-hidden />
          )
        }
        loading={act.isPending}
        onClick={() =>
          act.mutate({ path: `${base}/archive`, body: { archived: !archived, version } })
        }
      >
        {archived ? 'Reativar' : 'Arquivar'}
      </Button>
      {deletable &&
        (confirm ? (
          <>
            <Button
              size="sm"
              variant="danger"
              loading={act.isPending}
              onClick={() => act.mutate({ path: `${base}/delete`, body: { version } })}
            >
              Excluir de vez
            </Button>
            <Button size="sm" variant="secondary" onClick={() => setConfirm(false)}>
              Manter
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            aria-label={`Excluir ${what.toLowerCase()}`}
            icon={<Trash2 className="size-4" aria-hidden />}
            onClick={() => setConfirm(true)}
          />
        ))}
      {act.error && <span className="text-xs text-danger-600">{act.error}</span>}
    </span>
  );
}

function ItemRow({ item: i, manage }: { item: InventoryItemDto; manage: boolean }) {
  const [mode, setMode] = useState<'none' | 'adjust' | 'history' | 'roll' | 'cost'>('none');
  const toggle = (m: typeof mode) => setMode(mode === m ? 'none' : m);
  return (
    <li className="px-4 py-3" data-testid="inventory-item">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
        <div className="min-w-48 flex-1">
          <p className="font-medium">
            {i.name}{' '}
            {i.archived && (
              <Badge tone="neutral" className="ml-1">
                Arquivado
              </Badge>
            )}
          </p>
          <p className="text-xs text-ink-muted">
            {[
              i.categoryName ?? 'Sem categoria',
              i.location,
              i.referenceCostCents !== null &&
                i.referenceCostCents !== undefined &&
                `custo de referência ${formatCents(i.referenceCostCents)}/${i.unit}`,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        <p className="tabular-nums" data-testid="inventory-quantity">
          <span className="text-lg font-semibold">{qty(i.quantity)}</span> {i.unit}
          {i.rollMeters !== null && (
            <span className="ml-2 text-xs text-ink-muted">
              ({qty(i.rollMeters)} m em {i.rolls.filter((r) => !r.archived).length} rolo(s))
            </span>
          )}
        </p>
        <span className="inline-flex flex-wrap gap-1">
          {manage && !i.archived && (
            <Button size="sm" variant="secondary" onClick={() => toggle('adjust')}>
              Ajustar
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            icon={<History className="size-4" aria-hidden />}
            onClick={() => toggle('history')}
          >
            Histórico
          </Button>
          {manage && !i.archived && (
            <Button size="sm" variant="ghost" onClick={() => toggle('roll')}>
              + Rolo
            </Button>
          )}
          {manage && i.referenceCostCents !== undefined && !i.archived && (
            <Button size="sm" variant="ghost" onClick={() => toggle('cost')}>
              Custo
            </Button>
          )}
          {manage && (
            <LifecycleButtons
              base={`/api/v1/inventory/items/${i.id}`}
              archived={i.archived}
              deletable={i.deletable}
              version={i.version}
              what="Material"
            />
          )}
        </span>
      </div>
      {mode === 'adjust' && (
        <AdjustForm
          path={`/api/v1/inventory/items/${i.id}/adjust`}
          version={i.version}
          current={i.quantity}
          unit={i.unit}
          onDone={() => setMode('none')}
        />
      )}
      {mode === 'history' && <AdjustmentHistory itemId={i.id} />}
      {mode === 'roll' && <NewRoll itemId={i.id} onDone={() => setMode('none')} />}
      {mode === 'cost' && <ReferenceCost item={i} onDone={() => setMode('none')} />}
      {i.rolls.length > 0 && (
        <ul className="mt-2 space-y-1 border-l-2 border-line pl-3" data-testid="inventory-rolls">
          {i.rolls.map((r) => (
            <RollRow key={r.id} roll={r} manage={manage} />
          ))}
        </ul>
      )}
    </li>
  );
}

function ReferenceCost({ item, onDone }: { item: InventoryItemDto; onDone: () => void }) {
  const [cost, setCost] = useState<{ cents: number | null; valid: boolean }>({
    cents: item.referenceCostCents ?? null,
    valid: true,
  });
  const act = useAction(INV, 'Custo de referência salvo.');
  return (
    <form
      className="mt-2 flex flex-wrap items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!cost.valid) return;
        act.mutate(
          {
            path: `/api/v1/inventory/items/${item.id}`,
            method: 'PATCH',
            body: { referenceCostCents: cost.cents, version: item.version },
          },
          { onSuccess: onDone },
        );
      }}
    >
      <span className="text-sm text-ink-muted">Custo de referência por {item.unit}</span>
      <div className="w-40">
        <MoneyInput
          aria-label="Custo de referência"
          placeholder="não informado"
          cents={item.referenceCostCents ?? null}
          onCents={(cents, valid) => setCost({ cents, valid })}
        />
      </div>
      <Button size="sm" type="submit" loading={act.isPending} disabled={!cost.valid}>
        Salvar
      </Button>
      <Button size="sm" variant="secondary" onClick={onDone}>
        Cancelar
      </Button>
      <span className="w-full text-xs text-ink-muted">
        Só referência: não entra no custo de nenhuma OS.
      </span>
      {act.error && (
        <Alert tone="danger" className="w-full">
          {act.error}
        </Alert>
      )}
    </form>
  );
}

function NewRoll({ itemId, onDone }: { itemId: string; onDone: () => void }) {
  const [d, setD] = useState({ code: '', color: '', meters: '' });
  const act = useAction(INV, 'Rolo cadastrado.');
  const m = parseQty(d.meters);
  const valid = d.code.trim().length >= 1 && !Number.isNaN(m);
  return (
    <form
      className="mt-2 flex flex-wrap items-center gap-2"
      data-testid="inventory-new-roll"
      onSubmit={(e) => {
        e.preventDefault();
        if (!valid) return;
        act.mutate(
          {
            path: `/api/v1/inventory/items/${itemId}/rolls`,
            body: { code: d.code, color: d.color || null, ...(m !== null ? { meters: m } : {}) },
          },
          { onSuccess: onDone },
        );
      }}
    >
      <Input
        aria-label="Identificação do rolo"
        placeholder="Identificação (ex.: R-014)"
        className="w-40"
        value={d.code}
        onChange={(e) => setD({ ...d, code: e.target.value })}
      />
      <Input
        aria-label="Cor"
        placeholder="Cor"
        className="w-36"
        value={d.color}
        onChange={(e) => setD({ ...d, color: e.target.value })}
      />
      <Input
        aria-label="Metros"
        placeholder="Metros"
        inputMode="decimal"
        className="w-24"
        value={d.meters}
        onChange={(e) => setD({ ...d, meters: e.target.value })}
      />
      <Button size="sm" type="submit" loading={act.isPending} disabled={!valid}>
        Adicionar rolo
      </Button>
      <Button size="sm" variant="secondary" onClick={onDone}>
        Cancelar
      </Button>
      {act.error && (
        <Alert tone="danger" className="w-full">
          {act.error}
        </Alert>
      )}
    </form>
  );
}

function RollRow({ roll: r, manage }: { roll: FabricRollDto; manage: boolean }) {
  const [mode, setMode] = useState<'none' | 'adjust' | 'history'>('none');
  return (
    <li className="text-sm" data-testid="inventory-roll">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="font-mono font-semibold">{r.code}</span>
        {r.color && <span className="text-ink-soft">{r.color}</span>}
        {r.reference && <span className="text-ink-muted">ref. {r.reference}</span>}
        <span className="tabular-nums">{qty(r.meters)} m</span>
        {r.archived && <Badge tone="neutral">Arquivado</Badge>}
        <span className="inline-flex flex-wrap gap-1">
          {manage && !r.archived && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setMode(mode === 'adjust' ? 'none' : 'adjust')}
            >
              Ajustar
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setMode(mode === 'history' ? 'none' : 'history')}
          >
            Histórico
          </Button>
          {manage && (
            <LifecycleButtons
              base={`/api/v1/inventory/rolls/${r.id}`}
              archived={r.archived}
              deletable={r.deletable}
              version={r.version}
              what="Rolo"
            />
          )}
        </span>
      </div>
      {mode === 'adjust' && (
        <AdjustForm
          path={`/api/v1/inventory/rolls/${r.id}/adjust`}
          version={r.version}
          current={r.meters}
          unit="m"
          onDone={() => setMode('none')}
        />
      )}
      {mode === 'history' && <AdjustmentHistory rollId={r.id} />}
    </li>
  );
}

function Categories({ manage }: { manage: boolean }) {
  const q = useInventoryCategories();
  const [name, setName] = useState('');
  const act = useAction(INV, 'Categoria criada.');
  return (
    <aside className="h-fit rounded-xl border border-line p-4" data-testid="inventory-categories">
      <h3 className="mb-2 font-semibold">Categorias</h3>
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <Alert tone="danger">{q.error.message}</Alert>
      ) : q.data.length === 0 ? (
        <p className="text-sm text-ink-muted">Nenhuma categoria ainda.</p>
      ) : (
        <ul className="space-y-1">
          {q.data.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center justify-between gap-1 text-sm">
              <span className={c.archived ? 'text-ink-muted line-through' : ''}>
                {c.name} <span className="text-xs text-ink-muted">({c.itemCount})</span>
              </span>
              {manage && (
                <LifecycleButtons
                  base={`/api/v1/inventory/categories/${c.id}`}
                  archived={c.archived}
                  deletable={c.deletable}
                  version={c.version}
                  what="Categoria"
                />
              )}
            </li>
          ))}
        </ul>
      )}
      {manage && (
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim().length < 2) return;
            act.mutate(
              { path: '/api/v1/inventory/categories', body: { name } },
              { onSuccess: () => setName('') },
            );
          }}
        >
          <Input
            aria-label="Nova categoria"
            placeholder="Nova categoria"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Button type="submit" size="sm" disabled={name.trim().length < 2} loading={act.isPending}>
            Criar
          </Button>
        </form>
      )}
      {act.error && (
        <Alert tone="danger" className="mt-2">
          {act.error}
        </Alert>
      )}
    </aside>
  );
}
