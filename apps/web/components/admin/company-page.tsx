'use client';

import type { CompanySettingsDto, ModuleSettingDto, OwnTeamSettingsDto } from '@cenario/shared';
import { WEEKDAYS, companySettingsSchema } from '@cenario/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Save } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox, Field, Input, Select } from '@/components/ui/field';
import { MoneyField } from '@/components/ui/form';
import { Alert, Card, PageHeader, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { ApiError, api, errorMessage, fieldErrors, newIdempotencyKey } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useCan, useMe } from '@/lib/hooks';
import { useCompany } from '@/lib/queries';
import { useOwnTeamSettings } from '@/lib/commercial';
import { ExportDataCard, SupportAccessCard } from '@/components/improvements/company-extras';
import { PrivacyRequestCard } from '@/components/improvements/privacy-extras';

const TIMEZONES = [
  { value: 'America/Sao_Paulo', label: 'Horário de Brasília' },
  { value: 'America/Bahia', label: 'Bahia' },
  { value: 'America/Fortaleza', label: 'Nordeste (Fortaleza, Recife)' },
  { value: 'America/Belem', label: 'Pará e Amapá' },
  { value: 'America/Manaus', label: 'Amazonas (Manaus)' },
  { value: 'America/Cuiaba', label: 'Mato Grosso e Mato Grosso do Sul' },
  { value: 'America/Porto_Velho', label: 'Rondônia' },
  { value: 'America/Rio_Branco', label: 'Acre' },
  { value: 'America/Noronha', label: 'Fernando de Noronha' },
];

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
  const me = useMe();
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
        description="Dados da empresa e horários da oficina."
        help="Os dados que saem na proposta e na OS (nome, telefone, endereço) e o horário da oficina. O horário de trabalho é usado para calcular os prazos e a semana da oficina."
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
            {text('arrivalWindowStart', '“Cheguei” disponível a partir de', { type: 'time' })}
            {text('workdayStart', 'Início previsto do expediente', {
              type: 'time',
              hint: 'Chegada depois deste horário registra atraso operacional.',
            })}
            {text('arrivalAlertAt', 'Ausência presumida às', {
              type: 'time',
              hint: 'Sem confirmação até aqui: alerta ao gestor (não é falta).',
            })}
            {text('workdayEnd', 'Fim do expediente', { type: 'time' })}
            <Field
              label="Avisar o gestor de atraso a partir de (min)"
              error={errors.lateAlertMinutes}
            >
              {(p) => (
                <Input
                  {...p}
                  type="number"
                  min={0}
                  max={240}
                  disabled={!editable}
                  value={String(form.lateAlertMinutes)}
                  onChange={(e) => set('lateAlertMinutes', Number(e.target.value))}
                />
              )}
            </Field>
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
          </div>
          <div className="mt-5">
            {/* Melhoria 166: fuso com nome de gente, não o código técnico. */}
            <Field label="Fuso horário">
              {(p) => (
                <Select
                  {...p}
                  disabled={!editable}
                  value={form.timezone}
                  onChange={(e) => set('timezone', e.target.value)}
                >
                  {[
                    ...TIMEZONES,
                    ...(TIMEZONES.some((t) => t.value === form.timezone)
                      ? []
                      : [{ value: form.timezone, label: form.timezone }]),
                  ].map((t) => (
                    <option key={t.value} value={t.value}>
                      {t.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          {/* Perguntas do começo (26/11/2026): dá para mudar a resposta aqui depois. */}
          <div className="mt-5 grid gap-4 sm:grid-cols-2">
            <Checkbox
              label="Faço serviço na casa do cliente"
              description="Desligado, a opção “No local” some do fechamento do serviço."
              disabled={!editable}
              checked={form.servesOnSite}
              onChange={(e) => set('servesOnSite', e.target.checked)}
              data-testid="company-serves-on-site"
            />
            <MoneyField
              label="Meta de faturamento do mês"
              hint="Aparece no Financeiro. Deixe em branco para não usar."
              disabled={!editable}
              cents={form.monthlyGoalCents}
              onCents={(v) => set('monthlyGoalCents', v)}
              data-testid="company-monthly-goal"
            />
          </div>
        </Card>
      </div>
      <OwnTeamCard />
      <ModulesCard />
      {can('empresa.configurar') && (
        <>
          <SupportAccessCard />
          <ExportDataCard />
          {!me.data?.company.platformOwner && <PrivacyRequestCard scope="EMPRESA" />}
        </>
      )}
      <p className="mt-4 text-xs text-ink-muted">
        Última alteração: {formatDateTime(company.data.updatedAt)} · versão {company.data.version}
      </p>
    </>
  );
}

/**
 * Simplificação Fase 2: responsável padrão da retirada pela equipe própria (Thiago). Referência ao
 * cadastro real do funcionário; inativo/inelegível vira pendência visível (nunca troca sozinho).
 */
function OwnTeamCard() {
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const settings = useOwnTeamSettings();
  const editable = can('empresa.configurar');
  const [userId, setUserId] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () =>
      api<OwnTeamSettingsDto>('/api/v1/company/own-team', {
        method: 'PUT',
        body: { userId: userId || null, version: settings.data!.version },
      }),
    onSuccess: (r) => {
      qc.setQueryData(['own-team-settings'], r);
      void qc.invalidateQueries({ queryKey: ['company'] });
      void qc.invalidateQueries({ queryKey: ['new-service-defaults'] });
      setUserId(null);
      toast('ok', 'Responsável padrão da equipe própria salvo.');
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT')
        void qc.invalidateQueries({ queryKey: ['own-team-settings'] });
      toast('danger', errorMessage(e));
    },
  });
  if (settings.isPending) return <Spinner />;
  if (!settings.data) return null;
  const s = settings.data;
  const current = userId ?? s.userId ?? '';
  return (
    <Card className="mt-6 p-6" data-testid="own-team-card">
      <h2 className="font-semibold">Retiradas da equipe própria</h2>
      <p className="mt-1 text-sm text-ink-muted">
        Sugerido automaticamente no Novo serviço quando a retirada é feita pela equipe própria.
      </p>
      {s.problem && (
        <Alert tone="warn" className="mt-4">
          {s.problem === 'NAO_CONFIGURADO'
            ? 'Nenhum responsável padrão configurado: o gestor escolhe a cada retirada.'
            : `${s.displayName ?? 'O responsável configurado'} está ${s.problem === 'INATIVO' ? 'inativo' : 'sem permissão para executar'}. Escolha outro.`}
        </Alert>
      )}
      <div className="mt-4 grid gap-4 sm:grid-cols-12">
        <Field label="Responsável padrão da equipe própria" className="sm:col-span-6">
          {(p) => (
            <Select
              {...p}
              disabled={!editable}
              value={current}
              onChange={(e) => setUserId(e.target.value)}
              data-testid="own-team-select"
            >
              <option value="">Nenhum (escolher a cada retirada)</option>
              {s.candidates.map((c) => (
                <option key={c.userId} value={c.userId}>
                  {c.displayName}
                </option>
              ))}
              {s.userId && !s.candidates.some((c) => c.userId === s.userId) && (
                <option value={s.userId} disabled>
                  {s.displayName} (indisponível)
                </option>
              )}
            </Select>
          )}
        </Field>
        {editable && (
          <div className="field-action sm:col-span-3">
            <Button
              type="button"
              icon={<Save className="size-4" />}
              loading={save.isPending}
              disabled={userId === null || (userId || null) === s.userId}
              onClick={() => save.mutate()}
              data-testid="own-team-save"
            >
              Definir responsável
            </Button>
          </div>
        )}
      </div>
    </Card>
  );
}

/**
 * Reformulação, Fase 0: funcionalidades que podem ser desligadas sem apagar nada. Quem decide é o
 * servidor (recusa o que estiver desligado); aqui só o gestor com `empresa.configurar` altera.
 */
function ModulesCard() {
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const editable = can('empresa.configurar');
  const list = useQuery({
    queryKey: ['company', 'modules', 'list'],
    queryFn: () => api<ModuleSettingDto[]>('/api/company/modules'),
  });
  const save = useMutation({
    mutationFn: (m: ModuleSettingDto) =>
      api<ModuleSettingDto>(`/api/company/modules/${m.key}`, {
        method: 'PUT',
        body: { enabled: !m.enabled, version: m.version },
        idempotencyKey: newIdempotencyKey(),
      }),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['company', 'modules'] });
      toast('ok', `${r.label}: ${r.enabled ? 'ativada' : 'desativada'}.`);
    },
    onError: (e) => {
      void qc.invalidateQueries({ queryKey: ['company', 'modules'] });
      toast('danger', errorMessage(e));
    },
  });
  if (list.isPending) return <Spinner />;
  if (!list.data) return null;
  return (
    <Card className="mt-6 p-6" data-testid="modules-card">
      <h2 className="font-semibold">Funcionalidades</h2>
      <p className="mt-1 text-sm text-ink-muted">
        Desligar não apaga nada: o histórico continua disponível para consulta e religar volta ao
        funcionamento anterior.
      </p>
      <div className="mt-4 grid gap-4">
        {list.data.map((m) => (
          <div key={m.key} data-testid={`module-${m.key}`}>
            <Checkbox
              label={`${m.label}${m.configurable ? '' : ' (segue o plano em Assinatura)'}`}
              description={m.description}
              checked={m.enabled}
              disabled={!editable || !m.configurable || save.isPending}
              onChange={() => save.mutate(m)}
              data-testid={`module-${m.key}-toggle`}
            />
            {m.updatedAt && (
              <p className="mt-1 pl-8 text-xs text-ink-muted">
                {m.enabled ? 'Ativada' : 'Desativada'} por {m.updatedBy?.displayName ?? '—'} em{' '}
                {formatDateTime(m.updatedAt)}
              </p>
            )}
          </div>
        ))}
      </div>
    </Card>
  );
}
