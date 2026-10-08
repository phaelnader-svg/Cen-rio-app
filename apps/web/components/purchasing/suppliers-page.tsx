'use client';

import type { MaterialKind, SupplierDto } from '@cenario/shared';
import { MATERIAL_KINDS, MATERIAL_KIND_LABEL } from '@cenario/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Pencil, Plus, Store } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Textarea } from '@/components/ui/field';
import { Alert, Badge, Card, EmptyState, PageHeader, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage, fieldErrors } from '@/lib/api';
import { useCan } from '@/lib/hooks';
import { useSuppliers } from '@/lib/purchasing';

export function SuppliersPage() {
  const can = useCan();
  const list = useSuppliers();
  const [editing, setEditing] = useState<SupplierDto | 'new' | null>(null);
  return (
    <>
      <PageHeader
        title="Fornecedores"
        description="Cadastro simples para os pedidos de compra."
        actions={
          can('compras.gerenciar') && (
            <Button
              icon={<Plus className="size-4" aria-hidden />}
              onClick={() => setEditing('new')}
            >
              Novo fornecedor
            </Button>
          )
        }
      />
      {list.isPending ? (
        <Spinner />
      ) : list.isError ? (
        <Alert tone="danger">{list.error.message}</Alert>
      ) : list.data.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Store className="size-6" aria-hidden />}
            title="Nenhum fornecedor cadastrado"
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <ul className="divide-y divide-line" data-testid="suppliers">
            {list.data.map((s) => (
              <li
                key={s.id}
                className="flex flex-wrap items-center gap-3 px-5 py-3.5"
                data-testid={`supplier-${s.name}`}
              >
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {s.name} {!s.active && <Badge>Inativo</Badge>}
                  </p>
                  <p className="text-sm text-ink-muted">
                    {[s.contactName, s.phone, s.email].filter(Boolean).join(' · ') || 'Sem contato'}
                  </p>
                </div>
                <div className="flex gap-1">
                  {s.categories.map((c) => (
                    <Badge key={c} tone="bronze">
                      {MATERIAL_KIND_LABEL[c]}
                    </Badge>
                  ))}
                </div>
                <span className="text-sm text-ink-muted">{s.openOrders} pedido(s) em aberto</span>
                {can('compras.gerenciar') && (
                  <Button
                    size="sm"
                    variant="ghost"
                    icon={<Pencil className="size-3.5" aria-hidden />}
                    onClick={() => setEditing(s)}
                  >
                    Editar
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Card>
      )}
      {editing && (
        <SupplierDialog
          supplier={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
        />
      )}
    </>
  );
}

function SupplierDialog({
  supplier,
  onClose,
}: {
  supplier: SupplierDto | null;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [v, setV] = useState({
    name: supplier?.name ?? '',
    contactName: supplier?.contactName ?? '',
    phone: supplier?.phone ?? '',
    email: supplier?.email ?? '',
    address: supplier?.address ?? '',
    notes: supplier?.notes ?? '',
    categories: supplier?.categories ?? ([] as MaterialKind[]),
    active: supplier?.active ?? true,
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: () =>
      supplier
        ? api(`/api/v1/suppliers/${supplier.id}`, {
            method: 'PUT',
            body: { ...v, version: supplier.version },
          })
        : api('/api/v1/suppliers', { method: 'POST', body: v }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['suppliers'] });
      toast('ok', 'Fornecedor salvo.');
      onClose();
    },
    onError: (e) => {
      setErrors(fieldErrors(e));
      setError(errorMessage(e));
    },
  });
  const text = (
    k: 'name' | 'contactName' | 'phone' | 'email' | 'address',
    label: string,
    cls?: string,
  ) => (
    <Field label={label} error={errors[k]} className={cls} required={k === 'name'}>
      {(p) => <Input {...p} value={v[k]} onChange={(e) => setV({ ...v, [k]: e.target.value })} />}
    </Field>
  );
  return (
    <Dialog
      open
      onClose={onClose}
      title={supplier ? `Editar ${supplier.name}` : 'Novo fornecedor'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button loading={save.isPending} onClick={() => save.mutate()}>
            Salvar
          </Button>
        </>
      }
    >
      {error && (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        {text('name', 'Nome ou razão social', 'sm:col-span-2')}
        {text('contactName', 'Contato')}
        {text('phone', 'Telefone')}
        {text('email', 'E-mail')}
        {text('address', 'Endereço')}
        <fieldset className="sm:col-span-2">
          <legend className="label">Categorias de materiais</legend>
          <div className="flex flex-wrap gap-4">
            {MATERIAL_KINDS.map((k) => (
              <Checkbox
                key={k}
                label={MATERIAL_KIND_LABEL[k]}
                checked={v.categories.includes(k)}
                onChange={(e) =>
                  setV({
                    ...v,
                    categories: e.target.checked
                      ? [...v.categories, k]
                      : v.categories.filter((x) => x !== k),
                  })
                }
              />
            ))}
          </div>
        </fieldset>
        <Field label="Observações" className="sm:col-span-2">
          {(p) => (
            <Textarea
              {...p}
              rows={2}
              value={v.notes}
              onChange={(e) => setV({ ...v, notes: e.target.value })}
            />
          )}
        </Field>
        <Checkbox
          label="Ativo"
          checked={v.active}
          onChange={(e) => setV({ ...v, active: e.target.checked })}
        />
      </div>
    </Dialog>
  );
}
