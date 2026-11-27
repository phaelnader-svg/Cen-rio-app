import { Spinner } from '@/components/ui/misc';

/** Enquanto a próxima tela do painel carrega (internet lenta), mostra "Carregando…" no lugar. */
export default function Loading() {
  return (
    <div className="grid min-h-64 place-items-center">
      <Spinner />
    </div>
  );
}
