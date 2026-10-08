'use client';

import type { CompanySettingsDto } from '@cenario/shared';
import { WEEKDAYS, companySettingsSchema } from '@cenario/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Save } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Alert, Card, PageHeader, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { ApiError, api, errorMessage, fieldErrors } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useCan } from '@/lib/hooks';
import { useCompany } from '@/lib/queries';

type Form = Omit<
  CompanySettingsDto,
  'updatedAt' | 'legalName' | 'document' | 'phone' | 'email' | 'address'
> & {
  legalName: string;
  document: string;
  phone: string;
  email: string;
  address: string;
};

function toForm(c: CompanySettingsDto): Form {
  return {
    ...c,
    legalName: c.legalName ?? '',
    document: c.document ?? '',
    phone: c.phone ?? '',
    email: c.email ?? '',
    address: c.address ?? '',
  };
}

export function CompanyPage() {
  const can = useCan();
  const company = useCompany();
  const qc = useQueryClient();
  const toast = useToast();
  const editable = can('empresa.configurar');
  const [form, setForm] = useState<Form | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  // Atualizações em tempo real substituem o formulário apenas se não houver edição em andamento.
  useEffect(() => {
    if (company.data && !dirty) setForm(toForm(company.data));
  }, [company.data, dirty]);

  const m = useMutation({
    mutationFn: () => {
      const parsed = companySettingsSchema.safeParse(form);
      if (!parsed.success) {
        const map: Record<string, string> = {};
        for (const i of parsed.error.issues) map[String(i.path[0])] ??= i.message;
        setErrors(map);
        throw new Error('Revise os campos destacados.');
      }
      return api<CompanySettingsDto>('/api/company/settings', { method: 'PUT', body: parsed.data });
    },
    onSuccess: (saved) => {
      qc.setQueryData(['company'], saved);
      void qc.invalidateQueries({ queryKey: ['me'] });
      setDirty(false);
      setErrors({});
      setError(null);
      toast('ok', 'Configurações salvas.');
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT') {
        setDirty(false);
        void qc.invalidateQueries({ queryKey: ['company'] });
      }
      setErrors((prev) => ({ ...prev, ...fieldErrors(e) }));
      setError(
        e instanceof ApiError ? e.message : e instanceof Error ? e.message : errorMessage(e),
      );
    },
  });

  if (company.isPending || !form) return <Spinner />;
  if (company.isError) return <Alert tone="danger">{company.error.message}</Alert>;

  const set = <K extends keyof Form>(k: K, v: Form[K]) => {
    setDirty(true);
    setForm((f) => (f ? { ...f, [k]: v } : f));
  };

  const text = (
    key: keyof Form,
    label: string,
    opts: { hint?: string; required?: boolean; type?: string } = {},
  ) => (
    <Field label={label} error={errors[key]} hint={opts.hint} required={opts.required}>
      {(p) => (
        <Input
          {...p}
          type={opts.type ?? 'text'}
          disabled={!editable}
          value={String(form[key] ?? '')}
          onChange={(e) => set(key, e.target.value as never)}
        />
      )}
    </Field>
  );

  return (
    <>
      <PageHeader
        title="Empresa"
        description="Dados da empresa e parâmetros operacionais usados pelos próximos módulos."
        actions={
          editable && (
            <Button
              icon={<Save className="size-4" aria-hidden />}
              loading={m.isPending}
              disabled={!dirty}
              onClick={() => m.mutate()}
            >
              Salvar
            </Button>
          )
        }
      />
      {error && (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      )}
      {!editable && (
        <Alert tone="info" className="mb-4">
          Você pode consultar, mas não alterar, estas configurações.
        </Alert>
      )}
      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="p-6">
          <h2 className="mb-4 font-semibold">Dados cadastrais</h2>
          <div className="grid gap-4">
            {text('tradeName', 'Nome fantasia', { required: true })}
            {text('legalName', 'Razão social')}
            <div className="grid gap-4 sm:grid-cols-2">
              {text('document', 'CNPJ')}
              {text('phone', 'Telefone')}
            </div>
            {text('email', 'E-mail', { type: 'email' })}
            {text('address', 'Endereço')}
          </div>
        </Card>

        <Card className="p-6">
          <h2 className="font-semibold">Expediente e presença</h2>
          <p className="mt-1 mb-4 text-sm text-ink-muted">
            Controle operacional de disponibilidade — não é ponto eletrônico e não gera falta ou
            desconto automaticamente.
          </p>
          <div className="grid gap-4 sm:grid-cols-3">
            {text('workdayStart', '“Cheguei” a partir de', { type: 'time' })}
            {text('arrivalAlertAt', 'Alerta de ausência às', { type: 'time' })}
            {text('workdayEnd', 'Fim do expediente', { type: 'time' })}
          </div>
          <fieldset className="mt-5">
            <legend className="label">Dias de trabalho</legend>
            {errors.workingDays && (
              <p className="mb-2 text-sm text-danger-600">{errors.workingDays}</p>
            )}
            <div className="flex flex-wrap gap-2">
              {WEEKDAYS.map((d) => {
                const on = form.workingDays.includes(d.value);
                return (
                  <button
                    key={d.value}
                    type="button"
                    disabled={!editable}
                    aria-pressed={on}
                    onClick={() =>
                      set(
                        'workingDays',
                        on
                          ? form.workingDays.filter((x) => x !== d.value)
                          : [...form.workingDays, d.value].sort(),
                      )
                    }
                    className="rounded-xl border border-line-strong px-3 py-2 text-sm font-medium text-ink-soft aria-pressed:border-brand-600 aria-pressed:bg-brand-50 aria-pressed:text-brand-700 disabled:cursor-not-allowed"
                  >
                    {d.label.slice(0, 3)}
                  </button>
                );
              })}
            </div>
          </fieldset>
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <Field label="Dia habitual de programação" hint="Programação da semana seguinte.">
              {(p) => (
                <Select
                  {...p}
                  disabled={!editable}
                  value={form.planningWeekday}
                  onChange={(e) => set('planningWeekday', Number(e.target.value))}
                >
                  {WEEKDAYS.map((d) => (
                    <option key={d.value} value={d.value}>
                      {d.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Dia habitual de medição" hint="Tecidos e espumas.">
              {(p) => (
                <Select
                  {...p}
                  disabled={!editable}
                  value={form.measurementWeekday}
                  onChange={(e) => set('measurementWeekday', Number(e.target.value))}
                >
                  {WEEKDAYS.map((d) => (
                    <option key={d.value} value={d.value}>
                      {d.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          <div className="mt-5">
            {text('timezone', 'Fuso horário', { hint: 'Padrão: America/Sao_Paulo' })}
          </div>
        </Card>
      </div>
      <p className="mt-4 text-xs text-ink-muted">
        Última alteração: {formatDateTime(company.data.updatedAt)} · versão {company.data.version}
      </p>
    </>
  );
}
