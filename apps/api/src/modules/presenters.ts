import type { EmployeeDto, EmployeeSummaryDto, MeDto, Permission } from '@cenario/shared';
import { isPermission } from '@cenario/shared';
import type { Employee, PrismaClient, Tx } from '@cenario/db';
import { z } from 'zod';
import type { AuthContext } from '../core/types';
import { Errors } from '../lib/errors';

export const idParams = z.object({ id: z.string().uuid({ message: 'Identificador inválido.' }) });

export function photoUrl(fileId: string | null): string | null {
  return fileId ? `/api/files/${fileId}` : null;
}

export function toEmployeeSummary(e: Employee): EmployeeSummaryDto {
  return {
    id: e.id,
    displayName: e.displayName,
    fullName: e.fullName,
    jobTitle: e.jobTitle,
    color: e.color,
    photoUrl: photoUrl(e.photoFileId),
  };
}

export const employeeInclude = {
  user: {
    select: {
      id: true,
      email: true,
      pinHash: true,
      roles: { select: { role: { select: { id: true, name: true } } } },
      permissions: { select: { permission: true } },
    },
  },
} as const;

type EmployeeWithUser = Employee & {
  user: {
    id: string;
    email: string | null;
    pinHash: string | null;
    roles: { role: { id: string; name: string } }[];
    permissions: { permission: string }[];
  };
};

export function toEmployeeDto(e: EmployeeWithUser): EmployeeDto {
  return {
    ...toEmployeeSummary(e),
    responsibilities: e.responsibilities,
    phone: e.phone,
    active: e.active,
    version: e.version,
    roles: e.user.roles.map((r) => r.role).sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')),
    extraPermissions: e.user.permissions.map((p) => p.permission).filter(isPermission),
    hasPin: Boolean(e.user.pinHash),
    adminEmail: e.user.email,
    userId: e.user.id,
    createdAt: e.createdAt.toISOString(),
    updatedAt: e.updatedAt.toISOString(),
  };
}

/** Payload público de funcionário para eventos (sem dados sensíveis). */
export function employeeEventPayload(e: Employee) {
  return {
    id: e.id,
    displayName: e.displayName,
    jobTitle: e.jobTitle,
    color: e.color,
    active: e.active,
    photoUrl: photoUrl(e.photoFileId),
    version: e.version,
  };
}

export async function buildMe(
  db: PrismaClient | Tx,
  auth: Pick<AuthContext, 'sessionId' | 'kind' | 'userId' | 'deviceId' | 'expiresAt'> & {
    permissions: Iterable<Permission>;
  },
): Promise<MeDto> {
  const [user, device, company] = await Promise.all([
    db.user.findUniqueOrThrow({ where: { id: auth.userId }, include: { employee: true } }),
    auth.deviceId
      ? db.device.findUnique({ where: { id: auth.deviceId }, select: { id: true, name: true } })
      : null,
    db.companySettings.findUnique({ where: { id: 1 } }),
  ]);
  return {
    user: { id: user.id, email: user.email, displayName: user.displayName },
    employee: user.employee ? toEmployeeSummary(user.employee) : null,
    session: {
      id: auth.sessionId,
      kind: auth.kind,
      expiresAt: auth.expiresAt.toISOString(),
      deviceId: auth.deviceId,
    },
    device,
    permissions: [...auth.permissions],
    company: {
      tradeName: company?.tradeName ?? 'Cenário Estofados',
      timezone: company?.timezone ?? 'America/Sao_Paulo',
      workdayStart: company?.workdayStart ?? '08:30',
      arrivalAlertAt: company?.arrivalAlertAt ?? '09:30',
      workdayEnd: company?.workdayEnd ?? '18:00',
    },
  };
}

/**
 * Impede escalonamento de privilégios: ninguém concede permissão que não possui.
 */
export function assertCanGrant(actor: AuthContext, permissions: Iterable<string>): void {
  const missing = [...permissions].filter((p) => !isPermission(p) || !actor.permissions.has(p));
  if (missing.length > 0) {
    throw Errors.forbidden(
      'Você não pode conceder permissões que não possui ou que não existem: ' + missing.join(', '),
    );
  }
}
