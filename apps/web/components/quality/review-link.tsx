'use client';

import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Copy, MessageCircle, Star } from 'lucide-react';
import { useState } from 'react';
import { api } from '@/lib/api';

interface ReviewLink {
  url: string;
  text: string;
  whatsappUrl: string | null;
  rated: boolean;
}

/**
 * Item 22 (lista de 53): depois da entrega, um botão manda ao cliente o link do "Como ficou?"
 * (nota de 1 a 5 e os cuidados com a peça). `large` = tamanho do tablet.
 */
export function AskReview({ deliveryId, large }: { deliveryId: string; large?: boolean }) {
  const q = useQuery({
    queryKey: ['review-link', deliveryId],
    queryFn: () => api<ReviewLink>(`/api/v1/deliveries/${deliveryId}/review-link`),
    retry: false,
    staleTime: 60_000,
  });
  const [copied, setCopied] = useState(false);
  if (!q.data) return null;
  const l = q.data;
  if (l.rated)
    return (
      <p
        className={clsx(
          'flex items-center gap-2 text-ink-muted',
          large ? 'mt-4 text-lg' : 'text-sm',
        )}
        data-testid="avaliacao-respondida"
      >
        <Star className="size-5 fill-amber-400 text-amber-400" aria-hidden /> O cliente já deu a
        nota desta entrega.
      </p>
    );
  const cls = clsx(
    'flex items-center justify-center gap-2 rounded-xl px-4 font-semibold',
    large ? 'mt-4 h-14 w-full text-lg' : 'h-10 text-sm',
  );
  return l.whatsappUrl ? (
    <a
      href={l.whatsappUrl}
      target="_blank"
      rel="noopener noreferrer"
      className={clsx(cls, 'bg-ok-600 text-white hover:bg-ok-600/90')}
      data-testid="pedir-avaliacao"
    >
      <MessageCircle className="size-5" aria-hidden /> Perguntar ao cliente: como ficou?
    </a>
  ) : (
    <button
      type="button"
      className={clsx(cls, 'border border-line bg-surface hover:bg-subtle')}
      data-testid="pedir-avaliacao"
      onClick={() => {
        void navigator.clipboard?.writeText(l.text);
        setCopied(true);
      }}
    >
      <Copy className="size-5" aria-hidden />
      {copied ? 'Mensagem copiada' : 'Copiar o "Como ficou?" para mandar ao cliente'}
    </button>
  );
}
