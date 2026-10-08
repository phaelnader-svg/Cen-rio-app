'use client';

import type { CustomerDto, DuplicateCandidateDto } from '@cenario/shared';
import {
  createCustomerSchema,
  formatDocument,
  formatPhone,
  updateCustomerSchema,
} from '@cenario/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import Link from 'next/link';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Alert } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { ApiError, api, fieldErrors, newIdempotencyKey } from '@/lib/api';
import { AddressFields, emptyAddress, type AddressState } from './address-form';

const REASON: Record<DuplicateCandidateDto['reasons'][number], string> = {
  documento: 'mesmo CPF/CNPJ',
  telefone: 'mesmo telefone',
  whatsapp: 'mesmo WhatsApp',
  email: 'mesmo e-mail',
  nome: 'mesmo nome',
};

function issuesToMap(e: unknown): Record<string, string> {
  const map: Record<string, string> = {};
  const issues = (e as { issues?: { path: PropertyKey[]; message: string }[] }).issues ?? [];
  for (const i of issues) map[i.path.map(String).join('.')] ??= i.message;
  return map;
}

export function CustomerForm({
  customer,
  onClose,
  onSaved,
}: {
  customer?: CustomerDto;
  onClose: () => void;
  onSaved?: (c: CustomerDto) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [kind, setKind] = useState<'PF' | 'PJ'>(customer?.kind ?? 'PF');
  const [name, setName] = useState(customer?.name ?? '');
  const [tradeName, setTradeName] = useState(customer?.tradeName ?? '');
  const [document, setDocument] = useState(formatDocument(customer?.document));
  const [phone, setPhone] = useState(formatPhone(customer?.phone));
  const [whatsapp, setWhatsapp] = useState(formatPhone(customer?.whatsapp));
  const [email, setEmail] = useState(customer?.email ?? '');
  const [notes, setNotes] = useState(customer?.notes ?? '');
  const [address, setAddress] = useState<AddressState>(emptyAddress());
  const [withAddress, setWithAddress] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<DuplicateCandidateDto[] | null>(null);
  const idem = useRef(newIdempotencyKey());

  const m = useMutation({
    mutationFn: async (allowSimilar: boolean) => {
      const base = { kind, name, tradeName, document, phone, whatsapp, email, notes, allowSimilar };
      if (customer) {
        const body = updateCustomerSchema.parse({ ...base, version: customer.version });
        return api<CustomerDto>(`/api/v1/customers/${customer.id}`, { method: 'PUT', body });
      }
      const body = createCustomerSchema.parse({ ...base, addresses: withAddress ? [address] : [] });
      return api<CustomerDto>('/api/v1/customers', {
        method: 'POST',
        body,
        idempotencyKey: idem.current,
      });
    },
    onSuccess: (saved) => {
      void qc.invalidateQueries({ queryKey: ['customers'] });
      qc.setQueryData(['customer', saved.id], saved);
      toast('ok', customer ? 'Cliente atualizado.' : 'Cliente cadastrado.');
      onSaved?.(saved);
      onClose();
    },
    onError: (e) => {
      idem.current = newIdempotencyKey();
      if (!(e instanceof ApiError)) {
        setErrors(issuesToMap(e));
        setError('Revise os campos destacados.');
        return;
      }
      const details = e.details as { candidates?: DuplicateCandidateDto[] } | undefined;
      if (e.code === 'POSSIBLE_DUPLICATE' || (e.code === 'CONFLICT' && details?.candidates)) {
        setCandidates(details?.candidates ?? []);
      }
      if (e.code === 'VERSION_CONFLICT') void qc.invalidateQueries({ queryKey: ['customer'] });
      setErrors(fieldErrors(e));
      setError(e.message);
    },
  });

  const submit = (allowSimilar = false) => {
    setError(null);
    if (!allowSimilar) setCandidates(null);
    m.mutate(allowSimilar);
  };
  const blocking = candidates?.some((c) => c.reasons.includes('documento'));

  return (
    <Dialog
      open
      onClose={onClose}
      size="lg"
      title={customer ? `Editar ${customer.name}` : 'Novo cliente'}
      description="Dados pessoais visíveis apenas para quem tem permissão de ver clientes."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          {candidates && candidates.length > 0 && !blocking ? (
            <Button loading={m.isPending} onClick={() => submit(true)}>
              É outra pessoa — salvar mesmo assim
            </Button>
          ) : (
            <Button loading={m.isPending} onClick={() => submit(false)}>
              {customer ? 'Salvar' : 'Cadastrar cliente'}
            </Button>
          )}
        </>
      }
    >
      <form
        className="space-y-5"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          submit(false);
        }}
      >
        {error && (
          <Alert tone={candidates?.length ? 'warn' : 'danger'} title={error}>
            {candidates && candidates.length > 0 && (
              <ul className="mt-1 space-y-1" data-testid="duplicate-candidates">
                {candidates.map((c) => (
                  <li key={c.id}>
                    <Link
                      href={`/painel/clientes/${c.id}`}
                      target="_blank"
                      className="font-medium text-brand-700 underline"
                    >
                      {c.name}
                    </Link>{' '}
                    — {c.reasons.map((r) => REASON[r]).join(', ')}
                  </li>
                ))}
              </ul>
            )}
          </Alert>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Tipo">
            {(p) => (
              <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as 'PF' | 'PJ')}>
                <option value="PF">Pessoa física</option>
                <option value="PJ">Pessoa jurídica</option>
              </Select>
            )}
          </Field>
          <Field
            label={kind === 'PF' ? 'CPF (opcional)' : 'CNPJ (opcional)'}
            error={errors.document}
          >
            {(p) => (
              <Input
                {...p}
                inputMode="numeric"
                value={document}
                onChange={(e) => setDocument(e.target.value)}
              />
            )}
          </Field>
          <Field
            label={kind === 'PF' ? 'Nome completo' : 'Razão social'}
            error={errors.name}
            required
            className="sm:col-span-2"
          >
            {(p) => (
              <Input {...p} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            )}
          </Field>
          {kind === 'PJ' && (
            <Field label="Nome fantasia" error={errors.tradeName} className="sm:col-span-2">
              {(p) => (
                <Input {...p} value={tradeName} onChange={(e) => setTradeName(e.target.value)} />
              )}
            </Field>
          )}
          <Field label="Telefone" error={errors.phone}>
            {(p) => (
              <Input
                {...p}
                inputMode="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
              />
            )}
          </Field>
          <Field label="WhatsApp" error={errors.whatsapp}>
            {(p) => (
              <Input
                {...p}
                inputMode="tel"
                value={whatsapp}
                onChange={(e) => setWhatsapp(e.target.value)}
              />
            )}
          </Field>
          <Field label="E-mail" error={errors.email} className="sm:col-span-2">
            {(p) => (
              <Input {...p} type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            )}
          </Field>
          <Field label="Observações" error={errors.notes} className="sm:col-span-2">
            {(p) => (
              <Textarea {...p} rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            )}
          </Field>
        </div>
        {!customer && (
          <fieldset>
            <legend className="mb-3 flex w-full items-center justify-between text-sm font-semibold">
              Endereço de atendimento
              <button
                type="button"
                className="text-sm font-medium text-brand-700"
                onClick={() => setWithAddress(!withAddress)}
              >
                {withAddress ? 'Cadastrar depois' : 'Incluir endereço'}
              </button>
            </legend>
            {withAddress && (
              <AddressFields
                value={address}
                onChange={setAddress}
                errors={errors}
                prefix="addresses.0."
              />
            )}
          </fieldset>
        )}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}
