'use client';

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FileSpreadsheet, Upload } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Alert, Spinner } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';

/**
 * Melhoria 75: importar uma planilha (Excel ou CSV). A pessoa escolhe qual coluna é o quê, vê as
 * primeiras linhas e confirma. Linhas com problema voltam numa lista; as outras entram.
 */
export interface ImportField {
  key: string;
  label: string;
  required?: boolean;
  /** Palavras do cabeçalho que indicam esta coluna (sem acento, minúsculas). */
  guess: string[];
}

interface Result {
  created: number;
  updated?: number;
  problems: { line: number; name: string; reason: string }[];
}

const fold = (s: string) =>
  s
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .trim();

function guessMapping(header: string[], fields: ImportField[]): Record<string, number> {
  const out: Record<string, number> = {};
  const used = new Set<number>();
  for (const f of fields) {
    const idx = header.findIndex(
      (h, i) => !used.has(i) && f.guess.some((g) => fold(h) === g || fold(h).includes(g)),
    );
    if (idx >= 0) {
      out[f.key] = idx;
      used.add(idx);
    }
  }
  return out;
}

export function SheetImportButton({
  title,
  description,
  fields,
  endpoint,
  invalidate,
  resultText,
}: {
  title: string;
  description: string;
  fields: ImportField[];
  endpoint: string;
  invalidate: string[];
  resultText: (r: Result) => string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="secondary"
        icon={<FileSpreadsheet className="size-4" aria-hidden />}
        onClick={() => setOpen(true)}
      >
        Importar planilha
      </Button>
      {open && (
        <ImportDialog
          title={title}
          description={description}
          fields={fields}
          endpoint={endpoint}
          invalidate={invalidate}
          resultText={resultText}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function ImportDialog({
  title,
  description,
  fields,
  endpoint,
  invalidate,
  resultText,
  onClose,
}: {
  title: string;
  description: string;
  fields: ImportField[];
  endpoint: string;
  invalidate: string[];
  resultText: (r: Result) => string;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [rows, setRows] = useState<string[][] | null>(null);
  const [map, setMap] = useState<Record<string, number>>({});
  const [result, setResult] = useState<Result | null>(null);
  const read = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append('file', file);
      return api<{ rows: string[][] }>('/api/v1/import/planilha', { method: 'POST', body: fd });
    },
    onSuccess: (r) => {
      setRows(r.rows);
      setMap(guessMapping(r.rows[0] ?? [], fields));
      setResult(null);
    },
  });
  const header = rows?.[0] ?? [];
  const body = rows?.slice(1).filter((r) => r.some((c) => c.trim())) ?? [];
  const missing = fields.filter((f) => f.required && map[f.key] === undefined);
  const send = useMutation({
    mutationFn: () =>
      api<Result>(endpoint, {
        method: 'POST',
        body: {
          rows: body.map((r, i) => {
            const o: Record<string, string | number> = { line: i + 2 };
            for (const f of fields) {
              const idx = map[f.key];
              const v = idx === undefined ? '' : (r[idx] ?? '').trim();
              if (v || f.required) o[f.key] = v;
            }
            return o;
          }),
        },
      }),
    onSuccess: async (r) => {
      setResult(r);
      for (const k of invalidate) await qc.invalidateQueries({ queryKey: [k] });
    },
  });

  return (
    <Dialog open onClose={onClose} title={title} description={description} size="xl">
      {!rows ? (
        <div className="space-y-3">
          <label className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border-2 border-dashed border-line-strong p-8 text-center hover:bg-subtle">
            <Upload className="size-6 text-ink-muted" aria-hidden />
            <span className="font-medium">Escolher planilha (.xlsx ou .csv)</span>
            <span className="text-sm text-ink-muted">
              A primeira linha precisa ter os nomes das colunas.
            </span>
            <input
              type="file"
              className="sr-only"
              accept=".xlsx,.csv,.txt,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) read.mutate(f);
                e.target.value = '';
              }}
            />
          </label>
          {read.isPending && <Spinner label="Lendo a planilha…" />}
          {read.error && <Alert tone="danger">{errorMessage(read.error)}</Alert>}
        </div>
      ) : result ? (
        <div className="space-y-3">
          <Alert tone={result.problems.length ? 'warn' : 'ok'}>{resultText(result)}</Alert>
          {result.problems.length > 0 && (
            <div>
              <p className="label">
                Linhas que não entraram (corrija na planilha e importe de novo)
              </p>
              <ul className="max-h-72 divide-y divide-line overflow-y-auto rounded-xl border border-line text-sm">
                {result.problems.map((p) => (
                  <li key={p.line} className="px-3 py-2">
                    <strong>Linha {p.line}</strong> {p.name ? `(${p.name})` : ''}: {p.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="flex justify-end">
            <Button onClick={onClose}>Fechar</Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-ink-soft">
            {body.length} linha(s) encontrada(s). Confira qual coluna da planilha corresponde a cada
            campo.
          </p>
          <div className="grid gap-3 sm:grid-cols-3">
            {fields.map((f) => (
              <label key={f.key} className="field">
                <span className="label">
                  {f.label}
                  {f.required ? ' *' : ''}
                </span>
                <select
                  className="h-10 rounded-lg border border-line-strong bg-surface px-2 text-sm"
                  value={map[f.key] ?? ''}
                  onChange={(e) =>
                    setMap((m) => {
                      const next = { ...m };
                      if (e.target.value === '') delete next[f.key];
                      else next[f.key] = Number(e.target.value);
                      return next;
                    })
                  }
                >
                  <option value="">Não importar</option>
                  {header.map((h, i) => (
                    <option key={i} value={i}>
                      {h || `Coluna ${i + 1}`}
                    </option>
                  ))}
                </select>
              </label>
            ))}
          </div>
          <div className="overflow-x-auto rounded-xl border border-line">
            <table className="w-full text-left text-sm">
              <thead className="bg-subtle text-xs text-ink-muted">
                <tr>
                  {fields
                    .filter((f) => map[f.key] !== undefined)
                    .map((f) => (
                      <th key={f.key} className="px-3 py-2 font-semibold">
                        {f.label}
                      </th>
                    ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {body.slice(0, 5).map((r, i) => (
                  <tr key={i}>
                    {fields
                      .filter((f) => map[f.key] !== undefined)
                      .map((f) => (
                        <td key={f.key} className="max-w-48 truncate px-3 py-2">
                          {r[map[f.key]!]}
                        </td>
                      ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {missing.length > 0 && (
            <Alert tone="warn">
              Escolha a coluna de: {missing.map((f) => f.label).join(', ')}.
            </Alert>
          )}
          {send.error && <Alert tone="danger">{errorMessage(send.error)}</Alert>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" onClick={() => setRows(null)}>
              Escolher outra planilha
            </Button>
            <Button
              loading={send.isPending}
              disabled={missing.length > 0 || !body.length}
              onClick={() => send.mutate()}
            >
              Importar {body.length} linha(s)
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

export const CUSTOMER_IMPORT_FIELDS: ImportField[] = [
  { key: 'name', label: 'Nome', required: true, guess: ['nome', 'cliente', 'razao social'] },
  { key: 'phone', label: 'Telefone', guess: ['telefone', 'fone', 'celular'] },
  { key: 'whatsapp', label: 'WhatsApp', guess: ['whatsapp', 'whats', 'zap'] },
  { key: 'email', label: 'E-mail', guess: ['e-mail', 'email'] },
  { key: 'document', label: 'CPF ou CNPJ', guess: ['cpf', 'cnpj', 'documento'] },
  { key: 'street', label: 'Rua', guess: ['rua', 'endereco', 'logradouro'] },
  { key: 'number', label: 'Número', guess: ['numero', 'nº', 'num'] },
  { key: 'district', label: 'Bairro', guess: ['bairro'] },
  { key: 'city', label: 'Cidade', guess: ['cidade', 'municipio'] },
  { key: 'state', label: 'Estado (UF)', guess: ['uf', 'estado'] },
  { key: 'postalCode', label: 'CEP', guess: ['cep'] },
  { key: 'notes', label: 'Observações', guess: ['observ', 'obs', 'anotac'] },
];

export const PRICE_IMPORT_FIELDS: ImportField[] = [
  {
    key: 'name',
    label: 'Material',
    required: true,
    guess: ['material', 'produto', 'nome', 'item'],
  },
  { key: 'price', label: 'Preço', required: true, guess: ['preco', 'valor', 'custo'] },
  { key: 'category', label: 'Categoria', guess: ['categoria', 'tipo', 'grupo'] },
  { key: 'unit', label: 'Unidade', guess: ['unidade', 'un', 'medida'] },
];
