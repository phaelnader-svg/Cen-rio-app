'use client';

import type {
  MaterialKind,
  MaterialRequestItemInput,
  MaterialSourcing,
  MaterialUnit,
} from '@cenario/shared';
import {
  MATERIAL_SOURCING_LABEL,
  MATERIAL_UNIT_LABEL,
  UNITS_BY_KIND,
  materialRequestItemSchema,
} from '@cenario/shared';
import clsx from 'clsx';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { decimalText, parseDecimal } from '@/lib/measurements';

export interface PieceOption {
  id: string;
  code: string;
  description: string;
}

export type ItemDraft = MaterialRequestItemInput & { key: string };

const KIND_TITLE: Record<MaterialKind, string> = {
  TECIDO: 'Tecido',
  ESPUMA: 'Espuma',
  OUTRO: 'Outro material',
};

/** Formulário curto de um material (campos variam por tipo). Sem preço nem fornecedor. */
export function MaterialForm({
  kind,
  pieces,
  initial,
  onSave,
  onCancel,
  large,
}: {
  kind: MaterialKind;
  pieces: PieceOption[];
  initial?: ItemDraft;
  onSave: (item: ItemDraft) => void;
  onCancel: () => void;
  large?: boolean;
}) {
  const [piece, setPiece] = useState(
    initial?.serviceOrderItemId ?? (pieces.length === 1 ? pieces[0]!.id : ''),
  );
  const [description, setDescription] = useState(
    initial?.description ?? (kind === 'ESPUMA' ? 'Espuma' : ''),
  );
  const [color, setColor] = useState(initial?.color ?? '');
  const [reference, setReference] = useState(initial?.reference ?? '');
  const [density, setDensity] = useState(initial?.foamDensity ?? '');
  const [thickness, setThickness] = useState(decimalText(initial?.thicknessCm));
  const [length, setLength] = useState(decimalText(initial?.lengthCm));
  const [width, setWidth] = useState(decimalText(initial?.widthCm));
  const [quantity, setQuantity] = useState(decimalText(initial?.quantity));
  const [unit, setUnit] = useState<MaterialUnit>(initial?.unit ?? UNITS_BY_KIND[kind][0]!);
  const [sourcing, setSourcing] = useState<MaterialSourcing>(
    initial?.sourcing ?? (kind === 'OUTRO' ? 'ESTOQUE' : 'EXCLUSIVO_OS'),
  );
  const [notes, setNotes] = useState(initial?.notes ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const optional = (v: string) => (v.trim() ? parseDecimal(v) : null);
  const inputCls = large ? 'h-14 text-lg' : undefined;

  function save() {
    const candidate = {
      serviceOrderItemId: piece || null,
      kind,
      sourcing: kind === 'TECIDO' ? 'EXCLUSIVO_OS' : sourcing,
      description,
      color,
      reference,
      foamDensity: kind === 'ESPUMA' ? density : '',
      thicknessCm: kind === 'ESPUMA' ? optional(thickness) : null,
      lengthCm: kind === 'ESPUMA' ? optional(length) : null,
      widthCm: kind === 'ESPUMA' ? optional(width) : null,
      quantity: parseDecimal(quantity),
      unit,
      notes,
    };
    const parsed = materialRequestItemSchema.safeParse(candidate);
    if (!parsed.success) {
      const map: Record<string, string> = {};
      for (const i of parsed.error.issues)
        map[String(i.path[0])] ??=
          Number.isNaN(candidate.quantity) && i.path[0] === 'quantity'
            ? 'Informe a quantidade (ex.: 12,5).'
            : i.message;
      setErrors(map);
      return;
    }
    onSave({ ...candidate, key: initial?.key ?? crypto.randomUUID() } as ItemDraft);
  }

  return (
    <div
      className={clsx('rounded-2xl border border-brand-200 bg-brand-50/40 p-4', large && 'p-5')}
      data-testid={`material-form-${kind}`}
    >
      <p className={clsx('mb-3 font-semibold', large && 'text-lg')}>
        {initial ? 'Editar' : 'Adicionar'} {KIND_TITLE[kind].toLowerCase()}
      </p>
      <div className="grid gap-3 sm:grid-cols-2">
        {pieces.length > 1 && (
          <Field label="Peça" className="sm:col-span-2">
            {(p) => (
              <Select
                {...p}
                className={inputCls}
                value={piece}
                onChange={(e) => setPiece(e.target.value)}
              >
                <option value="">Toda a OS</option>
                {pieces.map((x) => (
                  <option key={x.id} value={x.id}>
                    {x.code} — {x.description}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <Field
          label={kind === 'TECIDO' ? 'Tecido (nome ou referência)' : 'Descrição'}
          error={errors.description}
          required
        >
          {(p) => (
            <Input
              {...p}
              className={inputCls}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={kind === 'OUTRO' ? 'Ex.: MDF 15 mm, grampos 80/10, cola' : undefined}
            />
          )}
        </Field>
        {kind === 'TECIDO' && (
          <>
            <Field label="Cor" error={errors.color}>
              {(p) => (
                <Input
                  {...p}
                  className={inputCls}
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                />
              )}
            </Field>
            <Field label="Referência do fornecedor" error={errors.reference}>
              {(p) => (
                <Input
                  {...p}
                  className={inputCls}
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                />
              )}
            </Field>
          </>
        )}
        {kind === 'ESPUMA' && (
          <>
            <Field
              label="Tipo / densidade"
              error={errors.foamDensity}
              required
              hint="Ex.: D28, D33, soft"
            >
              {(p) => (
                <Input
                  {...p}
                  className={inputCls}
                  value={density}
                  onChange={(e) => setDensity(e.target.value)}
                />
              )}
            </Field>
            <Field label="Espessura (cm)" error={errors.thicknessCm} required>
              {(p) => (
                <Input
                  {...p}
                  className={inputCls}
                  inputMode="decimal"
                  value={thickness}
                  onChange={(e) => setThickness(e.target.value)}
                />
              )}
            </Field>
            <Field label="Comprimento (cm)" error={errors.lengthCm}>
              {(p) => (
                <Input
                  {...p}
                  className={inputCls}
                  inputMode="decimal"
                  value={length}
                  onChange={(e) => setLength(e.target.value)}
                />
              )}
            </Field>
            <Field label="Largura (cm)" error={errors.widthCm}>
              {(p) => (
                <Input
                  {...p}
                  className={inputCls}
                  inputMode="decimal"
                  value={width}
                  onChange={(e) => setWidth(e.target.value)}
                />
              )}
            </Field>
          </>
        )}
        <Field
          label={kind === 'TECIDO' ? 'Metragem (m)' : 'Quantidade'}
          error={errors.quantity}
          required
        >
          {(p) => (
            <Input
              {...p}
              className={inputCls}
              inputMode="decimal"
              value={quantity}
              onChange={(e) => setQuantity(e.target.value)}
              placeholder={kind === 'TECIDO' ? 'Ex.: 12,5' : undefined}
            />
          )}
        </Field>
        {UNITS_BY_KIND[kind].length > 1 && (
          <Field label="Unidade" error={errors.unit}>
            {(p) => (
              <Select
                {...p}
                className={inputCls}
                value={unit}
                onChange={(e) => setUnit(e.target.value as MaterialUnit)}
              >
                {UNITS_BY_KIND[kind].map((u) => (
                  <option key={u} value={u}>
                    {MATERIAL_UNIT_LABEL[u]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        {kind !== 'TECIDO' && (
          <Field label="Origem" error={errors.sourcing}>
            {(p) => (
              <Select
                {...p}
                className={inputCls}
                value={sourcing}
                onChange={(e) => setSourcing(e.target.value as MaterialSourcing)}
              >
                {(['EXCLUSIVO_OS', 'ESTOQUE'] as const).map((s) => (
                  <option key={s} value={s}>
                    {MATERIAL_SOURCING_LABEL[s]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <Field label="Observações" className="sm:col-span-2">
          {(p) => (
            <Input
              {...p}
              className={inputCls}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          )}
        </Field>
      </div>
      {kind === 'TECIDO' && (
        <p className="mt-2 text-xs text-ink-muted">
          Tecido é comprado especificamente para esta OS.
        </p>
      )}
      <div className="mt-4 flex gap-2">
        <Button size={large ? 'lg' : 'md'} onClick={save}>
          {initial ? 'Salvar material' : 'Adicionar'}
        </Button>
        <Button size={large ? 'lg' : 'md'} variant="secondary" onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </div>
  );
}
