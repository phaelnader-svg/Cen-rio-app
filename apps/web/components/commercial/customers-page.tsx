'use client';

import { CUSTOMER_KIND_LABEL, formatPhone } from '@cenario/shared';
import { Contact, Plus, Search } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useDeferredValue, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox, Input, Select } from '@/components/ui/field';
import { Alert, Badge, Card, EmptyState, PageHeader, Spinner } from '@/components/ui/misc';
import { useCustomers } from '@/lib/commercial';
import { useCan } from '@/lib/hooks';
import { CustomerForm } from './customer-form';

export function CustomersPage() {
  const can = useCan();
  const router = useRouter();
  const [q, setQ] = useState('');
  const [kind, setKind] = useState('');
  const [city, setCity] = useState('');
  const [archived, setArchived] = useState(false);
  const [creating, setCreating] = useState(false);
  const params = {
    q: useDeferredValue(q),
    kind,
    city: useDeferredValue(city),
    includeArchived: archived ? 'true' : undefined,
  };
  const customers = useCustomers(params);

  return (
    <>
      <PageHeader
        title="Clientes"
        description="Pessoas e empresas atendidas, com endereços, contatos e histórico de serviços."
        actions={
          can('clientes.gerenciar') && (
            <Button
              icon={<Plus className="size-4" aria-hidden />}
              onClick={() => setCreating(true)}
            >
              Novo cliente
            </Button>
          )
        }
      />
      <Card className="mb-4 p-4">
        <div className="grid gap-3 sm:grid-cols-[1fr_180px_200px] sm:items-center">
          <label className="relative">
            <span className="sr-only">Pesquisar clientes</span>
            <Search
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-muted"
              aria-hidden
            />
            <Input
              className="pl-9"
              placeholder="Nome, CPF/CNPJ, telefone ou e-mail"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </label>
          <Select
            aria-label="Tipo de cliente"
            value={kind}
            onChange={(e) => setKind(e.target.value)}
          >
            <option value="">Todos os tipos</option>
            <option value="PF">Pessoa física</option>
            <option value="PJ">Pessoa jurídica</option>
          </Select>
          <Input
            aria-label="Cidade"
            placeholder="Cidade"
            value={city}
            onChange={(e) => setCity(e.target.value)}
          />
        </div>
        <Checkbox
          className="mt-3"
          label="Incluir arquivados"
          checked={archived}
          onChange={(e) => setArchived(e.target.checked)}
        />
      </Card>

      {customers.isPending ? (
        <Spinner />
      ) : customers.isError ? (
        <Alert tone="danger">{customers.error.message}</Alert>
      ) : customers.data.items.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Contact className="size-6" aria-hidden />}
            title={q || kind || city ? 'Nenhum cliente encontrado' : 'Nenhum cliente cadastrado'}
          />
        </Card>
      ) : (
        <Card className="overflow-hidden">
          <p className="border-b border-line px-5 py-2.5 text-sm text-ink-muted">
            {customers.data.total} cliente(s)
          </p>
          <ul className="divide-y divide-line">
            {customers.data.items.map((c) => {
              const primary = c.addresses.find((a) => a.isPrimary) ?? c.addresses[0];
              return (
                <li key={c.id}>
                  <Link
                    href={`/painel/clientes/${c.id}`}
                    className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3.5 hover:bg-subtle/70"
                    data-testid={`customer-${c.name}`}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">
                        {c.name} {!c.active && <Badge tone="neutral">Arquivado</Badge>}
                      </p>
                      <p className="text-sm text-ink-muted">
                        {CUSTOMER_KIND_LABEL[c.kind]}
                        {primary ? ` · ${primary.city}/${primary.state}` : ''}
                        {c.phone || c.whatsapp ? ` · ${formatPhone(c.whatsapp ?? c.phone)}` : ''}
                      </p>
                    </div>
                    <span className="text-sm text-ink-muted">
                      {c.orderCount} pedido(s) · {c.serviceOrderCount} OS
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
      {creating && (
        <CustomerForm
          onClose={() => setCreating(false)}
          onSaved={(c) => router.push(`/painel/clientes/${c.id}`)}
        />
      )}
    </>
  );
}
