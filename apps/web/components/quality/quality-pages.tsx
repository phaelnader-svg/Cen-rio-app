'use client';

import type { InspectionDto, PackagingDto, QualityTemplateDto } from '@cenario/shared';
import {
  FULFILLMENT_STAGE_LABEL,
  INSPECTION_REASON_LABEL,
  INSPECTION_STATUS_LABEL,
  PACKAGING_STATUS_LABEL,
  PIECE_TYPES,
  PIECE_TYPE_LABEL,
  PRIORITY_LABEL,
  SERVICE_TYPES,
  SERVICE_TYPE_LABEL,
  type InspectionStatus,
  type PieceType,
  type ServiceType,
} from '@cenario/shared';
import { BadgeCheck, Plus } from 'lucide-react';
import Link from 'next/link';
import { useState } from 'react';
import { BackLink, Section } from '@/components/commercial/section';
import { PhotoGallery } from '@/components/commercial/photo-gallery';
import { useSend } from '@/components/production/use-send';
import { InspectionDetail } from '@/components/tablet/quality';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Select, Textarea } from '@/components/ui/field';
import { Alert, Badge, Card, EmptyState, PageHeader, Spinner } from '@/components/ui/misc';
import { Tabs } from '@/components/ui/tabs';
import { api, newIdempotencyKey } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useWorkers } from '@/lib/production';
import {
  useInspection,
  useInspections,
  useInspectors,
  useLocations,
  usePackaging,
  useQualitySettings,
  useQualityTemplates,
} from '@/lib/quality';

const STATUS_TONE: Record<InspectionStatus, 'warn' | 'info' | 'ok' | 'danger' | 'neutral'> = {
  PENDENTE: 'warn',
  EM_ANDAMENTO: 'info',
  APROVADA: 'ok',
  REPROVADA: 'danger',
  INVALIDADA: 'neutral',
  CANCELADA: 'neutral',
};

export function InspectionBadge({ status }: { status: InspectionStatus }) {
  return <Badge tone={STATUS_TONE[status]}>{INSPECTION_STATUS_LABEL[status]}</Badge>;
}

// ─────────────────────────── Página Qualidade ───────────────────────────

export function QualityPage() {
  const [tab, setTab] = useState('inspections');
  const open = useInspections({ scope: 'open' });
  const packaging = usePackaging('open');
  return (
    <>
      <PageHeader
        title="Qualidade e embalagem"
        description="Inspeção final de cada peça (Thiago como inspetor principal), reprovações com correção e nova inspeção, embalagem só depois da aprovação."
      />
      <Tabs
        tabs={[
          { key: 'inspections', label: 'Inspeções', count: open.data?.length },
          { key: 'history', label: 'Histórico' },
          { key: 'packaging', label: 'Embalagens', count: packaging.data?.length },
          { key: 'templates', label: 'Checklists' },
          { key: 'settings', label: 'Inspetor e localizações' },
        ]}
        active={tab}
        onChange={setTab}
      >
        {tab === 'inspections' && <InspectionList scope="open" />}
        {tab === 'history' && <InspectionList scope="all" />}
        {tab === 'packaging' && <PackagingList />}
        {tab === 'templates' && <Templates />}
        {tab === 'settings' && <Settings />}
      </Tabs>
    </>
  );
}

function InspectionList({ scope }: { scope: 'open' | 'all' }) {
  const q = useInspections({ scope });
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{q.error.message}</Alert>;
  if (!q.data.length)
    return (
      <Card>
        <EmptyState
          icon={<BadgeCheck className="size-6" />}
          title={scope === 'open' ? 'Nenhuma inspeção aberta' : 'Nenhuma inspeção registrada'}
          description="A inspeção nasce sozinha quando a produção obrigatória da peça termina."
        />
      </Card>
    );
  return (
    <Card className="overflow-hidden">
      <ul className="divide-y divide-line" data-testid={`inspections-${scope}`}>
        {q.data.map((i) => (
          <InspectionRow key={i.id} i={i} />
        ))}
      </ul>
    </Card>
  );
}

function InspectionRow({ i }: { i: InspectionDto }) {
  return (
    <li
      className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3.5 text-sm"
      data-testid={`inspection-row-${i.code}`}
    >
      <span className="w-24 font-mono font-semibold">{i.code}</span>
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          {i.piece.code} · {i.piece.description} · {i.piece.customer}
        </p>
        <p className="text-ink-muted">
          {INSPECTION_REASON_LABEL[i.reason]} · rodada {i.round} ·{' '}
          {i.inspector
            ? `Inspetor: ${i.inspector.displayName}`
            : (i.substituteReason ?? 'Sem inspetor')}
          {i.inspectorExecuted && i.executorAuthorized ? ' (executor autorizado)' : ''} · Prioridade{' '}
          {PRIORITY_LABEL[i.priority].toLowerCase()}
        </p>
      </div>
      {!i.inspector && (i.status === 'PENDENTE' || i.status === 'EM_ANDAMENTO') && (
        <Badge tone="danger">Precisa de inspetor</Badge>
      )}
      <InspectionBadge status={i.status} />
      <Link
        href={`/painel/qualidade/inspecoes/${i.id}`}
        className="font-semibold text-brand-700 hover:underline"
      >
        Abrir
      </Link>
    </li>
  );
}

function PackagingList() {
  const q = usePackaging('all');
  const [assign, setAssign] = useState<PackagingDto | null>(null);
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{q.error.message}</Alert>;
  if (!q.data.length)
    return (
      <Card>
        <EmptyState
          title="Nenhuma embalagem"
          description="A embalagem é liberada pela aprovação da qualidade."
        />
      </Card>
    );
  return (
    <Card className="overflow-hidden">
      <ul className="divide-y divide-line" data-testid="packaging-list">
        {q.data.map((p) => (
          <li
            key={p.id}
            className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3.5 text-sm"
            data-testid={`packaging-${p.code}`}
          >
            <span className="w-24 font-mono font-semibold">{p.code}</span>
            <div className="min-w-0 flex-1">
              <p className="font-medium">
                {p.piece.code} · {p.piece.description} · {p.piece.customer}
              </p>
              <p className="text-ink-muted">
                Aprovação {p.inspectionCode} · {p.assignee?.displayName ?? 'Sem responsável'}
                {p.tapeceiroAuthorized ? ' (tapeceiro autorizado)' : ''}
                {p.location ? ` · ${p.location.label}` : ''}
                {p.completedAt ? ` · ${formatDateTime(p.completedAt)}` : ''}
              </p>
            </div>
            <Badge
              tone={p.status === 'CONCLUIDA' ? 'ok' : p.status === 'PENDENTE' ? 'warn' : 'neutral'}
            >
              {PACKAGING_STATUS_LABEL[p.status]}
            </Badge>
            {p.status === 'PENDENTE' && (
              <Button size="sm" variant="secondary" onClick={() => setAssign(p)}>
                Designar
              </Button>
            )}
          </li>
        ))}
      </ul>
      {assign && <AssignPackagingDialog p={assign} onClose={() => setAssign(null)} />}
    </Card>
  );
}

function AssignPackagingDialog({ p, onClose }: { p: PackagingDto; onClose: () => void }) {
  const workers = useWorkers();
  const [userId, setUserId] = useState(p.assignee?.userId ?? '');
  const [authorize, setAuthorize] = useState(false);
  const { m, error } = useSend(onClose);
  const chosen = workers.data?.find((w) => w.userId === userId);
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Quem embala ${p.piece.code}`}
      description="Ordem: João quando disponível, depois Thiago; o tapeceiro responsável só com a sua autorização."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={!userId || (chosen?.isTapeceiro && !authorize)}
            loading={m.isPending}
            onClick={() =>
              m.mutate({
                run: () =>
                  api(`/api/v1/packaging/${p.id}/assign`, {
                    method: 'POST',
                    body: {
                      assigneeUserId: userId,
                      authorizeTapeceiro: authorize,
                      version: p.version,
                    },
                  }),
                ok: 'Responsável pela embalagem definido.',
              })
            }
          >
            Designar
          </Button>
        </>
      }
    >
      {error && (
        <Alert tone="danger" className="mb-3">
          {error}
        </Alert>
      )}
      <Field label="Responsável">
        {(f) => (
          <Select {...f} value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">Escolha</option>
            {workers.data?.map((w) => (
              <option key={w.userId} value={w.userId}>
                {w.displayName}
                {w.isTapeceiro ? ' (tapeceiro)' : ''}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {chosen?.isTapeceiro && (
        <div className="mt-3">
          <Checkbox
            label="Autorizo o tapeceiro a embalar esta peça"
            checked={authorize}
            onChange={(e) => setAuthorize(e.target.checked)}
          />
        </div>
      )}
    </Dialog>
  );
}

// ─────────────────────────── Checklists ───────────────────────────

function Templates() {
  const q = useQualityTemplates();
  const [edit, setEdit] = useState<QualityTemplateDto | 'new' | null>(null);
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{q.error.message}</Alert>;
  return (
    <>
      <div className="mb-3 flex justify-end">
        <Button icon={<Plus className="size-4" />} onClick={() => setEdit('new')}>
          Novo checklist
        </Button>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        {q.data.map((t) => (
          <Section
            key={t.id}
            title={`${t.name}${t.active ? '' : ' (inativo)'}`}
            actions={
              <Button size="sm" variant="secondary" onClick={() => setEdit(t)}>
                Editar
              </Button>
            }
          >
            <p className="mb-2 text-sm text-ink-muted">
              {t.pieceTypes.map((p) => PIECE_TYPE_LABEL[p]).join(', ')}
            </p>
            <ol className="list-decimal space-y-1 pl-5 text-sm">
              {t.items.map((i) => (
                <li key={i.id}>
                  {i.label}
                  {!i.required && <span className="text-ink-muted"> (opcional)</span>}
                  {i.serviceTypes.length > 0 && (
                    <span className="text-ink-muted">
                      {' '}
                      — só em {i.serviceTypes.map((s) => SERVICE_TYPE_LABEL[s]).join(', ')}
                    </span>
                  )}
                </li>
              ))}
            </ol>
          </Section>
        ))}
      </div>
      {edit && <TemplateDialog t={edit === 'new' ? null : edit} onClose={() => setEdit(null)} />}
    </>
  );
}

function TemplateDialog({ t, onClose }: { t: QualityTemplateDto | null; onClose: () => void }) {
  const [name, setName] = useState(t?.name ?? '');
  const [pieceTypes, setPieceTypes] = useState<PieceType[]>(t?.pieceTypes ?? []);
  const [active, setActive] = useState(t?.active ?? true);
  const [items, setItems] = useState(
    t?.items.map((i) => ({
      label: i.label,
      guidance: i.guidance ?? '',
      required: i.required,
      serviceTypes: i.serviceTypes,
    })) ?? [{ label: '', guidance: '', required: true, serviceTypes: [] as ServiceType[] }],
  );
  const { m, error } = useSend(onClose);
  const toggle = <T,>(list: T[], v: T) =>
    list.includes(v) ? list.filter((x) => x !== v) : [...list, v];
  return (
    <Dialog
      open
      size="lg"
      onClose={onClose}
      title={t ? `Checklist: ${t.name}` : 'Novo checklist'}
      description="Inspeções já criadas guardam a própria cópia; a mudança vale para as próximas."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            loading={m.isPending}
            onClick={() =>
              m.mutate({
                run: () =>
                  api(t ? `/api/v1/quality/templates/${t.id}` : '/api/v1/quality/templates', {
                    method: t ? 'PUT' : 'POST',
                    body: {
                      name,
                      pieceTypes,
                      active,
                      items: items
                        .filter((i) => i.label.trim())
                        .map((i) => ({ ...i, guidance: i.guidance || null })),
                      version: t?.version,
                    },
                  }),
                ok: 'Checklist salvo.',
              })
            }
          >
            Salvar
          </Button>
        </>
      }
    >
      {error && (
        <Alert tone="danger" className="mb-3">
          {error}
        </Alert>
      )}
      <div className="grid gap-3">
        <Field label="Nome">
          {(f) => <Input {...f} value={name} onChange={(e) => setName(e.target.value)} />}
        </Field>
        <fieldset>
          <legend className="mb-1 text-sm font-medium">Tipos de peça</legend>
          <div className="flex flex-wrap gap-3">
            {PIECE_TYPES.map((p) => (
              <Checkbox
                key={p}
                label={PIECE_TYPE_LABEL[p]}
                checked={pieceTypes.includes(p)}
                onChange={() => setPieceTypes((x) => toggle(x, p))}
              />
            ))}
          </div>
        </fieldset>
        <Checkbox label="Ativo" checked={active} onChange={(e) => setActive(e.target.checked)} />
        <div className="space-y-3">
          {items.map((i, idx) => (
            <div key={idx} className="rounded-xl border border-line p-3">
              <div className="grid gap-2 sm:grid-cols-2">
                <Input
                  aria-label={`Item ${idx + 1}`}
                  placeholder="Item (ex.: Costuras)"
                  value={i.label}
                  onChange={(e) =>
                    setItems((x) =>
                      x.map((y, j) => (j === idx ? { ...y, label: e.target.value } : y)),
                    )
                  }
                />
                <Input
                  aria-label={`Orientação do item ${idx + 1}`}
                  placeholder="Orientação (opcional)"
                  value={i.guidance}
                  onChange={(e) =>
                    setItems((x) =>
                      x.map((y, j) => (j === idx ? { ...y, guidance: e.target.value } : y)),
                    )
                  }
                />
              </div>
              <div className="mt-2 flex flex-wrap gap-3 text-sm">
                <Checkbox
                  label="Obrigatório"
                  checked={i.required}
                  onChange={(e) =>
                    setItems((x) =>
                      x.map((y, j) => (j === idx ? { ...y, required: e.target.checked } : y)),
                    )
                  }
                />
                <span className="text-ink-muted">Só nos serviços (vazio = todos):</span>
                {SERVICE_TYPES.map((s) => (
                  <Checkbox
                    key={s}
                    label={SERVICE_TYPE_LABEL[s]}
                    checked={i.serviceTypes.includes(s)}
                    onChange={() =>
                      setItems((x) =>
                        x.map((y, j) =>
                          j === idx ? { ...y, serviceTypes: toggle(y.serviceTypes, s) } : y,
                        ),
                      )
                    }
                  />
                ))}
              </div>
            </div>
          ))}
          <Button
            variant="secondary"
            size="sm"
            onClick={() =>
              setItems((x) => [...x, { label: '', guidance: '', required: true, serviceTypes: [] }])
            }
          >
            Adicionar item
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// ─────────────────────────── Configuração ───────────────────────────

function Settings() {
  const settings = useQualitySettings();
  const inspectors = useInspectors();
  const locations = useLocations();
  const [label, setLabel] = useState('');
  const { m, error } = useSend(() => setLabel(''));
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <Section title="Inspetor principal">
        {error && (
          <Alert tone="danger" className="mb-3">
            {error}
          </Alert>
        )}
        <p className="mb-3 text-sm text-ink-muted">
          Vigente: <strong>{settings.data?.effectiveInspector?.displayName ?? 'nenhum'}</strong>.
          Sem definição, vale quem tem a competência de inspeção.
        </p>
        <Field label="Inspetor principal">
          {(f) => (
            <Select
              {...f}
              value={settings.data?.qualityInspectorUserId ?? ''}
              onChange={(e) =>
                m.mutate({
                  run: () =>
                    api('/api/v1/quality/settings', {
                      method: 'PUT',
                      body: { qualityInspectorUserId: e.target.value || null },
                    }),
                  ok: 'Inspetor principal salvo.',
                })
              }
            >
              <option value="">Automático (competência de inspeção)</option>
              {inspectors.data?.map((i) => (
                <option key={i.userId} value={i.userId}>
                  {i.displayName}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </Section>
      <Section title="Localizações internas">
        <ul className="mb-4 divide-y divide-line text-sm" data-testid="locations">
          {locations.data?.map((l) => (
            <li key={l.id} className="flex items-center justify-between py-2">
              <span className={l.active ? '' : 'text-ink-muted line-through'}>{l.label}</span>
              <span className="flex items-center gap-3">
                <span className="text-ink-muted">{l.pieces} peça(s)</span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() =>
                    m.mutate({
                      run: () =>
                        api(`/api/v1/locations/${l.id}`, {
                          method: 'PUT',
                          body: { label: l.label, position: l.position, active: !l.active },
                        }),
                    })
                  }
                >
                  {l.active ? 'Desativar' : 'Reativar'}
                </Button>
              </span>
            </li>
          ))}
        </ul>
        <div className="flex gap-2">
          <Input
            aria-label="Nova localização"
            placeholder="Nova localização"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
          />
          <Button
            disabled={label.trim().length < 2}
            loading={m.isPending}
            onClick={() =>
              m.mutate({
                run: () =>
                  api('/api/v1/locations', {
                    method: 'POST',
                    body: { label: label.trim(), position: (locations.data?.length ?? 0) + 1 },
                  }),
                ok: 'Localização criada.',
              })
            }
          >
            Adicionar
          </Button>
        </div>
        <p className="mt-3 text-xs text-ink-muted">
          Etiqueta/QR da peça: o texto CENARIO:PECA:OS-00000/n pode ser impresso em qualquer
          gerador; a leitura encontra a peça (sem exigir leitor dedicado).
        </p>
      </Section>
    </div>
  );
}

// ─────────────────────────── Detalhe da inspeção (gestor) ───────────────────────────

export function InspectionAdminPage({ id }: { id: string }) {
  const q = useInspection(id);
  const [assign, setAssign] = useState(false);
  if (q.isPending) return <Spinner />;
  if (q.isError) return <Alert tone="danger">{q.error.message}</Alert>;
  const i = q.data;
  const open = i.status === 'PENDENTE' || i.status === 'EM_ANDAMENTO';
  return (
    <>
      <BackLink href="/painel/qualidade" label="Qualidade" />
      <PageHeader
        title={`Inspeção ${i.code}`}
        description={`${i.piece.code} · ${i.piece.description} · ${i.piece.customer} · ${FULFILLMENT_STAGE_LABEL[i.piece.stage]}`}
        actions={
          open ? (
            <Button variant="secondary" onClick={() => setAssign(true)}>
              Designar inspetor
            </Button>
          ) : undefined
        }
      />
      <div
        className="mb-4 flex flex-wrap items-center gap-3 text-sm"
        data-testid="inspection-header"
      >
        <InspectionBadge status={i.status} />
        <span>
          Inspetor: <strong>{i.inspector?.displayName ?? 'nenhum'}</strong>
          {i.substituteReason ? ` — ${i.substituteReason}` : ''}
        </span>
        {i.inspectorExecuted && (
          <Badge tone={i.executorAuthorized ? 'warn' : 'danger'}>
            Inspetor executou o serviço{i.executorAuthorized ? ' (autorizado)' : ''}
          </Badge>
        )}
        {i.osRevision !== null && (
          <span className="text-ink-muted">
            Revisão da OS {i.osRevision} · versão técnica {i.itemVersion}
          </span>
        )}
        {i.invalidReason && <span className="text-danger-600">{i.invalidReason}</span>}
      </div>
      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <Card className="p-5">
          <InspectionDetail id={i.id} onDone={() => undefined} />
        </Card>
        <Section title="Fotos">
          <PhotoGallery entityType="QUALITY_INSPECTION" entityId={i.id} canManage />
        </Section>
      </div>
      {assign && <AssignInspectorDialog i={i} onClose={() => setAssign(false)} />}
    </>
  );
}

function AssignInspectorDialog({ i, onClose }: { i: InspectionDto; onClose: () => void }) {
  const inspectors = useInspectors();
  const [userId, setUserId] = useState('');
  const [reason, setReason] = useState('');
  const [authorize, setAuthorize] = useState(false);
  const [key] = useState(newIdempotencyKey);
  const { m, error } = useSend(onClose);
  return (
    <Dialog
      open
      onClose={onClose}
      title="Designar inspetor"
      description="Substituto autorizado (permissão de inspecionar). Quem executou o serviço só com autorização explícita e justificativa."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={!userId}
            loading={m.isPending}
            onClick={() =>
              m.mutate({
                run: () =>
                  api(`/api/v1/quality/inspections/${i.id}/assign`, {
                    method: 'POST',
                    body: {
                      inspectorUserId: userId,
                      reason: reason.trim() || null,
                      authorizeExecutor: authorize,
                      version: i.version,
                    },
                    idempotencyKey: key,
                  }),
                ok: 'Inspetor designado.',
              })
            }
          >
            Designar
          </Button>
        </>
      }
    >
      {error && (
        <Alert tone="danger" className="mb-3">
          {error}
        </Alert>
      )}
      <div className="grid gap-3">
        <Field label="Inspetor">
          {(f) => (
            <Select {...f} value={userId} onChange={(e) => setUserId(e.target.value)}>
              <option value="">Escolha</option>
              {inspectors.data?.map((x) => (
                <option key={x.userId} value={x.userId}>
                  {x.displayName}
                  {x.isMain ? ' (principal)' : ''}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Motivo">
          {(f) => <Textarea {...f} value={reason} onChange={(e) => setReason(e.target.value)} />}
        </Field>
        <Checkbox
          label="Autorizo quem executou o serviço a inspecionar (exige motivo)"
          checked={authorize}
          onChange={(e) => setAuthorize(e.target.checked)}
        />
      </div>
    </Dialog>
  );
}
