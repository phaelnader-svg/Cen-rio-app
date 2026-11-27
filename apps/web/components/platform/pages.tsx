'use client';

import {
  PASSWORD_RULE_HINT,
  SIGNUP_SOURCES,
  SIGNUP_SOURCE_LABEL,
  pixBrCode,
  type PlanKey,
  type SignupSource,
  type PlatformAuditDto,
  type PlatformCompanyDto,
  type PlatformDashboardDto,
  type PlatformPaymentDto,
  type PlatformSettingsDto,
} from '@cenario/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import {
  Ban,
  Building2,
  CircleCheck,
  Copy,
  HandCoins,
  History,
  MessageCircle,
  Pencil,
  Plus,
  PowerOff,
  Undo2,
} from 'lucide-react';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input } from '@/components/ui/field';
import {
  DateField,
  FormActions,
  FormGrid,
  FormSection,
  MoneyField,
  NumberField,
  SelectField,
  TextAreaField,
  TextField,
} from '@/components/ui/form';
import { Alert, Badge, Card, EmptyState, PageHeader, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage, fieldErrors } from '@/lib/api';
import { formatCents, formatDay } from '@/lib/billing';
import { formatDateTime } from '@/lib/format';
import {
  DemoCompanyCard,
  FeedbackInbox,
  NoticesCard,
  SupportSessionButton,
} from '@/components/improvements/platform-extras';
import { PrivacyRequestsInbox } from '@/components/improvements/privacy-extras';
import { PixQr } from '@/components/billing/pix-proof';
import { UsageThermometer } from './usage-thermometer';
import {
  CloseCompanyDialog,
  ClosedCompanyBar,
  DemosCard,
  FeedbackGroupsCard,
  MessageTemplatesForm,
  ProofsInbox,
  PushCard,
  ScreenUsageCard,
  SourcesCard,
  TimelineDialog,
} from '@/components/platform/painel-extras';

const PLAN_LABEL: Record<PlanKey, string> = {
  gestao: 'Cenário Gestão',
  gestao_jogo: 'Cenário Gestão + Firma Viva',
};
const todayYmd = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date());
const ymdOf = (iso: string | null) =>
  iso
    ? new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Sao_Paulo' }).format(new Date(iso))
    : '';
const perCycle = (c: { cycle: string }) => (c.cycle === 'ANUAL' ? '/ano' : '/mês');

function useCompanies() {
  return useQuery({
    queryKey: ['platform-companies'],
    queryFn: () => api<{ items: PlatformCompanyDto[] }>('/api/v1/platform/companies'),
  });
}
function useSettings() {
  return useQuery({
    queryKey: ['platform-settings'],
    queryFn: () => api<PlatformSettingsDto>('/api/v1/platform/settings'),
  });
}

/** Situação em uma frase, com a cor que o dono pediu (verde em dia, vermelho atraso). */
function DueBadge({ c }: { c: PlatformCompanyDto }) {
  const d = c.daysToDue;
  if (c.blockedAt) return <Badge tone="danger">Bloqueada</Badge>;
  switch (c.tone) {
    case 'courtesy':
      return <Badge tone="info">Cortesia</Badge>;
    case 'trial':
      return (
        <Badge tone="info">
          Teste até {formatDay(c.trialEndsAt)}
          {d !== null && d <= 2
            ? d === 0
              ? ' (hoje)'
              : ` (${d} ${d === 1 ? 'dia' : 'dias'})`
            : ''}
        </Badge>
      );
    case 'soon':
      return (
        <Badge tone="warn">
          Vence {d === 0 ? 'hoje' : d === 1 ? 'amanhã' : `em ${d} dias`} ({formatDay(c.dueAt)})
        </Badge>
      );
    case 'late':
      return (
        <Badge tone="danger">
          Atrasada {d !== null ? `${-d} ${-d === 1 ? 'dia' : 'dias'}` : ''}
        </Badge>
      );
    case 'blocked':
      return <Badge tone="danger">Bloqueada sem pagamento</Badge>;
    default:
      return <Badge tone="ok">Em dia até {formatDay(c.paidUntil)}</Badge>;
  }
}

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'danger' | 'ok';
}) {
  return (
    <Card className="p-4">
      <p className="text-sm font-medium text-ink-muted">{label}</p>
      <p
        className={clsx(
          'mt-1 text-2xl font-semibold tabular-nums',
          tone === 'danger' && 'text-danger-600',
          tone === 'ok' && 'text-ok-600',
        )}
      >
        {value}
      </p>
      {hint && <p className="mt-0.5 text-xs text-ink-muted">{hint}</p>}
    </Card>
  );
}

// ───────────────────────────── Início ─────────────────────────────
export function PlatformDashboard() {
  const q = useQuery({
    queryKey: ['platform-dashboard'],
    queryFn: () => api<PlatformDashboardDto>('/api/v1/platform/dashboard'),
  });
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{errorMessage(q.error)}</Alert>;
  const d = q.data;
  const max = Math.max(1, ...d.byMonth.map((m) => m.cents));
  const monthName = (m: string) =>
    new Date(`${m}-15T12:00:00Z`).toLocaleDateString('pt-BR', { month: 'short' }).replace('.', '');
  return (
    <>
      <PageHeader title="Início" description="Como está o Cenário Gestão como negócio." />
      {!d.pixConfigured && (
        <Alert tone="warn" className="mb-4" title="Falta a chave PIX">
          Sem ela, o cliente não sabe como pagar quando o teste acaba.{' '}
          <Link href="/plataforma/recebimento" className="font-semibold underline">
            Cadastrar em Como eu recebo
          </Link>
        </Alert>
      )}
      {d.pendingProofs > 0 && (
        <Alert
          tone="warn"
          className="mb-4"
          title="Comprovante para conferir"
          data-testid="inicio-comprovantes"
        >
          {d.pendingProofs === 1
            ? 'Uma empresa mandou o comprovante do PIX.'
            : `${d.pendingProofs} empresas mandaram o comprovante do PIX.`}{' '}
          <Link href="/plataforma/cobranca" className="font-semibold underline">
            Conferir em Cobrança
          </Link>
        </Alert>
      )}
      {d.demosPending > 0 && (
        <Alert
          tone="info"
          className="mb-4"
          title="Demonstração marcada"
          data-testid="inicio-demonstracoes"
        >
          {d.demosPending === 1
            ? 'Tem uma demonstração marcada pelo site.'
            : `Tem ${d.demosPending} demonstrações marcadas pelo site.`}{' '}
          <Link href="/plataforma/avisos" className="font-semibold underline">
            Ver em Avisos e pedidos
          </Link>
        </Alert>
      )}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat
          label="Receita por mês"
          value={formatCents(d.mrrCents)}
          hint="anual dividido por 12"
        />
        <Stat label="Recebido este mês" value={formatCents(d.receivedThisMonthCents)} tone="ok" />
        <Stat
          label="Vence em 7 dias"
          value={formatCents(d.dueNext7Cents)}
          hint={`${d.dueNext7.length} ${d.dueNext7.length === 1 ? 'empresa' : 'empresas'}`}
        />
        <Stat
          label="Atrasadas"
          value={String(d.late)}
          tone={d.late > 0 ? 'danger' : undefined}
          hint={d.blocked ? `${d.blocked} bloqueada${d.blocked > 1 ? 's' : ''}` : undefined}
        />
        <Stat label="Pagando" value={String(d.paying)} />
        <Stat label="Em teste grátis" value={String(d.trial)} />
        <Stat label="Contas novas no mês" value={String(d.newThisMonth)} />
        <Stat
          label="Bloqueio automático"
          value={d.autoBlock ? 'Ligado' : 'Desligado'}
          hint={d.autoBlock ? undefined : 'ninguém é bloqueado sozinho'}
        />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        <Card className="p-5 lg:col-span-2">
          <h2 className="font-semibold">Recebido por mês</h2>
          <p className="text-sm text-ink-muted">Os pagamentos marcados em Cobrança.</p>
          <div
            className="mt-4 flex h-44 items-end gap-1.5"
            role="img"
            aria-label="Recebido por mês"
          >
            {d.byMonth.map((m) => (
              <div key={m.month} className="flex flex-1 flex-col items-center gap-1">
                <span className="text-[10px] text-ink-muted tabular-nums">
                  {m.cents ? Math.round(m.cents / 100).toLocaleString('pt-BR') : ''}
                </span>
                <div
                  className="w-full rounded-t-md bg-brand-600"
                  style={{ height: `${Math.max(2, (m.cents / max) * 130)}px` }}
                  title={`${monthName(m.month)}: ${formatCents(m.cents)}`}
                />
                <span className="text-[11px] text-ink-muted">{monthName(m.month)}</span>
              </div>
            ))}
          </div>
        </Card>
        <Card className="p-5">
          <h2 className="font-semibold">Para receber</h2>
          {d.lateList.length === 0 && d.dueNext7.length === 0 && d.trialEnding.length === 0 ? (
            <p className="mt-2 text-sm text-ink-muted">Nada vencendo nos próximos 7 dias.</p>
          ) : (
            <ul className="mt-3 space-y-2 text-sm">
              {d.lateList.map((x) => (
                <li key={`l${x.id}`} className="flex justify-between gap-2">
                  <span className="truncate">
                    <span className="font-medium text-danger-600">{x.tradeName}</span>
                    <span className="block text-xs text-ink-muted">
                      atrasada {x.days} {x.days === 1 ? 'dia' : 'dias'}
                    </span>
                  </span>
                  <span className="font-medium tabular-nums">{formatCents(x.priceCents)}</span>
                </li>
              ))}
              {d.dueNext7.map((x) => (
                <li key={`v${x.id}`} className="flex justify-between gap-2">
                  <span className="truncate">
                    <span className="font-medium">{x.tradeName}</span>
                    <span className="block text-xs text-ink-muted">vence {formatDay(x.dueAt)}</span>
                  </span>
                  <span className="font-medium tabular-nums">{formatCents(x.priceCents)}</span>
                </li>
              ))}
              {d.trialEnding.map((x) => (
                <li key={`t${x.id}`} className="flex justify-between gap-2">
                  <span className="truncate">
                    <span className="font-medium">{x.tradeName}</span>
                    <span className="block text-xs text-ink-muted">
                      teste acaba {formatDay(x.trialEndsAt)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
          <Link
            href="/plataforma/cobranca"
            className="mt-4 inline-block text-sm font-semibold text-brand-700 hover:underline"
          >
            Abrir a Cobrança
          </Link>
        </Card>
        <SourcesCard d={d} />
      </div>
    </>
  );
}

// ───────────────────────────── Empresas ─────────────────────────────
export function PlatformCompanies() {
  const qc = useQueryClient();
  const toast = useToast();
  const list = useCompanies();
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<PlatformCompanyDto | null>(null);
  const [creating, setCreating] = useState(false);
  const [timeline, setTimeline] = useState<PlatformCompanyDto | null>(null);
  const [closing, setClosing] = useState<PlatformCompanyDto | null>(null);
  const toggle = useMutation({
    mutationFn: (c: PlatformCompanyDto) =>
      api(`/api/v1/platform/companies/${c.id}/${c.blockedAt ? 'unblock' : 'block'}`, {
        method: 'POST',
        body: {},
      }),
    onSuccess: (_r, c) => {
      toast(
        'ok',
        c.blockedAt
          ? `${c.tradeName} liberada: a equipe já pode entrar.`
          : `${c.tradeName} bloqueada: ninguém dela entra até você liberar.`,
      );
      void qc.invalidateQueries({ queryKey: ['platform-companies'] });
    },
    onError: (e) => toast('danger', errorMessage(e)),
  });
  const helpDone = useMutation({
    mutationFn: (id: number) =>
      api(`/api/v1/platform/companies/${id}/help-done`, { method: 'POST', body: {} }),
    onSuccess: () => {
      toast('ok', 'Pedido de ajuda marcado como atendido.');
      void qc.invalidateQueries({ queryKey: ['platform-companies'] });
    },
    onError: (e) => toast('danger', errorMessage(e)),
  });
  // Aviso "parou de entrar" no celular: abre aqui com ?parada=<empresa>.
  const [parada] = useState<number | null>(() =>
    typeof window === 'undefined'
      ? null
      : Number(new URLSearchParams(window.location.search).get('parada')) || null,
  );
  const items = useMemo(() => {
    const s = search.trim().toLowerCase();
    const all = (list.data?.items ?? []).filter(
      (c) =>
        !s ||
        c.tradeName.toLowerCase().includes(s) ||
        (c.ownerEmail ?? '').toLowerCase().includes(s) ||
        (c.ownerName ?? '').toLowerCase().includes(s) ||
        (c.phone ?? '').replace(/\D/g, '').includes(s.replace(/\D/g, '') || '~'),
    );
    // Aviso de empresa parada (celular): ela aparece primeiro.
    return parada
      ? [...all].sort((x, y) => Number(y.id === parada) - Number(x.id === parada))
      : all;
  }, [list.data, search, parada]);

  return (
    <>
      <PageHeader
        title="Empresas"
        description="Todas as empresas que usam o Cenário Gestão."
        actions={
          <Button icon={<Plus className="size-4" aria-hidden />} onClick={() => setCreating(true)}>
            Cadastrar empresa
          </Button>
        }
      />
      <Input
        className="mb-4 max-w-sm"
        placeholder="Buscar por nome, e-mail ou telefone"
        aria-label="Buscar empresa"
        value={search}
        onChange={(e) => setSearch(e.target.value)}
      />
      {list.isPending && <Spinner />}
      {list.isError && <Alert tone="danger">{errorMessage(list.error)}</Alert>}
      {list.isSuccess && items.length === 0 && (
        <EmptyState
          icon={<Building2 className="size-6" aria-hidden />}
          title="Nenhuma empresa encontrada"
        />
      )}
      <div className="space-y-3">
        {items.map((c) => (
          <Card
            key={c.id}
            className={clsx('p-4', c.id === parada && 'ring-2 ring-danger-600/40')}
            data-testid="platform-company"
          >
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-semibold text-ink">{c.tradeName}</p>
                  {c.serverConnections && <Badge tone="brand">Conexões do servidor</Badge>}
                  {c.isDemo && <Badge tone="bronze">Demonstração</Badge>}
                  {!c.closedAt && <DueBadge c={c} />}
                  {c.canceledAt && !c.closedAt && (
                    <Badge tone="danger">Cancelou em {formatDay(c.canceledAt)}</Badge>
                  )}
                  {c.closedAt && <Badge tone="danger">Encerrada</Badge>}
                  {c.pendingProofs > 0 && <Badge tone="warn">Comprovante para conferir</Badge>}
                  {c.signupSource && (
                    <span data-testid="empresa-origem">
                      <Badge tone="neutral">
                        Veio de: {SIGNUP_SOURCE_LABEL[c.signupSource]}
                        {c.signupSourceDetail ? ` (${c.signupSourceDetail})` : ''}
                      </Badge>
                    </span>
                  )}
                </div>
                {/* Contato de quem criou a conta (26/11/2026): nome, WhatsApp e e-mail. */}
                <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink-muted">
                  {c.ownerName && <span className="font-medium text-ink-soft">{c.ownerName}</span>}
                  {c.phone ? (
                    <span data-testid="empresa-whatsapp">{c.phone}</span>
                  ) : (
                    <Badge tone="danger">Sem telefone</Badge>
                  )}
                  {c.ownerEmail ? (
                    <a
                      href={`mailto:${c.ownerEmail}`}
                      className="underline-offset-4 hover:text-ink hover:underline"
                      data-testid="empresa-email"
                    >
                      {c.ownerEmail}
                      {!c.ownerEmailConfirmed ? ' (não confirmado)' : ''}
                    </a>
                  ) : (
                    <span>sem e-mail</span>
                  )}
                </p>
                <p className="text-sm text-ink-muted">
                  {c.planLabel} ·{' '}
                  {c.courtesy ? 'não paga' : `${formatCents(c.priceCents)}${perCycle(c)}`}
                  {c.billingPriceCents
                    ? c.billingPriceUntil
                      ? ` (valor combinado até ${formatDay(c.billingPriceUntil)})`
                      : ' (valor combinado)'
                    : ''}{' '}
                  · {c.users} {c.users === 1 ? 'usuário' : 'usuários'} · {c.orders}{' '}
                  {c.orders === 1 ? 'pedido' : 'pedidos'}
                </p>
                <p className="text-sm text-ink-muted">
                  Cadastro em {formatDateTime(c.createdAt)} · último acesso{' '}
                  {c.lastLoginAt ? formatDateTime(c.lastLoginAt) : 'nunca'}
                </p>
                <UsageThermometer c={c} />
                {/* Item 42 (26/11/2026): em que passo do começo a empresa parou. */}
                {c.gettingStarted && (
                  <p className="text-sm text-ink-muted" data-testid="empresa-comeco">
                    Começo: {c.gettingStarted.done} de {c.gettingStarted.total}
                    {c.gettingStarted.nextLabel ? (
                      <>
                        {' '}
                        · falta:{' '}
                        <span className="font-medium text-ink-soft">
                          {c.gettingStarted.nextLabel}
                        </span>
                      </>
                    ) : (
                      ' · fez tudo'
                    )}
                  </p>
                )}
                {c.helpRequestedFor && (
                  <div
                    className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-warn-50 px-3 py-2 text-sm"
                    data-testid="empresa-pediu-ajuda"
                  >
                    <span className="font-medium text-ink">
                      Pediu ajuda para começar: ligar{' '}
                      {new Date(c.helpRequestedFor).toLocaleString('pt-BR', {
                        timeZone: 'America/Sao_Paulo',
                        weekday: 'long',
                        day: '2-digit',
                        month: '2-digit',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                    <Button
                      size="sm"
                      variant="secondary"
                      icon={<CircleCheck className="size-4" aria-hidden />}
                      loading={helpDone.isPending && helpDone.variables === c.id}
                      onClick={() => helpDone.mutate(c.id)}
                      data-testid="empresa-ajuda-feita"
                    >
                      Atendido
                    </Button>
                  </div>
                )}
                {c.note && <p className="mt-1 text-sm text-ink-soft">Anotação: {c.note}</p>}
                {c.closedAt && <ClosedCompanyBar company={c} />}
              </div>
              <div className="flex flex-wrap gap-2 sm:justify-end">
                {c.contactWhatsappUrl && (
                  <a
                    href={c.contactWhatsappUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    title={`Chamar ${c.ownerName ?? c.tradeName} no WhatsApp`}
                    data-testid="empresa-chamar-whatsapp"
                    className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-ok-600 px-3 text-sm font-semibold text-white hover:bg-ok-600/90"
                  >
                    <MessageCircle className="size-4" aria-hidden /> WhatsApp
                  </a>
                )}
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<Pencil className="size-4" aria-hidden />}
                  onClick={() => setEditing(c)}
                >
                  Editar
                </Button>
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<History className="size-4" aria-hidden />}
                  onClick={() => setTimeline(c)}
                  data-testid="empresa-linha-do-tempo"
                >
                  Linha do tempo
                </Button>
                <SupportSessionButton
                  companyId={c.id}
                  tradeName={c.tradeName}
                  until={c.supportAccessUntil}
                />
                {!c.closedAt && (
                  <Button
                    size="sm"
                    variant={c.blockedAt ? 'secondary' : 'outline-danger'}
                    icon={
                      c.blockedAt ? (
                        <CircleCheck className="size-4" aria-hidden />
                      ) : (
                        <Ban className="size-4" aria-hidden />
                      )
                    }
                    loading={toggle.isPending && toggle.variables?.id === c.id}
                    onClick={() => toggle.mutate(c)}
                  >
                    {c.blockedAt ? 'Liberar' : 'Bloquear'}
                  </Button>
                )}
                {!c.closedAt && !c.isDemo && (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<PowerOff className="size-4" aria-hidden />}
                    onClick={() => setClosing(c)}
                    data-testid="empresa-encerrar"
                  >
                    Encerrar
                  </Button>
                )}
              </div>
            </div>
          </Card>
        ))}
      </div>
      {editing && <EditCompanyDialog company={editing} onClose={() => setEditing(null)} />}
      {creating && <CreateCompanyDialog onClose={() => setCreating(false)} />}
      {timeline && <TimelineDialog company={timeline} onClose={() => setTimeline(null)} />}
      {closing && <CloseCompanyDialog company={closing} onClose={() => setClosing(null)} />}
    </>
  );
}

function EditCompanyDialog({
  company,
  onClose,
}: {
  company: PlatformCompanyDto;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState({
    tradeName: company.tradeName,
    email: company.email ?? '',
    phone: company.phone ?? '',
    document: company.document ?? '',
    plan: company.plan,
    cycle: company.cycle,
    courtesy: company.courtesy,
    billingPriceCents: company.billingPriceCents,
    paidUntil: ymdOf(company.paidUntil),
    trialEndsAt: ymdOf(company.trialEndsAt),
    note: company.note ?? '',
    serverConnections: company.serverConnections,
    billingPriceUntil: ymdOf(company.billingPriceUntil),
    signupSource: (company.signupSource ?? '') as SignupSource | '',
    signupSourceDetail: company.signupSourceDetail ?? '',
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));
  const save = useMutation({
    mutationFn: () =>
      api(`/api/v1/platform/companies/${company.id}`, {
        method: 'PUT',
        body: {
          ...f,
          paidUntil: f.paidUntil || null,
          trialEndsAt: f.trialEndsAt || null,
          billingPriceUntil: f.billingPriceCents ? f.billingPriceUntil || null : null,
          signupSource: f.signupSource || null,
        },
      }),
    onSuccess: () => {
      toast('ok', `${f.tradeName}: salvo.`);
      void qc.invalidateQueries({ queryKey: ['platform-companies'] });
      void qc.invalidateQueries({ queryKey: ['platform-dashboard'] });
      onClose();
    },
    onError: (e) => {
      setErrors(fieldErrors(e));
      toast('danger', errorMessage(e));
    },
  });
  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title={`Editar ${company.tradeName}`}
      description="Muda na hora. O jogo (Firma Viva) liga só no plano com o Firma Viva."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button loading={save.isPending} onClick={() => save.mutate()}>
            Salvar
          </Button>
        </>
      }
    >
      <FormGrid>
        <TextField
          label="Nome da empresa"
          cols={8}
          value={f.tradeName}
          error={errors.tradeName}
          onChange={(e) => set('tradeName', e.target.value)}
        />
        <TextField
          label="CPF ou CNPJ"
          cols={4}
          value={f.document}
          onChange={(e) => set('document', e.target.value)}
        />
        <TextField
          label="E-mail da empresa"
          cols={6}
          type="email"
          value={f.email}
          error={errors.email}
          hint="O login do cliente não muda."
          onChange={(e) => set('email', e.target.value)}
        />
        <TextField
          label="Telefone / WhatsApp"
          cols={6}
          value={f.phone}
          onChange={(e) => set('phone', e.target.value)}
        />
        <SelectField
          label="Plano"
          cols={6}
          value={f.plan}
          onChange={(e) => set('plan', e.target.value as PlanKey)}
        >
          <option value="gestao">{PLAN_LABEL.gestao}</option>
          <option value="gestao_jogo">{PLAN_LABEL.gestao_jogo}</option>
        </SelectField>
        <SelectField
          label="Paga por"
          cols={3}
          value={f.cycle}
          onChange={(e) => set('cycle', e.target.value as 'MENSAL' | 'ANUAL')}
        >
          <option value="MENSAL">Mês</option>
          <option value="ANUAL">Ano</option>
        </SelectField>
        <MoneyField
          label="Valor combinado"
          cols={3}
          hint="Vazio = preço da tabela"
          cents={f.billingPriceCents}
          onCents={(v) => set('billingPriceCents', v)}
        />
        {f.billingPriceCents ? (
          <DateField
            label="Valor combinado vale até"
            cols={12}
            value={f.billingPriceUntil}
            hint="Preço de lançamento: depois deste dia, passa a valer o preço da tabela. Vazio = sem prazo."
            onChange={(e) => set('billingPriceUntil', e.target.value)}
          />
        ) : null}
        <DateField
          label="Pago até"
          cols={4}
          value={f.paidUntil}
          onChange={(e) => set('paidUntil', e.target.value)}
        />
        <DateField
          label="Teste grátis até"
          cols={4}
          value={f.trialEndsAt}
          onChange={(e) => set('trialEndsAt', e.target.value)}
        />
        <div className="flex items-end sm:col-span-4">
          <Checkbox
            checked={f.courtesy}
            onChange={(e) => set('courtesy', e.target.checked)}
            label="Cortesia"
            description="Não paga e nunca bloqueia."
          />
        </div>
        <div className="sm:col-span-12">
          <Checkbox
            checked={f.serverConnections}
            onChange={(e) => set('serverConnections', e.target.checked)}
            label="Liberar as conexões do servidor"
            description="Esta empresa passa a usar as contas ligadas no servidor (WhatsApp e outras). Só uma empresa por vez: marcar aqui tira da outra."
          />
        </div>
        <SelectField
          label="De onde veio"
          cols={5}
          value={f.signupSource}
          onChange={(e) => set('signupSource', e.target.value as SignupSource | '')}
        >
          <option value="">Não sei</option>
          {SIGNUP_SOURCES.map((k) => (
            <option key={k} value={k}>
              {SIGNUP_SOURCE_LABEL[k]}
            </option>
          ))}
        </SelectField>
        <TextField
          label="Detalhe"
          cols={7}
          value={f.signupSourceDetail}
          placeholder="Ex.: indicação do João, artigo do blog"
          onChange={(e) => set('signupSourceDetail', e.target.value)}
        />
        <TextAreaField
          label="Anotação (só você vê)"
          cols={12}
          rows={2}
          value={f.note}
          onChange={(e) => set('note', e.target.value)}
        />
      </FormGrid>
    </Dialog>
  );
}

function CreateCompanyDialog({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const settings = useSettings();
  const [f, setF] = useState({
    tradeName: '',
    ownerName: '',
    email: '',
    phone: '',
    plan: 'gestao' as PlanKey,
    cycle: 'MENSAL' as 'MENSAL' | 'ANUAL',
    trialDays: '',
    billingPriceCents: null as number | null,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState<{ email: string; password: string; tradeName: string } | null>(
    null,
  );
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((s) => ({ ...s, [k]: v }));
  const trial = f.trialDays === '' ? (settings.data?.trialDays ?? 7) : Number(f.trialDays);
  const create = useMutation({
    mutationFn: () =>
      api<{ email: string; password: string; company: PlatformCompanyDto }>(
        '/api/v1/platform/companies',
        { method: 'POST', body: { ...f, trialDays: trial } },
      ),
    onSuccess: (r) => {
      void qc.invalidateQueries({ queryKey: ['platform-companies'] });
      void qc.invalidateQueries({ queryKey: ['platform-dashboard'] });
      setDone({ email: r.email, password: r.password, tradeName: r.company.tradeName });
    },
    onError: (e) => {
      setErrors(fieldErrors(e));
      toast('danger', errorMessage(e));
    },
  });
  const site = typeof window !== 'undefined' ? window.location.origin : '';
  const msg = done
    ? `Olá! Sua conta no Cenário Gestão está pronta.\nEntre em ${site}/entrar\nE-mail: ${done.email}\nSenha provisória: ${done.password}\nTroque a senha em Minha conta no primeiro acesso.`
    : '';
  const digits = f.phone.replace(/\D/g, '');
  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title={done ? `${done.tradeName} cadastrada` : 'Cadastrar empresa'}
      description={
        done
          ? 'A senha provisória aparece só agora. Mande para o cliente.'
          : 'Você cria a conta para o cliente. Ele entra com o e-mail e a senha provisória.'
      }
      footer={
        done ? (
          <>
            <Button
              variant="secondary"
              icon={<Copy className="size-4" aria-hidden />}
              onClick={() => {
                void navigator.clipboard.writeText(msg);
                toast('ok', 'Mensagem copiada.');
              }}
            >
              Copiar mensagem
            </Button>
            {digits.length >= 10 && (
              <a
                href={`https://wa.me/${digits.length <= 11 ? `55${digits}` : digits}?text=${encodeURIComponent(msg)}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-11 items-center gap-2 rounded-xl bg-ok-600 px-4 font-semibold text-white hover:opacity-90"
              >
                <MessageCircle className="size-4" aria-hidden /> Mandar no WhatsApp
              </a>
            )}
            <Button onClick={onClose}>Pronto</Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancelar
            </Button>
            <Button loading={create.isPending} onClick={() => create.mutate()}>
              Cadastrar
            </Button>
          </>
        )
      }
    >
      {done ? (
        <Card className="p-4 text-[15px]">
          <p>
            E-mail: <strong>{done.email}</strong>
          </p>
          <p>
            Senha provisória: <strong className="font-mono">{done.password}</strong>
          </p>
        </Card>
      ) : (
        <FormGrid>
          <TextField
            label="Nome da empresa"
            cols={6}
            value={f.tradeName}
            error={errors.tradeName}
            onChange={(e) => set('tradeName', e.target.value)}
          />
          <TextField
            label="Nome do dono"
            cols={6}
            value={f.ownerName}
            error={errors.ownerName}
            onChange={(e) => set('ownerName', e.target.value)}
          />
          <TextField
            label="E-mail (vira o login)"
            cols={6}
            type="email"
            value={f.email}
            error={errors.email}
            onChange={(e) => set('email', e.target.value)}
          />
          <TextField
            label="WhatsApp"
            cols={6}
            value={f.phone}
            onChange={(e) => set('phone', e.target.value)}
          />
          <SelectField
            label="Plano"
            cols={6}
            value={f.plan}
            onChange={(e) => set('plan', e.target.value as PlanKey)}
          >
            <option value="gestao">{PLAN_LABEL.gestao}</option>
            <option value="gestao_jogo">{PLAN_LABEL.gestao_jogo}</option>
          </SelectField>
          <SelectField
            label="Paga por"
            cols={3}
            value={f.cycle}
            onChange={(e) => set('cycle', e.target.value as 'MENSAL' | 'ANUAL')}
          >
            <option value="MENSAL">Mês</option>
            <option value="ANUAL">Ano</option>
          </SelectField>
          <NumberField
            label="Dias de teste"
            cols={3}
            min={0}
            max={90}
            placeholder={String(settings.data?.trialDays ?? 7)}
            value={f.trialDays}
            hint="0 = já começa pagando"
            onChange={(e) => set('trialDays', e.target.value)}
          />
          <MoneyField
            label="Valor combinado"
            cols={6}
            hint="Vazio = preço da tabela"
            cents={f.billingPriceCents}
            onCents={(v) => set('billingPriceCents', v)}
          />
        </FormGrid>
      )}
    </Dialog>
  );
}

// ───────────────────────────── Cobrança ─────────────────────────────
const ORDER: Record<PlatformCompanyDto['tone'], number> = {
  blocked: 0,
  late: 1,
  soon: 2,
  trial: 3,
  ok: 4,
  courtesy: 5,
};

export function PlatformBilling() {
  const list = useCompanies();
  const payments = useQuery({
    queryKey: ['platform-payments'],
    queryFn: () => api<{ items: PlatformPaymentDto[] }>('/api/v1/platform/payments'),
  });
  const qc = useQueryClient();
  const toast = useToast();
  const [paying, setPaying] = useState<PlatformCompanyDto | null>(null);
  const undo = useMutation({
    mutationFn: (p: PlatformPaymentDto) =>
      api(`/api/v1/platform/payments/${p.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      toast('ok', 'Pagamento desfeito.');
      void qc.invalidateQueries({ queryKey: ['platform-payments'] });
      void qc.invalidateQueries({ queryKey: ['platform-companies'] });
      void qc.invalidateQueries({ queryKey: ['platform-dashboard'] });
    },
    onError: (e) => toast('danger', errorMessage(e)),
  });
  const rows = (list.data?.items ?? [])
    .filter((c) => !c.isDemo && !c.courtesy && !c.canceledAt)
    .sort((a, b) => ORDER[a.tone] - ORDER[b.tone] || (a.dueAt ?? '').localeCompare(b.dueAt ?? ''));
  const lastPaymentOf = new Map<number, string>();
  for (const p of payments.data?.items ?? [])
    if (!lastPaymentOf.has(p.companyId)) lastPaymentOf.set(p.companyId, p.id);
  return (
    <>
      <PageHeader
        title="Cobrança"
        description="Quem vence primeiro aparece primeiro. Quando o PIX cair, clique em Recebi o pagamento."
      />
      <ProofsInbox />
      {list.isPending && <Spinner />}
      {list.isError && <Alert tone="danger">{errorMessage(list.error)}</Alert>}
      {list.isSuccess && rows.length === 0 && (
        <EmptyState
          icon={<HandCoins className="size-6" aria-hidden />}
          title="Ninguém para cobrar ainda"
          description="As empresas que pagam aparecem aqui, em ordem de vencimento."
        />
      )}
      {rows.length > 0 && (
        <Card className="divide-y divide-line">
          {rows.map((c) => (
            <div
              key={c.id}
              className="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-center"
              data-testid="cobranca-linha"
            >
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <p className="font-semibold">{c.tradeName}</p>
                  <DueBadge c={c} />
                </div>
                <p className="text-sm text-ink-muted">
                  {c.planLabel} · {c.cycle === 'ANUAL' ? 'anual' : 'mensal'}
                  {c.paidTotalCents
                    ? ` · já pagou ${formatCents(c.paidTotalCents)}`
                    : ' · ainda não pagou'}
                  {c.blocksAt && (c.tone === 'late' || c.tone === 'soon')
                    ? ` · bloqueia ${formatDay(c.blocksAt)}`
                    : ''}
                </p>
              </div>
              <p className="text-lg font-semibold tabular-nums sm:w-40 sm:text-right">
                {formatCents(c.priceCents)}
                <span className="text-sm font-normal text-ink-muted">{perCycle(c)}</span>
              </p>
              <div className="flex gap-2 sm:w-[340px] sm:justify-end">
                {c.chargeWhatsappUrl && (
                  <a
                    href={c.chargeWhatsappUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    title="Lembrar o cliente pelo WhatsApp"
                    className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line-strong px-3 text-sm font-semibold text-ink-soft hover:bg-subtle"
                  >
                    <MessageCircle className="size-4" aria-hidden /> Lembrar
                  </a>
                )}
                <Button
                  size="sm"
                  className="bg-ok-600 hover:bg-ok-600/90"
                  icon={<CircleCheck className="size-4" aria-hidden />}
                  onClick={() => setPaying(c)}
                >
                  Recebi o pagamento
                </Button>
              </div>
            </div>
          ))}
        </Card>
      )}

      <section className="mt-8">
        <h2 className="mb-3 text-lg font-semibold">Pagamentos recebidos</h2>
        {payments.isSuccess && payments.data.items.length === 0 && (
          <p className="text-sm text-ink-muted">Nenhum pagamento marcado ainda.</p>
        )}
        {payments.isSuccess && payments.data.items.length > 0 && (
          <Card className="divide-y divide-line">
            {payments.data.items.map((p) => (
              <div
                key={p.id}
                className="flex min-h-12 flex-wrap items-center gap-3 px-4 py-1.5 text-sm"
              >
                <span className="w-24 text-ink-muted">
                  {formatDay(`${p.receivedOn}T12:00:00Z`)}
                </span>
                <span className="min-w-0 flex-1 truncate font-medium">{p.tradeName}</span>
                <span className="text-ink-muted">
                  {p.periodEnd ? `até ${formatDay(p.periodEnd)}` : ''}
                  {p.provider !== 'MANUAL' ? ' · Asaas' : ''}
                </span>
                <span className="w-24 text-right font-semibold tabular-nums">
                  {formatCents(p.amountCents)}
                </span>
                <span className="flex w-28 shrink-0 justify-end">
                  {p.provider === 'MANUAL' && lastPaymentOf.get(p.companyId) === p.id ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={<Undo2 className="size-4" aria-hidden />}
                      loading={undo.isPending && undo.variables?.id === p.id}
                      onClick={() => {
                        if (
                          window.confirm(
                            `Desfazer o pagamento de ${formatCents(p.amountCents)} de ${p.tradeName}?`,
                          )
                        )
                          undo.mutate(p);
                      }}
                    >
                      Desfazer
                    </Button>
                  ) : null}
                </span>
              </div>
            ))}
          </Card>
        )}
      </section>
      {paying && <PaymentDialog company={paying} onClose={() => setPaying(null)} />}
    </>
  );
}

function addCycles(fromIso: string, cycle: string, n: number): Date {
  const d = new Date(fromIso);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + (cycle === 'ANUAL' ? 12 : 1) * n);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

function PaymentDialog({ company, onClose }: { company: PlatformCompanyDto; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [cycles, setCycles] = useState(1);
  const [amount, setAmount] = useState<number | null>(company.priceCents);
  const [receivedOn, setReceivedOn] = useState(todayYmd());
  const [unblock, setUnblock] = useState(true);
  // Mesma conta do servidor, para mostrar antes de confirmar.
  const received = `${receivedOn}T23:59:59-03:00`;
  let base =
    company.paidUntil ?? (company.status === 'TESTE' ? company.trialEndsAt : null) ?? received;
  if (addCycles(base, company.cycle, 1).getTime() < new Date(received).getTime()) base = received;
  const until = addCycles(base, company.cycle, cycles);
  const pay = useMutation({
    mutationFn: () =>
      api(`/api/v1/platform/companies/${company.id}/payments`, {
        method: 'POST',
        body: { amountCents: amount, receivedOn, cycles, unblock },
      }),
    onSuccess: () => {
      toast('ok', `${company.tradeName}: pago até ${formatDay(until.toISOString())}.`);
      for (const k of ['platform-companies', 'platform-payments', 'platform-dashboard'])
        void qc.invalidateQueries({ queryKey: [k] });
      onClose();
    },
    onError: (e) => toast('danger', errorMessage(e)),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Recebi o pagamento de ${company.tradeName}`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            className="bg-ok-600 hover:bg-ok-600/90"
            loading={pay.isPending}
            disabled={!amount}
            onClick={() => pay.mutate()}
          >
            Confirmar
          </Button>
        </>
      }
    >
      <FormGrid>
        <MoneyField label="Valor recebido" cols={6} cents={amount} onCents={(v) => setAmount(v)} />
        <DateField
          label="Dia em que recebeu"
          cols={6}
          value={receivedOn}
          onChange={(e) => setReceivedOn(e.target.value)}
        />
        <SelectField
          label={company.cycle === 'ANUAL' ? 'Quantos anos' : 'Quantos meses'}
          cols={6}
          value={String(cycles)}
          onChange={(e) => {
            const n = Number(e.target.value);
            setCycles(n);
            setAmount(company.priceCents * n);
          }}
        >
          {(company.cycle === 'ANUAL' ? [1, 2] : [1, 2, 3, 6, 12]).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </SelectField>
      </FormGrid>
      <Card className="mt-4 bg-ok-50 p-4 text-[15px]">
        Pago até passa de <strong>{company.paidUntil ? formatDay(company.paidUntil) : '—'}</strong>{' '}
        para <strong>{formatDay(until.toISOString())}</strong>.
      </Card>
      {company.blockedAt && (
        <Checkbox
          className="mt-4"
          checked={unblock}
          onChange={(e) => setUnblock(e.target.checked)}
          label="Liberar o acesso também"
          description="A empresa está bloqueada."
        />
      )}
    </Dialog>
  );
}

// ───────────────────────────── Planos e preços ─────────────────────────────
export function PlatformPlans() {
  const q = useSettings();
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{errorMessage(q.error)}</Alert>;
  return <PlansForm s={q.data} />;
}

function useSaveSettings() {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (body: object) =>
      api<PlatformSettingsDto>('/api/v1/platform/settings', { method: 'PUT', body }),
    onSuccess: (s) => {
      qc.setQueryData(['platform-settings'], s);
      void qc.invalidateQueries({ queryKey: ['platform-companies'] });
      void qc.invalidateQueries({ queryKey: ['platform-dashboard'] });
      toast('ok', 'Salvo. Já vale para todas as empresas.');
    },
    onError: (e) => toast('danger', errorMessage(e)),
  });
}

function PlansForm({ s }: { s: PlatformSettingsDto }) {
  const save = useSaveSettings();
  const [f, setF] = useState({
    priceGestaoCents: s.priceGestaoCents as number | null,
    priceJogoCents: s.priceJogoCents as number | null,
    annualDiscountPct: String(s.annualDiscountPct),
    trialDays: String(s.trialDays),
    graceDays: String(s.graceDays),
    noticeDays: String(s.noticeDays),
  });
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((x) => ({ ...x, [k]: v }));
  const disc = Number(f.annualDiscountPct) || 0;
  const annual = (m: number | null) => (m ? Math.round(m * 12 * (1 - disc / 100)) : 0);
  const [confirmOn, setConfirmOn] = useState(false);
  return (
    <>
      <PageHeader
        title="Planos e preços"
        description="Vale para as empresas novas e para quem não tem valor combinado."
      />
      <div className="space-y-5">
        <FormSection title="Preços">
          <FormGrid>
            <MoneyField
              label="Cenário Gestão (por mês)"
              cols={4}
              cents={f.priceGestaoCents}
              onCents={(v) => set('priceGestaoCents', v)}
              hint={`Anual: ${formatCents(annual(f.priceGestaoCents))}`}
            />
            <MoneyField
              label="Com o Firma Viva (por mês)"
              cols={4}
              cents={f.priceJogoCents}
              onCents={(v) => set('priceJogoCents', v)}
              hint={`Anual: ${formatCents(annual(f.priceJogoCents))}`}
            />
            <NumberField
              label="Desconto do anual (%)"
              cols={4}
              min={0}
              max={90}
              value={f.annualDiscountPct}
              onChange={(e) => set('annualDiscountPct', e.target.value)}
            />
          </FormGrid>
        </FormSection>
        <FormSection title="Teste, aviso e bloqueio">
          <FormGrid>
            <NumberField
              label="Dias de teste grátis"
              cols={4}
              min={0}
              max={90}
              value={f.trialDays}
              hint="Para as contas novas"
              onChange={(e) => set('trialDays', e.target.value)}
            />
            <NumberField
              label="Me avisar antes do vencimento (dias)"
              cols={4}
              min={0}
              max={30}
              value={f.noticeDays}
              hint={
                s.emailEnabled ? 'Por e-mail e no Início' : 'No Início (e-mail ainda não ligado)'
              }
              onChange={(e) => set('noticeDays', e.target.value)}
            />
            <NumberField
              label="Bloquear depois do vencimento (dias)"
              cols={4}
              min={0}
              max={60}
              value={f.graceDays}
              hint="O fim do teste bloqueia no mesmo dia"
              onChange={(e) => set('graceDays', e.target.value)}
            />
          </FormGrid>
          <FormActions className="mt-5">
            <Button
              loading={save.isPending}
              disabled={!f.priceGestaoCents || !f.priceJogoCents}
              onClick={() =>
                save.mutate({
                  priceGestaoCents: f.priceGestaoCents,
                  priceJogoCents: f.priceJogoCents,
                  annualDiscountPct: Number(f.annualDiscountPct),
                  trialDays: Number(f.trialDays),
                  graceDays: Number(f.graceDays),
                  noticeDays: Number(f.noticeDays),
                })
              }
            >
              Salvar preços e prazos
            </Button>
          </FormActions>
        </FormSection>
        <FormSection
          title="Bloqueio automático"
          description="Ligado, a empresa que não pagou só vê a tela de pagamento (com a sua chave PIX) até você marcar Recebi o pagamento. Os dados dela ficam guardados."
        >
          <div className="flex flex-wrap items-center gap-3">
            <Badge tone={s.autoBlock ? 'ok' : 'neutral'}>
              {s.autoBlock ? 'Ligado' : 'Desligado'}
            </Badge>
            <Button
              variant={s.autoBlock ? 'outline-danger' : 'primary'}
              loading={save.isPending}
              onClick={() => (s.autoBlock ? save.mutate({ autoBlock: false }) : setConfirmOn(true))}
            >
              {s.autoBlock ? 'Desligar' : 'Ligar o bloqueio automático'}
            </Button>
          </div>
        </FormSection>
      </div>
      <Dialog
        open={confirmOn}
        onClose={() => setConfirmOn(false)}
        title="Ligar o bloqueio automático?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmOn(false)}>
              Cancelar
            </Button>
            <Button
              onClick={() => {
                save.mutate({ autoBlock: true });
                setConfirmOn(false);
              }}
            >
              Ligar
            </Button>
          </>
        }
      >
        {s.wouldBlockNow.length === 0 ? (
          <p className="text-[15px]">Nenhuma empresa fica bloqueada agora. Pode ligar.</p>
        ) : (
          <>
            <p className="text-[15px]">
              Estas empresas ficam <strong>bloqueadas na hora</strong>, porque o teste ou a
              mensalidade já venceu:
            </p>
            <ul className="mt-2 list-disc pl-5 text-[15px]">
              {s.wouldBlockNow.map((c) => (
                <li key={c.id}>{c.tradeName}</li>
              ))}
            </ul>
            <p className="mt-2 text-sm text-ink-muted">
              Se alguma não deve bloquear, cancele e estenda o teste dela em Empresas.
            </p>
          </>
        )}
      </Dialog>
    </>
  );
}

// ───────────────────────────── Como eu recebo ─────────────────────────────
export function PlatformReceive() {
  const q = useSettings();
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{errorMessage(q.error)}</Alert>;
  return <ReceiveForm s={q.data} />;
}

function ReceiveForm({ s }: { s: PlatformSettingsDto }) {
  const save = useSaveSettings();
  const [f, setF] = useState({
    pixKey: s.pixKey ?? '',
    pixName: s.pixName ?? '',
    pixBank: s.pixBank ?? '',
    pixCity: s.pixCity ?? '',
    whatsapp: s.whatsapp ?? '',
    paymentMessage: s.paymentMessage ?? '',
  });
  const set = <K extends keyof typeof f>(k: K, v: string) => setF((x) => ({ ...x, [k]: v }));
  return (
    <>
      <PageHeader
        title="Como eu recebo"
        description="O que o cliente vê quando o teste acaba ou a mensalidade vence."
      />
      <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
        <FormSection title="PIX e WhatsApp">
          <FormGrid>
            <TextField
              label="Chave PIX"
              cols={12}
              value={f.pixKey}
              placeholder="CPF, e-mail, celular ou chave aleatória"
              onChange={(e) => set('pixKey', e.target.value)}
            />
            <TextField
              label="Nome que aparece no PIX"
              cols={7}
              value={f.pixName}
              hint="Para o cliente conferir antes de pagar"
              onChange={(e) => set('pixName', e.target.value)}
            />
            <TextField
              label="Banco"
              cols={5}
              value={f.pixBank}
              onChange={(e) => set('pixBank', e.target.value)}
            />
            <TextField
              label="Cidade do PIX"
              cols={12}
              value={f.pixCity}
              placeholder="Ex.: São José dos Campos"
              hint="Vai dentro do QR Code. O banco do cliente mostra junto com o nome."
              onChange={(e) => set('pixCity', e.target.value)}
            />
            <TextField
              label="Seu WhatsApp"
              cols={12}
              value={f.whatsapp}
              placeholder="(12) 99999-9999"
              hint="O botão do cliente abre uma conversa com este número"
              onChange={(e) => set('whatsapp', e.target.value)}
            />
            <TextAreaField
              label="Recado para o cliente"
              cols={12}
              rows={3}
              value={f.paymentMessage}
              placeholder="Ex.: Depois de pagar, mande o comprovante pelo WhatsApp que eu libero na hora."
              onChange={(e) => set('paymentMessage', e.target.value)}
            />
          </FormGrid>
          <FormActions className="mt-5">
            <Button loading={save.isPending} onClick={() => save.mutate(f)}>
              Salvar
            </Button>
          </FormActions>
        </FormSection>
        <div>
          <p className="mb-2 text-sm font-medium text-ink-muted">Como o cliente vê</p>
          <PixCard
            pixKey={f.pixKey || null}
            pixName={f.pixName || null}
            pixBank={f.pixBank || null}
            message={f.paymentMessage || null}
            amountCents={s.priceGestaoCents}
            whatsappUrl={f.whatsapp ? '#' : null}
            pixCode={
              f.pixKey
                ? pixBrCode({
                    key: f.pixKey,
                    name: f.pixName || 'Cenario Gestao',
                    city: f.pixCity || 'Sao Paulo',
                    amountCents: s.priceGestaoCents,
                    txid: 'CENARIO0',
                  })
                : null
            }
            preview
          />
        </div>
      </div>
      <div className="mt-6 space-y-6">
        <PushCard s={s} />
        <MessageTemplatesForm s={s} />
      </div>
    </>
  );
}

/** Cartão de pagamento por PIX (o mesmo da tela do cliente). */
export function PixCard({
  pixKey,
  pixName,
  pixBank,
  message,
  amountCents,
  whatsappUrl,
  pixCode,
  preview,
}: {
  pixKey: string | null;
  pixName: string | null;
  pixBank: string | null;
  message: string | null;
  amountCents: number;
  whatsappUrl: string | null;
  pixCode?: string | null;
  preview?: boolean;
}) {
  const toast = useToast();
  return (
    <Card className="p-5 text-left">
      <p className="text-sm text-ink-muted">Valor</p>
      <p className="text-2xl font-semibold tabular-nums">{formatCents(amountCents)}</p>
      {pixCode && (
        <div className="mt-4 flex flex-col items-center gap-2">
          <PixQr code={pixCode} />
          <p className="text-center text-sm text-ink-muted">
            Aponte a câmera do banco: o valor já vem preenchido.
          </p>
        </div>
      )}
      {pixKey && (
        <>
          <p className="mt-4 text-sm text-ink-muted">Chave PIX</p>
          <div className="mt-1 flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded-lg bg-subtle px-3 py-2 text-[15px]">
              {pixKey}
            </code>
            <Button
              size="sm"
              variant="secondary"
              icon={<Copy className="size-4" aria-hidden />}
              onClick={() => {
                if (preview) return;
                void navigator.clipboard.writeText(pixKey);
                toast('ok', 'Chave PIX copiada.');
              }}
            >
              Copiar
            </Button>
          </div>
          {(pixName || pixBank) && (
            <p className="mt-1 text-sm text-ink-muted">
              {[pixName, pixBank].filter(Boolean).join(' · ')}
            </p>
          )}
        </>
      )}
      {message && <p className="mt-4 text-[15px] text-ink-soft">{message}</p>}
      {whatsappUrl && (
        <a
          href={preview ? undefined : whatsappUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="mt-4 inline-flex h-11 w-full items-center justify-center gap-2 rounded-xl bg-ok-600 px-4 font-semibold text-white hover:opacity-90"
        >
          <MessageCircle className="size-4" aria-hidden /> Mandar o comprovante no WhatsApp
        </a>
      )}
    </Card>
  );
}

// ───────────────────────────── Avisos e pedidos ─────────────────────────────
export function PlatformNotices() {
  return (
    <>
      <PageHeader
        title="Avisos e pedidos"
        description="Demonstrações marcadas, avisos para todas as empresas, o que elas pedem, as telas que usam e os pedidos sobre dados pessoais."
      />
      <DemosCard />
      <NoticesCard />
      <FeedbackGroupsCard />
      <FeedbackInbox />
      <ScreenUsageCard />
      <PrivacyRequestsInbox />
      <DemoCompanyCard />
    </>
  );
}

// ───────────────────────────── Minha conta ─────────────────────────────
export function PlatformAccount() {
  const toast = useToast();
  const [f, setF] = useState({ currentPassword: '', newPassword: '', newPasswordConfirm: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const hist = useQuery({
    queryKey: ['platform-history'],
    queryFn: () => api<{ items: PlatformAuditDto[] }>('/api/plataforma/historico'),
  });
  const save = useMutation({
    mutationFn: () => api('/api/plataforma/senha', { method: 'POST', body: f }),
    onSuccess: () => {
      toast('ok', 'Senha trocada. Os outros aparelhos saíram do painel.');
      setF({ currentPassword: '', newPassword: '', newPasswordConfirm: '' });
      setErrors({});
    },
    onError: (e) => {
      setErrors(fieldErrors(e));
      toast('danger', errorMessage(e));
    },
  });
  return (
    <>
      <PageHeader
        title="Minha conta"
        description="Sua tapeçaria, a senha do painel e tudo o que foi feito nele."
      />
      <FormSection title="Trocar a senha do painel">
        <FormGrid>
          {(
            [
              ['currentPassword', 'Senha atual', 'current-password'],
              ['newPassword', 'Senha nova', 'new-password'],
              ['newPasswordConfirm', 'Repita a senha nova', 'new-password'],
            ] as const
          ).map(([k, label, ac]) => (
            <Field
              key={k}
              label={label}
              error={errors[k]}
              hint={k === 'newPassword' ? PASSWORD_RULE_HINT : undefined}
              className="sm:col-span-4"
            >
              {(p) => (
                <Input
                  {...p}
                  type="password"
                  autoComplete={ac}
                  value={f[k]}
                  onChange={(e) => setF((x) => ({ ...x, [k]: e.target.value }))}
                />
              )}
            </Field>
          ))}
        </FormGrid>
        <FormActions className="mt-5">
          <Button loading={save.isPending} onClick={() => save.mutate()}>
            Trocar a senha
          </Button>
        </FormActions>
      </FormSection>
      <section className="mt-8">
        <h2 className="mb-3 text-lg font-semibold">Histórico do painel</h2>
        {hist.isPending && <Spinner />}
        {hist.isSuccess && (
          <Card className="divide-y divide-line">
            {hist.data.items.map((h) => (
              <div
                key={h.id}
                className="flex flex-col gap-0.5 px-4 py-2.5 text-sm sm:flex-row sm:gap-4"
              >
                <span className="shrink-0 text-ink-muted sm:w-36">{formatDateTime(h.at)}</span>
                <span className="min-w-0 flex-1">{h.summary}</span>
              </div>
            ))}
          </Card>
        )}
      </section>
    </>
  );
}
