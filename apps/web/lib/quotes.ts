'use client';

import {
  emptyQuoteDraft,
  quoteDraftSchema,
  type QuoteCatalogItemDto,
  type QuoteDraft,
  type QuoteDto,
  type QuoteSettingsDto,
  type QuoteSummaryDto,
} from '@cenario/shared';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { useMe } from './hooks';

/** Módulo Orçamentos: consultas e o orçamento em elaboração (guardado no navegador). */

export const QUOTES_KEY = ['quotes'] as const;

export const useQuoteCatalog = () =>
  useQuery({
    queryKey: ['quotes', 'catalog'],
    queryFn: () => api<QuoteCatalogItemDto[]>('/api/v1/quotes/catalog'),
  });

export const useQuoteSettings = () =>
  useQuery({
    queryKey: ['quotes', 'settings'],
    queryFn: () => api<QuoteSettingsDto>('/api/v1/quotes/settings'),
  });

export const useSavedQuotes = () =>
  useQuery({
    queryKey: ['quotes', 'list'],
    queryFn: () => api<QuoteSummaryDto[]>('/api/v1/quotes'),
  });

export const useSavedQuote = (id: string | null) =>
  useQuery({
    queryKey: ['quotes', 'detail', id],
    queryFn: () => api<QuoteDto>(`/api/v1/quotes/${id}`),
    enabled: Boolean(id),
  });

const storageKey = (userId: string) => `cenario.orcamento.rascunho.v1.${userId}`;

function readDraft(userId: string): QuoteDraft {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    if (!raw) return emptyQuoteDraft();
    const parsed = quoteDraftSchema.safeParse({ ...emptyQuoteDraft(), ...JSON.parse(raw) });
    return parsed.success ? parsed.data : emptyQuoteDraft();
  } catch {
    return emptyQuoteDraft();
  }
}

/**
 * Orçamento em elaboração: fica neste navegador (por pessoa) até ser salvo, como no modelo
 * original. Sair da tela ou recarregar não perde nada; "Limpar orçamento" recomeça.
 */
/** Orçamento salvo reaberto no "Elaborar": ao salvar, ele é atualizado (mesmo número e link). */
export interface QuoteEditing {
  id: string;
  number: number;
  version: number;
}

const editingKey = (userId: string) => `cenario.orcamento.editando.v1.${userId}`;

function readEditing(userId: string): QuoteEditing | null {
  try {
    const raw = localStorage.getItem(editingKey(userId));
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<QuoteEditing>;
    return typeof v.id === 'string' && typeof v.number === 'number' && typeof v.version === 'number'
      ? { id: v.id, number: v.number, version: v.version }
      : null;
  } catch {
    return null;
  }
}

/** Leva um rascunho pronto (ex.: o montado pelo agente) para a tela "Elaborar" desta pessoa. */
export function putDraftInEditor(userId: string, draft: QuoteDraft) {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(draft));
    localStorage.removeItem(editingKey(userId));
    return true;
  } catch {
    return false;
  }
}

export function useQuoteDraft() {
  const me = useMe();
  const userId = me.data?.user.id ?? null;
  const [state, setState] = useState<{
    uid: string | null;
    draft: QuoteDraft;
    editing: QuoteEditing | null;
  }>(() => ({ uid: null, draft: emptyQuoteDraft(), editing: null }));
  // Ao conhecer a pessoa, carrega o rascunho dela (ajuste de estado durante a renderização).
  if (userId && state.uid !== userId)
    setState({ uid: userId, draft: readDraft(userId), editing: readEditing(userId) });
  const loaded = userId !== null && state.uid === userId;
  const draft = state.draft;

  useEffect(() => {
    if (!state.uid) return;
    try {
      localStorage.setItem(storageKey(state.uid), JSON.stringify(state.draft));
      if (state.editing) localStorage.setItem(editingKey(state.uid), JSON.stringify(state.editing));
      else localStorage.removeItem(editingKey(state.uid));
    } catch {
      // Armazenamento indisponível: o orçamento continua na tela, só não sobrevive a recarregar.
    }
  }, [state]);

  const update = useCallback(
    (patch: Partial<QuoteDraft> | ((d: QuoteDraft) => Partial<QuoteDraft>)) =>
      setState((st) => ({
        ...st,
        draft: { ...st.draft, ...(typeof patch === 'function' ? patch(st.draft) : patch) },
      })),
    [],
  );
  const reset = useCallback(
    () => setState((st) => ({ ...st, draft: emptyQuoteDraft(), editing: null })),
    [],
  );
  /** Abre um orçamento salvo para editar (substitui o que estava em elaboração). */
  const load = useCallback(
    (d: QuoteDraft, editing: QuoteEditing) => setState((st) => ({ ...st, draft: d, editing })),
    [],
  );
  return { draft, update, reset, load, editing: state.editing, loaded };
}

/** Valor em reais (já calculado em reais) formatado. */
export const brl = (reais: number) =>
  Math.max(0, reais).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export const pct = (n: number) => `${n.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;

export const qtyText = (n: number, digits = 3) =>
  n.toLocaleString('pt-BR', { maximumFractionDigits: digits });

/** Data local (AAAA-MM-DD) de um instante. */
export function localDay(iso: string | Date): string {
  const d = new Date(iso);
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

/** Reduz a imagem (lado maior ≤ `max` px) e devolve em data URL. */
export function shrinkImage(
  file: File,
  max: number,
  type: 'image/png' | 'image/jpeg',
  quality = 0.79,
) {
  return new Promise<string>((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
        const ctx = canvas.getContext('2d')!;
        if (type === 'image/jpeg') {
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL(type, quality));
      } catch (e) {
        reject(e as Error);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Imagem inválida'));
    };
    img.src = url;
  });
}

/**
 * Imprime só o elemento `id`: tudo o que não é ele nem um de seus ancestrais some na impressão
 * (menu, topo, abas e botões), sem páginas em branco no fim.
 */
export function printArea(id: string) {
  const area = document.getElementById(id);
  if (!area) return;
  const hidden: Element[] = [];
  const first = area.querySelector('.print-page');
  first?.setAttribute('data-print-first', '');
  // Os contêineres em volta (abas, painel) perdem o respiro de tela na folha: o documento começa
  // no topo da margem da página.
  const ancestors: Element[] = [];
  for (let el: Element | null = area; el && el !== document.body; el = el.parentElement) {
    if (el !== area) {
      el.setAttribute('data-print-ancestor', '');
      ancestors.push(el);
    }
    for (const sib of Array.from(el.parentElement?.children ?? []))
      if (sib !== el) {
        sib.setAttribute('data-print-hidden', '');
        hidden.push(sib);
      }
  }
  const done = () => {
    hidden.forEach((h) => h.removeAttribute('data-print-hidden'));
    ancestors.forEach((a) => a.removeAttribute('data-print-ancestor'));
    first?.removeAttribute('data-print-first');
    window.removeEventListener('afterprint', done);
  };
  window.addEventListener('afterprint', done);
  window.print();
}
