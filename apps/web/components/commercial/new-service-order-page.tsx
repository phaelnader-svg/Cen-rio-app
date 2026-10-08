'use client';

import type { Priority, ServiceOrderDto, ServiceType } from '@cenario/shared';
import {
  PRIORITIES,
  PRIORITY_LABEL,
  SERVICE_TYPES,
  SERVICE_TYPE_LABEL,
  createServiceOrderSchema,
} from '@cenario/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Alert, Card, PageHeader, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { ApiError, api, newIdempotencyKey } from '@/lib/api';
import { useAvailableForOs, type AvailableForOs } from '@/lib/commercial';
import { useCan } from '@/lib/hooks';
import { useEmployees } from '@/lib/queries';
import { BackLink } from './section';

interface Row {
  key: string;
  orderItemId: string;
  quantity: string;
  description: string;
  serviceType: ServiceType;
  fabricName: string;
  fabricColor: string;
  fabricReference: string;
  foamSpecs: string;
  technicalNotes: string;
}

export function NewServiceOrderPage() {
  const params = useSearchParams();
  const orderId = params.get('pedido');
  const can = useCan();
  const available = useAvailableForOs(orderId);
  if (!can('os.gerenciar')) return <Alert tone="warn">Você não tem permissão para criar OS.</Alert>;
  if (!orderId)
    return <Alert tone="info">Abra um pedido com peças recebidas e use “Criar OS técnica”.</Alert>;
  if (available.isPending) return <Spinner />;
  if (available.isError) return <Alert tone="danger">{available.error.message}</Alert>;
  return (
    <>
      <BackLink href={`/painel/pedidos/${orderId}`} label={`Pedido ${available.data.order.code}`} />
      <PageHeader
        title="Nova OS técnica"
        description={`${available.data.customer.name} · ${available.data.order.contractedService}`}
      />
      {available.data.items.every((i) => i.receivedQuantity === 0) ? (
        <Alert tone="warn" title="Aguardando a chegada das peças">
          A OS técnica só pode ser criada depois que a peça chegar à oficina. Registre o recebimento
          primeiro.
        </Alert>
      ) : available.data.items.every((i) => i.available <= 0) ? (
        <Alert tone="info">Todas as peças recebidas deste pedido já estão em OS.</Alert>
      ) : (
        <ServiceOrderForm data={available.data} />
      )}
    </>
  );
}

function ServiceOrderForm({ data }: { data: AvailableForOs }) {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const can = useCan();
  const employees = useEmployees(can('funcionarios.ver'));
  const usable = data.items.filter((i) => i.available > 0);
  const [rows, setRows] = useState<Row[]>(() =>
    usable.map((i) => ({
      key: crypto.randomUUID(),
      orderItemId: i.orderItemId,
      quantity: String(i.available),
      description: i.description,
      serviceType: 'REFORMA_COMPLETA',
      fabricName: '',
      fabricColor: '',
      fabricReference: '',
      foamSpecs: '',
      technicalNotes: '',
    })),
  );
  const [priority, setPriority] = useState<Priority>('NORMAL');
  const [promisedDate, setPromisedDate] = useState('');
  const [lead, setLead] = useState('');
  const [instructions, setInstructions] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const idem = useRef(newIdempotencyKey());
  const setRow = (key: string, patch: Partial<Row>) =>
    setRows((r) => r.map((x) => (x.key === key ? { ...x, ...patch } : x)));

  const m = useMutation({
    mutationFn: () => {
      const body = createServiceOrderSchema.parse({
        orderId: data.order.id,
        priority,
        promisedDate: promisedDate || null,
        technicalLeadId: lead || null,
        technicalInstructions: instructions,
        notes,
        items: rows.map((r) => ({ ...r, quantity: Number(r.quantity) })),
      });
      return api<ServiceOrderDto>('/api/v1/service-orders', {
        method: 'POST',
        body,
        idempotencyKey: idem.current,
      });
    },
    onSuccess: (so) => {
      void qc.invalidateQueries({ queryKey: ['service-orders'] });
      void qc.invalidateQueries({ queryKey: ['order', data.order.id] });
      toast('ok', `OS ${so.code} criada.`);
      router.push(`/painel/os/${so.id}`);
    },
    onError: (e) => {
      if (e instanceof ApiError) idem.current = newIdempotencyKey();
      setError(
        e instanceof ApiError
          ? e.message
          : ((e as { issues?: { message: string }[] }).issues?.[0]?.message ?? 'Revise os dados.'),
      );
    },
  });

  return (
    <form
      className="space-y-6"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        m.mutate();
      }}
    >
      {error && <Alert tone="danger">{error}</Alert>}
      <Card className="p-6">
        <h2 className="mb-4 font-semibold">Dados gerais</h2>
        <div className="grid gap-4 sm:grid-cols-3">
          <Field label="Prioridade">
            {(p) => (
              <Select
                {...p}
                value={priority}
                onChange={(e) => setPriority(e.target.value as Priority)}
              >
                {PRIORITIES.map((x) => (
                  <option key={x} value={x}>
                    {PRIORITY_LABEL[x]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="Prazo prometido ao cliente" hint="Opcional">
            {(p) => (
              <Input
                {...p}
                type="date"
                value={promisedDate}
                onChange={(e) => setPromisedDate(e.target.value)}
              />
            )}
          </Field>
          <Field label="Responsável técnico principal" hint="Opcional">
            {(p) => (
              <Select
                {...p}
                value={lead}
                onChange={(e) => setLead(e.target.value)}
                disabled={!employees.data}
              >
                <option value="">A definir</option>
                {employees.data
                  ?.filter((e) => e.active)
                  .map((e) => (
                    <option key={e.id} value={e.id}>
                      {e.displayName} — {e.jobTitle}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
          <Field label="Instruções técnicas" className="sm:col-span-3">
            {(p) => (
              <Textarea
                {...p}
                rows={3}
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
              />
            )}
          </Field>
          <Field label="Observações" className="sm:col-span-3">
            {(p) => (
              <Textarea {...p} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            )}
          </Field>
        </div>
      </Card>

      <Card className="p-6">
        <div className="mb-1 flex items-center justify-between">
          <h2 className="font-semibold">Peças da OS</h2>
          <Button
            size="sm"
            variant="secondary"
            icon={<Plus className="size-3.5" aria-hidden />}
            onClick={() =>
              setRows([
                ...rows,
                {
                  ...rows[0]!,
                  key: crypto.randomUUID(),
                  orderItemId: usable[0]!.orderItemId,
                  quantity: '1',
                },
              ])
            }
          >
            Dividir em mais itens
          </Button>
        </div>
        <p className="mb-4 text-sm text-ink-muted">
          Cada item recebe um código próprio (ex.: OS-00012/2). Divida peças iguais quando
          precisarem de identificação individual.
        </p>
        <ol className="space-y-4">
          {rows.map((r, idx) => {
            const src = data.items.find((i) => i.orderItemId === r.orderItemId)!;
            return (
              <li
                key={r.key}
                className="rounded-xl border border-line p-4"
                data-testid={`so-row-${idx}`}
              >
                <div className="grid gap-3 sm:grid-cols-[1fr_120px_200px_auto] sm:items-end">
                  <Field label={`Peça recebida (item ${idx + 1})`}>
                    {(p) => (
                      <Select
                        {...p}
                        value={r.orderItemId}
                        onChange={(e) => setRow(r.key, { orderItemId: e.target.value })}
                      >
                        {usable.map((i) => (
                          <option key={i.orderItemId} value={i.orderItemId}>
                            {i.description} ({i.available} disponível(is))
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  <Field label="Quantidade" hint={`máx. ${src.available}`}>
                    {(p) => (
                      <Input
                        {...p}
                        type="number"
                        min={1}
                        max={src.available}
                        value={r.quantity}
                        onChange={(e) => setRow(r.key, { quantity: e.target.value })}
                      />
                    )}
                  </Field>
                  <Field label="Tipo de serviço">
                    {(p) => (
                      <Select
                        {...p}
                        value={r.serviceType}
                        onChange={(e) =>
                          setRow(r.key, { serviceType: e.target.value as ServiceType })
                        }
                      >
                        {SERVICE_TYPES.map((s) => (
                          <option key={s} value={s}>
                            {SERVICE_TYPE_LABEL[s]}
                          </option>
                        ))}
                      </Select>
                    )}
                  </Field>
                  <Button
                    variant="ghost"
                    aria-label={`Remover item ${idx + 1}`}
                    disabled={rows.length === 1}
                    icon={<Trash2 className="size-4" aria-hidden />}
                    onClick={() => setRows(rows.filter((x) => x.key !== r.key))}
                  />
                </div>
                <div className="mt-3 grid gap-3 sm:grid-cols-4">
                  <Field label="Descrição na OS" className="sm:col-span-4">
                    {(p) => (
                      <Input
                        {...p}
                        value={r.description}
                        onChange={(e) => setRow(r.key, { description: e.target.value })}
                      />
                    )}
                  </Field>
                  <Field label="Tecido escolhido">
                    {(p) => (
                      <Input
                        {...p}
                        value={r.fabricName}
                        onChange={(e) => setRow(r.key, { fabricName: e.target.value })}
                      />
                    )}
                  </Field>
                  <Field label="Cor">
                    {(p) => (
                      <Input
                        {...p}
                        value={r.fabricColor}
                        onChange={(e) => setRow(r.key, { fabricColor: e.target.value })}
                      />
                    )}
                  </Field>
                  <Field label="Referência">
                    {(p) => (
                      <Input
                        {...p}
                        value={r.fabricReference}
                        onChange={(e) => setRow(r.key, { fabricReference: e.target.value })}
                      />
                    )}
                  </Field>
                  <Field label="Espumas / especificações">
                    {(p) => (
                      <Input
                        {...p}
                        value={r.foamSpecs}
                        onChange={(e) => setRow(r.key, { foamSpecs: e.target.value })}
                      />
                    )}
                  </Field>
                  <Field label="Observações técnicas" className="sm:col-span-4">
                    {(p) => (
                      <Input
                        {...p}
                        value={r.technicalNotes}
                        onChange={(e) => setRow(r.key, { technicalNotes: e.target.value })}
                      />
                    )}
                  </Field>
                </div>
              </li>
            );
          })}
        </ol>
        <p className="mt-4 text-sm text-ink-muted">
          As medidas são registradas depois, na OS (rotina de sexta-feira ou medição
          extraordinária).
        </p>
      </Card>
      <div className="flex justify-end">
        <Button type="submit" size="lg" loading={m.isPending}>
          Criar OS
        </Button>
      </div>
    </form>
  );
}
