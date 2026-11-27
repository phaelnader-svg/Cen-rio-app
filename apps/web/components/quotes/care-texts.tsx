'use client';

import { careTextFor } from '@cenario/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/field';
import { Alert, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';

interface CareItem {
  fabric: string;
  text: string;
  custom: boolean;
}

/**
 * Item 23 (lista de 53): cuidados com cada tecido, que o cliente recebe junto com o "Como ficou?"
 * depois da entrega. O texto já vem pronto pela palavra do nome (couro, veludo, linho...); a
 * tapeçaria troca só o que quiser.
 */
export function CareTexts({ fabrics }: { fabrics: string[] }) {
  const q = useQuery({
    queryKey: ['care-texts'],
    queryFn: () => api<{ items: CareItem[] }>('/api/v1/quotes/care-texts'),
  });
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{q.error.message}</Alert>;
  return <CareForm items={q.data.items} fabrics={fabrics} />;
}

function CareForm({ items, fabrics }: { items: CareItem[]; fabrics: string[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const byName = new Map(items.map((i) => [i.fabric, i]));
  for (const f of fabrics)
    if (f.trim() && !byName.has(f.trim()))
      byName.set(f.trim(), { fabric: f.trim(), text: careTextFor(f), custom: false });
  const rows = [...byName.values()].sort((a, b) => a.fabric.localeCompare(b.fabric, 'pt-BR'));
  const [draft, setDraft] = useState<Record<string, string>>(() =>
    Object.fromEntries(rows.map((r) => [r.fabric, r.text])),
  );
  const save = useMutation({
    mutationFn: () => {
      // Grava só o que ficou diferente do texto padrão.
      const texts = Object.fromEntries(
        Object.entries(draft).filter(([f, t]) => t.trim() && t.trim() !== careTextFor(f)),
      );
      return api('/api/v1/quotes/care-texts', { method: 'PUT', body: { texts } });
    },
    onSuccess: () => {
      toast('ok', 'Cuidados salvos.');
      void qc.invalidateQueries({ queryKey: ['care-texts'] });
    },
  });
  if (rows.length === 0)
    return (
      <p className="text-sm text-ink-muted">
        Cadastre os tecidos na aba Tecidos. Cada um ganha aqui um texto de cuidados pronto, que o
        cliente recebe depois da entrega.
      </p>
    );
  return (
    <div className="max-w-3xl space-y-4" data-testid="cuidados-tecidos">
      <p className="text-sm text-ink-soft">
        O cliente recebe estes cuidados junto com o &quot;Como ficou?&quot; depois da entrega. O
        texto já vem pronto pelo nome do tecido; troque só se quiser.
      </p>
      {rows.map((r) => (
        <label key={r.fabric} className="block">
          <span className="text-sm font-medium">{r.fabric}</span>
          <Textarea
            className="mt-1"
            rows={2}
            maxLength={600}
            value={draft[r.fabric] ?? ''}
            onChange={(e) => setDraft((d) => ({ ...d, [r.fabric]: e.target.value }))}
          />
        </label>
      ))}
      {save.isError && <Alert tone="danger">{errorMessage(save.error)}</Alert>}
      <Button loading={save.isPending} onClick={() => save.mutate()}>
        Salvar cuidados
      </Button>
    </div>
  );
}
