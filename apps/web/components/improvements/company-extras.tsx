'use client';

import { plural } from '@cenario/shared';
import { CANCEL_REASONS, SUPPORT_ACCESS_HOURS } from '@cenario/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, LifeBuoy, PauseCircle } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { FormGrid, SelectField, TextAreaField } from '@/components/ui/form';
import { Alert, Card } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { useMe } from '@/lib/hooks';

const fmt = (iso: string) =>
  new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });

/** Melhoria 114: o dono libera o suporte do Cenário por algumas horas (fica na Auditoria). */
export function SupportAccessCard() {
  const me = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const [hours, setHours] = useState<number>(8);
  const until = me.data?.company.supportAccessUntil ?? null;
  const active = Boolean(until && new Date(until) > new Date());
  const save = useMutation({
    mutationFn: (h: number) =>
      api('/api/v1/company/support-access', { method: 'POST', body: { hours: h } }),
    onSuccess: async (_r, h) => {
      toast('ok', h ? `Suporte liberado por ${h} horas.` : 'Acesso do suporte encerrado.');
      await qc.invalidateQueries({ queryKey: ['me'] });
    },
    onError: (e) => toast('danger', errorMessage(e)),
  });
  if (me.data?.company.platformOwner) return null;
  return (
    <Card className="mt-6 p-6" data-testid="support-access-card">
      <h2 className="flex items-center gap-2 font-semibold">
        <LifeBuoy className="size-4" aria-hidden /> Acesso do suporte
      </h2>
      <p className="mt-1 text-sm text-ink-muted">
        Se precisar de ajuda, libere a equipe do Cenário Gestão para entrar no seu sistema por
        algumas horas. Tudo o que for feito fica registrado na Auditoria. Depois do prazo, o acesso
        acaba sozinho.
      </p>
      {active ? (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Alert tone="info" className="flex-1">
            Suporte liberado até {fmt(until!)}.
          </Alert>
          <Button variant="outline-danger" loading={save.isPending} onClick={() => save.mutate(0)}>
            Encerrar agora
          </Button>
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <SelectField
            label="Por quanto tempo"
            value={String(hours)}
            onChange={(e) => setHours(Number(e.target.value))}
          >
            {SUPPORT_ACCESS_HOURS.map((h) => (
              <option key={h} value={h}>
                {h < 24 ? `${h} horas` : `${plural(h / 24, 'dia', 'dias')}`}
              </option>
            ))}
          </SelectField>
          <Button loading={save.isPending} onClick={() => save.mutate(hours)}>
            Liberar acesso do suporte
          </Button>
        </div>
      )}
    </Card>
  );
}

/** Melhoria 99: baixar todos os dados da empresa num arquivo .zip (planilhas CSV). */
export function ExportDataCard() {
  return (
    <Card className="mt-6 p-6">
      <h2 className="font-semibold">Baixar todos os dados</h2>
      <p className="mt-1 text-sm text-ink-muted">
        Um arquivo .zip com uma planilha (CSV, abre no Excel) para cada parte do sistema: clientes,
        pedidos, ordens de serviço, orçamentos, financeiro e o resto. Senhas e chaves de acesso não
        vão no arquivo.
      </p>
      <a
        href="/api/v1/company/export.zip"
        className="mt-4 inline-flex h-11 items-center gap-2 rounded-xl border border-line-strong bg-surface px-4 text-[15px] font-semibold hover:bg-subtle"
        download
      >
        <Download className="size-4" aria-hidden /> Baixar os dados (.zip)
      </a>
    </Card>
  );
}

interface CancelState {
  reasons: string[];
  canceledAt: string | null;
  pausedUntil: string | null;
  cancelReason: string | null;
  courtesy: boolean;
}

/** Melhoria 113: cancelar ou pausar a assinatura, com o motivo; a pausa é oferecida antes. */
export function CancelSubscriptionCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const state = useQuery({
    queryKey: ['assinatura-cancelamento'],
    queryFn: () => api<CancelState>('/api/v1/subscription/cancel-options'),
  });
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [details, setDetails] = useState('');
  const act = useMutation({
    mutationFn: (action: 'CANCELAR' | 'PAUSAR') =>
      api('/api/v1/subscription/cancel', {
        method: 'POST',
        body: { action, reason, details: details.trim() || undefined },
      }),
    onSuccess: async (_r, action) => {
      toast('ok', action === 'PAUSAR' ? 'Assinatura pausada por um mês.' : 'Assinatura cancelada.');
      setOpen(false);
      await qc.invalidateQueries();
    },
  });
  const resume = useMutation({
    mutationFn: () => api('/api/v1/subscription/resume', { method: 'POST', body: {} }),
    onSuccess: async () => {
      toast('ok', 'Assinatura reativada. Escolha o plano acima para voltar a pagar.');
      await qc.invalidateQueries();
    },
  });
  const s = state.data;
  if (!s || s.courtesy) return null;
  const paused = s.pausedUntil && new Date(s.pausedUntil) > new Date();
  return (
    <Card className="mt-8 p-5">
      {s.canceledAt || paused ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="flex-1 text-sm">
            {s.canceledAt
              ? `Assinatura cancelada em ${new Date(s.canceledAt).toLocaleDateString('pt-BR')}.`
              : `Assinatura pausada até ${new Date(s.pausedUntil!).toLocaleDateString('pt-BR')}.`}{' '}
            Os dados continuam guardados.
          </p>
          <Button loading={resume.isPending} onClick={() => resume.mutate()}>
            Reativar assinatura
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <p className="flex-1 text-sm text-ink-muted">
            Precisa parar? Você pode pausar por um mês ou cancelar quando quiser, sem multa.
          </p>
          <Button variant="secondary" onClick={() => setOpen(true)}>
            Pausar ou cancelar
          </Button>
        </div>
      )}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Pausar ou cancelar a assinatura"
        description="Conte o motivo: ajuda a melhorar o sistema."
      >
        <FormGrid>
          <SelectField
            label="Motivo"
            cols={12}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          >
            <option value="">Selecione</option>
            {CANCEL_REASONS.map((r) => (
              <option key={r}>{r}</option>
            ))}
          </SelectField>
          <TextAreaField
            label="Quer contar mais? (opcional)"
            cols={12}
            rows={2}
            maxLength={400}
            value={details}
            onChange={(e) => setDetails(e.target.value)}
          />
        </FormGrid>
        <Alert tone="info" className="mt-4" title="Que tal pausar por um mês?">
          Na pausa, nada é cobrado e os dados ficam guardados. Quando voltar, é só reativar.
        </Alert>
        {act.error && (
          <Alert tone="danger" className="mt-3">
            {errorMessage(act.error)}
          </Alert>
        )}
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button
            variant="outline-danger"
            disabled={!reason}
            loading={act.isPending && act.variables === 'CANCELAR'}
            onClick={() => act.mutate('CANCELAR')}
          >
            Cancelar assinatura
          </Button>
          <Button
            icon={<PauseCircle className="size-4" aria-hidden />}
            disabled={!reason}
            loading={act.isPending && act.variables === 'PAUSAR'}
            onClick={() => act.mutate('PAUSAR')}
          >
            Pausar por um mês
          </Button>
        </div>
      </Dialog>
    </Card>
  );
}
