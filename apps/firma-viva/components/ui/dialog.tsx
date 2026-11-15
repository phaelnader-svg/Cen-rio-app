'use client';

import { X } from 'lucide-react';
import { useEffect, useId, useRef } from 'react';

/**
 * Diálogo modal baseado no elemento nativo <dialog> (foco preso, Esc para
 * fechar e fundo inerte providos pelo navegador).
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = 'md',
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: React.ReactNode;
  footer?: React.ReactNode;
  size?: 'sm' | 'md' | 'lg' | 'xl';
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (open && !el.open) el.showModal();
    if (!open && el.open) el.close();
  }, [open]);

  const width = { sm: 'max-w-md', md: 'max-w-xl', lg: 'max-w-3xl', xl: 'max-w-5xl' }[size];

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className={`m-auto w-[calc(100%-1.5rem)] ${width} rounded-2xl border border-line bg-surface p-0 text-ink shadow-[var(--shadow-pop)]`}
    >
      {open && (
        <div className="flex max-h-[min(88vh,calc(100dvh-1.5rem))] flex-col">
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-4 sm:px-6">
            <div className="min-w-0">
              <h2 id={titleId} className="text-lg font-semibold">
                {title}
              </h2>
              {description && (
                <p id={descId} className="mt-0.5 text-sm text-ink-muted">
                  {description}
                </p>
              )}
            </div>
            <button
              type="button"
              onClick={onClose}
              className="-mr-2 rounded-lg p-2 text-ink-muted hover:bg-subtle hover:text-ink"
              aria-label="Fechar"
            >
              <X className="size-5" aria-hidden />
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-5 sm:px-6">
            {children}
          </div>
          {footer && (
            <div className="flex flex-col-reverse gap-2 border-t border-line bg-subtle/60 px-5 py-3.5 sm:flex-row sm:flex-wrap sm:justify-end sm:px-6 [&>*]:w-full sm:[&>*]:w-auto">
              {footer}
            </div>
          )}
        </div>
      )}
    </dialog>
  );
}
