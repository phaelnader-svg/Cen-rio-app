'use client';

import {
  DEFAULT_MESSAGE_TEMPLATES,
  MESSAGE_PLACEHOLDERS,
  MESSAGE_TEMPLATE_KEYS,
  MESSAGE_TEMPLATE_LABEL,
  SIGNUP_SOURCE_LABEL,
  type FeedbackGroupDto,
  type MessageTemplateKey,
  type PlatformCompanyDto,
  type PlatformDashboardDto,
  type PlatformDemoDto,
  type PlatformPaymentProofDto,
  type PlatformSettingsDto,
  type ScreenUsageDto,
  type TimelineItemDto,
  type TimelineKind,
} from '@cenario/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bell,
  CalendarClock,
  CircleCheck,
  Download,
  ExternalLink,
  MessageCircle,
  X,
} from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/field';
import { FormActions, FormSection, TextAreaField } from '@/components/ui/form';
import { Badge, Card, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage, fieldErrors } from '@/lib/api';
import { enablePush, pushSupported } from '@/lib/app-install';
import { formatCents, formatDay } from '@/lib/billing';
import { formatDateTime, typedWhatsapp } from '@/lib/format';

const fmtWhen = (iso: string) =>
  new Date(iso).toLocaleString('pt-BR', {
    timeZone: 'America/Sao_Paulo',
    weekday: 'long',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

function refresh(qc: ReturnType<typeof useQueryClient>) {
  for (const k of [
    'platform-proofs',
    'platform-companies',
    'platform-dashboard',
    'platform-payments',
    'platform-demos',
  ])
    void qc.invalidateQueries({ queryKey: [k] });
}

// ───────────────────────── Comprovantes para conferir (41) ─────────────────────────
export function ProofsInbox() {
  const qc = useQueryClient();
  const toast = useToast();
  const [rejecting, setRejecting] = useState<PlatformPaymentProofDto | null>(null);
  const q = useQuery({
    queryKey: ['platform-proofs'],
    queryFn: () => api<{ items: PlatformPaymentProofDto[] }>('/api/v1/platform/proofs'),
  });
  const confirm = useMutation({
    mutationFn: (p: PlatformPaymentProofDto) =>
      api<{ paidUntil: string }>(`/api/v1/platform/proofs/${p.id}/confirm`, {
        method: 'POST',
        body: {},
      }),
    onSuccess: (r, p) => {
      toast('ok', `${p.tradeName}: pagamento confirmado, liberado até ${formatDay(r.paidUntil)}.`);
      refresh(qc);
    },
    onError: (e) => toast('danger', errorMessage(e)),
  });
  const items = q.data?.items ?? [];
  if (q.isPending) return <Spinner className="mb-6" />;
  if (items.length === 0) return null;
  return (
    <Card className="mb-6 border-warn-600/30 p-5" data-testid="comprovantes">
      <h2 className="font-semibold">
        Comprovantes para conferir{' '}
        <Badge tone="warn" className="ml-1 align-middle">
          {items.length}
        </Badge>
      </h2>
      <p className="text-sm text-ink-muted">
        Confira se o PIX caiu e aperte Confirmar: o pagamento é lançado e a empresa é avisada.
      </p>
      <ul className="mt-3 divide-y divide-line">
        {items.map((p) => (
          <li
            key={p.id}
            className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center"
            data-testid="comprovante-linha"
          >
            <div className="min-w-0 flex-1">
              <p className="font-semibold">{p.tradeName}</p>
              <p className="text-sm text-ink-muted">
                <span className="font-medium text-ink">{formatCents(p.amountCents)}</span> pago em{' '}
                {formatDay(p.paidOn + 'T12:00:00Z')}
                {p.sentBy ? ` · mandado por ${p.sentBy}` : ''}
              </p>
              {p.amountCents !== p.expectedCents && (
                <p className="text-sm font-medium text-warn-600">
                  A mensalidade dela é {formatCents(p.expectedCents)}.
                </p>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              <a
                href={`/api/v1/platform/proofs/${p.id}/file`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-line-strong px-3 text-sm font-semibold hover:bg-subtle"
              >
                <ExternalLink className="size-4" aria-hidden /> Ver comprovante
              </a>
              <Button
                size="sm"
                variant="outline-danger"
                icon={<X className="size-4" aria-hidden />}
                onClick={() => setRejecting(p)}
              >
                Recusar
              </Button>
              <Button
                size="sm"
                className="bg-ok-600 hover:bg-ok-600/90"
                icon={<CircleCheck className="size-4" aria-hidden />}
                loading={confirm.isPending && confirm.variables?.id === p.id}
                onClick={() => confirm.mutate(p)}
                data-testid="comprovante-confirmar"
              >
                Confirmar
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {rejecting && <RejectDialog proof={rejecting} onClose={() => setRejecting(null)} />}
    </Card>
  );
}

function RejectDialog({ proof, onClose }: { proof: PlatformPaymentProofDto; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const save = useMutation({
    mutationFn: () =>
      api(`/api/v1/platform/proofs/${proof.id}/reject`, { method: 'POST', body: { reason } }),
    onSuccess: () => {
      toast('ok', `${proof.tradeName} foi avisada por e-mail.`);
      refresh(qc);
      onClose();
    },
    onError: (e) => toast('danger', errorMessage(e)),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Recusar o comprovante de ${proof.tradeName}`}
      description="A empresa recebe o motivo por e-mail e pode mandar outro."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="danger" loading={save.isPending} onClick={() => save.mutate()}>
            Recusar
          </Button>
        </>
      }
    >
      <Field label="Motivo">
        {(p) => (
          <Input
            {...p}
            value={reason}
            placeholder="Ex.: o PIX ainda não caiu na conta"
            onChange={(e) => setReason(e.target.value)}
          />
        )}
      </Field>
    </Dialog>
  );
}

// ───────────────────────── Origem no Início (45) ─────────────────────────
export function SourcesCard({ d }: { d: PlatformDashboardDto }) {
  if (d.bySource.length === 0) return null;
  return (
    <Card className="p-5" data-testid="origens">
      <h2 className="font-semibold">De onde vieram</h2>
      <p className="text-sm text-ink-muted">Onde vale gastar tempo e dinheiro.</p>
      <table className="mt-3 w-full text-sm">
        <thead>
          <tr className="text-left text-ink-muted">
            <th className="py-1 font-medium">Origem</th>
            <th className="py-1 text-right font-medium">Contas</th>
            <th className="py-1 text-right font-medium">Pagando</th>
          </tr>
        </thead>
        <tbody>
          {d.bySource.map((s) => (
            <tr key={s.source ?? 'x'} className="border-t border-line">
              <td className="py-1.5">{s.source ? SIGNUP_SOURCE_LABEL[s.source] : 'Não se sabe'}</td>
              <td className="py-1.5 text-right tabular-nums">{s.companies}</td>
              <td className="py-1.5 text-right font-medium tabular-nums">{s.paying}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

// ───────────────────────── Linha do tempo (46) ─────────────────────────
const KIND_LABEL: Record<
  TimelineKind,
  { label: string; tone: 'brand' | 'ok' | 'info' | 'neutral' | 'warn' | 'bronze' }
> = {
  cadastro: { label: 'Cadastro', tone: 'brand' },
  conversa: { label: 'Conversa', tone: 'bronze' },
  pagamento: { label: 'Pagamento', tone: 'ok' },
  comprovante: { label: 'Comprovante', tone: 'ok' },
  aviso: { label: 'Aviso', tone: 'info' },
  mudanca: { label: 'Mudança', tone: 'neutral' },
  ajuda: { label: 'Ajuda', tone: 'warn' },
  sugestao: { label: 'Sugestão', tone: 'info' },
};

export function TimelineDialog({
  company,
  onClose,
}: {
  company: PlatformCompanyDto;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [text, setText] = useState('');
  const key = ['platform-timeline', company.id];
  const q = useQuery({
    queryKey: key,
    queryFn: () =>
      api<{ items: TimelineItemDto[] }>(`/api/v1/platform/companies/${company.id}/timeline`),
  });
  const add = useMutation({
    mutationFn: () =>
      api(`/api/v1/platform/companies/${company.id}/timeline`, {
        method: 'POST',
        body: { text },
      }),
    onSuccess: () => {
      setText('');
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => toast('danger', errorMessage(e)),
  });
  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title={`Linha do tempo: ${company.tradeName}`}
      description="Cadastro, conversas, pagamentos, avisos e o que mudou, do mais novo ao mais antigo."
      footer={<Button onClick={onClose}>Fechar</Button>}
    >
      <div className="mb-4 flex gap-2">
        <Input
          aria-label="Anotar uma conversa"
          placeholder="Anotar uma conversa (ex.: liguei e expliquei o orçamento)"
          value={text}
          maxLength={280}
          onChange={(e) => setText(e.target.value)}
          data-testid="linha-tempo-texto"
        />
        <Button
          loading={add.isPending}
          disabled={text.trim().length < 2}
          onClick={() => add.mutate()}
          data-testid="linha-tempo-anotar"
        >
          Anotar
        </Button>
      </div>
      {q.isPending && <Spinner />}
      {q.isSuccess && (
        <ol className="relative space-y-3 border-l border-line pl-5" data-testid="linha-tempo">
          {q.data.items.map((i, n) => (
            <li key={n} className="relative">
              <span className="absolute top-1.5 -left-[25px] size-2.5 rounded-full bg-brand-600" />
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="text-ink-muted">{formatDateTime(i.at)}</span>
                <Badge tone={KIND_LABEL[i.kind].tone}>{KIND_LABEL[i.kind].label}</Badge>
              </div>
              <p className="text-[15px] text-ink">{i.text}</p>
            </li>
          ))}
        </ol>
      )}
    </Dialog>
  );
}

// ───────────────────────── Encerrar empresa (51) ─────────────────────────
export function CloseCompanyDialog({
  company,
  onClose,
}: {
  company: PlatformCompanyDto;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [reason, setReason] = useState('');
  const [confirmName, setConfirmName] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: () =>
      api<{ purgeAfter: string }>(`/api/v1/platform/companies/${company.id}/close`, {
        method: 'POST',
        body: { reason, confirmName },
      }),
    onSuccess: (r) => {
      toast(
        'ok',
        `${company.tradeName} encerrada. Os dados ficam guardados até ${formatDay(r.purgeAfter)}.`,
      );
      refresh(qc);
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
      onClose={onClose}
      title={`Encerrar ${company.tradeName}`}
      description="Ninguém da empresa entra mais. Nada é apagado agora: os dados ficam guardados por 90 dias e dá para reabrir. Depois disso, o sistema apaga sozinho e guarda as planilhas no arquivo."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            variant="danger"
            loading={save.isPending}
            disabled={confirmName !== company.tradeName || reason.trim().length < 3}
            onClick={() => save.mutate()}
            data-testid="encerrar-confirmar"
          >
            Encerrar
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <a
          href={`/api/v1/platform/companies/${company.id}/export.zip`}
          className="inline-flex h-10 items-center gap-2 rounded-xl border border-line-strong px-4 text-sm font-semibold hover:bg-subtle"
        >
          <Download className="size-4" aria-hidden /> Baixar os dados antes (planilhas)
        </a>
        <Field label="Motivo" error={errors.reason}>
          {(p) => (
            <Input
              {...p}
              value={reason}
              placeholder="Ex.: fechou a oficina"
              onChange={(e) => setReason(e.target.value)}
            />
          )}
        </Field>
        <Field label={`Para confirmar, digite: ${company.tradeName}`} error={errors.confirmName}>
          {(p) => (
            <Input
              {...p}
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              data-testid="encerrar-nome"
            />
          )}
        </Field>
      </div>
    </Dialog>
  );
}

export function ClosedCompanyBar({ company }: { company: PlatformCompanyDto }) {
  const [now] = useState(() => new Date().toISOString());
  const qc = useQueryClient();
  const toast = useToast();
  const reopen = useMutation({
    mutationFn: () =>
      api(`/api/v1/platform/companies/${company.id}/reopen`, { method: 'POST', body: {} }),
    onSuccess: () => {
      toast('ok', `${company.tradeName} reaberta: a equipe já pode entrar.`);
      refresh(qc);
    },
    onError: (e) => toast('danger', errorMessage(e)),
  });
  if (!company.closedAt) return null;
  const canPurge = company.purgeAfter && company.purgeAfter <= now;
  return (
    <div
      className="mt-2 flex flex-wrap items-center gap-2 rounded-lg bg-danger-50 px-3 py-2 text-sm"
      data-testid="empresa-encerrada"
    >
      <span className="font-medium text-ink">
        Encerrada em {formatDay(company.closedAt)}
        {company.closeReason ? ` (${company.closeReason})` : ''}.{' '}
        {canPurge
          ? 'Passou dos 90 dias: o sistema apaga hoje e guarda as planilhas no arquivo.'
          : `Dados guardados até ${formatDay(company.purgeAfter)}. Depois, o sistema apaga sozinho e guarda as planilhas no arquivo (aviso por e-mail 7 dias antes).`}
      </span>
      <a
        href={`/api/v1/platform/companies/${company.id}/export.zip`}
        className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line-strong bg-surface px-2.5 font-semibold hover:bg-subtle"
      >
        <Download className="size-4" aria-hidden /> Baixar os dados
      </a>
      <Button
        size="sm"
        variant="secondary"
        loading={reopen.isPending}
        onClick={() => reopen.mutate()}
      >
        Reabrir
      </Button>
    </div>
  );
}

// ───────────────────────── Demonstrações (44) ─────────────────────────
export function DemosCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: ['platform-demos'],
    queryFn: () => api<{ items: PlatformDemoDto[] }>('/api/v1/platform/demos'),
  });
  const act = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'feita' | 'cancelar' }) =>
      api(`/api/v1/platform/demos/${id}/${action}`, { method: 'POST', body: {} }),
    onSuccess: () => refresh(qc),
    onError: (e) => toast('danger', errorMessage(e)),
  });
  const items = q.data?.items ?? [];
  const pending = items.filter((i) => i.status === 'PENDENTE');
  return (
    <Card className="mb-6 p-5" data-testid="demonstracoes">
      <h2 className="flex items-center gap-2 font-semibold">
        <CalendarClock className="size-5 text-brand-700" aria-hidden />
        Demonstrações marcadas pelo site
        {pending.length > 0 && <Badge tone="warn">{pending.length}</Badge>}
      </h2>
      {q.isPending ? (
        <Spinner className="mt-3" />
      ) : pending.length === 0 ? (
        <p className="mt-2 text-sm text-ink-muted">
          Nenhuma marcada. Quem toca em &ldquo;Agendar demonstração&rdquo; no site escolhe o dia e o
          horário, e aparece aqui.
        </p>
      ) : (
        <ul className="mt-3 divide-y divide-line">
          {pending.map((d) => (
            <li key={d.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center">
              <div className="min-w-0 flex-1">
                <p className="font-semibold first-letter:uppercase">{fmtWhen(d.preferredAt)}</p>
                <p className="text-sm text-ink-soft">
                  {d.name}
                  {d.businessName ? `, ${d.businessName}` : ''}
                  {d.city ? ` (${d.city})` : ''}
                  {d.phone ? ` · ${typedWhatsapp(d.phone)}` : ''}
                </p>
                {d.note && <p className="text-sm text-ink-muted">{d.note}</p>}
              </div>
              <div className="flex flex-wrap gap-2">
                {d.whatsappUrl && (
                  <a
                    href={d.whatsappUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-ok-600 px-3 text-sm font-semibold text-white hover:bg-ok-600/90"
                  >
                    <MessageCircle className="size-4" aria-hidden /> WhatsApp
                  </a>
                )}
                <Button
                  size="sm"
                  variant="secondary"
                  icon={<CircleCheck className="size-4" aria-hidden />}
                  onClick={() => act.mutate({ id: d.id, action: 'feita' })}
                >
                  Feita
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => act.mutate({ id: d.id, action: 'cancelar' })}
                >
                  Desmarcar
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ───────────────────────── Sugestões agrupadas (50) ─────────────────────────
export function FeedbackGroupsCard() {
  const q = useQuery({
    queryKey: ['platform-feedback-groups'],
    queryFn: () => api<{ items: FeedbackGroupDto[] }>('/api/v1/platform/feedback/groups'),
  });
  const [open, setOpen] = useState<string | null>(null);
  const groups = (q.data?.items ?? []).filter((g) => g.count > 1 || g.companies > 1);
  return (
    <Card className="mb-6 p-5" data-testid="sugestoes-agrupadas">
      <h2 className="font-semibold">O que mais pedem</h2>
      <p className="text-sm text-ink-muted">
        Sugestões parecidas juntas. Quanto mais empresas pedem, mais para cima.
      </p>
      {q.isPending ? (
        <Spinner className="mt-3" />
      ) : groups.length === 0 ? (
        <p className="mt-2 text-sm text-ink-muted">Ainda não tem pedidos repetidos.</p>
      ) : (
        <ul className="mt-3 divide-y divide-line">
          {groups.map((g) => (
            <li key={g.key} className="py-3">
              <button
                type="button"
                className="flex w-full items-start gap-3 text-left"
                onClick={() => setOpen(open === g.key ? null : g.key)}
                aria-expanded={open === g.key}
              >
                <Badge tone={g.companies > 1 ? 'brand' : 'neutral'} className="shrink-0">
                  {g.companies} {g.companies === 1 ? 'empresa pediu' : 'empresas pediram'}
                </Badge>
                <span className="min-w-0 flex-1 text-[15px] text-ink">{g.title}</span>
              </button>
              {open === g.key && (
                <ul className="mt-2 space-y-1.5 pl-2 text-sm">
                  {g.items.map((i) => (
                    <li key={i.id}>
                      <span className="font-medium">{i.companyName}</span>{' '}
                      <span className="text-ink-muted">({formatDay(i.createdAt)})</span>:{' '}
                      {i.message}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

// ───────────────────────── Telas usadas (49) ─────────────────────────
export function ScreenUsageCard() {
  const q = useQuery({
    queryKey: ['platform-screens'],
    queryFn: () => api<ScreenUsageDto>('/api/v1/platform/screens'),
  });
  if (q.isPending) return <Spinner className="mb-6" />;
  if (q.isError) return null;
  const d = q.data;
  const max = Math.max(1, ...d.items.map((i) => i.companies));
  return (
    <Card className="mb-6 p-5" data-testid="telas-usadas">
      <h2 className="font-semibold">Telas que as empresas usam</h2>
      <p className="text-sm text-ink-muted">
        Últimos {d.days} dias, {d.companies} {d.companies === 1 ? 'empresa' : 'empresas'} com
        acesso. O que ninguém usa é candidato a sair do sistema.
      </p>
      <div className="mt-4 grid gap-6 lg:grid-cols-2">
        <ul className="space-y-1.5 text-sm">
          {d.items.slice(0, 15).map((i) => (
            <li key={i.screen} className="flex items-center gap-2">
              <span className="w-40 shrink-0 truncate">{i.label}</span>
              <span className="h-2 flex-1 rounded bg-subtle">
                <span
                  className="block h-2 rounded bg-brand-600"
                  style={{ width: `${(i.companies / max) * 100}%` }}
                />
              </span>
              <span className="w-24 shrink-0 text-right text-ink-muted tabular-nums">
                {i.companies} {i.companies === 1 ? 'empresa' : 'empresas'}
              </span>
            </li>
          ))}
        </ul>
        <div>
          <p className="text-sm font-medium text-ink">Ninguém abriu</p>
          {d.unused.length === 0 ? (
            <p className="text-sm text-ink-muted">Todas as telas do menu foram usadas.</p>
          ) : (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {d.unused.map((u) => (
                <Badge key={u.screen} tone="neutral">
                  {u.label}
                </Badge>
              ))}
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

// ───────────────────────── Avisos no celular (43) ─────────────────────────
export function PushCard({ s }: { s: PlatformSettingsDto }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  async function turnOn() {
    setBusy(true);
    try {
      const r = await enablePush('plataforma');
      if (r === 'ok') {
        toast('ok', 'Avisos ligados neste aparelho.');
        await api('/api/v1/platform/push/test', { method: 'POST', body: {} });
        void qc.invalidateQueries({ queryKey: ['platform-settings'] });
      } else if (r === 'negado')
        toast('danger', 'O navegador bloqueou os avisos. Libere nas configurações do site.');
      else
        toast(
          'danger',
          'Este navegador não recebe avisos. No iPhone, instale o painel na tela de início.',
        );
    } catch (e) {
      toast('danger', errorMessage(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="mt-5 p-5" data-testid="avisos-celular">
      <h2 className="flex items-center gap-2 font-semibold">
        <Bell className="size-5 text-brand-700" aria-hidden /> Avisos no seu celular
      </h2>
      <p className="mt-1 text-sm text-ink-muted">
        Empresa nova, comprovante de pagamento, mensalidade atrasada, pedido de ajuda e demonstração
        marcada chegam na hora, como mensagem no celular.
      </p>
      <p className="mt-2 text-sm">
        {s.pushDevices > 0
          ? `Ligado em ${s.pushDevices} ${s.pushDevices === 1 ? 'aparelho' : 'aparelhos'}.`
          : 'Ainda não ligado em nenhum aparelho.'}
      </p>
      <Button
        className="mt-3"
        loading={busy}
        disabled={!pushSupported()}
        onClick={turnOn}
        icon={<Bell className="size-4" aria-hidden />}
      >
        Ligar neste aparelho
      </Button>
    </Card>
  );
}

// ───────────────────────── Mensagens prontas (47) ─────────────────────────
export function MessageTemplatesForm({ s }: { s: PlatformSettingsDto }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [f, setF] = useState<Record<MessageTemplateKey, string>>(
    () =>
      Object.fromEntries(
        MESSAGE_TEMPLATE_KEYS.map((k) => [
          k,
          s.messageTemplates[k] ?? DEFAULT_MESSAGE_TEMPLATES[k],
        ]),
      ) as Record<MessageTemplateKey, string>,
  );
  const save = useMutation({
    mutationFn: () =>
      api<PlatformSettingsDto>('/api/v1/platform/settings', {
        method: 'PUT',
        body: {
          messageTemplates: Object.fromEntries(
            MESSAGE_TEMPLATE_KEYS.map((k) => [
              k,
              f[k].trim() === DEFAULT_MESSAGE_TEMPLATES[k] ? '' : f[k],
            ]),
          ),
        },
      }),
    onSuccess: (r) => {
      qc.setQueryData(['platform-settings'], r);
      void qc.invalidateQueries({ queryKey: ['platform-companies'] });
      toast('ok', 'Mensagens salvas.');
    },
    onError: (e) => toast('danger', errorMessage(e)),
  });
  return (
    <FormSection title="Mensagens prontas do WhatsApp" className="mt-5">
      <p className="mb-4 text-sm text-ink-muted">
        Escreva do seu jeito. Onde estiver {MESSAGE_PLACEHOLDERS.join(', ')}, o sistema troca pelo
        nome da pessoa, da empresa, o valor, o vencimento e o passo do começo. Apagar tudo volta ao
        texto padrão.
      </p>
      <div className="space-y-4" data-testid="mensagens-prontas">
        {MESSAGE_TEMPLATE_KEYS.map((k) => (
          <TextAreaField
            key={k}
            label={MESSAGE_TEMPLATE_LABEL[k].label}
            hint={MESSAGE_TEMPLATE_LABEL[k].hint}
            rows={3}
            cols={12}
            value={f[k]}
            maxLength={600}
            onChange={(e) => setF((x) => ({ ...x, [k]: e.target.value }))}
          />
        ))}
      </div>
      <FormActions className="mt-5">
        <Button loading={save.isPending} onClick={() => save.mutate()}>
          Salvar as mensagens
        </Button>
      </FormActions>
    </FormSection>
  );
}
