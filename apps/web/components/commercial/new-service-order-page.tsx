'use client';

import type { EligibilityRule, Priority, ServiceOrderDto, ServiceType } from '@cenario/shared';
import {
  ELIGIBILITY_LABEL,
  ELIGIBILITY_RULES,
  PRIORITIES,
  PRIORITY_LABEL,
  SERVICE_TYPES,
  SERVICE_TYPE_LABEL,
  createServiceOrderSchema,
} from '@cenario/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  DateField,
  FieldAction,
  FormActions,
  FormGrid,
  FormSection,
  MoneyField,
  NumberField,
  SelectField,
  SummaryRow,
  TextAreaField,
  TextField,
} from '@/components/ui/form';
import { Alert, PageHeader, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { ApiError, api, newIdempotencyKey } from '@/lib/api';
import { useAvailableForOs, type AvailableForOs } from '@/lib/commercial';
import { money } from '@/lib/finance';
import { useCan } from '@/lib/hooks';
import { useEmployees } from '@/lib/queries';
import { BackLink } from './section';

/**
 * Correção global — criação da OS em seções: informações gerais, peças, responsável (titular por
 * peça), valores comerciais (do pedido, com o fluxo autorizado para ajustar), mão de obra por
 * peça e resumo. Titular e mão de obra são gravados NA MESMA operação da OS (atômica: se um
 * falhar, nada é criado). Nenhum pagamento é liberado na criação.
 */

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
  upholstererUserId: string;
  laborCents: number | null;
  laborValid: boolean;
  eligibility: EligibilityRule;
}

export function NewServiceOrderPage() {
  const params = useSearchParams();
  const orderId = params.get('pedido');
  const can = useCan();
  const available = useAvailableForOs(orderId);
  if (!can('os.gerenciar')) return <Alert tone="warn">Você não tem permissão para criar OS.</Alert>;
  if (!orderId)
    return (
      <>
        <PageHeader
          title="Nova OS técnica"
          description="A OS técnica nasce de um pedido com peças já recebidas na oficina."
        />
        <Alert tone="info">
          Abra um pedido com peças recebidas e use “Criar OS técnica”.{' '}
          <Link href="/painel/pedidos" className="font-semibold text-brand-700 hover:underline">
            Ir para Pedidos comerciais
          </Link>
        </Alert>
      </>
    );
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

const emptyRow = (orderItemId: string, quantity: number, description: string): Row => ({
  key: crypto.randomUUID(),
  orderItemId,
  quantity: String(quantity),
  description,
  serviceType: 'REFORMA_COMPLETA',
  fabricName: '',
  fabricColor: '',
  fabricReference: '',
  foamSpecs: '',
  technicalNotes: '',
  upholstererUserId: '',
  laborCents: null,
  laborValid: true,
  eligibility: 'QUALIDADE_APROVADA',
});

function ServiceOrderForm({ data }: { data: AvailableForOs }) {
  const router = useRouter();
  const qc = useQueryClient();
  const toast = useToast();
  const can = useCan();
  const employees = useEmployees(can('funcionarios.ver'));
  const usable = data.items.filter((i) => i.available > 0);
  const [rows, setRows] = useState<Row[]>(() =>
    usable.map((i) => emptyRow(i.orderItemId, i.available, i.description)),
  );
  const [priority, setPriority] = useState<Priority>('NORMAL');
  const [promisedDate, setPromisedDate] = useState('');
  const [lead, setLead] = useState('');
  const [instructions, setInstructions] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const idem = useRef(newIdempotencyKey());
  const setRow = (key: string, patch: Partial<Row>) =>
    setRows((r) => r.map((x) => (x.key === key ? { ...x, ...patch } : x)));
  const perms = data.permissions;
  const byUser = new Map(data.upholsterers.map((u) => [u.userId, u]));

  // Resumo: receita estimada desta OS (rateio proporcional às peças do pedido, a mesma regra do
  // financeiro) e mão de obra combinada nesta tela. Não é lucro: faltam materiais e logística.
  const pieces = rows.reduce((a, r) => a + (Number(r.quantity) || 0), 0);
  const c = data.commercial;
  const projected = useMemo(() => {
    if (!c || c.finalCents === null) return null;
    const others = c.serviceOrders.reduce((a, s) => a + s.pieces, 0);
    const total = others + pieces;
    return total > 0 ? Math.round((c.finalCents * pieces) / total) : 0;
  }, [c, pieces]);
  const laborTotal = rows.reduce((a, r) => a + (r.upholstererUserId ? (r.laborCents ?? 0) : 0), 0);
  const laborInvalid = rows.some((r) => !r.laborValid);

  const m = useMutation({
    mutationFn: () => {
      const body = createServiceOrderSchema.parse({
        orderId: data.order.id,
        priority,
        promisedDate: promisedDate || null,
        technicalLeadId: lead || null,
        technicalInstructions: instructions,
        notes,
        items: rows.map((r) => ({
          orderItemId: r.orderItemId,
          quantity: Number(r.quantity),
          description: r.description,
          serviceType: r.serviceType,
          fabricName: r.fabricName,
          fabricColor: r.fabricColor,
          fabricReference: r.fabricReference,
          foamSpecs: r.foamSpecs,
          technicalNotes: r.technicalNotes,
          ...(perms.upholsterer && r.upholstererUserId
            ? { upholstererUserId: r.upholstererUserId }
            : {}),
          ...(perms.labor && r.upholstererUserId && r.laborCents
            ? { labor: { agreedCents: r.laborCents, eligibility: r.eligibility } }
            : {}),
        })),
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
      void qc.invalidateQueries({ queryKey: ['finance'] });
      toast('ok', `OS ${so.code} criada.`);
      router.push(`/painel/os/${so.id}`);
    },
    onError: (e) => {
      if (e instanceof ApiError) idem.current = newIdempotencyKey();
      const issues = (e as { issues?: { path: PropertyKey[]; message: string }[] }).issues;
      if (issues) {
        const map: Record<string, string> = {};
        for (const i of issues) map[i.path.map(String).join('.')] ??= i.message;
        setFieldErrors(map);
      }
      setError(
        e instanceof ApiError ? e.message : (issues?.[0]?.message ?? 'Revise os dados da OS.'),
      );
    },
  });
  const err = (idx: number, f: string) => fieldErrors[`items.${idx}.${f}`];

  return (
    <form
      className="space-y-6"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        setFieldErrors({});
        m.mutate();
      }}
      data-testid="new-service-order"
    >
      {error && (
        <Alert tone="danger" title="A OS não foi criada">
          {error} Nada foi gravado: corrija e tente de novo.
        </Alert>
      )}

      <FormSection step={1} title="Informações gerais" id="os-geral">
        <FormGrid>
          <TextField label="Cliente" value={data.customer.name} readOnly cols={6} />
          <Field2Link
            label="Pedido de origem"
            href={`/painel/pedidos/${data.order.id}`}
            text={`${data.order.code} · ${data.order.contractedService}`}
          />
          <TextField
            label="Identificação da OS"
            value="Gerada ao criar (OS-número/item)"
            readOnly
            cols={4}
            hint="Cada peça recebe um código próprio."
          />
          <SelectField
            label="Prioridade"
            cols={4}
            value={priority}
            onChange={(e) => setPriority(e.target.value as Priority)}
          >
            {PRIORITIES.map((x) => (
              <option key={x} value={x}>
                {PRIORITY_LABEL[x]}
              </option>
            ))}
          </SelectField>
          <DateField
            label="Prazo prometido ao cliente"
            hint="Opcional"
            cols={4}
            value={promisedDate}
            onChange={(e) => setPromisedDate(e.target.value)}
          />
          <SelectField
            label="Responsável técnico principal"
            hint="Opcional"
            cols={6}
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
          </SelectField>
          <TextAreaField
            label="Instruções técnicas"
            cols={12}
            rows={3}
            value={instructions}
            onChange={(e) => setInstructions(e.target.value)}
          />
          <TextAreaField
            label="Observações"
            cols={12}
            rows={2}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </FormGrid>
      </FormSection>

      <FormSection
        step={2}
        title="Peças"
        id="os-pecas"
        description="Cada item recebe um código próprio (ex.: OS-00012/2). Divida peças iguais quando precisarem de identificação individual. As medidas são registradas depois, na OS."
        actions={
          <Button
            size="sm"
            variant="secondary"
            icon={<Plus className="size-3.5" aria-hidden />}
            onClick={() =>
              setRows([
                ...rows,
                emptyRow(usable[0]!.orderItemId, 1, rows[0]?.description ?? usable[0]!.description),
              ])
            }
          >
            Dividir em mais itens
          </Button>
        }
      >
        <ol className="space-y-4">
          {rows.map((r, idx) => {
            const src = data.items.find((i) => i.orderItemId === r.orderItemId)!;
            return (
              <li
                key={r.key}
                className="rounded-xl border border-line p-4"
                data-testid={`so-row-${idx}`}
              >
                <p className="mb-3 text-sm font-semibold text-ink-soft">Item {idx + 1}</p>
                <FormGrid>
                  <SelectField
                    label="Peça recebida"
                    cols={5}
                    value={r.orderItemId}
                    onChange={(e) => setRow(r.key, { orderItemId: e.target.value })}
                  >
                    {usable.map((i) => (
                      <option key={i.orderItemId} value={i.orderItemId}>
                        {i.description} ({i.available} disponível(is))
                      </option>
                    ))}
                  </SelectField>
                  <NumberField
                    label="Quantidade"
                    hint={`máx. ${src.available}`}
                    error={err(idx, 'quantity')}
                    cols={2}
                    min={1}
                    max={src.available}
                    value={r.quantity}
                    onChange={(e) => setRow(r.key, { quantity: e.target.value })}
                  />
                  <SelectField
                    label="Tipo de serviço"
                    cols={4}
                    value={r.serviceType}
                    onChange={(e) => setRow(r.key, { serviceType: e.target.value as ServiceType })}
                  >
                    {SERVICE_TYPES.map((s) => (
                      <option key={s} value={s}>
                        {SERVICE_TYPE_LABEL[s]}
                      </option>
                    ))}
                  </SelectField>
                  <FieldAction className="sm:col-span-1">
                    <Button
                      variant="ghost"
                      aria-label={`Remover item ${idx + 1}`}
                      disabled={rows.length === 1}
                      icon={<Trash2 className="size-4" aria-hidden />}
                      onClick={() => setRows(rows.filter((x) => x.key !== r.key))}
                    />
                  </FieldAction>
                  <TextField
                    label="Descrição na OS"
                    cols={12}
                    error={err(idx, 'description')}
                    value={r.description}
                    onChange={(e) => setRow(r.key, { description: e.target.value })}
                  />
                  <TextField
                    label="Tecido escolhido"
                    cols={4}
                    value={r.fabricName}
                    onChange={(e) => setRow(r.key, { fabricName: e.target.value })}
                  />
                  <TextField
                    label="Cor"
                    cols={4}
                    value={r.fabricColor}
                    onChange={(e) => setRow(r.key, { fabricColor: e.target.value })}
                  />
                  <TextField
                    label="Referência"
                    cols={4}
                    value={r.fabricReference}
                    onChange={(e) => setRow(r.key, { fabricReference: e.target.value })}
                  />
                  <TextField
                    label="Espumas e especificações"
                    cols={6}
                    value={r.foamSpecs}
                    onChange={(e) => setRow(r.key, { foamSpecs: e.target.value })}
                  />
                  <TextField
                    label="Observações técnicas"
                    cols={6}
                    value={r.technicalNotes}
                    onChange={(e) => setRow(r.key, { technicalNotes: e.target.value })}
                  />
                </FormGrid>
              </li>
            );
          })}
        </ol>
      </FormSection>

      <FormSection
        step={3}
        title="Responsável"
        id="os-responsavel"
        description="Tapeceiro titular de cada peça: só ele executa as etapas de tapeçaria da peça. Lista com tapeceiros ativos e com a competência de corte e costura."
      >
        {!perms.upholsterer ? (
          <Alert tone="info">
            Definir o titular exige a permissão de planejar a produção. A OS pode ser criada sem
            titular; ele é definido depois no planejamento.
          </Alert>
        ) : (
          <ul className="divide-y divide-line rounded-xl border border-line">
            {rows.map((r, idx) => (
              <li key={r.key} className="px-4 py-3">
                <FormGrid>
                  <TextField
                    label={`Item ${idx + 1}`}
                    cols={6}
                    value={`${r.description} (${r.quantity || 0})`}
                    readOnly
                    tabIndex={-1}
                  />
                  <SelectField
                    label="Tapeceiro titular"
                    cols={6}
                    data-testid={`so-owner-${idx}`}
                    value={r.upholstererUserId}
                    error={err(idx, 'upholstererUserId')}
                    onChange={(e) => setRow(r.key, { upholstererUserId: e.target.value })}
                  >
                    <option value="">A definir depois</option>
                    {data.upholsterers.map((u) => (
                      <option key={u.userId} value={u.userId}>
                        {u.displayName}
                      </option>
                    ))}
                  </SelectField>
                </FormGrid>
              </li>
            ))}
          </ul>
        )}
      </FormSection>

      <FormSection
        step={4}
        title="Valores comerciais"
        id="os-valores"
        description="O valor cobrado do cliente é o do pedido (contratado + ajustes autorizados). A receita de cada OS é a sua parte desse valor — não há valor comercial por peça."
      >
        {!c ? (
          <Alert tone="info">Você não tem permissão para ver os valores do pedido.</Alert>
        ) : (
          <div className="grid gap-6 lg:grid-cols-2">
            <dl className="divide-y divide-line rounded-xl border border-line px-4">
              <SummaryRow
                label="Valor contratado no pedido"
                value={c.contractedCents === null ? 'Sem valor' : money(c.contractedCents)}
                testId="so-contracted"
              />
              {c.adjustmentsCents !== null && (
                <SummaryRow label="Ajustes autorizados" value={money(c.adjustmentsCents)} />
              )}
              <SummaryRow
                label="Valor final do pedido"
                value={c.finalCents === null ? '—' : money(c.finalCents)}
                strong
              />
              {c.serviceOrders.map((s) => (
                <SummaryRow
                  key={s.code}
                  label={`${s.code} (já criada)`}
                  hint={`${s.pieces} peça(s)`}
                  value={money(s.revenueCents)}
                />
              ))}
              <SummaryRow
                label="Esta OS (estimativa)"
                hint={`${pieces} peça(s) — proporcional às peças do pedido`}
                value={projected === null ? '—' : money(projected)}
                strong
                testId="so-projected"
              />
            </dl>
            <div className="space-y-3 text-sm">
              {c.finalCents === null && (
                <Alert tone="warn">
                  O pedido não tem valor contratado: a receita da OS fica zerada.
                </Alert>
              )}
              {c.manualSplit && (
                <Alert tone="warn">
                  A receita deste pedido foi distribuída manualmente entre as OS. Com esta nova OS,
                  volta a ser proporcional às peças até o financeiro redistribuir.
                </Alert>
              )}
              <p className="text-ink-muted">
                Para alterar o valor cobrado use o fluxo autorizado: editar o pedido (permissão de
                valores) ou lançar um ajuste comercial no financeiro (com justificativa). A
                distribuição entre OS é feita no financeiro.
              </p>
              <div className="flex flex-wrap gap-2">
                <Link
                  href={`/painel/pedidos/${data.order.id}/editar`}
                  className="text-sm font-semibold text-brand-700 hover:underline"
                >
                  Editar valor do pedido
                </Link>
                <span aria-hidden className="text-ink-muted">
                  ·
                </span>
                <Link
                  href="/painel/financeiro"
                  className="text-sm font-semibold text-brand-700 hover:underline"
                >
                  Ajustes e distribuição no financeiro
                </Link>
              </div>
            </div>
          </div>
        )}
      </FormSection>

      <FormSection
        step={5}
        title="Mão de obra"
        id="os-mao-de-obra"
        description="Valor combinado com o tapeceiro titular, por peça (uma obrigação por profissional por peça). Nada é pago agora: a obrigação só fica devida pela regra de liberação."
      >
        {!perms.labor ? (
          <Alert tone="info">
            Combinar a mão de obra exige a permissão de gerenciar o financeiro. Ela pode ser
            combinada depois, na OS.
          </Alert>
        ) : (
          <ul className="divide-y divide-line rounded-xl border border-line">
            {rows.map((r, idx) => {
              const owner = byUser.get(r.upholstererUserId);
              const blocked = !owner || !owner.isTapeceiro;
              return (
                <li key={r.key} className="px-4 py-3" data-testid={`so-labor-${idx}`}>
                  <FormGrid>
                    <TextField
                      label={`Item ${idx + 1} · recebedor`}
                      cols={4}
                      readOnly
                      tabIndex={-1}
                      value={owner ? owner.displayName : 'Defina o titular (seção 3)'}
                    />
                    <MoneyField
                      label="Valor combinado"
                      cols={3}
                      cents={r.laborCents}
                      disabled={blocked}
                      error={
                        !r.laborValid
                          ? 'Valor inválido.'
                          : (err(idx, 'labor') ?? err(idx, 'labor.agreedCents'))
                      }
                      hint={
                        owner && !owner.isTapeceiro
                          ? 'Pagamento por produção é só para tapeceiro.'
                          : 'Vazio = combinar depois'
                      }
                      data-testid={`so-labor-value-${idx}`}
                      onCents={(v, ok) => setRow(r.key, { laborCents: v, laborValid: ok })}
                    />
                    <SelectField
                      label="Liberação para pagamento"
                      cols={5}
                      disabled={blocked}
                      value={r.eligibility}
                      onChange={(e) =>
                        setRow(r.key, { eligibility: e.target.value as EligibilityRule })
                      }
                    >
                      {ELIGIBILITY_RULES.map((x) => (
                        <option key={x} value={x}>
                          {ELIGIBILITY_LABEL[x]}
                        </option>
                      ))}
                    </SelectField>
                  </FormGrid>
                  <p className="mt-2 text-xs text-ink-muted">
                    Situação ao criar:{' '}
                    {r.laborCents && !blocked
                      ? 'combinada, aguardando a liberação (sem pagamento).'
                      : 'sem valor combinado.'}{' '}
                    Revisões e ajustes seguem as regras do financeiro.
                  </p>
                </li>
              );
            })}
          </ul>
        )}
      </FormSection>

      <FormSection step={6} title="Resumo" id="os-resumo">
        <dl className="max-w-xl divide-y divide-line rounded-xl border border-line px-4">
          <SummaryRow
            label="Receita contratada (esta OS)"
            value={projected === null ? (c ? '—' : 'Sem permissão') : money(projected)}
          />
          <SummaryRow
            label="Mão de obra combinada"
            value={perms.labor ? money(laborTotal) : 'Sem permissão'}
            testId="so-labor-total"
          />
          <SummaryRow
            label="Outros custos conhecidos"
            hint="Materiais e logística entram depois, no resultado por OS."
            value="—"
          />
          <SummaryRow
            label="Saldo estimado antes dos demais custos"
            hint="Não é lucro: faltam materiais, logística, despesas e impostos."
            value={projected === null || !perms.labor ? '—' : money(projected - laborTotal)}
            strong
            testId="so-balance"
          />
        </dl>
      </FormSection>

      <FormActions>
        <Button variant="secondary" onClick={() => router.back()}>
          Cancelar
        </Button>
        <Button type="submit" size="lg" loading={m.isPending} disabled={laborInvalid}>
          Criar OS
        </Button>
      </FormActions>
    </form>
  );
}

/** Campo somente leitura com link (pedido de origem). */
function Field2Link({ label, href, text }: { label: string; href: string; text: string }) {
  return (
    <div className="field sm:col-span-6">
      <span className="label">{label}</span>
      <Link
        href={href}
        className="input flex h-11 items-center truncate font-medium text-brand-700 hover:underline"
      >
        {text}
      </Link>
      <div className="field-msg" />
    </div>
  );
}
