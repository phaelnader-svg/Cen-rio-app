'use client';

import type {
  CustomerAddressDto,
  CustomerSummaryDto,
  DuplicateCandidateDto,
  NewServiceDefaultsDto,
  NewServiceResultDto,
  PickupTeam,
  PieceType,
  ServiceType,
} from '@cenario/shared';
import {
  CUSTOMER_KINDS,
  CUSTOMER_KIND_LABEL,
  PICKUP_TEAM_LABEL,
  PIECE_TYPES,
  PIECE_TYPE_LABEL,
  SERVICE_TYPES,
  SERVICE_TYPE_LABEL,
  newServiceSchema,
} from '@cenario/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CheckCircle2, Plus, Search, Trash2 } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useDeferredValue, useMemo, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox, Input } from '@/components/ui/field';
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
  TimeField,
} from '@/components/ui/form';
import { Alert, Card, PageHeader, Spinner } from '@/components/ui/misc';
import { ApiError, api, newIdempotencyKey } from '@/lib/api';
import { useCustomerAddresses, useCustomerLookup, useNewServiceDefaults } from '@/lib/commercial';
import { AddressFields, addressLines, emptyAddress, type AddressState } from './address-form';

/**
 * Simplificação Fase 2 — "Novo serviço": cliente, serviço fechado e retirada em UM formulário e
 * UMA confirmação. A OS não é criada aqui: nasce sozinha quando as peças chegam à oficina.
 */

interface PieceRow {
  key: string;
  pieceType: PieceType;
  /** Tipo de serviço DA PEÇA: define o modelo de produção dela (peças podem ter tipos diferentes). */
  serviceType: ServiceType;
  description: string;
  quantity: string;
  fabricName: string;
  /** Titular previsto ('' = definir no planejamento) e mão de obra prevista por unidade. */
  upholsterer: string;
  laborCents: number | null;
  laborOk: boolean;
}

const newPiece = (serviceType: ServiceType = 'REFORMA_COMPLETA'): PieceRow => ({
  key: crypto.randomUUID(),
  pieceType: 'SOFA',
  serviceType,
  description: '',
  quantity: '1',
  fabricName: '',
  upholsterer: '',
  laborCents: null,
  laborOk: true,
});

const brl = (cents: number | null | undefined) =>
  cents === null || cents === undefined
    ? '—'
    : (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const brDate = (d: string | null | undefined) => (d ? d.split('-').reverse().join('/') : '—');

/** Mão de obra por produção é só do tapeceiro principal (titular com corte e costura não recebe). */
const laborAllowed = (d: NewServiceDefaultsDto | undefined, userId: string) =>
  Boolean(d?.upholsterers.find((u) => u.userId === userId)?.isTapeceiro);

const blank = (v: string) => (v.trim() === '' ? null : v.trim());

export function NewServicePage() {
  const defaults = useNewServiceDefaults();
  if (defaults.isPending) return <Spinner />;
  if (defaults.isError || !defaults.data)
    return <Alert tone="danger">Não foi possível carregar os dados do formulário.</Alert>;
  // Monta o formulário só com os padrões em mãos (responsável e valor sugeridos já no início).
  return <NewServiceForm d={defaults.data} />;
}

function NewServiceForm({ d }: { d: NewServiceDefaultsDto }) {
  const qc = useQueryClient();

  // ── Cliente
  const [mode, setMode] = useState<'EXISTENTE' | 'NOVO'>('EXISTENTE');
  const [search, setSearch] = useState('');
  const [customer, setCustomer] = useState<CustomerSummaryDto | null>(null);
  const lookup = useCustomerLookup(useDeferredValue(search), mode === 'EXISTENTE' && !customer);
  const addresses = useCustomerAddresses(mode === 'EXISTENTE' ? (customer?.id ?? null) : null);
  const [addressId, setAddressId] = useState('');
  const [useNewAddress, setUseNewAddress] = useState(false);
  const [kind, setKind] = useState<(typeof CUSTOMER_KINDS)[number]>('PF');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [document, setDocument] = useState('');
  const [customerNotes, setCustomerNotes] = useState('');
  const [address, setAddress] = useState<AddressState>(emptyAddress('Retirada'));
  const [allowSimilar, setAllowSimilar] = useState(false);
  const [candidates, setCandidates] = useState<DuplicateCandidateDto[] | null>(null);

  // ── Serviço fechado
  const [contracted, setContracted] = useState('');
  const [pieces, setPieces] = useState<PieceRow[]>([newPiece()]);
  const [value, setValue] = useState<number | null>(null);
  const [valueOk, setValueOk] = useState(true);
  const [terms, setTerms] = useState('');
  const [promised, setPromised] = useState('');
  const [technicalNotes, setTechnicalNotes] = useState('');

  // ── Retirada (opcional: o cliente pode entregar as peças na tapeçaria)
  const [delivery, setDelivery] = useState<'RETIRADA' | 'CLIENTE_ENTREGA'>('RETIRADA');
  const withPickup = delivery === 'RETIRADA';
  const [date, setDate] = useState('');
  const [arrival, setArrival] = useState('');
  const [team, setTeam] = useState<PickupTeam>('LOGISTICA_TERCEIRIZADA');
  const [responsible, setResponsible] = useState(d.outsourced.userId ?? '');
  const [participants, setParticipants] = useState<string[]>([]);
  const [amount, setAmount] = useState<number | null>(d.suggestedPickupCostCents);
  const [amountOk, setAmountOk] = useState(true);
  const [instructions, setInstructions] = useState('');
  const [pickupNotes, setPickupNotes] = useState('');

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<NewServiceResultDto | null>(null);
  const idem = useRef(newIdempotencyKey());

  const people = d.people[team];
  // Ao trocar de equipe, aplica o responsável padrão daquela equipe (nunca um qualquer).
  const changeTeam = (t: PickupTeam) => {
    setTeam(t);
    setParticipants([]);
    setResponsible(
      (t === 'EQUIPE_PROPRIA'
        ? d.ownTeam.problem
          ? null
          : d.ownTeam.userId
        : d.outsourced.userId) ?? '',
    );
  };

  // Descrição padrão: os tipos das peças, sem repetir (ex.: "Reforma completa + Fabricação").
  const serviceSummary = [...new Set(pieces.map((p) => SERVICE_TYPE_LABEL[p.serviceType]))].join(
    ' + ',
  );
  const contractedText = contracted || serviceSummary;
  const totalPieces = pieces.reduce((a, p) => a + (Number(p.quantity) || 0), 0);
  const chosenAddress: CustomerAddressDto | null =
    addresses.data?.find((a) => a.id === addressId) ??
    (!addressId ? (addresses.data?.find((a) => a.isPrimary) ?? null) : null);

  const payload = useMemo(() => {
    const customerPart =
      mode === 'NOVO'
        ? {
            mode: 'NOVO' as const,
            kind,
            name,
            phone,
            whatsapp: phone,
            email,
            document,
            notes: customerNotes,
            // Sem retirada, o endereço é opcional: só vai se foi preenchido (nada inventado).
            address: withPickup || address.street.trim() ? { ...address, isPrimary: true } : null,
            allowSimilar,
          }
        : {
            mode: 'EXISTENTE' as const,
            customerId: customer?.id ?? '',
            ...(useNewAddress
              ? { newAddress: address }
              : { addressId: addressId || (withPickup ? chosenAddress?.id : null) || null }),
          };
    const outsourced = team === 'LOGISTICA_TERCEIRIZADA';
    return {
      customer: customerPart,
      service: {
        contractedService: contractedText,
        agreedValueCents: d?.canSetValues ? value : null,
        paymentTerms: d?.canSetValues ? blank(terms) : null,
        promisedDate: promised,
        technicalNotes: blank(technicalNotes),
        items: pieces.map((p) => ({
          pieceType: p.pieceType,
          description: p.description,
          quantity: Number(p.quantity),
          serviceType: p.serviceType,
          fabricName: blank(p.fabricName),
          plannedUpholstererUserId: d?.canPlanUpholsterer ? p.upholsterer || null : null,
          plannedLaborUnitCents:
            d?.canPlanLabor && p.upholsterer && laborAllowed(d, p.upholsterer)
              ? p.laborCents
              : null,
        })),
      },
      pickup: withPickup
        ? {
            scheduledDate: date || null,
            windowStart: arrival || null,
            team,
            logisticsUserId: responsible || null,
            participantUserIds: participants,
            amountCents: outsourced && d?.canSetTripCost && amount ? amount : null,
            instructions: blank(instructions),
            notes: blank(pickupNotes),
          }
        : null,
    };
  }, [
    withPickup,
    mode,
    kind,
    name,
    phone,
    email,
    document,
    customerNotes,
    address,
    allowSimilar,
    customer,
    useNewAddress,
    addressId,
    chosenAddress,
    team,
    contractedText,
    d,
    value,
    terms,
    promised,
    technicalNotes,
    pieces,
    date,
    arrival,
    responsible,
    participants,
    amount,
    instructions,
    pickupNotes,
  ]);

  const save = useMutation({
    mutationFn: () => {
      if (!valueOk) throw new Error('Valor fechado inválido.');
      if (pieces.some((p) => !p.laborOk)) throw new Error('Mão de obra prevista inválida.');
      if (!amountOk) throw new Error('Valor da logística inválido.');
      if (mode === 'EXISTENTE' && !customer) throw new Error('Selecione o cliente.');
      const parsed = newServiceSchema.safeParse(payload);
      if (!parsed.success) {
        const map: Record<string, string> = {};
        for (const i of parsed.error.issues) map[i.path.map(String).join('.')] ??= i.message;
        setErrors(map);
        throw new Error('Revise os campos destacados.');
      }
      return api<NewServiceResultDto>('/api/v1/services', {
        method: 'POST',
        body: parsed.data,
        idempotencyKey: idem.current,
      });
    },
    onSuccess: (r) => {
      setDone(r);
      void qc.invalidateQueries({ queryKey: ['orders'] });
      void qc.invalidateQueries({ queryKey: ['pickups'] });
      void qc.invalidateQueries({ queryKey: ['logistics-route'] });
      window.scrollTo({ top: 0 });
    },
    onError: (e) => {
      idem.current = newIdempotencyKey();
      if (e instanceof ApiError && e.code === 'POSSIBLE_DUPLICATE') {
        setCandidates(
          ((e.details as { candidates?: DuplicateCandidateDto[] })?.candidates ?? []).slice(0, 5),
        );
        setError(null);
        return;
      }
      if (e instanceof ApiError && e.details && typeof e.details === 'object') {
        const issues = (e.details as { issues?: { path: string; message: string }[] }).issues;
        if (issues) {
          const map: Record<string, string> = {};
          for (const i of issues) map[i.path] ??= i.message;
          setErrors(map);
        }
      }
      setError(e instanceof Error ? e.message : 'Não foi possível salvar.');
    },
  });

  const err = (k: string) => errors[k];
  const ownerName = (id: string) => d.upholsterers.find((u) => u.userId === id)?.displayName ?? '—';
  const setPiece = (key: string, patch: Partial<PieceRow>) =>
    setPieces((list) => list.map((p) => (p.key === key ? { ...p, ...patch } : p)));

  if (done) return <Confirmation result={done} onNew={() => window.location.reload()} />;

  const ownProblem = d.ownTeam.problem;

  return (
    <form
      noValidate
      className="space-y-5"
      data-testid="new-service-form"
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        setErrors({});
        save.mutate();
      }}
    >
      <PageHeader
        title="Novo serviço"
        description="Cliente, serviço fechado e retirada em um só formulário. A OS é criada automaticamente quando as peças chegarem à oficina."
      />

      {/* 1. Cliente */}
      <FormSection
        step={1}
        title="Cliente"
        id="ns-cliente"
        actions={
          <div
            className="inline-flex rounded-xl bg-subtle p-1"
            role="radiogroup"
            aria-label="Cliente"
          >
            {(
              [
                ['EXISTENTE', 'Já cadastrado'],
                ['NOVO', 'Cliente novo'],
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={mode === k}
                disabled={k === 'NOVO' && !d.canCreateCustomer}
                onClick={() => {
                  setMode(k);
                  setCandidates(null);
                }}
                className="h-9 rounded-lg px-3 text-sm font-medium text-ink-soft aria-checked:bg-surface aria-checked:text-ink aria-checked:shadow-sm disabled:opacity-50"
                data-testid={`ns-mode-${k === 'NOVO' ? 'new' : 'existing'}`}
              >
                {label}
              </button>
            ))}
          </div>
        }
      >
        {mode === 'EXISTENTE' ? (
          customer ? (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line p-3">
                <div>
                  <p className="font-medium" data-testid="ns-customer-chosen">
                    {customer.name}
                  </p>
                  <p className="text-sm text-ink-muted">{CUSTOMER_KIND_LABEL[customer.kind]}</p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="secondary"
                  onClick={() => {
                    setCustomer(null);
                    setAddressId('');
                    setUseNewAddress(false);
                  }}
                >
                  Trocar cliente
                </Button>
              </div>
              <FormGrid>
                <SelectField
                  label="Endereço de retirada"
                  cols={8}
                  value={useNewAddress ? '__novo' : addressId || chosenAddress?.id || ''}
                  onChange={(e) => {
                    const v = e.target.value;
                    setUseNewAddress(v === '__novo');
                    setAddressId(v === '__novo' ? '' : v);
                  }}
                  error={err('customer.addressId')}
                  data-testid="ns-address"
                >
                  {(addresses.data ?? []).map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label} — {addressLines(a)[0]}
                    </option>
                  ))}
                  {d.canCreateCustomer && (
                    <option value="__novo">+ Cadastrar outro endereço</option>
                  )}
                  {!addresses.data?.length && !d.canCreateCustomer && (
                    <option value="">Cliente sem endereço</option>
                  )}
                </SelectField>
              </FormGrid>
              {useNewAddress && (
                <AddressFields
                  value={address}
                  onChange={setAddress}
                  errors={errors}
                  prefix="customer.newAddress."
                />
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <label className="field">
                <span className="label">Buscar cliente</span>
                <div className="relative min-w-0">
                  <Search
                    className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-ink-muted"
                    aria-hidden
                  />
                  <Input
                    className="pl-9"
                    placeholder="Nome, telefone ou CPF/CNPJ"
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    data-testid="ns-customer-search"
                  />
                </div>
              </label>
              {search.trim().length >= 2 && (
                <ul
                  className="divide-y divide-line rounded-xl border border-line"
                  data-testid="ns-customer-results"
                >
                  {(lookup.data ?? []).map((c) => (
                    <li key={c.id}>
                      <button
                        type="button"
                        className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left hover:bg-subtle"
                        onClick={() => setCustomer(c)}
                      >
                        <span className="font-medium">{c.name}</span>
                        <span className="text-xs text-ink-muted">
                          {CUSTOMER_KIND_LABEL[c.kind]}
                        </span>
                      </button>
                    </li>
                  ))}
                  {lookup.data && !lookup.data.length && (
                    <li className="px-3 py-2.5 text-sm text-ink-muted">
                      Nenhum cliente encontrado.{' '}
                      {d.canCreateCustomer && (
                        <button
                          type="button"
                          className="font-medium text-brand-700 underline"
                          onClick={() => {
                            setMode('NOVO');
                            setName(search);
                          }}
                        >
                          Cadastrar como cliente novo
                        </button>
                      )}
                    </li>
                  )}
                </ul>
              )}
              {err('customer.customerId') && <Alert tone="danger">Selecione o cliente.</Alert>}
            </div>
          )
        ) : (
          <div className="space-y-4">
            <FormGrid>
              <SelectField
                label="Tipo"
                cols={3}
                value={kind}
                onChange={(e) => setKind(e.target.value as typeof kind)}
              >
                {CUSTOMER_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {CUSTOMER_KIND_LABEL[k]}
                  </option>
                ))}
              </SelectField>
              <TextField
                label="Nome completo"
                required
                cols={9}
                value={name}
                onChange={(e) => setName(e.target.value)}
                error={err('customer.name')}
                data-testid="ns-name"
              />
              <TextField
                label="Telefone / WhatsApp"
                cols={4}
                inputMode="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                error={err('customer.phone')}
                data-testid="ns-phone"
              />
              <TextField
                label="E-mail"
                cols={4}
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                error={err('customer.email')}
              />
              <TextField
                label={kind === 'PF' ? 'CPF' : 'CNPJ'}
                cols={4}
                inputMode="numeric"
                value={document}
                onChange={(e) => setDocument(e.target.value)}
                error={err('customer.document')}
                hint="Opcional"
              />
              <TextAreaField
                label="Observações importantes"
                cols={12}
                rows={2}
                value={customerNotes}
                onChange={(e) => setCustomerNotes(e.target.value)}
                error={err('customer.notes')}
              />
            </FormGrid>
            <h3 className="text-sm font-semibold">
              Endereço de retirada{!withPickup && ' (opcional — o cliente entrega as peças)'}
            </h3>
            <AddressFields
              value={address}
              onChange={setAddress}
              errors={errors}
              prefix="customer.address."
            />
          </div>
        )}
        {candidates && (
          <Alert tone="warn" title="Encontramos cadastros parecidos" className="mt-4">
            <p className="mb-2">Use o cadastro existente ou confirme que é outra pessoa.</p>
            <ul className="space-y-2" data-testid="ns-dup-candidates">
              {candidates.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    <strong>{c.name}</strong>{' '}
                    <span className="text-xs">(mesmo {c.reasons.join(', ')})</span>
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setCustomer({ id: c.id, name: c.name, kind: c.kind, tradeName: null });
                      setMode('EXISTENTE');
                      setUseNewAddress(true);
                      setCandidates(null);
                    }}
                  >
                    Usar este cadastro
                  </Button>
                </li>
              ))}
            </ul>
            <Button
              type="button"
              size="sm"
              className="mt-3"
              onClick={() => {
                setAllowSimilar(true);
                setCandidates(null);
                save.mutate();
              }}
              data-testid="ns-dup-confirm"
            >
              É outra pessoa — cadastrar mesmo assim
            </Button>
          </Alert>
        )}
      </FormSection>

      {/* 2. Serviço fechado */}
      <FormSection
        step={2}
        title="Serviço fechado"
        id="ns-servico"
        description="Só o que já foi combinado. Detalhes técnicos ficam para quando as peças chegarem."
      >
        <FormGrid>
          <TextField
            label="Descrição do serviço"
            cols={12}
            placeholder={serviceSummary}
            hint="O tipo de serviço é escolhido em cada peça."
            value={contracted}
            onChange={(e) => setContracted(e.target.value)}
            error={err('service.contractedService')}
          />
        </FormGrid>
        <div className="mt-5 space-y-3" data-testid="ns-pieces">
          {pieces.map((p, idx) => (
            <FormGrid key={p.key} data-testid={`ns-piece-${idx}`}>
              <SelectField
                label="Peça"
                cols={3}
                value={p.pieceType}
                onChange={(e) => setPiece(p.key, { pieceType: e.target.value as PieceType })}
              >
                {PIECE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {PIECE_TYPE_LABEL[t]}
                  </option>
                ))}
              </SelectField>
              <SelectField
                label="Tipo de serviço"
                cols={3}
                value={p.serviceType}
                onChange={(e) => setPiece(p.key, { serviceType: e.target.value as ServiceType })}
                error={err(`service.items.${idx}.serviceType`)}
                data-testid={`ns-piece-service-${idx}`}
              >
                {SERVICE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {SERVICE_TYPE_LABEL[t]}
                  </option>
                ))}
              </SelectField>
              <TextField
                label="Descrição"
                required
                cols={4}
                value={p.description}
                onChange={(e) => setPiece(p.key, { description: e.target.value })}
                error={err(`service.items.${idx}.description`)}
                data-testid={`ns-piece-desc-${idx}`}
              />
              <NumberField
                label="Qtd."
                cols={2}
                min={1}
                max={200}
                value={p.quantity}
                onChange={(e) => setPiece(p.key, { quantity: e.target.value })}
                error={err(`service.items.${idx}.quantity`)}
                data-testid={`ns-piece-qty-${idx}`}
              />
              <TextField
                label="Tecido"
                cols={3}
                placeholder="Se já escolhido"
                value={p.fabricName}
                onChange={(e) => setPiece(p.key, { fabricName: e.target.value })}
              />
              <FieldAction cols={2} className="sm:!col-span-1">
                <Button
                  type="button"
                  variant="ghost"
                  aria-label={`Remover peça ${idx + 1}`}
                  disabled={pieces.length === 1}
                  onClick={() => setPieces((list) => list.filter((x) => x.key !== p.key))}
                  icon={<Trash2 className="size-4" />}
                />
              </FieldAction>
              {d.canPlanUpholsterer && (
                <SelectField
                  label="Tapeceiro titular (previsto)"
                  cols={4}
                  value={p.upholsterer}
                  onChange={(e) =>
                    setPiece(p.key, {
                      upholsterer: e.target.value,
                      ...(laborAllowed(d, e.target.value)
                        ? {}
                        : { laborCents: null, laborOk: true }),
                    })
                  }
                  error={err(`service.items.${idx}.plannedUpholstererUserId`)}
                  data-testid={`ns-piece-owner-${idx}`}
                >
                  <option value="">Definir no planejamento</option>
                  {d.upholsterers.map((u) => (
                    <option key={u.userId} value={u.userId}>
                      {u.displayName}
                    </option>
                  ))}
                </SelectField>
              )}
              {d.canPlanLabor && p.upholsterer && laborAllowed(d, p.upholsterer) && (
                <MoneyField
                  label="Mão de obra prevista (por unidade)"
                  cols={4}
                  cents={p.laborCents}
                  onCents={(v, ok) => setPiece(p.key, { laborCents: v, laborOk: ok })}
                  hint="Previsão: vira valor combinado só quando a peça chegar."
                  error={
                    !p.laborOk
                      ? 'Valor inválido.'
                      : err(`service.items.${idx}.plannedLaborUnitCents`)
                  }
                  data-testid={`ns-piece-labor-${idx}`}
                />
              )}
            </FormGrid>
          ))}
          <Button
            type="button"
            size="sm"
            variant="secondary"
            icon={<Plus className="size-4" />}
            // A peça nova começa com o tipo da última (o mais comum: várias do mesmo serviço).
            onClick={() => setPieces((l) => [...l, newPiece(l[l.length - 1]?.serviceType)])}
            data-testid="ns-add-piece"
          >
            Adicionar peça
          </Button>
        </div>
        <FormGrid className="mt-5">
          {d.canSetValues && (
            <MoneyField
              label="Valor total fechado"
              cols={4}
              cents={value}
              onCents={(v, ok) => {
                setValue(v);
                setValueOk(ok);
              }}
              error={!valueOk ? 'Valor inválido.' : err('service.agreedValueCents')}
              data-testid="ns-value"
            />
          )}
          {d.canSetValues && (
            <TextField
              label="Condições de pagamento"
              cols={5}
              value={terms}
              onChange={(e) => setTerms(e.target.value)}
            />
          )}
          <DateField
            label="Prazo de entrega combinado"
            cols={3}
            required
            value={promised}
            onChange={(e) => setPromised(e.target.value)}
            error={err('service.promisedDate')}
            data-testid="ns-promised"
          />
          <TextAreaField
            label="Observações técnicas"
            cols={12}
            rows={2}
            value={technicalNotes}
            onChange={(e) => setTechnicalNotes(e.target.value)}
          />
        </FormGrid>
      </FormSection>

      {/* 3. Retirada (opcional) */}
      <FormSection
        step={3}
        title="Retirada"
        id="ns-retirada"
        description={
          withPickup
            ? 'O horário é o de CHEGADA ao endereço do cliente.'
            : 'O cliente traz as peças até a tapeçaria: nenhuma retirada é agendada.'
        }
      >
        <div
          className="mb-5 grid gap-2 sm:grid-cols-2"
          role="radiogroup"
          aria-label="Como as peças chegam"
        >
          {(
            [
              ['RETIRADA', 'Buscar na casa do cliente', 'Agenda a retirada com a equipe'],
              [
                'CLIENTE_ENTREGA',
                'Cliente entrega na tapeçaria',
                'Sem retirada, sem custo de logística',
              ],
            ] as const
          ).map(([k, title, hint]) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={delivery === k}
              onClick={() => setDelivery(k)}
              className="rounded-xl border border-line p-3 text-left aria-checked:border-brand-500 aria-checked:ring-4 aria-checked:ring-brand-100"
              data-testid={k === 'RETIRADA' ? 'ns-delivery-pickup' : 'ns-delivery-dropoff'}
            >
              <span className="block font-medium">{title}</span>
              <span className="text-sm text-ink-muted">{hint}</span>
            </button>
          ))}
        </div>
        {!withPickup && (
          <div data-testid="ns-dropoff-info">
            <Alert tone="info">
              Quando o cliente chegar com as peças, registre em Recebimentos (&quot;Entregue pelo
              cliente&quot;): a OS é criada automaticamente com o que chegou.
            </Alert>
          </div>
        )}
        {withPickup && (
          <>
            <FormGrid>
              <DateField
                label="Data da retirada"
                cols={4}
                value={date}
                onChange={(e) => setDate(e.target.value)}
                error={err('pickup.scheduledDate')}
                data-testid="ns-date"
              />
              <TimeField
                label="Horário de chegada ao cliente"
                cols={4}
                value={arrival}
                required={Boolean(date)}
                onChange={(e) => setArrival(e.target.value)}
                error={err('pickup.windowStart')}
                data-testid="ns-arrival"
              />
            </FormGrid>
            <div className="mt-5">
              <p className="label mb-2">Equipe responsável</p>
              <div
                className="grid gap-2 sm:grid-cols-2"
                role="radiogroup"
                aria-label="Equipe responsável"
              >
                {(['EQUIPE_PROPRIA', 'LOGISTICA_TERCEIRIZADA'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    role="radio"
                    aria-checked={team === t}
                    onClick={() => changeTeam(t)}
                    className="rounded-xl border border-line p-3 text-left aria-checked:border-brand-500 aria-checked:ring-4 aria-checked:ring-brand-100"
                    data-testid={t === 'EQUIPE_PROPRIA' ? 'ns-team-own' : 'ns-team-outsourced'}
                  >
                    <span className="block font-medium">{PICKUP_TEAM_LABEL[t]}</span>
                    <span className="text-sm text-ink-muted">
                      {t === 'EQUIPE_PROPRIA'
                        ? `Padrão: ${d.ownTeam.displayName ?? 'não configurado'} · sem custo de terceirização`
                        : `Padrão: ${d.outsourced.displayName ?? 'não configurado'} · valor total único`}
                    </span>
                  </button>
                ))}
              </div>
            </div>
            {team === 'EQUIPE_PROPRIA' && ownProblem && (
              <Alert
                tone="warn"
                className="mt-4"
                title="Responsável padrão da equipe própria pendente"
              >
                {ownProblem === 'NAO_CONFIGURADO'
                  ? 'Nenhum responsável padrão configurado em Empresa. Escolha quem fará a retirada.'
                  : `${d.ownTeam.displayName ?? 'O responsável padrão'} está ${ownProblem === 'INATIVO' ? 'inativo' : 'sem permissão para executar'}. Escolha outro responsável.`}
              </Alert>
            )}
            <FormGrid className="mt-5">
              <SelectField
                label="Profissional responsável"
                cols={6}
                value={responsible}
                onChange={(e) => setResponsible(e.target.value)}
                error={err('pickup.logisticsUserId')}
                data-testid="ns-responsible"
              >
                <option value="">
                  {team === 'EQUIPE_PROPRIA' ? 'Escolha…' : 'Definir depois'}
                </option>
                {people.map((p) => (
                  <option key={p.userId} value={p.userId}>
                    {p.displayName}
                  </option>
                ))}
              </SelectField>
              {team === 'LOGISTICA_TERCEIRIZADA' && d.canSetTripCost && (
                <MoneyField
                  label="Valor total combinado da equipe"
                  cols={6}
                  cents={amount}
                  hint="Valor único da operação — não é dividido entre os participantes."
                  onCents={(v, ok) => {
                    setAmount(v);
                    setAmountOk(ok);
                  }}
                  error={!amountOk ? 'Valor inválido.' : err('pickup.amountCents')}
                  data-testid="ns-amount"
                />
              )}
            </FormGrid>
            {people.filter((p) => p.userId !== responsible).length > 0 && (
              <fieldset className="mt-4">
                <legend className="label mb-2">Participantes</legend>
                <div className="flex flex-wrap gap-x-6 gap-y-2">
                  {people
                    .filter((p) => p.userId !== responsible)
                    .map((p) => (
                      <Checkbox
                        key={p.userId}
                        label={p.displayName}
                        checked={participants.includes(p.userId)}
                        onChange={(e) =>
                          setParticipants((list) =>
                            e.target.checked
                              ? [...list, p.userId]
                              : list.filter((x) => x !== p.userId),
                          )
                        }
                        data-testid={`ns-participant-${p.displayName}`}
                      />
                    ))}
                </div>
              </fieldset>
            )}
            <FormGrid className="mt-5">
              <TextAreaField
                label="Instruções para a retirada"
                cols={8}
                rows={2}
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
              />
              <TextField
                label="Observações"
                cols={4}
                value={pickupNotes}
                onChange={(e) => setPickupNotes(e.target.value)}
              />
            </FormGrid>
          </>
        )}
      </FormSection>

      {/* 4. Resumo */}
      <FormSection step={4} title="Resumo" id="ns-resumo">
        <dl className="divide-y divide-line" data-testid="ns-summary">
          <SummaryRow
            label="Cliente"
            value={mode === 'NOVO' ? name || '—' : (customer?.name ?? '—')}
          />
          <SummaryRow label="Serviço" value={`${contractedText} · ${totalPieces} peça(s)`} />
          <SummaryRow
            label="Peças"
            value={pieces
              .map(
                (p) =>
                  `${p.quantity}× ${p.description || PIECE_TYPE_LABEL[p.pieceType]} — ${SERVICE_TYPE_LABEL[p.serviceType]}`,
              )
              .join(' · ')}
            testId="ns-sum-pieces"
          />
          {d.canSetValues && (
            <SummaryRow label="Valor fechado" value={brl(value)} testId="ns-sum-value" />
          )}
          {pieces.some((p) => p.upholsterer) && (
            <SummaryRow
              label="Titular previsto"
              value={pieces
                .filter((p) => p.upholsterer)
                .map(
                  (p) =>
                    `${p.description || PIECE_TYPE_LABEL[p.pieceType]}: ${ownerName(p.upholsterer)}${
                      p.laborCents ? ` (${brl(p.laborCents)}/un.)` : ''
                    }`,
                )
                .join(' · ')}
              hint="Aplicado na OS gerada na chegada; mão de obra prevista não é pagamento."
              testId="ns-sum-owners"
            />
          )}
          <SummaryRow
            label="Retirada"
            value={
              !withPickup
                ? 'Cliente entrega na tapeçaria'
                : date
                  ? `${brDate(date)}, chegada ${arrival || '—'}`
                  : 'Aguardando agendamento'
            }
            testId="ns-sum-pickup"
          />
          {withPickup && (
            <SummaryRow
              label="Equipe"
              value={`${PICKUP_TEAM_LABEL[team]} · ${people.find((p) => p.userId === responsible)?.displayName ?? 'sem responsável'}`}
            />
          )}
          {withPickup && team === 'LOGISTICA_TERCEIRIZADA' && d.canSetTripCost && (
            <SummaryRow
              label="Valor previsto da logística"
              value={brl(amount)}
              hint="Vira obrigação só quando a retirada for realizada."
              testId="ns-sum-amount"
            />
          )}
        </dl>
        {error && (
          <Alert tone="danger" className="mt-4">
            {error}
          </Alert>
        )}
        <FormActions className="mt-5">
          <Button
            type="submit"
            loading={save.isPending}
            disabled={save.isPending}
            data-testid="ns-submit"
          >
            {withPickup ? 'Salvar serviço e agendar retirada' : 'Salvar serviço'}
          </Button>
        </FormActions>
      </FormSection>
    </form>
  );
}

function Confirmation({ result, onNew }: { result: NewServiceResultDto; onNew: () => void }) {
  const router = useRouter();
  const p = result.pickup;
  return (
    <div className="space-y-5" data-testid="ns-confirmation">
      <PageHeader title="Serviço registrado" />
      <Card className="p-5 sm:p-6">
        <div className="mb-4 flex items-center gap-3">
          <CheckCircle2 className="size-7 text-ok-600" aria-hidden />
          <div>
            <p className="font-semibold">
              {p ? 'Aguardando retirada' : 'Aguardando entrega do cliente'}
            </p>
            <p className="text-sm text-ink-muted">
              A OS será criada automaticamente quando as peças chegarem à oficina.
            </p>
          </div>
        </div>
        <dl className="divide-y divide-line">
          <SummaryRow
            label="Cliente"
            value={`${result.customer.name}${result.customer.created ? ' (novo)' : ''}`}
          />
          <SummaryRow label="Pedido" value={result.order.code} testId="ns-done-order" />
          {p ? (
            <>
              <SummaryRow label="Retirada" value={p.code} />
              <SummaryRow
                label="Data e horário de chegada"
                value={
                  p.scheduledDate
                    ? `${brDate(p.scheduledDate)}, ${p.windowStart}`
                    : 'Aguardando agendamento'
                }
                testId="ns-done-when"
              />
              <SummaryRow
                label="Equipe responsável"
                value={`${PICKUP_TEAM_LABEL[p.team]} · ${p.responsible ?? 'sem responsável'}${p.participants.length ? ` + ${p.participants.join(', ')}` : ''}`}
                testId="ns-done-team"
              />
            </>
          ) : (
            <SummaryRow
              label="Retirada"
              value="Sem retirada — o cliente entrega as peças na tapeçaria"
              testId="ns-done-dropoff"
            />
          )}
          {result.tripCost && (
            <SummaryRow
              label="Valor previsto da logística"
              value={brl(result.tripCost.amountCents)}
              testId="ns-done-cost"
            />
          )}
        </dl>
        <FormActions className="mt-5">
          <Button type="button" variant="secondary" onClick={onNew}>
            Novo serviço
          </Button>
          {p?.scheduledDate && (
            <Button
              type="button"
              variant="secondary"
              onClick={() => router.push(`/painel/roteiro?data=${p.scheduledDate}`)}
            >
              Ver roteiro do dia
            </Button>
          )}
          <Button
            type="button"
            onClick={() => router.push(`/painel/pedidos/${result.order.id}`)}
            data-testid="ns-open-order"
          >
            Abrir pedido
          </Button>
        </FormActions>
      </Card>
    </div>
  );
}
