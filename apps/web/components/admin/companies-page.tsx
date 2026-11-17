'use client';

/**
 * Multi-empresa — etapa 4: painel simples do dono da plataforma. Lista as empresas que usam o
 * sistema (cada "Criar conta" é uma empresa nova) e bloqueia/libera o acesso de cada uma.
 * Mostra só o resumo da empresa (plano, pagamento, contagem de pedidos); nenhum dado de cliente.
 */
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { SUBSCRIPTION_STATUS_LABEL, type PlanKey, type SubscriptionStatus } from '@cenario/shared';
import { Ban, Building2, CircleCheck, CreditCard } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Select } from '@/components/ui/field';
import { formatCents, formatDay } from '@/lib/billing';
import { Alert, Badge, Card, EmptyState, PageHeader, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import {
  BusinessNumbersCard,
  DemoCompanyCard,
  FeedbackInbox,
  NoticesCard,
  SupportSessionButton,
} from '@/components/improvements/platform-extras';

interface CompanyRow {
  id: number;
  tradeName: string;
  ownerEmail: string | null;
  users: number;
  createdAt: string;
  lastLoginAt: string | null;
  blockedAt: string | null;
  blockedReason: string | null;
  isPlatform: boolean;
  ownerEmailConfirmed: boolean;
  isDemo: boolean;
  supportAccessUntil: string | null;
  canceledAt: string | null;
  pausedUntil: string | null;
  cancelReason: string | null;
  orders: number;
  lastOrderAt: string | null;
  subscription: {
    plan: PlanKey;
    planLabel: string;
    cycle: string;
    courtesy: boolean;
    trialEndsAt: string | null;
    paidUntil: string | null;
    status: SubscriptionStatus;
    lastInvoice: { status: string; dueDate: string; amountCents: number } | null;
  };
}

const STATUS_TONE = {
  CORTESIA: 'info',
  TESTE: 'info',
  ATIVA: 'ok',
  ATRASADA: 'warn',
  VENCIDA: 'danger',
} as const;

export function CompaniesPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const list = useQuery({
    queryKey: ['platform-companies'],
    queryFn: () => api<{ items: CompanyRow[] }>('/api/v1/platform/companies'),
  });
  const toggle = useMutation({
    mutationFn: (c: CompanyRow) =>
      api(`/api/v1/platform/companies/${c.id}/${c.blockedAt ? 'unblock' : 'block'}`, {
        method: 'POST',
        body: {},
      }),
    onSuccess: (_r, c) => {
      toast(
        'ok',
        c.blockedAt
          ? `${c.tradeName} liberada: a equipe dela já pode entrar.`
          : `${c.tradeName} bloqueada: ninguém dela entra até você liberar.`,
      );
      void qc.invalidateQueries({ queryKey: ['platform-companies'] });
    },
    onError: (e) => toast('danger', errorMessage(e)),
  });
  const [editing, setEditing] = useState<CompanyRow | null>(null);
  const items = list.data?.items ?? [];
  const outras = items.filter((c) => !c.isPlatform);

  return (
    <>
      <PageHeader
        title="Empresas"
        description="Empresas que usam o Cenário Gestão."
        help="Empresas que usam o Cenário Gestão, com plano, situação do pagamento e uso. Cada conta criada na tela de entrar é uma empresa nova, com dados separados das outras."
      />
      <BusinessNumbersCard />
      <FeedbackInbox />
      <NoticesCard />
      <DemoCompanyCard />
      {list.isLoading ? <Spinner /> : null}
      {list.isError ? <Alert tone="danger">{errorMessage(list.error)}</Alert> : null}
      {list.isSuccess && outras.length === 0 ? (
        <EmptyState
          icon={<Building2 className="size-6" aria-hidden />}
          title="Nenhuma outra empresa ainda"
          description="Quando alguém criar uma conta na tela de entrar, a empresa aparece aqui."
        />
      ) : null}
      <div className="space-y-3">
        {items.map((c) => (
          <Card
            key={c.id}
            className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center"
            data-testid="company-row"
          >
            <div className="min-w-0 flex-1">
              <p className="font-semibold text-ink">
                {c.tradeName} <span className="text-sm font-normal text-ink-muted">nº {c.id}</span>
              </p>
              <p className="text-sm text-ink-muted">
                {c.ownerEmail ?? 'sem e-mail'}
                {c.ownerEmail && !c.ownerEmailConfirmed ? ' (e-mail não confirmado)' : ''} ·{' '}
                {c.users} {c.users === 1 ? 'usuário' : 'usuários'} · criada em{' '}
                {formatDateTime(c.createdAt)} · último acesso{' '}
                {c.lastLoginAt ? formatDateTime(c.lastLoginAt) : 'nunca'}
              </p>
              <p className="text-sm text-ink-muted">
                {c.orders} {c.orders === 1 ? 'pedido lançado' : 'pedidos lançados'}
                {c.lastOrderAt ? ` (último em ${formatDay(c.lastOrderAt)})` : ''} ·{' '}
                {c.subscription.planLabel}
                {c.subscription.status === 'TESTE'
                  ? ` · teste até ${formatDay(c.subscription.trialEndsAt)}`
                  : c.subscription.paidUntil
                    ? ` · pago até ${formatDay(c.subscription.paidUntil)}`
                    : ''}
                {c.subscription.lastInvoice
                  ? ` · última cobrança ${formatCents(c.subscription.lastInvoice.amountCents)} (${c.subscription.lastInvoice.status.toLowerCase()})`
                  : ''}
              </p>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {c.isPlatform ? <Badge tone="info">Sua empresa</Badge> : null}
                {c.isDemo ? <Badge tone="bronze">Demonstração</Badge> : null}
                {c.canceledAt ? (
                  <Badge tone="danger">
                    Cancelou em {formatDay(c.canceledAt)}
                    {c.cancelReason ? ` (${c.cancelReason})` : ''}
                  </Badge>
                ) : c.pausedUntil && new Date(c.pausedUntil) > new Date() ? (
                  <Badge tone="warn">Pausada até {formatDay(c.pausedUntil)}</Badge>
                ) : null}
                {c.supportAccessUntil && new Date(c.supportAccessUntil) > new Date() ? (
                  <Badge tone="info">
                    Suporte liberado até {formatDateTime(c.supportAccessUntil)}
                  </Badge>
                ) : null}
                <Badge tone={STATUS_TONE[c.subscription.status]}>
                  {SUBSCRIPTION_STATUS_LABEL[c.subscription.status]}
                </Badge>
                {c.blockedAt ? (
                  <Badge tone="danger">Bloqueada em {formatDateTime(c.blockedAt)}</Badge>
                ) : (
                  <Badge tone="ok">Ativa</Badge>
                )}
              </div>
            </div>
            {c.isPlatform ? null : (
              <SupportSessionButton
                companyId={c.id}
                tradeName={c.tradeName}
                until={c.supportAccessUntil}
              />
            )}
            {c.isPlatform ? null : (
              <Button
                variant="secondary"
                icon={<CreditCard className="size-4" aria-hidden />}
                onClick={() => setEditing(c)}
              >
                Plano
              </Button>
            )}
            {c.isPlatform ? null : (
              <Button
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
          </Card>
        ))}
      </div>
      {editing && <PlanDialog company={editing} onClose={() => setEditing(null)} />}
    </>
  );
}

/** Plano, cortesia, teste e pagamento recebido fora do Asaas (melhoria 7). */
function PlanDialog({ company, onClose }: { company: CompanyRow; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [plan, setPlan] = useState<PlanKey>(company.subscription.plan);
  const [courtesy, setCourtesy] = useState(company.subscription.courtesy);
  const [paidUntil, setPaidUntil] = useState('');
  const [trialEndsAt, setTrialEndsAt] = useState('');
  const save = useMutation({
    mutationFn: () =>
      api(`/api/v1/platform/companies/${company.id}/subscription`, {
        method: 'PUT',
        body: {
          plan,
          courtesy,
          ...(paidUntil ? { paidUntil } : {}),
          ...(trialEndsAt ? { trialEndsAt } : {}),
        },
      }),
    onSuccess: () => {
      toast('ok', `${company.tradeName}: plano atualizado.`);
      void qc.invalidateQueries({ queryKey: ['platform-companies'] });
      onClose();
    },
    onError: (e) => toast('danger', errorMessage(e)),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Plano de ${company.tradeName}`}
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
      <div className="space-y-4">
        <Field label="Plano">
          {(p) => (
            <Select {...p} value={plan} onChange={(e) => setPlan(e.target.value as PlanKey)}>
              <option value="gestao">Cenário Gestão</option>
              <option value="gestao_jogo">Cenário Gestão + Firma Viva</option>
            </Select>
          )}
        </Field>
        <Checkbox
          checked={courtesy}
          onChange={(e) => setCourtesy(e.target.checked)}
          label="Cortesia"
          description="Não paga e nunca bloqueia."
        />
        <Field label="Recebi o pagamento por fora: liberar até" hint="Deixe vazio para não mudar.">
          {(p) => (
            <Input
              {...p}
              type="date"
              value={paidUntil}
              onChange={(e) => setPaidUntil(e.target.value)}
            />
          )}
        </Field>
        <Field label="Estender o teste grátis até" hint="Deixe vazio para não mudar.">
          {(p) => (
            <Input
              {...p}
              type="date"
              value={trialEndsAt}
              onChange={(e) => setTrialEndsAt(e.target.value)}
            />
          )}
        </Field>
      </div>
    </Dialog>
  );
}
