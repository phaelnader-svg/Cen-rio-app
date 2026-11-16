'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, LogOut, Send } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { FirmaMark } from '@/components/brand';
import { Button } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Alert, Badge, Card, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { ApiError, api, errorMessage } from '@/lib/api';
import { useMe } from '@/lib/hooks';

interface Members {
  members: {
    userId: string;
    name: string;
    email: string;
    role: string;
    roleLabel: string;
    lastLoginAt: string | null;
  }[];
  invites: { id: string; email: string; roleLabel: string; expiresAt: string }[];
}

export function OrgPage() {
  const me = useMe();
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('GESTOR');
  const [lastLink, setLastLink] = useState<string | null>(null);
  const unauth = me.error instanceof ApiError && me.error.status === 401;
  useEffect(() => {
    if (unauth) window.location.assign('/api/entrar/cenario');
  }, [unauth, router]);
  const members = useQuery({
    queryKey: ['org-members', me.data?.organization?.id],
    queryFn: () => api<Members>('/api/org/membros'),
    enabled: Boolean(me.data?.organization),
  });
  const isAdmin = ['DONO', 'ADMIN'].includes(me.data?.organization?.role ?? '');

  async function invite(e: React.FormEvent) {
    e.preventDefault();
    try {
      const r = await api<{ devLink?: string }>('/api/org/convites', {
        method: 'POST',
        body: { email, role },
      });
      toast('ok', `Convite enviado para ${email}.`);
      setLastLink(r.devLink ?? null);
      setEmail('');
      void qc.invalidateQueries({ queryKey: ['org-members'] });
    } catch (err) {
      toast('danger', errorMessage(err));
    }
  }
  async function switchOrg(orgId: string) {
    const m = await api('/api/auth/organizacao', { method: 'POST', body: { orgId } });
    qc.clear();
    qc.setQueryData(['me'], m);
    router.push('/jogo');
  }
  async function logout() {
    await api('/api/auth/logout', { method: 'POST' });
    qc.clear();
    router.replace('/entrar?motivo=saiu');
  }

  if (me.isLoading || unauth)
    return (
      <div className="grid min-h-dvh place-items-center">
        <Spinner />
      </div>
    );
  const org = me.data?.organization;
  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <div className="mb-6 flex items-center justify-between gap-3">
        <FirmaMark />
        <div className="flex gap-2">
          <Link
            href="/jogo"
            className="inline-flex items-center gap-1 rounded-xl px-3 py-2 text-sm font-semibold text-brand-700 hover:bg-subtle"
          >
            <ArrowLeft className="size-4" aria-hidden /> Voltar ao jogo
          </Link>
          <Button
            variant="secondary"
            icon={<LogOut className="size-4" aria-hidden />}
            onClick={() => void logout()}
            data-testid="logout"
          >
            Sair
          </Button>
        </div>
      </div>
      <h1 className="text-2xl font-semibold tracking-tight" data-testid="org-title">
        {org?.name ?? 'Sem organização'}
      </h1>
      <p className="mt-1 text-sm text-ink-muted">
        {me.data?.user.name} · {org?.roleLabel} · Cenário Gestão:{' '}
        {org?.cenario.status === 'CONECTADA'
          ? `conectado (${org.cenario.companyName})`
          : 'não conectado'}
      </p>

      {(me.data?.organizations.length ?? 0) > 1 ? (
        <Card className="mt-6 p-4">
          <p className="mb-2 text-sm font-semibold">Suas organizações</p>
          <div className="flex flex-wrap gap-2">
            {me.data!.organizations.map((o) => (
              <Button
                key={o.id}
                variant={o.id === org?.id ? 'primary' : 'secondary'}
                onClick={() => void switchOrg(o.id)}
              >
                {o.name} · {o.roleLabel}
              </Button>
            ))}
          </div>
        </Card>
      ) : null}

      <Card className="mt-6 p-4">
        <p className="mb-3 text-sm font-semibold">Pessoas</p>
        {members.isLoading ? <Spinner /> : null}
        <ul className="divide-y divide-line">
          {members.data?.members.map((m) => (
            <li
              key={m.userId}
              className="flex items-center justify-between gap-2 py-2 text-sm"
              data-testid="member-row"
            >
              <span>
                <strong>{m.name}</strong> <span className="text-ink-muted">{m.email}</span>
              </span>
              <Badge tone={m.role === 'DONO' ? 'brand' : 'neutral'}>{m.roleLabel}</Badge>
            </li>
          ))}
          {members.data?.invites.map((i) => (
            <li
              key={i.id}
              className="flex items-center justify-between gap-2 py-2 text-sm text-ink-muted"
            >
              <span>{i.email} (convite pendente)</span>
              <Badge tone="warn">{i.roleLabel}</Badge>
            </li>
          ))}
        </ul>
      </Card>

      {isAdmin ? (
        <Card className="mt-6 p-4">
          <p className="mb-3 text-sm font-semibold">Convidar pessoa</p>
          <form onSubmit={invite} className="grid gap-3 sm:grid-cols-[1fr_12rem_auto] sm:items-end">
            <Field label="E-mail">
              {(p) => (
                <Input
                  {...p}
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  data-testid="invite-email"
                />
              )}
            </Field>
            <Field label="Papel">
              {(p) => (
                <Select
                  {...p}
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  data-testid="invite-role"
                >
                  <option value="ADMIN">Administrador</option>
                  <option value="GESTOR">Gestor</option>
                  <option value="MEMBRO">Membro (acompanha)</option>
                </Select>
              )}
            </Field>
            <Button
              type="submit"
              icon={<Send className="size-4" aria-hidden />}
              data-testid="invite-send"
            >
              Convidar
            </Button>
          </form>
          {lastLink ? (
            <Alert
              tone="info"
              className="mt-3"
              title="Link do convite (prévia, sem envio de e-mail)"
            >
              <span className="break-all" data-testid="invite-link">
                {lastLink}
              </span>
            </Alert>
          ) : null}
          <p className="mt-3 text-xs text-ink-muted">
            Gestor opera o jogo (planta, agentes e ações na empresa conectada). Membro só acompanha.
            Administrador também convida pessoas e conecta o Cenário Gestão.
          </p>
        </Card>
      ) : null}
    </main>
  );
}
