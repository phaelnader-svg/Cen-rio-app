import type { Permission } from './permissions';

export type SessionKind = 'WEB' | 'DEVICE';

export interface MeDto {
  user: {
    id: string;
    email: string | null;
    displayName: string;
  };
  employee: EmployeeSummaryDto | null;
  session: {
    id: string;
    kind: SessionKind;
    expiresAt: string;
    deviceId: string | null;
  };
  device: { id: string; name: string } | null;
  permissions: Permission[];
  company: {
    tradeName: string;
    timezone: string;
    workdayStart: string;
    arrivalAlertAt: string;
    workdayEnd: string;
  };
}

export interface EmployeeSummaryDto {
  id: string;
  displayName: string;
  fullName: string;
  jobTitle: string;
  color: string;
  photoUrl: string | null;
}

export interface EmployeeDto extends EmployeeSummaryDto {
  responsibilities: string | null;
  phone: string | null;
  active: boolean;
  version: number;
  roles: { id: string; name: string }[];
  extraPermissions: Permission[];
  hasPin: boolean;
  adminEmail: string | null;
  userId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RoleDto {
  id: string;
  key: string | null;
  name: string;
  description: string | null;
  system: boolean;
  locked: boolean;
  permissions: Permission[];
  memberCount: number;
  version: number;
}

export type DeviceStatus = 'PENDING_PAIRING' | 'ACTIVE' | 'REVOKED';

export interface DeviceDto {
  id: string;
  name: string;
  kind: 'TABLET' | 'COMPUTADOR' | 'CELULAR';
  location: string | null;
  status: DeviceStatus;
  assignedEmployee: EmployeeSummaryDto | null;
  restrictToAssigned: boolean;
  pairedAt: string | null;
  lastSeenAt: string | null;
  online: boolean;
  userAgent: string | null;
  pairingCodeExpiresAt: string | null;
  activeSessions: number;
  version: number;
  createdAt: string;
}

export interface SessionDto {
  id: string;
  kind: SessionKind;
  user: { id: string; displayName: string };
  device: { id: string; name: string } | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  ipAddress: string | null;
  userAgent: string | null;
  current: boolean;
}

export interface CompanySettingsDto {
  tradeName: string;
  legalName: string | null;
  document: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  timezone: string;
  workdayStart: string;
  arrivalAlertAt: string;
  workdayEnd: string;
  workingDays: number[];
  planningWeekday: number;
  measurementWeekday: number;
  version: number;
  updatedAt: string;
}

export interface AuditLogDto {
  id: string;
  action: string;
  entityType: string;
  entityId: string | null;
  actor: { id: string; displayName: string } | null;
  summary: string;
  changes: unknown;
  ipAddress: string | null;
  createdAt: string;
}

export interface PairingCodeDto {
  deviceId: string;
  code: string;
  expiresAt: string;
}

export interface TabletLoginOptionDto {
  device: { id: string; name: string };
  employees: EmployeeSummaryDto[];
}
