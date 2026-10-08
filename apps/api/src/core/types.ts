import type { Permission, SessionKind } from '@cenario/shared';
import type { PrismaClient } from '@cenario/db';
import type { FastifyBaseLogger } from 'fastify';
import type { Env } from '../config/env';
import type { RealtimeHub } from './realtime/hub';
import type { FileStorage } from './storage/storage';
import type { EventProcessor } from './events/processor';

export interface AuthContext {
  sessionId: string;
  kind: SessionKind;
  userId: string;
  displayName: string;
  email: string | null;
  employeeId: string | null;
  deviceId: string | null;
  permissions: ReadonlySet<Permission>;
  expiresAt: Date;
}

export interface DeviceContext {
  id: string;
  name: string;
  assignedEmployeeId: string | null;
  restrictToAssigned: boolean;
}

/** Regra de acesso declarada em toda rota (verificada globalmente; ausência = erro na inicialização). */
export type AccessRule =
  | { public: true }
  | { device: true }
  | {
      session: 'any' | SessionKind;
      /** Todas obrigatórias. */
      permissions?: readonly Permission[];
      /** Basta possuir uma delas (avaliado além de `permissions`). */
      anyPermissions?: readonly Permission[];
      /**
       * Dispensa a permissão de ambiente (painel/produção). Usado apenas em rotas
       * que precisam funcionar para qualquer sessão válida (ex.: /auth/me, logout).
       */
      surfaceExempt?: boolean;
    };

export interface AppContext {
  env: Env;
  prisma: PrismaClient;
  hashToken: (token: string) => string;
  hub: RealtimeHub;
  storage: FileStorage;
  processor: EventProcessor;
  cookies: { session: string; device: string };
}

/** Metadados do autor de uma alteração (auditoria e eventos). */
export interface ActorContext {
  userId: string | null;
  sessionId: string | null;
  ip: string | null;
  requestId: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
    device: DeviceContext | null;
  }
  interface FastifyInstance {
    ctx: AppContext;
  }
  interface FastifyContextConfig {
    access?: AccessRule;
    idempotent?: boolean;
  }
}

export type { FastifyBaseLogger };
