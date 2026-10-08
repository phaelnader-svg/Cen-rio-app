'use client';

import type { EmployeeDto } from '@cenario/shared';
import { pinSchema, setAdminCredentialsSchema } from '@cenario/shared';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Camera,
  KeyRound,
  MonitorCog,
  Pencil,
  Plus,
  Power,
  Trash2,
  UserPlus,
  Users,
} from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Input } from '@/components/ui/field';
import { Alert, Avatar, Badge, Card, EmptyState, PageHeader, Spinner } from '@/components/ui/misc';
import { useToast } from '@/components/ui/toast';
import { api, errorMessage } from '@/lib/api';
import { useCan, useMe } from '@/lib/hooks';
import { useEmployees } from '@/lib/queries';
import { EmployeeForm } from './employee-form';

type Action =
  | { kind: 'create' }
  | { kind: 'edit'; employee: EmployeeDto }
  | { kind: 'pin'; employee: EmployeeDto }
  | { kind: 'panel'; employee: EmployeeDto }
  | { kind: 'photo'; employee: EmployeeDto }
  | { kind: 'status'; employee: EmployeeDto };

export function EmployeesPage() {
  const can = useCan();
  const me = useMe();
  const employees = useEmployees();
  const [action, setAction] = useState<Action | null>(null);
  const manage = can('funcionarios.gerenciar');
  const close = () => setAction(null);

  return (
    <>
      <PageHeader
        title="Funcionários"
        description="Equipe da oficina e do escritório, com funções, permissões e formas de acesso."
        actions={
          manage && (
            <Button
              icon={<Plus className="size-4" aria-hidden />}
              onClick={() => setAction({ kind: 'create' })}
            >
              Novo funcionário
            </Button>
          )
        }
      />

      {employees.isPending ? (
        <Spinner />
      ) : employees.isError ? (
        <Alert tone="danger">{employees.error.message}</Alert>
      ) : employees.data.length === 0 ? (
        <Card>
          <EmptyState
            icon={<Users className="size-6" aria-hidden />}
            title="Nenhum funcionário cadastrado"
            description="Cadastre a equipe para liberar o acesso aos tablets."
          />
        </Card>
      ) : (
        <ul className="grid gap-4 md:grid-cols-2" aria-label="Lista de funcionários">
          {employees.data.map((e) => (
            <li key={e.id}>
              <Card
                className={e.active ? 'p-5' : 'p-5 opacity-70'}
                data-testid={`employee-${e.displayName}`}
              >
                <div className="flex items-start gap-4">
                  <Avatar name={e.displayName} color={e.color} photoUrl={e.photoUrl} size={52} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-lg font-semibold">{e.displayName}</p>
                      {!e.active && <Badge tone="danger">Inativo</Badge>}
                    </div>
                    <p className="text-sm text-ink-muted">{e.jobTitle}</p>
                    {e.fullName !== e.displayName && (
                      <p className="text-sm text-ink-muted">{e.fullName}</p>
                    )}
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      {e.roles.map((r) => (
                        <Badge key={r.id} tone="brand">
                          {r.name}
                        </Badge>
                      ))}
                      {e.extraPermissions.length > 0 && (
                        <Badge tone="bronze">+{e.extraPermissions.length} permissão(ões)</Badge>
                      )}
                    </div>
                    <div className="mt-3 flex flex-wrap gap-1.5">
                      <Badge tone={e.hasPin ? 'ok' : 'neutral'} dot>
                        {e.hasPin ? 'PIN do tablet definido' : 'Sem PIN'}
                      </Badge>
                      <Badge tone={e.adminEmail ? 'info' : 'neutral'} dot>
                        {e.adminEmail ? `Painel: ${e.adminEmail}` : 'Sem acesso ao painel'}
                      </Badge>
                    </div>
                  </div>
                </div>
                {manage && (
                  <div className="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
                    <Button
                      size="sm"
                      variant="secondary"
                      icon={<Pencil className="size-3.5" aria-hidden />}
                      onClick={() => setAction({ kind: 'edit', employee: e })}
                    >
                      Editar
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      icon={<KeyRound className="size-3.5" aria-hidden />}
                      onClick={() => setAction({ kind: 'pin', employee: e })}
                    >
                      PIN
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      icon={<MonitorCog className="size-3.5" aria-hidden />}
                      onClick={() => setAction({ kind: 'panel', employee: e })}
                    >
                      Painel
                    </Button>
                    <Button
                      size="sm"
                      variant="secondary"
                      icon={<Camera className="size-3.5" aria-hidden />}
                      onClick={() => setAction({ kind: 'photo', employee: e })}
                    >
                      Foto
                    </Button>
                    {e.userId !== me.data?.user.id && (
                      <Button
                        size="sm"
                        variant={e.active ? 'outline-danger' : 'secondary'}
                        icon={<Power className="size-3.5" aria-hidden />}
                        onClick={() => setAction({ kind: 'status', employee: e })}
                      >
                        {e.active ? 'Desativar' : 'Reativar'}
                      </Button>
                    )}
                  </div>
                )}
              </Card>
            </li>
          ))}
        </ul>
      )}

      {action?.kind === 'create' && <EmployeeForm open onClose={close} />}
      {action?.kind === 'edit' && <EmployeeForm open onClose={close} employee={action.employee} />}
      {action?.kind === 'pin' && <PinDialog employee={action.employee} onClose={close} />}
      {action?.kind === 'panel' && <PanelAccessDialog employee={action.employee} onClose={close} />}
      {action?.kind === 'photo' && <PhotoDialog employee={action.employee} onClose={close} />}
      {action?.kind === 'status' && <StatusDialog employee={action.employee} onClose={close} />}
    </>
  );
}

function useEmployeeMutation(onDone: () => void, success: string) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['employees'] });
      toast('ok', success);
      onDone();
    },
  });
}

function PinDialog({ employee, onClose }: { employee: EmployeeDto; onClose: () => void }) {
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const m = useEmployeeMutation(
    onClose,
    'PIN atualizado. Sessões anteriores nos tablets foram encerradas.',
  );
  const remove = useEmployeeMutation(onClose, 'Acesso aos tablets removido.');
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={`PIN de ${employee.displayName}`}
      description="O PIN de 6 dígitos é usado para entrar nos tablets da oficina."
      footer={
        <>
          {employee.hasPin && (
            <Button
              variant="outline-danger"
              className="mr-auto"
              loading={remove.isPending}
              icon={<Trash2 className="size-4" aria-hidden />}
              onClick={() =>
                remove.mutate(
                  () => api(`/api/employees/${employee.id}/pin`, { method: 'DELETE' }),
                  {
                    onError: (e) => setError(errorMessage(e)),
                  },
                )
              }
            >
              Remover
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            loading={m.isPending}
            onClick={() => {
              const parsed = pinSchema.safeParse(pin);
              if (!parsed.success) return setError(parsed.error.issues[0]!.message);
              setError(null);
              m.mutate(
                () => api(`/api/employees/${employee.id}/pin`, { method: 'PUT', body: { pin } }),
                {
                  onError: (e) => setError(errorMessage(e)),
                },
              );
            }}
          >
            Salvar PIN
          </Button>
        </>
      }
    >
      <Field
        label="Novo PIN"
        error={error ?? undefined}
        hint="Evite sequências (123456) e dígitos repetidos."
      >
        {(p) => (
          <Input
            {...p}
            inputMode="numeric"
            autoComplete="off"
            maxLength={6}
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))}
            className="text-center font-mono text-2xl tracking-[0.5em]"
            autoFocus
          />
        )}
      </Field>
    </Dialog>
  );
}

function PanelAccessDialog({ employee, onClose }: { employee: EmployeeDto; onClose: () => void }) {
  const me = useMe();
  const [email, setEmail] = useState(employee.adminEmail ?? '');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const save = useEmployeeMutation(onClose, 'Acesso ao painel atualizado.');
  const remove = useEmployeeMutation(onClose, 'Acesso ao painel removido.');
  const isSelf = me.data?.user.id === employee.userId;
  return (
    <Dialog
      open
      onClose={onClose}
      title={`Acesso ao painel — ${employee.displayName}`}
      description="E-mail e senha para entrar no painel administrativo. A pessoa também precisa de uma função com a permissão de acesso ao painel."
      footer={
        <>
          {employee.adminEmail && !isSelf && (
            <Button
              variant="outline-danger"
              className="mr-auto"
              loading={remove.isPending}
              onClick={() =>
                remove.mutate(
                  () => api(`/api/employees/${employee.id}/admin-access`, { method: 'DELETE' }),
                  { onError: (e) => setError(errorMessage(e)) },
                )
              }
            >
              Remover acesso
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            loading={save.isPending}
            onClick={() => {
              const parsed = setAdminCredentialsSchema.safeParse({ email, password });
              if (!parsed.success) {
                const map: Record<string, string> = {};
                for (const i of parsed.error.issues) map[String(i.path[0])] ??= i.message;
                return setErrors(map);
              }
              setErrors({});
              setError(null);
              save.mutate(
                () =>
                  api(`/api/employees/${employee.id}/admin-access`, {
                    method: 'PUT',
                    body: parsed.data,
                  }),
                { onError: (e) => setError(errorMessage(e)) },
              );
            }}
          >
            Salvar acesso
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="E-mail" error={errors.email}>
          {(p) => (
            <Input
              {...p}
              type="email"
              autoComplete="off"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          )}
        </Field>
        <Field
          label="Nova senha"
          error={errors.password}
          hint="Mínimo de 10 caracteres, com letras e números. Sessões anteriores no painel serão encerradas."
        >
          {(p) => (
            <Input
              {...p}
              type="password"
              autoComplete="new-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
        </Field>
      </div>
    </Dialog>
  );
}

function PhotoDialog({ employee, onClose }: { employee: EmployeeDto; onClose: () => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const upload = useEmployeeMutation(onClose, 'Foto atualizada.');
  const remove = useEmployeeMutation(onClose, 'Foto removida.');
  const preview = file ? URL.createObjectURL(file) : employee.photoUrl;
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={`Foto de ${employee.displayName}`}
      description="Usada para identificação visual no painel e nos tablets. JPEG, PNG ou WebP até 5 MB. Armazenada de forma privada."
      footer={
        <>
          {employee.photoUrl && (
            <Button
              variant="outline-danger"
              className="mr-auto"
              loading={remove.isPending}
              onClick={() =>
                remove.mutate(
                  () => api(`/api/employees/${employee.id}/photo`, { method: 'DELETE' }),
                  {
                    onError: (e) => setError(errorMessage(e)),
                  },
                )
              }
            >
              Remover
            </Button>
          )}
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            disabled={!file}
            loading={upload.isPending}
            onClick={() => {
              if (!file) return;
              const fd = new FormData();
              fd.append('file', file);
              upload.mutate(
                () => api(`/api/employees/${employee.id}/photo`, { method: 'POST', body: fd }),
                {
                  onError: (e) => setError(errorMessage(e)),
                },
              );
            }}
          >
            Enviar foto
          </Button>
        </>
      }
    >
      <div className="flex flex-col items-center gap-4">
        <Avatar name={employee.displayName} color={employee.color} photoUrl={preview} size={112} />
        {error && <Alert tone="danger">{error}</Alert>}
        <label className="w-full">
          <span className="label">Arquivo de imagem</span>
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="block w-full text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-brand-50 file:px-3 file:py-2 file:font-semibold file:text-brand-700"
          />
        </label>
      </div>
    </Dialog>
  );
}

function StatusDialog({ employee, onClose }: { employee: EmployeeDto; onClose: () => void }) {
  const [error, setError] = useState<string | null>(null);
  const m = useEmployeeMutation(
    onClose,
    employee.active ? `${employee.displayName} desativado.` : `${employee.displayName} reativado.`,
  );
  const deactivating = employee.active;
  return (
    <Dialog
      open
      onClose={onClose}
      size="sm"
      title={
        deactivating ? `Desativar ${employee.displayName}?` : `Reativar ${employee.displayName}?`
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancelar
          </Button>
          <Button
            variant={deactivating ? 'danger' : 'primary'}
            loading={m.isPending}
            icon={
              deactivating ? (
                <Power className="size-4" aria-hidden />
              ) : (
                <UserPlus className="size-4" aria-hidden />
              )
            }
            onClick={() =>
              m.mutate(
                () =>
                  api(`/api/employees/${employee.id}/status`, {
                    method: 'POST',
                    body: { active: !employee.active, version: employee.version },
                  }),
                { onError: (e) => setError(errorMessage(e)) },
              )
            }
          >
            {deactivating ? 'Desativar' : 'Reativar'}
          </Button>
        </>
      }
    >
      {error && (
        <Alert tone="danger" className="mb-3">
          {error}
        </Alert>
      )}
      <p className="text-[15px] text-ink-soft">
        {deactivating
          ? 'A pessoa perde o acesso imediatamente: todas as sessões abertas no painel e nos tablets são encerradas. O histórico é preservado.'
          : 'O cadastro volta a ficar disponível. As credenciais existentes voltam a funcionar.'}
      </p>
    </Dialog>
  );
}
