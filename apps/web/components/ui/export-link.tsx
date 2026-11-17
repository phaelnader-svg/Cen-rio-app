import { Download } from 'lucide-react';

/** Botão "Exportar planilha" (CSV que abre no Excel) das listas do painel. */
export function ExportLink({ href, testId }: { href: string; testId?: string }) {
  return (
    <a
      href={href}
      download
      data-testid={testId}
      className="inline-flex h-10 items-center gap-2 rounded-xl border border-line bg-surface px-4 text-sm font-medium hover:bg-subtle"
    >
      <Download className="size-4" aria-hidden /> Exportar planilha
    </a>
  );
}
