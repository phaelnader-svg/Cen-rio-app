'use client';

import type { DeviceDto, PairingCodeDto, SessionDto } from '@cenario/shared';
import { DEVICE_KINDS, createDeviceSchema, updateDeviceSchema } from '@cenario/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Ban,
  KeyRound,
  LogOut,
  Monitor,
  Pencil,
  Plus,
  TabletSmartphone,
  Trash2,
} from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Checkbox, Field, Input, Select } from '@/components/ui/field';
import { Alert, Avatar, Badge, Card, EmptyState, PageHeader, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { ApiError, api, errorMessage, newIdempotencyKey } from '@/lib/api';
import { describeUserAgent, formatDateTime, relativeTime } from '@/lib/format';
import { useCan } from '@/lib/hooks';
import { useDevices, useEmployees, useSessions } from '@/lib/queries';

const KIND_LABEL: Record<(typeof DEVICE_KINDS)[number], string> = {
  TABLET: 'Tablet',
  COMPUTADOR: 'Computador',
  CELULAR: 'Celular',
};

function statusBadge(d: DeviceDto) {
  if (d.status === 'REVOKED') return <Badge tone="danger">Revogado</Badge>;
  if (d.status === 'PENDING_PAIRING') return <Badge tone="warn">Aguardando vinculação</Badge>;
  return d.online ? (
    <Badge tone="ok" dot>
      Conectado
    </Badge>
  ) : (
    <Badge tone="neutral" dot>
      Desconectado
    </Badge>
  );
}

export function DevicesPage() {
  const can = useCan();
  const devices = useDevices(can('dispositivos.ver'));
  const manage = can('dispositivos.gerenciar');
  const [dialog, setDialog] = useState<
    | { kind: 'create' }
    | { kind: 'edit'; device: DeviceDto }
    | { kind: 'code'; pairing: PairingCodeDto; deviceName: string }
    | { kind: 'revoke'; device: DeviceDto }
    | { kind: 'delete'; device: DeviceDto }
    | null
  >(null);
  const close = () => setDialog(null);

  return (
    <>
      <PageHeader
        title="Dispositivos e sessões"
        description="Tablets da oficina com sessão permanente. Revogue a qualquer momento: o acesso é encerrado na hora."
        actions={
          manage && (
            <Button
              icon={<Plus className="size-4" aria-hidden />}
              onClick={() => setDialog({ kind: 'create' })}
            >
              Cadastrar dispositivo
            </Button>
          )
        }
      />

      {can('dispositivos.ver') && (
        <section aria-labelledby="dispositivos-titulo">
          <h2 id="dispositivos-titulo" className="sr-only">
            Dispositivos
          </h2>
          {devices.isPending ? (
            <Spinner />
          ) : devices.isError ? (
            <Alert tone="danger">{devices.error.message}</Alert>
          ) : devices.data.length === 0 ? (
            <Card>
              <EmptyState
                icon={<TabletSmartphone className="size-6" aria-hidden />}
                title="Nenhum dispositivo cadastrado"
                description="Cadastre cada tablet da oficina e vincule-o com o código gerado."
              />
            </Card>
          ) : (
            <ul className="grid gap-4 md:grid-cols-2">
              {devices.data.map((d) => (
                <li key={d.id}>
                  <Card className="p-5" data-testid={`device-${d.name}`}>
                    <div className="flex items-start gap-3">
                      <span className="rounded-xl bg-subtle p-2.5 text-ink-soft">
                        {d.kind === 'COMPUTADOR' ? (
                          <Monitor className="size-5" aria-hidden />
                        ) : (
                          <TabletSmartphone className="size-5" aria-hidden />
                        )}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <p className="text-lg font-semibold">{d.name}</p>
                          {statusBadge(d)}
                        </div>
                        <p className="text-sm text-ink-muted">
                          {KIND_LABEL[d.kind]}
                          {d.location ? ` · ${d.location}` : ''}
                        </p>
                      </div>
                    </div>
                    <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                      <div className="col-span-2 flex items-center gap-2">
                        <dt className="sr-only">Funcionário</dt>
                        <dd className="flex items-center gap-2">
                          {d.assignedEmployee ? (
                            <>
                              <Avatar
                                name={d.assignedEmployee.displayName}
                                color={d.assignedEmployee.color}
                                photoUrl={d.assignedEmployee.photoUrl}
                                size={24}
                              />
                              <span className="font-medium">{d.assignedEmployee.displayName}</span>
                              <span className="text-ink-muted">
                                {d.restrictToAssigned ? '· uso exclusivo' : '· uso compartilhado'}
                              </span>
                            </>
                          ) : (
                            <span className="text-ink-muted">
                              Sem funcionário atribuído (compartilhado)
                            </span>
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt className="text-ink-muted">Último contato</dt>
                        <dd title={formatDateTime(d.lastSeenAt)}>{relativeTime(d.lastSeenAt)}</dd>
                      </div>
                      <div>
                        <dt className="text-ink-muted">Sessões ativas</dt>
                        <dd>{d.activeSessions}</dd>
                      </div>
                      {d.pairingCodeExpiresAt && (
                        <div className="col-span-2">
                          <dt className="text-ink-muted">Código de vinculação válido até</dt>
                          <dd>{formatDateTime(d.pairingCodeExpiresAt)}</dd>
                        </div>
                      )}
                      {d.userAgent && (
                        <div className="col-span-2">
                          <dt className="text-ink-muted">Navegador</dt>
                          <dd>{describeUserAgent(d.userAgent)}</dd>
                        </div>
                      )}
                    </dl>
                    {manage && (
                      <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
                        <Button
                          size="sm"
                          variant="secondary"
                          icon={<Pencil className="size-3.5" aria-hidden />}
                          onClick={() => setDialog({ kind: 'edit', device: d })}
                        >
                          Editar
                        </Button>
                        <NewCodeButton
                          device={d}
                          onCode={(pairing) =>
                            setDialog({ kind: 'code', pairing, deviceName: d.name })
                          }
                        />
                        {d.status !== 'REVOKED' && (
                          <Button
                            size="sm"
                            variant="outline-danger"
                            icon={<Ban className="size-3.5" aria-hidden />}
                            onClick={() => setDialog({ kind: 'revoke', device: d })}
                          >
                            Revogar
                          </Button>
                        )}
                        {d.status !== 'ACTIVE' && (
                          <Button
                            size="sm"
                            variant="ghost"
                            icon={<Trash2 className="size-3.5" aria-hidden />}
                            onClick={() => setDialog({ kind: 'delete', device: d })}
                          >
                            Excluir
                          </Button>
                        )}
                      </div>
                    )}
                  </Card>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {can('sessoes.ver') && <SessionsSection />}

      {dialog?.kind === 'create' && (
        <DeviceDialog
          onClose={close}
          onCreated={(pairing, name) => setDialog({ kind: 'code', pairing, deviceName: name })}
        />
      )}
      {dialog?.kind === 'edit' && <DeviceDialog device={dialog.device} onClose={close} />}
      {dialog?.kind === 'code' && (
        <PairingCodeDialog
          pairing={dialog.pairing}
          deviceName={dialog.deviceName}
          onClose={close}
        />
      )}
      {dialog?.kind === 'revoke' && (
        <ConfirmDialog
          title={`Revogar "${dialog.device.name}"?`}
          body="O tablet perde a credencial imediatamente e todas as sessões nele são encerradas. Para voltar a usá-lo, gere um novo código de vinculação."
          confirm="Revogar dispositivo"
          success="Dispositivo revogado."
          action={() => api(`/api/devices/${dialog.device.id}/revoke`, { method: 'POST' })}
          onClose={close}
        />
      )}
      {dialog?.kind === 'delete' && (
        <ConfirmDialog
          title={`Excluir "${dialog.device.name}"?`}
          body="O cadastro do dispositivo é removido. A auditoria continua registrando o histórico."
          confirm="Excluir"
          success="Dispositivo excluído."
          action={() => api(`/api/devices/${dialog.device.id}`, { method: 'DELETE' })}
          onClose={close}
        />
      )}
    </>
  );
}

function NewCodeButton({
  device,
  onCode,
}: {
  device: DeviceDto;
  onCode: (p: PairingCodeDto) => void;
}) {
  const toast = useToast();
  const qc = useQueryClient();
  const idem = useRef(newIdempotencyKey());
  const m = useMutation({
    mutationFn: () =>
      api<PairingCodeDto>(`/api/devices/${device.id}/pairing-code`, {
        method: 'POST',
        idempotencyKey: idem.current,
      }),
    onSuccess: (p) => {
      idem.current = newIdempotencyKey();
      void qc.invalidateQueries({ queryKey: ['devices'] });
      onCode(p);
    },
    onError: (e) => toast('danger', errorMessage(e)),
  });
  return (
    <Button
      size="sm"
      variant="secondary"
      loading={m.isPending}
      icon={<KeyRound className="size-3.5" aria-hidden />}
      onClick={() => m.mutate()}
    >
      {device.status === 'ACTIVE' ? 'Revincular' : 'Gerar código'}
    </Button>
  );
}

function DeviceDialog({
  device,
  onClose,
  onCreated,
}: {
  device?: DeviceDto;
  onClose: () => void;
  onCreated?: (p: PairingCodeDto, name: string) => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const employees = useEmployees();
  const [name, setName] = useState(device?.name ?? '');
  const [kind, setKind] = useState<(typeof DEVICE_KINDS)[number]>(device?.kind ?? 'TABLET');
  const [location, setLocation] = useState(device?.location ?? '');
  const [assigned, setAssigned] = useState(device?.assignedEmployee?.id ?? '');
  const [restrict, setRestrict] = useState(device?.restrictToAssigned ?? true);
  const [error, setError] = useState<string | null>(null);
  const idem = useRef(newIdempotencyKey());

  const m = useMutation({
    mutationFn: async () => {
      if (device) {
        const body = updateDeviceSchema.parse({
          name,
          location,
          assignedEmployeeId: assigned || null,
          restrictToAssigned: restrict,
          version: device.version,
        });
        await api(`/api/devices/${device.id}`, { method: 'PUT', body });
        return null;
      }
      const body = createDeviceSchema.parse({
        name,
        kind,
        location,
        assignedEmployeeId: assigned || null,
        restrictToAssigned: restrict,
      });
      return api<{ device: DeviceDto; pairing: PairingCodeDto }>('/api/devices', {
        method: 'POST',
        body,
        idempotencyKey: idem.current,
      });
    },
    onSuccess: (res) => {
      void qc.invalidateQueries({ queryKey: ['devices'] });
      if (res && onCreated) onCreated(res.pairing, res.device.name);
      else {
        toast('ok', 'Dispositivo atualizado.');
        onClose();
      }
    },
    onError: (e) => {
      if (e instanceof ApiError && e.code === 'VERSION_CONFLICT')
        void qc.invalidateQueries({ queryKey: ['devices'] });
      setError(
        e instanceof ApiError
          ? e.message
          : ((e as { issues?: { message: string }[] }).issues?.[0]?.message ?? errorMessage(e)),
      );
    },
  });

  return (
    <Dialog
      open
      onClose={onClose}
      title={device ? `Editar ${device.name}` : 'Cadastrar dispositivo'}
      description={
        device
          ? undefined
          : 'Após o cadastro, um código de uso único será exibido para vincular o tablet.'
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button loading={m.isPending} onClick={() => m.mutate()}>
            {device ? 'Salvar' : 'Cadastrar e gerar código'}
          </Button>
        </>
      }
    >
      <div className="grid gap-4 sm:grid-cols-2">
        {error && (
          <Alert tone="danger" className="sm:col-span-2">
            {error}
          </Alert>
        )}
        <Field label="Nome" required hint='Ex.: "Tablet Ricardo"'>
          {(p) => <Input {...p} value={name} onChange={(e) => setName(e.target.value)} autoFocus />}
        </Field>
        {!device && (
          <Field label="Tipo">
            {(p) => (
              <Select {...p} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
                {DEVICE_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {KIND_LABEL[k]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
        <Field label="Local" hint="Ex.: bancada de corte">
          {(p) => <Input {...p} value={location} onChange={(e) => setLocation(e.target.value)} />}
        </Field>
        <Field label="Funcionário do tablet">
          {(p) => (
            <Select {...p} value={assigned} onChange={(e) => setAssigned(e.target.value)}>
              <option value="">Nenhum (compartilhado)</option>
              {employees.data
                ?.filter((e) => e.active)
                .map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.displayName}
                  </option>
                ))}
            </Select>
          )}
        </Field>
        <Checkbox
          className="sm:col-span-2"
          label="Uso exclusivo do funcionário atribuído"
          description="Quando marcado, somente esse funcionário consegue entrar neste tablet."
          checked={restrict}
          disabled={!assigned}
          onChange={(e) => setRestrict(e.target.checked)}
        />
      </div>
    </Dialog>
  );
}

function PairingCodeDialog({
  pairing,
  deviceName,
  onClose,
}: {
  pairing: PairingCodeDto;
  deviceName: string;
  onClose: () => void;
}) {
  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={`Vincular "${deviceName}"`}
      footer={<Button onClick={onClose}>Concluído</Button>}
    >
      <ol className="list-decimal space-y-2 pl-5 text-[15px] text-ink-soft">
        <li>
          No tablet, abra <strong className="text-ink">{origin}/tablet</strong>.
        </li>
        <li>Digite o código abaixo na tela de vinculação.</li>
      </ol>
      <p
        data-testid="pairing-code"
        className="my-6 rounded-2xl bg-subtle py-6 text-center font-mono text-4xl font-semibold tracking-[0.18em] text-ink select-all"
      >
        {pairing.code}
      </p>
      <Alert tone="warn">
        Código de uso único, válido até {formatDateTime(pairing.expiresAt)}. Ele não será exibido
        novamente; se expirar, gere outro.
      </Alert>
    </Dialog>
  );
}

function ConfirmDialog({
  title,
  body,
  confirm,
  success,
  action,
  onClose,
}: {
  title: string;
  body: string;
  confirm: string;
  success: string;
  action: () => Promise<unknown>;
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [error, setError] = useState<string | null>(null);
  const m = useMutation({
    mutationFn: action,
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['devices'] });
      void qc.invalidateQueries({ queryKey: ['sessions'] });
      toast('ok', success);
      onClose();
    },
    onError: (e) => setError(errorMessage(e)),
  });
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={title}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button variant="danger" loading={m.isPending} onClick={() => m.mutate()}>
            {confirm}
          </Button>
        </>
      }
    >
      {error && (
        <Alert tone="danger" className="mb-3">
          {error}
        </Alert>
      )}
      <p className="text-[15px] text-ink-soft">{body}</p>
    </Dialog>
  );
}

function SessionsSection() {
  const can = useCan();
  const sessions = useSessions();
  const [target, setTarget] = useState<SessionDto | null>(null);
  return (
    <section id="sessoes" aria-labelledby="sessoes-titulo" className="mt-10 scroll-mt-20">
      <h2 id="sessoes-titulo" className="mb-1 text-lg font-semibold">
        Sessões ativas
      </h2>
      <p className="mb-4 text-sm text-ink-muted">
        Acessos abertos agora no painel e nos tablets. Encerrar uma sessão desconecta a pessoa
        imediatamente.
      </p>
      <Card className="overflow-hidden">
        {sessions.isPending ? (
          <Spinner className="p-5" />
        ) : sessions.isError ? (
          <Alert tone="danger" className="m-4">
            {sessions.error.message}
          </Alert>
        ) : sessions.data.length === 0 ? (
          <EmptyState title="Nenhuma sessão ativa" />
        ) : (
          <ul className="divide-y divide-line">
            {sessions.data.map((s) => (
              <li
                key={s.id}
                className="flex flex-wrap items-center gap-3 px-5 py-3.5"
                data-testid={`session-${s.user.displayName}-${s.kind}`}
              >
                <div className="min-w-0 flex-1">
                  <p className="font-medium">
                    {s.user.displayName} {s.current && <Badge tone="brand">Esta sessão</Badge>}
                  </p>
                  <p className="text-sm text-ink-muted">
                    {s.kind === 'DEVICE' ? `Tablet · ${s.device?.name ?? ''}` : 'Painel'} ·{' '}
                    {describeUserAgent(s.userAgent)} · ativo {relativeTime(s.lastSeenAt)}
                  </p>
                </div>
                {can('sessoes.revogar') && !s.current && (
                  <Button
                    size="sm"
                    variant="outline-danger"
                    icon={<LogOut className="size-3.5" aria-hidden />}
                    onClick={() => setTarget(s)}
                  >
                    Encerrar
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>
      {target && (
        <ConfirmDialog
          title={`Encerrar a sessão de ${target.user.displayName}?`}
          body={
            target.kind === 'DEVICE'
              ? 'O tablet continua vinculado, mas a pessoa precisará digitar o PIN novamente.'
              : 'A pessoa precisará entrar novamente no painel.'
          }
          confirm="Encerrar sessão"
          success="Sessão encerrada."
          action={() => api(`/api/sessions/${target.id}/revoke`, { method: 'POST' })}
          onClose={() => setTarget(null)}
        />
      )}
    </section>
  );
}
