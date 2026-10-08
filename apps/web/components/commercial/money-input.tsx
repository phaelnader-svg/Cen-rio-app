'use client';

import { parseMoneyToCents } from '@cenario/shared';
import { forwardRef, useState } from 'react';
import { Input } from '@/components/ui/field';

const toText = (cents: number | null) =>
  cents === null
    ? ''
    : (cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Campo de valor em reais (aceita "3.500,00"); devolve centavos ou null. */
export const MoneyInput = forwardRef<
  HTMLInputElement,
  Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'> & {
    cents: number | null;
    onCents: (v: number | null, valid: boolean) => void;
  }
>(function MoneyInput({ cents, onCents, ...rest }, ref) {
  const [text, setText] = useState(toText(cents));
  return (
    <div className="relative">
      <span className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-ink-muted">
        R$
      </span>
      <Input
        ref={ref}
        {...rest}
        inputMode="decimal"
        className="pl-10"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          const v = parseMoneyToCents(e.target.value);
          onCents(v, e.target.value.trim() === '' || v !== null);
        }}
        onBlur={() => setText(toText(parseMoneyToCents(text)))}
      />
    </div>
  );
});
