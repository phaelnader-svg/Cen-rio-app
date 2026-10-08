'use client';

import type { RoleDto } from '@cenario/shared';
import { createRoleSchema } from '@cenario/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Lock, Pencil, Plus, ShieldCheck, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Textarea } from '@/components/ui/field';
import { Alert, Badge, Card, PageHeader, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { ApiError, api, errorMessage, newIdempotencyKey } from '@/lib/api';
import { useCan } from '@/lib/hooks';
import { usePermissionCatalog, useRoles } from '@/lib/queries';

export function RolesPage() {
  const can = useCan();
  const roles = useRoles();
  const catalog = usePermissionCatalog();
  const [editing, setEditing] = useState<RoleDto | 'new' | null>(null);
  const [deleting, setDeleting] = useState<RoleDto | null>(null);
  const manage = can('funcoes.gerenciar');
  const labels = new Map(catalog.data?.permissions.map((p) => [p.key, p.label]));

  return (
    <>
      <PageHeader
        title="Funções e permissões"
        description="Funções agrupam permissões. Toda permissão é verificada no servidor, em cada operação."
        actions={
          manage && (
            <Button
              icon={<Plus className="size-4" aria-hidden />}
              onClick={() => setEditing('new')}
            >
              Nova função
            </Button>
          )
        }
      />
      {roles.isPending ? (
        <Spinner />
      ) : roles.isError ? (
        <Alert tone="danger">{roles.error.message}</Alert>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {roles.data.map((r) => (
            <Card key={r.id} className="flex flex-col p-5" data-testid={`role-${r.name}`}>
              <div className="flex items-start gap-3">
                <span className="rounded-xl bg-brand-50 p-2 text-brand-700">
                  <ShieldCheck className="size-5" aria-hidden />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-lg font-semibold">{r.name}</h2>
                    {r.system && <Badge>Padrão</Badge>}
                    {r.locked && (
                      <Badge tone="bronze">
                        <Lock className="size-3" aria-hidden /> Protegida
                      </Badge>
                    )}
                  </div>
                  {r.description && (
                    <p className="mt-0.5 text-sm text-ink-muted">{r.description}</p>
                  )}
                  <p className="mt-1 text-xs text-ink-muted">
                    {r.memberCount} {r.memberCount === 1 ? 'pessoa' : 'pessoas'} ·{' '}
                    {r.permissions.length} permissões
                  </p>
                </div>
              </div>
              <ul className="mt-4 flex flex-wrap gap-1.5">
                {r.permissions.map((p) => (
                  <li key={p}>
                    <Badge tone="neutral">{labels.get(p) ?? p}</Badge>
                  </li>
                ))}
              </ul>
              {manage && !r.locked && (
                <div className="mt-auto flex gap-2 pt-4">
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<Pencil className="size-3.5" aria-hidden />}
                    onClick={() => setEditing(r)}
                  >
                    Editar
                  </Button>
                  {!r.system && (
                    <Button
                      size="sm"
                      variant="outline-danger"
                      icon={<Trash2 className="size-3.5" aria-hidden />}
                      onClick={() => setDeleting(r)}
                    >
                      Excluir
                    </Button>
                  )}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
      {editing && (
        <RoleDialog
          role={editing === 'new' ? undefined : editing}
          onClose={() => setEditing(null)}
        />
      )}
      {deleting && <DeleteRoleDialog role={deleting} onClose={() => setDeleting(null)} />}
    </>
  );
}

function RoleDialog({ role, onClose }: { role?: RoleDto; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const catalog = usePermissionCatalog();
  const [name, setName] = useState(role?.name ?? '');
  const [description, setDescription] = useState(role?.description ?? '');
  const [perms, setPerms] = useState<string[]>(role?.permissions ?? []);
  const [error, setError] = useState<string | null>(null);
  const idem = useRef(newIdempotencyKey());

  const m = useMutation({
    mutationFn: () => {
      const body = createRoleSchema.parse({ name, description, permissions: perms });
      return role
        ? api(`/api/roles/${role.id}`, { method: 'PUT', body: { ...body, version: role.version } })
        : api('/api/roles', { method: 'POST', body, idempotencyKey: idem.current });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['roles'] });
      toast('ok', role ? 'Função atualizada.' : 'Função criada.');
      onClose();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT')
        void qc.invalidateQueries({ queryKey: ['roles'] });
      setError(
        e instanceof ApiError
          ? e.message
          : ((e as { issues?: { message: string }[] }).issues?.[0]?.message ?? errorMessage(e)),
      );
    },
  });

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={role ? `Editar função ${role.name}` : 'Nova função'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button loading={m.isPending} onClick={() => m.mutate()}>
            Salvar
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Nome" required>
          {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <Field label="Descrição">
          {(p) => (
            <Textarea
              {...p}
              rows={2}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          )}
        </Field>
        {catalog.data &&
          Object.entries(catalog.data.groups).map(([key, label]) => (
            <fieldset key={key}>
              <legend className="mb-2 text-xs font-semibold tracking-wide text-ink-muted uppercase">
                {label}
              </legend>
              <div className="grid gap-3 sm:grid-cols-2">
                {catalog.data.permissions
                  .filter((p) => p.group === key)
                  .map((p) => (
                    <Checkbox
                      key={p.key}
                      label={
                        <span className="inline-flex items-center gap-2">
                          {p.label} {p.critical && <Badge tone="bronze">crítica</Badge>}
                        </span>
                      }
                      description={p.description}
                      checked={perms.includes(p.key)}
                      onChange={(e) =>
                        setPerms(
                          e.target.checked ? [...perms, p.key] : perms.filter((x) => x !== p.key),
                        )
                      }
                    />
                  ))}
              </div>
            </fieldset>
          ))}
      </div>
    </Dialog>
  );
}

function DeleteRoleDialog({ role, onClose }: { role: RoleDto; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => api(`/api/roles/${role.id}`, { method: 'DELETE' }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['roles'] });
      toast('ok', 'Função excluída.');
      onClose();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={`Excluir a função ${role.name}?`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="danger" loading={m.isPending} onClick={() => m.mutate()}>
            Excluir
          </Button>
        </>
      }
    >
      {error && (
        <Alert tone="danger" className="mb-3">
          {error}
        </Alert>
      )}
      <p className="text-[15px] text-ink-soft">A exclusão fica registrada na auditoria.</p>
    </Dialog>
  );
}
