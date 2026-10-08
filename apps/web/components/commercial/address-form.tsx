'use client';

import type { CustomerAddressDto } from '@cenario/shared';
import { BR_STATES } from '@cenario/shared';
import { Checkbox, Field, Input, Select } from '@/components/ui/field';

export interface AddressState {
  label: string;
  street: string;
  number: string;
  complement: string;
  district: string;
  city: string;
  state: string;
  postalCode: string;
  reference: string;
  isPrimary: boolean;
}

export const emptyAddress = (label = 'Principal'): AddressState => ({
  label,
  street: '',
  number: '',
  complement: '',
  district: '',
  city: '',
  state: 'SP',
  postalCode: '',
  reference: '',
  isPrimary: false,
});

export const addressFromDto = (a: CustomerAddressDto): AddressState => ({
  label: a.label,
  street: a.street,
  number: a.number,
  complement: a.complement ?? '',
  district: a.district ?? '',
  city: a.city,
  state: a.state,
  postalCode: a.postalCode ?? '',
  reference: a.reference ?? '',
  isPrimary: a.isPrimary,
});

export function AddressFields({
  value,
  onChange,
  errors = {},
  prefix = '',
  showPrimary,
}: {
  value: AddressState;
  onChange: (v: AddressState) => void;
  errors?: Record<string, string>;
  prefix?: string;
  showPrimary?: boolean;
}) {
  const set = <K extends keyof AddressState>(k: K, v: AddressState[K]) =>
    onChange({ ...value, [k]: v });
  const err = (k: string) => errors[`${prefix}${k}`];
  return (
    <div className="grid gap-4 sm:grid-cols-6">
      <Field
        label="Identificação"
        error={err('label')}
        className="sm:col-span-2"
        hint="Ex.: Residência, Escritório"
      >
        {(p) => <Input {...p} value={value.label} onChange={(e) => set('label', e.target.value)} />}
      </Field>
      <Field label="CEP" error={err('postalCode')} className="sm:col-span-2">
        {(p) => (
          <Input
            {...p}
            inputMode="numeric"
            value={value.postalCode}
            onChange={(e) => set('postalCode', e.target.value)}
          />
        )}
      </Field>
      <div className="hidden sm:col-span-2 sm:block" />
      <Field label="Logradouro" error={err('street')} className="sm:col-span-4" required>
        {(p) => (
          <Input {...p} value={value.street} onChange={(e) => set('street', e.target.value)} />
        )}
      </Field>
      <Field label="Número" error={err('number')} className="sm:col-span-2" required>
        {(p) => (
          <Input {...p} value={value.number} onChange={(e) => set('number', e.target.value)} />
        )}
      </Field>
      <Field label="Complemento" error={err('complement')} className="sm:col-span-3">
        {(p) => (
          <Input
            {...p}
            value={value.complement}
            onChange={(e) => set('complement', e.target.value)}
          />
        )}
      </Field>
      <Field label="Bairro" error={err('district')} className="sm:col-span-3">
        {(p) => (
          <Input {...p} value={value.district} onChange={(e) => set('district', e.target.value)} />
        )}
      </Field>
      <Field label="Cidade" error={err('city')} className="sm:col-span-4" required>
        {(p) => <Input {...p} value={value.city} onChange={(e) => set('city', e.target.value)} />}
      </Field>
      <Field label="UF" error={err('state')} className="sm:col-span-2">
        {(p) => (
          <Select {...p} value={value.state} onChange={(e) => set('state', e.target.value)}>
            {BR_STATES.map((s) => (
              <option key={s}>{s}</option>
            ))}
          </Select>
        )}
      </Field>
      <Field
        label="Referência / instruções de acesso"
        error={err('reference')}
        className="sm:col-span-6"
      >
        {(p) => (
          <Input
            {...p}
            value={value.reference}
            onChange={(e) => set('reference', e.target.value)}
          />
        )}
      </Field>
      {showPrimary && (
        <Checkbox
          className="sm:col-span-6"
          label="Endereço principal"
          checked={value.isPrimary}
          onChange={(e) => set('isPrimary', e.target.checked)}
        />
      )}
    </div>
  );
}

export function addressLines(a: {
  street: string;
  number: string;
  complement: string | null;
  district: string | null;
  city: string;
  state: string;
  postalCode: string | null;
}): string {
  const cep = a.postalCode ? ` · CEP ${a.postalCode.replace(/(\d{5})(\d{3})/, '$1-$2')}` : '';
  return `${a.street}, ${a.number}${a.complement ? ` — ${a.complement}` : ''}\n${a.district ? `${a.district}, ` : ''}${a.city}/${a.state}${cep}`;
}
