'use client';

import {
  FEEDBACK_KIND_LABEL,
  FEEDBACK_STATUS_LABEL,
  formatCents,
  type BusinessNumbersDto,
  type FeedbackDto,
  type FeedbackStatus,
  type SystemNoticeDto,
} from '@cenario/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Image as ImageIcon, LifeBuoy, Megaphone } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { FormGrid, TextAreaField, TextField } from '@/components/ui/form';
import { Alert, Badge, Card, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';

const fmt = (iso: string) =>
  new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-line p-3">
      <p className="text-xs font-medium text-ink-muted">{label}</p>
      <p className="mt-0.5 text-2xl font-semibold tabular-nums">{value}</p>
      {hint && <p className="text-xs text-ink-muted">{hint}</p>}
    </div>
  );
}

/** Melhoria 116: números do negócio (receita por mês, testes, cancelados, em risco). */
export function BusinessNumbersCard() {
  const q = useQuery({
    queryKey: ['platform-numbers'],
    queryFn: () => api<BusinessNumbersDto>('/api/v1/platform/business-numbers'),
  });
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{q.error.message}</Alert>;
  const n = q.data;
  return (
    <Card className="mb-6 p-5">
      <h2 className="font-semibold">Números do negócio</h2>
      <p className="text-sm text-ink-muted">
        Só as empresas clientes (fora a sua e as contas de demonstração).
      </p>
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat
          label="Receita por mês"
          value={formatCents(n.mrrCents)}
          hint="anual dividido por 12"
        />
        <Stat label="Pagando" value={String(n.paying)} />
        <Stat label="Em teste grátis" value={String(n.trial)} />
        <Stat label="Novas em 30 dias" value={String(n.newLast30Days)} />
        <Stat label="Pagamento atrasado" value={String(n.overdue)} />
        <Stat label="Pausadas" value={String(n.paused)} />
        <Stat label="Canceladas" value={String(n.canceled)} />
        <Stat label="Cortesia" value={String(n.courtesy)} />
      </div>
      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <div>
          <p className="label">Em risco (7 dias ou mais sem ninguém entrar)</p>
          {n.atRisk.length ? (
            <ul className="divide-y divide-line rounded-xl border border-line text-sm">
              {n.atRisk.map((c) => (
                <li key={c.companyId} className="flex justify-between gap-3 px-3 py-2">
                  <span>{c.tradeName}</span>
                  <span className="text-ink-muted">
                    {c.lastActivityAt ? `último acesso ${fmt(c.lastActivityAt)}` : 'nunca entrou'}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink-muted">Nenhuma empresa parada.</p>
          )}
        </div>
        <div>
          <p className="label">Motivos de cancelamento e pausa</p>
          {n.cancelReasons.length ? (
            <ul className="divide-y divide-line rounded-xl border border-line text-sm">
              {n.cancelReasons.map((r) => (
                <li key={r.reason} className="flex justify-between gap-3 px-3 py-2">
                  <span>{r.reason}</span>
                  <span className="tabular-nums text-ink-muted">{r.count}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-ink-muted">Nenhum cancelamento até agora.</p>
          )}
        </div>
      </div>
    </Card>
  );
}

/** Melhoria 112: sugestões e problemas enviados pelas empresas, com o print. */
export function FeedbackInbox() {
  const qc = useQueryClient();
  const [print, setPrint] = useState<FeedbackDto | null>(null);
  const q = useQuery({
    queryKey: ['platform-feedback'],
    queryFn: () => api<{ items: FeedbackDto[] }>('/api/v1/platform/feedback'),
  });
  const mark = useMutation({
    mutationFn: ({ id, status }: { id: string; status: FeedbackStatus }) =>
      api(`/api/v1/platform/feedback/${id}/status`, { method: 'POST', body: { status } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['platform-feedback'] }),
  });
  const items = q.data?.items ?? [];
  const pending = items.filter((i) => i.status !== 'RESOLVIDO').length;
  return (
    <Card className="mb-6 p-5">
      <h2 className="font-semibold">
        Sugestões e problemas{' '}
        {pending > 0 && (
          <Badge tone="warn" className="ml-1 align-middle">
            {pending} em aberto
          </Badge>
        )}
      </h2>
      {q.isPending ? (
        <Spinner className="mt-3" />
      ) : q.isError ? (
        <Alert tone="danger" className="mt-3">
          {q.error.message}
        </Alert>
      ) : !items.length ? (
        <p className="mt-2 text-sm text-ink-muted">Nada enviado ainda.</p>
      ) : (
        <ul className="mt-3 max-h-[28rem] divide-y divide-line overflow-y-auto rounded-xl border border-line">
          {items.map((f) => (
            <li key={f.id} className="flex flex-wrap items-start gap-3 px-3 py-3 text-sm">
              <div className="min-w-0 flex-1">
                <p className="font-medium">
                  {f.companyName}{' '}
                  <Badge tone={f.kind === 'PROBLEMA' ? 'danger' : 'info'} className="ml-1">
                    {FEEDBACK_KIND_LABEL[f.kind]}
                  </Badge>{' '}
                  <Badge tone={f.status === 'RESOLVIDO' ? 'ok' : 'neutral'}>
                    {FEEDBACK_STATUS_LABEL[f.status]}
                  </Badge>
                </p>
                <p className="mt-1 whitespace-pre-line">{f.message}</p>
                <p className="mt-1 text-xs text-ink-muted">
                  {fmt(f.createdAt)} · {f.userName ?? 'usuário removido'}
                  {f.userEmail ? ` (${f.userEmail})` : ''}
                  {f.pageUrl ? ` · tela ${f.pageUrl}` : ''}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {f.hasScreenshot && (
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<ImageIcon className="size-4" aria-hidden />}
                    onClick={() => setPrint(f)}
                  >
                    Print
                  </Button>
                )}
                {f.status !== 'RESOLVIDO' && (
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={mark.isPending && mark.variables?.id === f.id}
                    onClick={() => mark.mutate({ id: f.id, status: 'RESOLVIDO' })}
                  >
                    Resolvido
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
      <Dialog
        open={Boolean(print)}
        onClose={() => setPrint(null)}
        title="Print da tela"
        description={print ? `${print.companyName} · ${fmt(print.createdAt)}` : undefined}
        size="xl"
      >
        {print && (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={`/api/v1/platform/feedback/${print.id}/print`}
            alt="Print enviado"
            className="w-full rounded-lg border border-line"
          />
        )}
      </Dialog>
    </Card>
  );
}

const localInput = (d: Date) => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** Melhoria 131: aviso de manutenção no topo do sistema de todas as empresas. */
export function NoticesCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: ['platform-notices'],
    queryFn: () => api<{ items: SystemNoticeDto[] }>('/api/v1/platform/notices'),
  });
  const [message, setMessage] = useState('');
  const [from, setFrom] = useState(() => localInput(new Date()));
  const [until, setUntil] = useState(() => localInput(new Date(Date.now() + 2 * 3600_000)));
  const create = useMutation({
    mutationFn: () =>
      api('/api/v1/platform/notices', {
        method: 'POST',
        body: {
          message,
          showFrom: new Date(from).toISOString(),
          showUntil: new Date(until).toISOString(),
        },
      }),
    onSuccess: async () => {
      toast('ok', 'Aviso publicado.');
      setMessage('');
      await qc.invalidateQueries({ queryKey: ['platform-notices'] });
      await qc.invalidateQueries({ queryKey: ['aviso-sistema'] });
    },
  });
  const end = useMutation({
    mutationFn: (id: string) =>
      api(`/api/v1/platform/notices/${id}/end`, { method: 'POST', body: {} }),
    onSuccess: async () => {
      await qc.invalidateQueries({ queryKey: ['platform-notices'] });
      await qc.invalidateQueries({ queryKey: ['aviso-sistema'] });
    },
  });
  const now = new Date();
  return (
    <Card className="mb-6 p-5">
      <h2 className="flex items-center gap-2 font-semibold">
        <Megaphone className="size-4" aria-hidden /> Aviso de manutenção
      </h2>
      <p className="text-sm text-ink-muted">
        Aparece numa faixa no topo do sistema de todas as empresas e na página de status.
      </p>
      <form
        className="mt-3"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <FormGrid>
          <TextAreaField
            label="Mensagem"
            cols={12}
            rows={2}
            maxLength={300}
            placeholder="Ex.: Atualização do sistema hoje das 22h às 22h30. Pode ficar fora do ar por alguns minutos."
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
          <TextField
            label="Mostrar a partir de"
            type="datetime-local"
            cols={6}
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
          <TextField
            label="Até"
            type="datetime-local"
            cols={6}
            value={until}
            onChange={(e) => setUntil(e.target.value)}
          />
        </FormGrid>
        {create.error && (
          <Alert tone="danger" className="mt-3">
            {errorMessage(create.error)}
          </Alert>
        )}
        <Button
          type="submit"
          className="mt-3"
          loading={create.isPending}
          disabled={message.trim().length < 5}
        >
          Publicar aviso
        </Button>
      </form>
      {(q.data?.items ?? []).length > 0 && (
        <ul className="mt-4 divide-y divide-line rounded-xl border border-line text-sm">
          {q.data!.items.map((n) => {
            const live = new Date(n.showFrom) <= now && new Date(n.showUntil) > now;
            const over = new Date(n.showUntil) <= now;
            return (
              <li key={n.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                <span className="min-w-0 flex-1">
                  {n.message}
                  <span className="block text-xs text-ink-muted">
                    {fmt(n.showFrom)} até {fmt(n.showUntil)}
                  </span>
                </span>
                <Badge tone={live ? 'warn' : over ? 'neutral' : 'info'}>
                  {live ? 'No ar' : over ? 'Encerrado' : 'Agendado'}
                </Badge>
                {!over && (
                  <Button
                    size="sm"
                    variant="secondary"
                    loading={end.isPending && end.variables === n.id}
                    onClick={() => end.mutate(n.id)}
                  >
                    Encerrar
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

/** Melhoria 114: entrar como suporte numa empresa que liberou o acesso. */
export function SupportSessionButton({
  companyId,
  tradeName,
  until,
}: {
  companyId: number;
  tradeName: string;
  until: string | null;
}) {
  const [open, setOpen] = useState(false);
  const go = useMutation({
    mutationFn: () =>
      api(`/api/v1/platform/companies/${companyId}/support-session`, { method: 'POST', body: {} }),
    onSuccess: () => {
      window.location.href = '/painel';
    },
  });
  if (!until || new Date(until) <= new Date()) return null;
  return (
    <>
      <Button
        variant="secondary"
        icon={<LifeBuoy className="size-4" aria-hidden />}
        onClick={() => setOpen(true)}
      >
        Entrar como suporte
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Entrar como suporte em ${tradeName}`}
        description={`Liberado até ${fmt(until)}.`}
        size="sm"
        footer={
          <>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancelar
            </Button>
            <Button loading={go.isPending} onClick={() => go.mutate()}>
              Entrar
            </Button>
          </>
        }
      >
        <p className="text-sm text-ink-soft">
          Você sai da sua conta neste navegador e entra no sistema da empresa como &quot;Suporte
          Cenário&quot;. Tudo fica registrado na Auditoria dela. Para voltar, clique em Sair e entre
          de novo com o seu e-mail.
        </p>
        {go.error && (
          <Alert tone="danger" className="mt-3">
            {errorMessage(go.error)}
          </Alert>
        )}
      </Dialog>
    </>
  );
}

/** Melhoria 128: conta de demonstração separada, para mostrar o sistema. */
export function DemoCompanyCard() {
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const create = useMutation({
    mutationFn: () =>
      api<{ companyId: number; email: string; password: string }>('/api/v1/platform/demo-company', {
        method: 'POST',
        body: { email },
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['platform-companies'] }),
  });
  return (
    <Card className="mb-6 p-5">
      <h2 className="font-semibold">Conta de demonstração</h2>
      <p className="text-sm text-ink-muted">
        Uma empresa separada, com clientes fictícios e o plano com o Firma Viva, para mostrar o
        sistema sem misturar com a Cenário Estofados. Não é cobrada e não entra nos números.
      </p>
      {create.data ? (
        <Alert
          tone="ok"
          className="mt-3"
          title="Conta criada. Anote a senha: ela não aparece de novo."
        >
          E-mail: <strong>{create.data.email}</strong>
          <br />
          Senha: <span className="font-mono font-semibold">{create.data.password}</span>
        </Alert>
      ) : (
        <form
          className="mt-3 flex flex-wrap items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            create.mutate();
          }}
        >
          <TextField
            label="E-mail de entrada da demonstração"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="demonstracao@seudominio.com.br"
          />
          <Button type="submit" loading={create.isPending} disabled={!email.includes('@')}>
            Criar conta de demonstração
          </Button>
        </form>
      )}
      {create.error && (
        <Alert tone="danger" className="mt-3">
          {errorMessage(create.error)}
        </Alert>
      )}
    </Card>
  );
}
