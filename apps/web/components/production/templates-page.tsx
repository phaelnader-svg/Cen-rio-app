'use client';

import type {
  PieceType,
  ProductionActivity,
  ProductionTemplateDto,
  TaskRole,
} from '@cenario/shared';
import {
  PIECE_TYPES,
  PIECE_TYPE_LABEL,
  PRODUCTION_ACTIVITIES,
  PRODUCTION_ACTIVITY_LABEL,
  TASK_ROLES,
  TASK_ROLE_LABEL,
} from '@cenario/shared';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Section } from '@/components/commercial/section';
import { Button } from '@/components/ui/button';
import { Checkbox, Input, Select } from '@/components/ui/field';
import { Alert, Badge, PageHeader, Spinner } from '@/components/ui/misc';
import { api } from '@/lib/api';
import { useCan } from '@/lib/hooks';
import { useTemplates } from '@/lib/production';
import { useSend } from './use-send';

interface StepDraft {
  activity: ProductionActivity;
  name: string;
  role: TaskRole;
  requiresMaterials: boolean;
  optional: boolean;
  dependsOn: number[];
}
interface Draft {
  name: string;
  pieceTypes: PieceType[];
  active: boolean;
  steps: StepDraft[];
}

const fromDto = (t: ProductionTemplateDto): Draft => ({
  name: t.name,
  pieceTypes: t.pieceTypes,
  active: t.active,
  steps: t.steps.map((s) => ({
    activity: s.activity,
    name: s.name,
    role: s.role,
    requiresMaterials: s.requiresMaterials,
    optional: s.optional,
    dependsOn: s.dependsOn,
  })),
});

/** Modelos de produção (sugestões de etapas por tipo de peça; o gestor adapta em cada OS). */
export function ProductionTemplatesPage() {
  const q = useTemplates();
  const can = useCan();
  const [creating, setCreating] = useState(false);
  return (
    <>
      <PageHeader
        title="Modelos de produção"
        description="Etapas sugeridas por tipo de peça ao incluir uma OS na semana. O gestor pode retirar, acrescentar e reorganizar etapas em cada OS; etapas opcionais não são geradas para peças de fabricação."
        actions={
          can('producao.planejar') && !creating ? (
            <Button
              icon={<Plus className="size-4" aria-hidden />}
              onClick={() => setCreating(true)}
            >
              Novo modelo
            </Button>
          ) : undefined
        }
      />
      {creating && (
        <TemplateEditor
          initial={{
            name: '',
            pieceTypes: [],
            active: true,
            steps: [
              {
                activity: 'PREPARACAO',
                name: 'Preparação',
                role: 'APOIO',
                requiresMaterials: false,
                optional: false,
                dependsOn: [],
              },
            ],
          }}
          onDone={() => setCreating(false)}
        />
      )}
      {q.isPending ? (
        <Spinner />
      ) : q.isError ? (
        <Alert tone="danger">{q.error.message}</Alert>
      ) : (
        <div className="space-y-6">
          {q.data.map((t) => (
            <TemplateEditor
              key={`${t.id}-${t.version}`}
              template={t}
              initial={fromDto(t)}
              readOnly={!can('producao.planejar')}
            />
          ))}
        </div>
      )}
    </>
  );
}

function TemplateEditor({
  template,
  initial,
  readOnly,
  onDone,
}: {
  template?: ProductionTemplateDto;
  initial: Draft;
  readOnly?: boolean;
  onDone?: () => void;
}) {
  const [d, setD] = useState<Draft>(initial);
  const [dirty, setDirty] = useState(!template);
  const { m, error } = useSend(onDone);
  const set = (next: Draft) => {
    setD(next);
    setDirty(true);
  };
  const setStep = (i: number, patch: Partial<StepDraft>) =>
    set({ ...d, steps: d.steps.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
  /** Move/remove etapa e renumera as dependências (por posição). */
  const reorder = (order: number[]) => {
    const map = new Map(order.map((old, idx) => [old + 1, idx + 1]));
    set({
      ...d,
      steps: order.map((old) => {
        const s = d.steps[old]!;
        return {
          ...s,
          dependsOn: s.dependsOn.map((p) => map.get(p)).filter((p): p is number => Boolean(p)),
        };
      }),
    });
  };
  const idx = d.steps.map((_, i) => i);
  return (
    <Section
      title={template ? template.name : 'Novo modelo'}
      actions={
        <>
          {!d.active && <Badge tone="neutral">Inativo</Badge>}
          {d.pieceTypes.map((p) => (
            <Badge key={p} tone="info">
              {PIECE_TYPE_LABEL[p]}
            </Badge>
          ))}
        </>
      }
    >
      {error && (
        <Alert tone="danger" className="mb-3">
          {error}
        </Alert>
      )}
      <fieldset disabled={readOnly} className="space-y-4">
        <div className="flex flex-wrap items-end gap-4">
          <label className="text-sm">
            <span className="mb-1 block text-ink-muted">Nome</span>
            <Input
              className="w-64"
              value={d.name}
              onChange={(e) => set({ ...d, name: e.target.value })}
            />
          </label>
          <div className="flex flex-wrap gap-3">
            {PIECE_TYPES.map((p) => (
              <Checkbox
                key={p}
                label={PIECE_TYPE_LABEL[p]}
                checked={d.pieceTypes.includes(p)}
                onChange={(e) =>
                  set({
                    ...d,
                    pieceTypes: e.target.checked
                      ? [...d.pieceTypes, p]
                      : d.pieceTypes.filter((x) => x !== p),
                  })
                }
              />
            ))}
          </div>
          <Checkbox
            label="Ativo"
            checked={d.active}
            onChange={(e) => set({ ...d, active: e.target.checked })}
          />
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[900px] text-sm">
            <thead className="text-left text-xs text-ink-muted uppercase">
              <tr>
                <th className="px-2 py-1">#</th>
                <th className="px-2 py-1">Etapa</th>
                <th className="px-2 py-1">Nome</th>
                <th className="px-2 py-1">Papel</th>
                <th className="px-2 py-1">Depende de</th>
                <th className="px-2 py-1">Materiais</th>
                <th className="px-2 py-1">Opcional</th>
                <th className="px-2 py-1" />
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {d.steps.map((s, i) => (
                <tr key={i}>
                  <td className="px-2 py-1.5 tabular-nums">{i + 1}</td>
                  <td className="px-2 py-1.5">
                    <Select
                      className="h-8 py-0"
                      value={s.activity}
                      onChange={(e) =>
                        setStep(i, { activity: e.target.value as ProductionActivity })
                      }
                    >
                      {PRODUCTION_ACTIVITIES.map((a) => (
                        <option key={a} value={a}>
                          {PRODUCTION_ACTIVITY_LABEL[a]}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td className="px-2 py-1.5">
                    <Input
                      className="h-8"
                      value={s.name}
                      onChange={(e) => setStep(i, { name: e.target.value })}
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <Select
                      className="h-8 py-0"
                      value={s.role}
                      onChange={(e) => setStep(i, { role: e.target.value as TaskRole })}
                    >
                      {TASK_ROLES.map((r) => (
                        <option key={r} value={r}>
                          {TASK_ROLE_LABEL[r]}
                        </option>
                      ))}
                    </Select>
                  </td>
                  <td className="px-2 py-1.5">
                    <Input
                      className="h-8 w-28"
                      placeholder="ex.: 1, 2"
                      aria-label={`Dependências da etapa ${i + 1}`}
                      value={s.dependsOn.join(', ')}
                      onChange={(e) =>
                        setStep(i, {
                          dependsOn: e.target.value
                            .split(/[^0-9]+/)
                            .map(Number)
                            .filter((n) => n > 0),
                        })
                      }
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <input
                      type="checkbox"
                      aria-label={`Etapa ${i + 1} exige materiais`}
                      className="size-4 accent-brand-700"
                      checked={s.requiresMaterials}
                      onChange={(e) => setStep(i, { requiresMaterials: e.target.checked })}
                    />
                  </td>
                  <td className="px-2 py-1.5">
                    <input
                      type="checkbox"
                      aria-label={`Etapa ${i + 1} opcional`}
                      className="size-4 accent-brand-700"
                      checked={s.optional}
                      onChange={(e) => setStep(i, { optional: e.target.checked })}
                    />
                  </td>
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label="Subir etapa"
                      disabled={i === 0}
                      icon={<ArrowUp className="size-3.5" aria-hidden />}
                      onClick={() => {
                        const o = [...idx];
                        [o[i - 1], o[i]] = [o[i]!, o[i - 1]!];
                        reorder(o);
                      }}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label="Descer etapa"
                      disabled={i === d.steps.length - 1}
                      icon={<ArrowDown className="size-3.5" aria-hidden />}
                      onClick={() => {
                        const o = [...idx];
                        [o[i + 1], o[i]] = [o[i]!, o[i + 1]!];
                        reorder(o);
                      }}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      aria-label="Remover etapa"
                      disabled={d.steps.length === 1}
                      icon={<Trash2 className="size-3.5" aria-hidden />}
                      onClick={() => reorder(idx.filter((j) => j !== i))}
                    />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {!readOnly && (
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="secondary"
              icon={<Plus className="size-4" aria-hidden />}
              onClick={() =>
                set({
                  ...d,
                  steps: [
                    ...d.steps,
                    {
                      activity: 'APOIO',
                      name: 'Apoio',
                      role: 'APOIO',
                      requiresMaterials: false,
                      optional: false,
                      dependsOn: [],
                    },
                  ],
                })
              }
            >
              Etapa
            </Button>
            <span className="flex-1" />
            {onDone && (
              <Button size="sm" variant="secondary" onClick={onDone}>
                Cancelar
              </Button>
            )}
            <Button
              size="sm"
              disabled={!dirty}
              loading={m.isPending}
              onClick={() =>
                m.mutate({
                  run: () =>
                    template
                      ? api(`/api/v1/production-templates/${template.id}`, {
                          method: 'PUT',
                          body: { ...d, version: template.version },
                        })
                      : api('/api/v1/production-templates', { method: 'POST', body: d }),
                  ok: 'Modelo salvo.',
                })
              }
            >
              Salvar modelo
            </Button>
          </div>
        )}
      </fieldset>
    </Section>
  );
}
