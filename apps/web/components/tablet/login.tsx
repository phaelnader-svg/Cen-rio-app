'use client';

import type { EmployeeSummaryDto, MeDto } from '@cenario/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import clsx from 'clsx';
import { ArrowLeft, Delete } from 'lucide-react';
import { useEffect, useState } from 'react';
import { BrandMark } from '@/components/brand';
import { Alert, Avatar, EmptyState } from '@/components/ui/misc';
import { ApiError, api } from '@/lib/api';

export function TabletLogin({
  deviceName,
  employees,
  notice,
}: {
  deviceName: string;
  employees: EmployeeSummaryDto[];
  notice?: string | null;
}) {
  const [chosen, setSelected] = useState<EmployeeSummaryDto | null>(null);
  // Se a lista mudar em tempo real (ex.: PIN removido), a escolha deixa de valer.
  const selected =
    chosen && employees.some((e) => e.id === chosen.id)
      ? chosen
      : employees.length === 1
        ? employees[0]!
        : null;

  return (
    <main className="flex min-h-dvh flex-col px-6 py-8 sm:px-10">
      <header className="flex items-center justify-between">
        <BrandMark />
        <p className="text-sm text-ink-muted">{deviceName}</p>
      </header>
      <div className="flex flex-1 flex-col items-center justify-center py-8">
        {notice && (
          <Alert tone="warn" className="mb-8 w-full max-w-xl">
            {notice}
          </Alert>
        )}
        {selected ? (
          <PinPad
            employee={selected}
            onBack={employees.length > 1 ? () => setSelected(null) : undefined}
          />
        ) : employees.length === 0 ? (
          <EmptyState
            title="Nenhum funcionário habilitado neste tablet"
            description="O gestor precisa definir um PIN para o funcionário e conceder acesso à produção."
          />
        ) : (
          <div className="w-full max-w-3xl">
            <h1 className="text-center text-3xl font-semibold tracking-tight">Quem está usando?</h1>
            <ul className="mt-10 grid grid-cols-2 gap-5 sm:grid-cols-3">
              {employees.map((e) => (
                <li key={e.id}>
                  <button
                    type="button"
                    onClick={() => setSelected(e)}
                    className="flex w-full flex-col items-center gap-4 rounded-2xl border border-line bg-surface p-6 shadow-[var(--shadow-card)] transition hover:border-brand-200 hover:shadow-[var(--shadow-pop)] active:scale-[0.98]"
                    style={{ borderTop: `6px solid ${e.color}` }}
                  >
                    <Avatar name={e.displayName} color={e.color} photoUrl={e.photoUrl} size={88} />
                    <span>
                      <span className="block text-xl font-semibold">{e.displayName}</span>
                      <span className="block text-sm text-ink-muted">{e.jobTitle}</span>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </main>
  );
}

function PinPad({ employee, onBack }: { employee: EmployeeSummaryDto; onBack?: () => void }) {
  const qc = useQueryClient();
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: (value: string) =>
      api<MeDto>('/api/tablet/login', {
        method: 'POST',
        body: { employeeId: employee.id, pin: value },
      }),
    onSuccess: (me) => {
      qc.setQueryData(['me'], me);
      void qc.invalidateQueries({ queryKey: ['tablet-status'] });
    },
    onError: (e) => {
      setPin('');
      setError(e instanceof ApiError ? e.message : 'Não foi possível entrar.');
    },
  });

  const press = (d: string) => {
    if (m.isPending || pin.length >= 6) return;
    setError(null);
    const next = pin + d;
    setPin(next);
    if (next.length === 6) m.mutate(next);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) press(e.key);
      if (e.key === 'Backspace') setPin((p) => p.slice(0, -1));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="w-full max-w-sm text-center">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="mb-6 inline-flex items-center gap-2 rounded-xl px-3 py-2 text-base font-medium text-ink-soft hover:bg-subtle"
        >
          <ArrowLeft className="size-5" aria-hidden /> Trocar funcionário
        </button>
      )}
      <Avatar
        name={employee.displayName}
        color={employee.color}
        photoUrl={employee.photoUrl}
        size={96}
        className="mx-auto"
      />
      <h1 className="mt-4 text-3xl font-semibold tracking-tight">Olá, {employee.displayName}</h1>
      <p className="mt-1 text-lg text-ink-muted">Digite seu PIN de 6 dígitos</p>

      <div
        className="mt-8 flex justify-center gap-3"
        aria-label={`${pin.length} de 6 dígitos digitados`}
        role="status"
      >
        {Array.from({ length: 6 }).map((_, i) => (
          <span
            key={i}
            className={clsx(
              'size-5 rounded-full border-2 transition',
              i < pin.length ? 'border-brand-700 bg-brand-700' : 'border-line-strong',
            )}
          />
        ))}
      </div>
      <p role="alert" className="mt-4 min-h-7 text-lg font-medium text-danger-600">
        {error}
      </p>

      <div className="mt-2 grid grid-cols-3 gap-3" aria-label="Teclado numérico">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <Key key={d} onClick={() => press(d)} disabled={m.isPending}>
            {d}
          </Key>
        ))}
        <span />
        <Key onClick={() => press('0')} disabled={m.isPending}>
          0
        </Key>
        <Key onClick={() => setPin((p) => p.slice(0, -1))} label="Apagar" disabled={m.isPending}>
          <Delete className="size-7" aria-hidden />
        </Key>
      </div>
    </div>
  );
}

function Key({
  children,
  onClick,
  label,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  label?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="grid h-20 place-items-center rounded-2xl border border-line bg-surface text-3xl font-semibold text-ink shadow-[var(--shadow-card)] transition active:scale-95 active:bg-subtle disabled:opacity-50"
    >
      {children}
    </button>
  );
}
