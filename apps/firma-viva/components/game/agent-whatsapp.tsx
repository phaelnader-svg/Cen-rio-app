'use client';
/**
 * Mensagens dos agentes pelo WhatsApp (pedido ao fornecedor, cobrança, aviso ao cliente): o dono
 * lê, ajusta o texto (e o fornecedor) e aprova. Sem o WhatsApp da empresa conectado, a aprovação
 * abre o WhatsApp com a mensagem pronta; quem aperta "enviar" é o dono.
 * Fornecedores: cadastro simples (nome, contato, WhatsApp e o que vende) usado pelo Compras.
 */
import type { AgentProposalDto, SupplierDto } from '@cenario/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { useToast } from '@/components/ui/toast';
import { ApiError, api, newIdempotencyKey } from '@/lib/api';
import { useSuppliers } from './game-api';
import { GBtn, Section, Tone } from './ui';

const KIND_LABEL: Record<string, string> = {
  PEDIR_FORNECEDOR: 'Pedido ao fornecedor',
  COBRAR_CLIENTE: 'Cobrança',
  ENVIAR_MENSAGEM: 'Mensagem ao cliente',
};

export function WhatsAppProposal({
  proposal: p,
  canManage,
  suppliers,
  linkOf,
  onDecide,
}: {
  proposal: AgentProposalDto;
  canManage: boolean;
  suppliers: SupplierDto[];
  linkOf: (href?: string | null) => string | undefined;
  onDecide: (
    decision: 'APROVAR' | 'REJEITAR',
    edits?: { text?: string; supplierId?: string },
  ) => Promise<void>;
}) {
  const original = String(p.payload.text ?? p.detail);
  const [text, setText] = useState(original);
  const [supplierId, setSupplierId] = useState(String(p.payload.supplierId ?? ''));
  const [busy, setBusy] = useState(false);
  const isOrder = p.kind === 'PEDIR_FORNECEDOR';
  const phone = isOrder
    ? (suppliers.find((s) => s.id === supplierId)?.phone ?? null)
    : ((p.payload.phone as string | null) ?? null);
  const edits = {
    ...(text.trim() !== original.trim() ? { text: text.trim() } : {}),
    ...(isOrder && supplierId !== p.payload.supplierId ? { supplierId } : {}),
  };
  const go = async (decision: 'APROVAR' | 'REJEITAR') => {
    setBusy(true);
    try {
      await onDecide(decision, Object.keys(edits).length ? edits : undefined);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li className="rounded-lg border border-line bg-white p-2 text-xs" data-testid="wa-proposal">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold">{p.title}</span>
        <Tone tone="info">{KIND_LABEL[p.kind] ?? 'WhatsApp'}</Tone>
      </div>
      {isOrder && suppliers.length > 1 ? (
        <label className="mt-1.5 block">
          <span className="text-ink-muted">Fornecedor</span>
          <select
            className="mt-0.5 w-full rounded-lg border border-line px-2 py-1"
            value={supplierId}
            disabled={!canManage}
            onChange={(e) => setSupplierId(e.target.value)}
          >
            {suppliers
              .filter((s) => s.active)
              .map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name}
                </option>
              ))}
          </select>
        </label>
      ) : null}
      <textarea
        className="mt-1.5 w-full rounded-lg border border-line p-2 leading-relaxed"
        rows={Math.min(10, text.split('\n').length + 1)}
        value={text}
        disabled={!canManage}
        onChange={(e) => setText(e.target.value)}
        data-testid="wa-proposal-text"
      />
      <div className="mt-1 text-ink-muted">
        {phone
          ? `Para ${phone}.`
          : 'Sem WhatsApp cadastrado: o WhatsApp vai pedir para você escolher o contato.'}
      </div>
      <div className="mt-1 flex flex-wrap gap-1">
        {p.evidence.map((r) => (
          <a
            key={r.id}
            href={linkOf(r.href)}
            target="_blank"
            rel="noreferrer"
            className="rounded bg-subtle px-1.5 py-0.5 underline"
          >
            {r.label}
          </a>
        ))}
      </div>
      {canManage ? (
        <div className="mt-1.5 flex gap-1.5">
          <GBtn
            tone="primary"
            className="!px-2 !py-1 text-xs"
            disabled={busy || !text.trim()}
            onClick={() => void go('APROVAR')}
            testId="proposal-approve"
          >
            Aprovar e abrir WhatsApp
          </GBtn>
          <GBtn
            tone="ghost"
            className="!px-2 !py-1 text-xs"
            disabled={busy}
            onClick={() => void go('REJEITAR')}
          >
            Rejeitar
          </GBtn>
        </div>
      ) : (
        <p className="mt-1 text-ink-muted">Aprovação exige agentes.gerenciar.</p>
      )}
      {isOrder ? (
        <p className="mt-1 text-ink-muted">
          Ao aprovar, os itens do pedido ficam marcados como comprados na lista da OS.
        </p>
      ) : null}
    </li>
  );
}

const CATEGORY_LABEL = { TECIDO: 'Tecidos', ESPUMA: 'Espumas', OUTRO: 'Outros' } as const;
type Category = keyof typeof CATEGORY_LABEL;
const blank = { name: '', contactName: '', phone: '', categories: [] as Category[] };

export function SuppliersSection({ canManage }: { canManage: boolean }) {
  const list = useSuppliers();
  const qc = useQueryClient();
  const toast = useToast();
  const [editing, setEditing] = useState<SupplierDto | 'novo' | null>(null);
  const [form, setForm] = useState(blank);
  const active = (list.data ?? []).filter((s) => s.active);
  const open = (s: SupplierDto | 'novo') => {
    setEditing(s);
    setForm(
      s === 'novo'
        ? blank
        : {
            name: s.name,
            contactName: s.contactName ?? '',
            phone: s.phone ?? '',
            categories: s.categories,
          },
    );
  };
  const save = async (deactivate = false) => {
    if (!editing) return;
    try {
      const body = {
        name: form.name,
        contactName: form.contactName || null,
        phone: form.phone || null,
        categories: form.categories,
      };
      await api(
        editing === 'novo' ? '/api/v1/game/suppliers' : `/api/v1/game/suppliers/${editing.id}`,
        {
          method: editing === 'novo' ? 'POST' : 'PUT',
          idempotencyKey: newIdempotencyKey(),
          body:
            editing === 'novo'
              ? body
              : { ...body, version: editing.version, ...(deactivate ? { active: false } : {}) },
        },
      );
      setEditing(null);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['game-suppliers'] }),
        qc.invalidateQueries({ queryKey: ['game-agent'] }),
      ]);
      toast('ok', deactivate ? 'Fornecedor removido.' : 'Fornecedor salvo.');
    } catch (e) {
      toast('danger', e instanceof ApiError ? e.message : 'Não foi possível salvar.');
    }
  };
  return (
    <Section
      title={`Fornecedores (${active.length})`}
      right={
        canManage && !editing ? (
          <GBtn tone="ghost" className="!px-2 !py-0.5 text-xs" onClick={() => open('novo')}>
            + Fornecedor
          </GBtn>
        ) : null
      }
    >
      {editing ? (
        <div className="space-y-1.5 rounded-xl border border-line bg-white p-2 text-xs">
          <input
            className="w-full rounded-lg border border-line px-2 py-1"
            placeholder="Nome do fornecedor"
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            data-testid="supplier-name"
          />
          <input
            className="w-full rounded-lg border border-line px-2 py-1"
            placeholder="Nome do contato (opcional)"
            value={form.contactName}
            onChange={(e) => setForm({ ...form, contactName: e.target.value })}
          />
          <input
            className="w-full rounded-lg border border-line px-2 py-1"
            placeholder="WhatsApp com DDD, ex.: (12) 99999-0000"
            inputMode="tel"
            value={form.phone}
            onChange={(e) => setForm({ ...form, phone: e.target.value })}
            data-testid="supplier-phone"
          />
          <div className="flex flex-wrap gap-2">
            <span className="text-ink-muted">Vende:</span>
            {(Object.keys(CATEGORY_LABEL) as Category[]).map((c) => (
              <label key={c} className="flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={form.categories.includes(c)}
                  onChange={(e) =>
                    setForm({
                      ...form,
                      categories: e.target.checked
                        ? [...form.categories, c]
                        : form.categories.filter((x) => x !== c),
                    })
                  }
                />
                {CATEGORY_LABEL[c]}
              </label>
            ))}
          </div>
          <div className="flex gap-1.5">
            <GBtn
              tone="primary"
              className="!px-2 !py-1 text-xs"
              disabled={!form.name.trim()}
              onClick={() => void save()}
              testId="supplier-save"
            >
              Salvar
            </GBtn>
            <GBtn tone="ghost" className="!px-2 !py-1 text-xs" onClick={() => setEditing(null)}>
              Cancelar
            </GBtn>
            {editing !== 'novo' ? (
              <GBtn tone="danger" className="!px-2 !py-1 text-xs" onClick={() => void save(true)}>
                Remover
              </GBtn>
            ) : null}
          </div>
        </div>
      ) : active.length ? (
        <ul className="space-y-1 text-xs" data-testid="suppliers">
          {active.map((s) => (
            <li
              key={s.id}
              className="flex items-center justify-between gap-2 rounded-lg border border-line bg-white px-2 py-1"
            >
              <span>
                <b>{s.name}</b>
                {s.categories.length
                  ? ` · ${s.categories.map((c) => CATEGORY_LABEL[c]).join(', ')}`
                  : ''}
                <span className="block text-ink-muted">
                  {s.phone ?? 'sem WhatsApp'}
                  {s.contactName ? ` · ${s.contactName}` : ''}
                </span>
              </span>
              {canManage ? (
                <GBtn tone="ghost" className="!px-2 !py-0.5 text-xs" onClick={() => open(s)}>
                  Editar
                </GBtn>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-ink-muted">
          Cadastre os fornecedores com o WhatsApp e o que cada um vende. O Compras junta os
          materiais das OS que faltam comprar e prepara o pedido de cada um.
        </p>
      )}
    </Section>
  );
}
