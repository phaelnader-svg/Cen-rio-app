'use client';

import type { EmployeeDto, Permission } from '@cenario/shared';
import { createEmployeeSchema, updateEmployeeSchema } from '@cenario/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Textarea } from '@/components/ui/field';
import { Alert, Badge } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { ApiError, api, errorMessage, fieldErrors, newIdempotencyKey } from '@/lib/api';
import { usePermissionCatalog, useRoles } from '@/lib/queries';

export const COLOR_PRESETS = [
  '#2563EB',
  '#059669',
  '#D97706',
  '#7C3AED',
  '#DB2777',
  '#0891B2',
  '#65A30D',
  '#DC2626',
  '#0F172A',
  '#A8743F',
];

interface FormState {
  fullName: string;
  displayName: string;
  jobTitle: string;
  responsibilities: string;
  phone: string;
  color: string;
  roleIds: string[];
  extraPermissions: string[];
  pin: string;
  email: string;
  password: string;
}

function initialState(e?: EmployeeDto): FormState {
  return {
    fullName: e?.fullName ?? '',
    displayName: e?.displayName ?? '',
    jobTitle: e?.jobTitle ?? '',
    responsibilities: e?.responsibilities ?? '',
    phone: e?.phone ?? '',
    color: e?.color ?? COLOR_PRESETS[0]!,
    roleIds: e?.roles.map((r) => r.id) ?? [],
    extraPermissions: e?.extraPermissions ?? [],
    pin: '',
    email: '',
    password: '',
  };
}

export function EmployeeForm({
  open,
  onClose,
  employee,
}: {
  open: boolean;
  onClose: () => void;
  employee?: EmployeeDto;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const roles = useRoles(open);
  const catalog = usePermissionCatalog(open);
  const [form, setForm] = useState<FormState>(() => initialState(employee));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  // Uma chave por intenção de cadastro: reenvios (duplo clique, rede instável) não duplicam.
  const idemKey = useRef(newIdempotencyKey());
  const editing = Boolean(employee);

  const set = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const rolePerms = useMemo(() => {
    const s = new Set<string>();
    for (const r of roles.data ?? [])
      if (form.roleIds.includes(r.id)) r.permissions.forEach((p) => s.add(p));
    return s;
  }, [roles.data, form.roleIds]);

  const mutation = useMutation({
    mutationFn: async () => {
      const base = {
        fullName: form.fullName,
        displayName: form.displayName,
        jobTitle: form.jobTitle,
        responsibilities: form.responsibilities,
        phone: form.phone,
        color: form.color,
        roleIds: form.roleIds,
        extraPermissions: form.extraPermissions.filter((p) => !rolePerms.has(p)),
      };
      if (employee) {
        const body = updateEmployeeSchema.parse({ ...base, version: employee.version });
        return api<EmployeeDto>(`/api/employees/${employee.id}`, { method: 'PUT', body });
      }
      const body = createEmployeeSchema.parse({
        ...base,
        ...(form.pin ? { pin: form.pin } : {}),
        ...(form.email ? { email: form.email, password: form.password } : {}),
      });
      return api<EmployeeDto>('/api/employees', {
        method: 'POST',
        body,
        idempotencyKey: idemKey.current,
      });
    },
    onSuccess: (saved) => {
      void qc.invalidateQueries({ queryKey: ['employees'] });
      toast(
        'ok',
        editing
          ? `Cadastro de ${saved.displayName} atualizado.`
          : `${saved.displayName} cadastrado.`,
      );
      onClose();
    },
    onError: (err) => {
      if (err && typeof err === 'object' && 'issues' in err) {
        const map: Record<string, string> = {};
        for (const i of (err as { issues: { path: PropertyKey[]; message: string }[] }).issues) {
          map[String(i.path[0])] ??= i.message;
        }
        setErrors(map);
        setFormError('Revise os campos destacados.');
        return;
      }
      setErrors(fieldErrors(err));
      if (err instanceof ApiError && err.code === 'VERSION_CONFLICT') {
        void qc.invalidateQueries({ queryKey: ['employees'] });
      }
      setFormError(errorMessage(err));
    },
  });

  const groups = catalog.data
    ? Object.entries(catalog.data.groups).map(([key, label]) => ({
        key,
        label,
        items: catalog.data!.permissions.filter((p) => p.group === key),
      }))
    : [];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      size="lg"
      title={editing ? `Editar ${employee!.displayName}` : 'Novo funcionário'}
      description="Dados de identificação, funções e permissões de acesso."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            loading={mutation.isPending}
            onClick={() => {
              setFormError(null);
              mutation.mutate();
            }}
          >
            {editing ? 'Salvar alterações' : 'Cadastrar'}
          </Button>
        </>
      }
    >
      <form
        className="space-y-6"
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate();
        }}
        noValidate
      >
        {formError && <Alert tone="danger">{formError}</Alert>}

        <fieldset className="grid gap-4 sm:grid-cols-2">
          <legend className="mb-3 text-sm font-semibold text-ink">Identificação</legend>
          <Field label="Nome completo" error={errors.fullName} required>
            {(p) => (
              <Input
                {...p}
                value={form.fullName}
                onChange={(e) => set('fullName', e.target.value)}
              />
            )}
          </Field>
          <Field
            label="Nome de exibição"
            error={errors.displayName}
            hint="Aparece nos tablets."
            required
          >
            {(p) => (
              <Input
                {...p}
                value={form.displayName}
                onChange={(e) => set('displayName', e.target.value)}
              />
            )}
          </Field>
          <Field label="Cargo / atuação" error={errors.jobTitle} required>
            {(p) => (
              <Input
                {...p}
                value={form.jobTitle}
                onChange={(e) => set('jobTitle', e.target.value)}
              />
            )}
          </Field>
          <Field label="Telefone" error={errors.phone}>
            {(p) => (
              <Input
                {...p}
                inputMode="tel"
                value={form.phone}
                onChange={(e) => set('phone', e.target.value)}
              />
            )}
          </Field>
          <Field
            label="Responsabilidades"
            error={errors.responsibilities}
            className="sm:col-span-2"
          >
            {(p) => (
              <Textarea
                {...p}
                rows={2}
                value={form.responsibilities}
                onChange={(e) => set('responsibilities', e.target.value)}
              />
            )}
          </Field>
          <div className="sm:col-span-2">
            <p className="label" id="color-label">
              Cor de identificação
            </p>
            <div
              role="radiogroup"
              aria-labelledby="color-label"
              className="flex flex-wrap items-center gap-2"
            >
              {COLOR_PRESETS.map((c) => (
                <button
                  key={c}
                  type="button"
                  role="radio"
                  aria-checked={form.color.toUpperCase() === c}
                  aria-label={`Cor ${c}`}
                  onClick={() => set('color', c)}
                  className="size-8 rounded-full ring-offset-2 aria-checked:ring-2 aria-checked:ring-ink"
                  style={{ backgroundColor: c }}
                />
              ))}
              <label className="ml-1 inline-flex items-center gap-2 text-sm text-ink-muted">
                <input
                  type="color"
                  value={form.color}
                  onChange={(e) => set('color', e.target.value.toUpperCase())}
                  className="size-8 cursor-pointer rounded border border-line"
                  aria-label="Escolher outra cor"
                />
                Outra
              </label>
            </div>
            {errors.color && <p className="mt-1.5 text-sm text-danger-600">{errors.color}</p>}
          </div>
        </fieldset>

        <fieldset>
          <legend className="mb-3 text-sm font-semibold text-ink">Funções</legend>
          {errors.roleIds && <p className="mb-2 text-sm text-danger-600">{errors.roleIds}</p>}
          <div className="grid gap-3 sm:grid-cols-2">
            {roles.data?.map((r) => (
              <Checkbox
                key={r.id}
                label={r.name}
                description={r.description ?? undefined}
                checked={form.roleIds.includes(r.id)}
                onChange={(e) =>
                  set(
                    'roleIds',
                    e.target.checked
                      ? [...form.roleIds, r.id]
                      : form.roleIds.filter((x) => x !== r.id),
                  )
                }
              />
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend className="mb-1 text-sm font-semibold text-ink">Permissões adicionais</legend>
          <p className="mb-3 text-sm text-ink-muted">
            Concessões individuais além das funções. Permissões já incluídas nas funções aparecem
            marcadas e bloqueadas.
          </p>
          <div className="space-y-4">
            {groups.map((g) => (
              <div key={g.key}>
                <p className="mb-2 text-xs font-semibold tracking-wide text-ink-muted uppercase">
                  {g.label}
                </p>
                <div className="grid gap-2.5 sm:grid-cols-2">
                  {g.items.map((p) => {
                    const viaRole = rolePerms.has(p.key);
                    return (
                      <Checkbox
                        key={p.key}
                        label={
                          <span className="inline-flex items-center gap-2">
                            {p.label} {p.critical && <Badge tone="bronze">crítica</Badge>}
                          </span>
                        }
                        checked={viaRole || form.extraPermissions.includes(p.key)}
                        disabled={viaRole}
                        onChange={(e) =>
                          set(
                            'extraPermissions',
                            e.target.checked
                              ? [...form.extraPermissions, p.key as Permission]
                              : form.extraPermissions.filter((x) => x !== p.key),
                          )
                        }
                      />
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </fieldset>

        {!editing && (
          <fieldset className="grid gap-4 sm:grid-cols-2">
            <legend className="mb-1 text-sm font-semibold text-ink">Acesso (opcional)</legend>
            <p className="text-sm text-ink-muted sm:col-span-2">
              Pode ser definido depois. O PIN é usado nos tablets; e-mail e senha, no painel.
            </p>
            <Field label="PIN do tablet (6 dígitos)" error={errors.pin}>
              {(p) => (
                <Input
                  {...p}
                  inputMode="numeric"
                  autoComplete="off"
                  maxLength={6}
                  value={form.pin}
                  onChange={(e) => set('pin', e.target.value.replace(/\D/g, ''))}
                />
              )}
            </Field>
            <div className="hidden sm:block" />
            <Field label="E-mail do painel" error={errors.email}>
              {(p) => (
                <Input
                  {...p}
                  type="email"
                  autoComplete="off"
                  value={form.email}
                  onChange={(e) => set('email', e.target.value)}
                />
              )}
            </Field>
            <Field
              label="Senha do painel"
              error={errors.password}
              hint="Mínimo de 10 caracteres, com letras e números."
            >
              {(p) => (
                <Input
                  {...p}
                  type="password"
                  autoComplete="new-password"
                  value={form.password}
                  onChange={(e) => set('password', e.target.value)}
                />
              )}
            </Field>
          </fieldset>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
