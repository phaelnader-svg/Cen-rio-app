'use client';

import { Printer } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ServiceOrderSheet } from './os-sheet';
import { BackLink } from './section';

/** Página da OS no painel (a mesma que o tablet abre em "Abrir OS"), com impressão. */
export function ServiceOrderSheetPage({ id }: { id: string }) {
  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-4 flex items-center justify-between gap-3 print:hidden">
        <BackLink href={`/painel/os/${id}`} label="Voltar para a OS" />
        <Button
          variant="secondary"
          size="sm"
          icon={<Printer className="size-4" aria-hidden />}
          onClick={() => window.print()}
        >
          Imprimir
        </Button>
      </div>
      <ServiceOrderSheet id={id} />
    </div>
  );
}
