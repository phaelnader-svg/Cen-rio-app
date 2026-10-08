'use client';

import clsx from 'clsx';
import { CheckCircle2, XCircle } from 'lucide-react';
import { createContext, useCallback, useContext, useState } from 'react';

interface Toast {
  id: number;
  tone: 'ok' | 'danger';
  message: string;
}

const ToastContext = createContext<(tone: Toast['tone'], message: string) => void>(() => {});

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((tone: Toast['tone'], message: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, tone, message }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 5000);
  }, []);
  return (
    <ToastContext.Provider value={push}>
      {children}
      <div
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2 px-4"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={clsx(
              'pointer-events-auto flex max-w-md items-center gap-2.5 rounded-xl border bg-surface px-4 py-3 text-sm font-medium shadow-[var(--shadow-pop)]',
              t.tone === 'ok' ? 'border-ok-600/20' : 'border-danger-600/25',
            )}
          >
            {t.tone === 'ok' ? (
              <CheckCircle2 className="size-4 text-ok-600" aria-hidden />
            ) : (
              <XCircle className="size-4 text-danger-600" aria-hidden />
            )}
            {t.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}
