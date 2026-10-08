'use client';

import type { MaterialRequestItemDto } from '@cenario/shared';
import {
  MATERIAL_KIND_LABEL,
  MATERIAL_SOURCING_LABEL,
  MATERIAL_UNIT_LABEL,
  consolidateMaterials,
  describeMaterial,
  formatQuantity,
} from '@cenario/shared';
import { Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';

type Row = Pick<
  MaterialRequestItemDto,
  | 'kind'
  | 'sourcing'
  | 'description'
  | 'color'
  | 'reference'
  | 'foamDensity'
  | 'thicknessCm'
  | 'lengthCm'
  | 'widthCm'
  | 'quantity'
  | 'unit'
  | 'notes'
> & { key: string; itemCode: string | null };

/** Lista de materiais por peça, com ações opcionais de edição. */
export function ItemsList({
  rows,
  onEdit,
  onRemove,
  large,
  empty = 'Nenhum material informado.',
}: {
  rows: Row[];
  onEdit?: (key: string) => void;
  onRemove?: (key: string) => void;
  large?: boolean;
  empty?: string;
}) {
  if (rows.length === 0) return <p className="text-sm text-ink-muted">{empty}</p>;
  return (
    <ul className="divide-y divide-line rounded-xl border border-line" data-testid="material-items">
      {rows.map((r) => (
        <li
          key={r.key}
          className={
            large ? 'flex items-center gap-3 px-4 py-3.5' : 'flex items-center gap-3 px-4 py-2.5'
          }
        >
          <div className="min-w-0 flex-1">
            <p className={large ? 'text-lg font-medium' : 'font-medium'}>
              {MATERIAL_KIND_LABEL[r.kind]}: {describeMaterial(r)}
            </p>
            <p className="text-sm text-ink-muted">
              {r.itemCode ?? 'Toda a OS'} · {MATERIAL_SOURCING_LABEL[r.sourcing]}
              {r.notes ? ` · ${r.notes}` : ''}
            </p>
          </div>
          <span
            className={large ? 'text-lg font-semibold tabular-nums' : 'font-semibold tabular-nums'}
          >
            {formatQuantity(r.quantity)} {MATERIAL_UNIT_LABEL[r.unit]}
          </span>
          {onEdit && (
            <Button
              size={large ? 'md' : 'sm'}
              variant="ghost"
              aria-label={`Editar ${r.description}`}
              icon={<Pencil className="size-4" aria-hidden />}
              onClick={() => onEdit(r.key)}
            />
          )}
          {onRemove && (
            <Button
              size={large ? 'md' : 'sm'}
              variant="ghost"
              aria-label={`Remover ${r.description}`}
              icon={<Trash2 className="size-4" aria-hidden />}
              onClick={() => onRemove(r.key)}
            />
          )}
        </li>
      ))}
    </ul>
  );
}

/** Total consolidado de uma OS (soma itens iguais de peças diferentes). */
export function OsTotals({ rows, osCode }: { rows: Row[]; osCode: string }) {
  const lines = consolidateMaterials(
    rows.map((r) => ({
      ...r,
      serviceOrder: { id: 'os', code: osCode },
      itemCode: r.itemCode,
      measurementCode: null,
    })),
  );
  if (lines.length === 0) return null;
  return (
    <table className="w-full text-sm" data-testid="os-totals">
      <thead className="text-left text-xs text-ink-muted uppercase">
        <tr>
          <th className="py-1.5 font-semibold">Material</th>
          <th className="py-1.5 text-right font-semibold">Total da OS</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-line">
        {lines.map((l) => (
          <tr key={l.key}>
            <td className="py-2">
              {MATERIAL_KIND_LABEL[l.kind]}: {describeMaterial(l)}
              <span className="block text-xs text-ink-muted">
                {l.origins.map((o) => o.itemCode ?? 'Toda a OS').join(' + ')}
              </span>
            </td>
            <td className="py-2 text-right font-semibold tabular-nums">
              {formatQuantity(l.totalQuantity)} {MATERIAL_UNIT_LABEL[l.unit]}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
