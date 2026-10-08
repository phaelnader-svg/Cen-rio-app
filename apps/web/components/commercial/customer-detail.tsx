'use client';

import {
  CUSTOMER_KIND_LABEL,
  SERVICE_ORDER_STATUS_LABEL,
  customerAddressSchema,
  formatDocument,
  formatPhone,
  type CustomerAddressDto,
  type OrderStatus,
} from '@cenario/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Archive, MapPin, Pencil, Plus, RotateCcw, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Badge, EmptyState, PageHeader, Spinner } from '@/components/ui/misc';
import { Tabs } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage, fieldErrors } from '@/lib/api';
import { useCustomer, useCustomerHistory } from '@/lib/commercial';
import { formatDateTime } from '@/lib/format';
import { useCan } from '@/lib/hooks';
import {
  AddressFields,
  addressFromDto,
  addressLines,
  emptyAddress,
  type AddressState,
} from './address-form';
import { OrderStatusBadge } from './badges';
import { CustomerForm } from './customer-form';
import { BackLink, Detail, Section } from './section';

export function CustomerDetail({ id }: { id: string }) {
  const can = useCan();
  const customer = useCustomer(id);
  const history = useCustomerHistory(id);
  const qc = useQueryClient();
  const toast = useToast();
  const [tab, setTab] = useState('dados');
  const [editing, setEditing] = useState(false);
  const [addressDialog, setAddressDialog] = useState<CustomerAddressDto | 'new' | null>(null);
  const manage = can('clientes.gerenciar');

  const archive = useMutation({
    mutationFn: () =>
      api(`/api/v1/customers/${id}/status`, {
        method: 'POST',
        body: { active: !customer.data!.active, version: customer.data!.version },
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['customer', id] });
      toast('ok', customer.data!.active ? 'Cliente arquivado.' : 'Cliente reativado.');
    },
    onError: (e) => toast('danger', errorMessage(e)),
  });
  const removeAddress = useMutation({
    mutationFn: (addressId: string) =>
      api(`/api/v1/customers/${id}/addresses/${addressId}`, { method: 'DELETE' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['customer', id] }),
    onError: (e) => toast('danger', errorMessage(e)),
  });

  if (customer.isPending) return <Spinner />;
  if (customer.isError) return <Alert tone="danger">{customer.error.message}</Alert>;
  const c = customer.data;

  return (
    <>
      <BackLink href="/painel/clientes" label="Clientes" />
      <PageHeader
        title={c.name}
        description={`${CUSTOMER_KIND_LABEL[c.kind]}${c.tradeName ? ` · ${c.tradeName}` : ''}`}
        actions={
          <>
            {can('pedidos.gerenciar') && c.active && (
              <Link
                href={`/painel/pedidos/novo?cliente=${c.id}`}
                className="inline-flex h-10 items-center gap-2 rounded-xl bg-brand-700 px-4 text-[15px] font-semibold text-white hover:bg-brand-800"
              >
                <Plus className="size-4" aria-hidden /> Novo pedido
              </Link>
            )}
            {manage && (
              <>
                <Button
                  variant="secondary"
                  icon={<Pencil className="size-4" aria-hidden />}
                  onClick={() => setEditing(true)}
                >
                  Editar
                </Button>
                <Button
                  variant="ghost"
                  loading={archive.isPending}
                  icon={
                    c.active ? (
                      <Archive className="size-4" aria-hidden />
                    ) : (
                      <RotateCcw className="size-4" aria-hidden />
                    )
                  }
                  onClick={() => archive.mutate()}
                >
                  {c.active ? 'Arquivar' : 'Reativar'}
                </Button>
              </>
            )}
          </>
        }
      />
      {!c.active && (
        <Alert tone="warn" className="mb-4">
          Cliente arquivado: não aparece na seleção de novos pedidos.
        </Alert>
      )}

      <Tabs
        active={tab}
        onChange={setTab}
        tabs={[
          { key: 'dados', label: 'Dados e endereços' },
          {
            key: 'servicos',
            label: 'Histórico de serviços',
            count: (history.data?.orders.length ?? 0) + (history.data?.serviceOrders.length ?? 0),
          },
          {
            key: 'alteracoes',
            label: 'Alterações do cadastro',
            count: history.data?.changes.length,
          },
        ]}
      >
        {tab === 'dados' && (
          <div className="grid gap-6 lg:grid-cols-5">
            <Section title="Contato" className="lg:col-span-2">
              <dl className="space-y-3">
                <Detail label={c.kind === 'PF' ? 'CPF' : 'CNPJ'}>
                  {formatDocument(c.document)}
                </Detail>
                <Detail label="Telefone">{formatPhone(c.phone)}</Detail>
                <Detail label="WhatsApp">{formatPhone(c.whatsapp)}</Detail>
                <Detail label="E-mail">{c.email}</Detail>
                <Detail label="Observações">{c.notes}</Detail>
                <Detail label="Cadastrado em">{formatDateTime(c.createdAt)}</Detail>
              </dl>
            </Section>
            <Section
              title="Endereços de atendimento"
              className="lg:col-span-3"
              actions={
                manage && (
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<Plus className="size-3.5" aria-hidden />}
                    onClick={() => setAddressDialog('new')}
                  >
                    Adicionar
                  </Button>
                )
              }
            >
              {c.addresses.length === 0 ? (
                <EmptyState
                  icon={<MapPin className="size-5" aria-hidden />}
                  title="Nenhum endereço"
                />
              ) : (
                <ul className="space-y-3">
                  {c.addresses.map((a) => (
                    <li key={a.id} className="rounded-xl border border-line p-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium">{a.label}</p>
                        {a.isPrimary && <Badge tone="brand">Principal</Badge>}
                        {manage && (
                          <div className="ml-auto flex gap-1">
                            <Button
                              size="sm"
                              variant="ghost"
                              icon={<Pencil className="size-3.5" aria-hidden />}
                              onClick={() => setAddressDialog(a)}
                            >
                              Editar
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              icon={<Trash2 className="size-3.5" aria-hidden />}
                              onClick={() => removeAddress.mutate(a.id)}
                            >
                              Remover
                            </Button>
                          </div>
                        )}
                      </div>
                      <p className="mt-1 text-sm whitespace-pre-line text-ink-soft">
                        {addressLines(a)}
                      </p>
                      {a.reference && (
                        <p className="mt-1 text-sm text-ink-muted">Ref.: {a.reference}</p>
                      )}
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-3 text-xs text-ink-muted">
                Pedidos e retiradas guardam uma cópia do endereço combinado; alterações aqui não
                mudam registros já feitos.
              </p>
            </Section>
          </div>
        )}
        {tab === 'servicos' &&
          (history.isPending ? (
            <Spinner />
          ) : (
            <div className="grid gap-6 lg:grid-cols-2">
              <Section title="Pedidos comerciais">
                {!can('pedidos.ver') ? (
                  <p className="text-sm text-ink-muted">Sem permissão para ver pedidos.</p>
                ) : history.data?.orders.length ? (
                  <ul className="divide-y divide-line">
                    {history.data.orders.map((o) => (
                      <li key={o.id} className="py-2.5">
                        <Link
                          href={`/painel/pedidos/${o.id}`}
                          className="font-medium text-brand-700 hover:underline"
                        >
                          {o.code}
                        </Link>{' '}
                        <OrderStatusBadge status={o.status as OrderStatus} />
                        <p className="text-sm text-ink-muted">
                          {o.contractedService} · {o.receivedPieces}/{o.totalPieces} peças recebidas
                          · {formatDateTime(o.createdAt)}
                        </p>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-ink-muted">Nenhum pedido.</p>
                )}
              </Section>
              <Section title="Ordens de serviço">
                {!can('os.ver') ? (
                  <p className="text-sm text-ink-muted">Sem permissão para ver OS.</p>
                ) : history.data?.serviceOrders.length ? (
                  <ul className="divide-y divide-line">
                    {history.data.serviceOrders.map((s) => (
                      <li key={s.id} className="py-2.5">
                        <Link
                          href={`/painel/os/${s.id}`}
                          className="font-medium text-brand-700 hover:underline"
                        >
                          {s.code}
                        </Link>{' '}
                        <span className="text-sm text-ink-muted">
                          {SERVICE_ORDER_STATUS_LABEL[s.status as 'ABERTA']} · {s.pieceCount}{' '}
                          peça(s) · {formatDateTime(s.createdAt)}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-ink-muted">Nenhuma OS.</p>
                )}
              </Section>
            </div>
          ))}
        {tab === 'alteracoes' && (
          <Section title="Alterações do cadastro" bodyClassName="p-0">
            <ol className="divide-y divide-line">
              {history.data?.changes.map((h) => (
                <li key={h.id} className="px-5 py-3">
                  <p className="text-sm">{h.summary}</p>
                  <p className="text-xs text-ink-muted">
                    {formatDateTime(h.createdAt)} · {h.actor ?? 'Sistema'}
                  </p>
                  {h.changes &&
                  typeof h.changes === 'object' &&
                  Object.keys(h.changes).length > 0 ? (
                    <ul className="mt-1 text-xs text-ink-soft">
                      {Object.entries(
                        h.changes as Record<string, { from: unknown; to: unknown }>,
                      ).map(([k, v]) => (
                        <li key={k}>
                          <strong>{k}</strong>: {String(v?.from ?? '—')} → {String(v?.to ?? '—')}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              ))}
            </ol>
          </Section>
        )}
      </Tabs>

      {editing && <CustomerForm customer={c} onClose={() => setEditing(false)} />}
      {addressDialog && (
        <AddressDialog
          customerId={id}
          address={addressDialog === 'new' ? undefined : addressDialog}
          onClose={() => setAddressDialog(null)}
        />
      )}
    </>
  );
}

function AddressDialog({
  customerId,
  address,
  onClose,
}: {
  customerId: string;
  address?: CustomerAddressDto;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [value, setValue] = useState<AddressState>(
    address ? addressFromDto(address) : emptyAddress('Novo endereço'),
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: () => {
      const body = customerAddressSchema.parse(value);
      return address
        ? api(`/api/v1/customers/${customerId}/addresses/${address.id}`, { method: 'PUT', body })
        : api(`/api/v1/customers/${customerId}/addresses`, { method: 'POST', body });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['customer', customerId] });
      onClose();
    },
    onError: (e) => {
      const issues = (e as { issues?: { path: PropertyKey[]; message: string }[] }).issues;
      if (issues) {
        const map: Record<string, string> = {};
        for (const i of issues) map[String(i.path[0])] ??= i.message;
        setErrors(map);
        return;
      }
      setErrors(fieldErrors(e));
      setError(errorMessage(e));
    },
  });
  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={address ? `Editar endereço "${address.label}"` : 'Novo endereço'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button loading={m.isPending} onClick={() => m.mutate()}>
            Salvar endereço
          </Button>
        </>
      }
    >
      {error && (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      )}
      <AddressFields value={value} onChange={setValue} errors={errors} showPrimary />
    </Dialog>
  );
}
