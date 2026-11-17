import type { Permission, SessionKind } from '@cenario/shared';
import type { PrismaClient } from '@cenario/db';
import type { FastifyBaseLogger } from 'fastify';
import type { Env } from '../config/env';
import type { ClientIpConfig } from './client-ip';
import type { RealtimeHub } from './realtime/hub';
import type { FileStorage } from './storage/storage';
import type { EventProcessor } from './events/processor';
import type { TenantStore } from './tenant';

export interface AuthContext {
  sessionId: string;
  /** Empresa do usuário (multi-empresa). */
  companyId: number;
  kind: SessionKind;
  userId: string;
  displayName: string;
  email: string | null;
  employeeId: string | null;
  deviceId: string | null;
  permissions: ReadonlySet<Permission>;
  expiresAt: Date;
  /**
   * Acesso delegado por aplicativo autorizado (OAuth). Permissões já reduzidas aos escopos.
   * `onBehalfOf`: pessoa do aplicativo que acionou (cabeçalho X-App-Actor), só para auditoria.
   */
  app?: {
    grantId: string;
    clientName: string;
    externalLabel: string | null;
    scopes: readonly string[];
    onBehalfOf: string | null;
  };
}

export interface DeviceContext {
  id: string;
  companyId: number;
  name: string;
  assignedEmployeeId: string | null;
  restrictToAssigned: boolean;
}

/** Regra de acesso declarada em toda rota (verificada globalmente; ausência = erro na inicialização). */
export type AccessRule =
  | {
      public: true;
      /**
       * Chamada servidor a servidor sem navegador (ex.: troca de token OAuth). Sem cookie e sem
       * Origin; o handler autentica o cliente (segredo) antes de qualquer efeito.
       */
      serverToServer?: true;
    }
  /** Webhook de provedor externo: sem sessão nem Origin; o handler EXIGE a assinatura/token do provedor. */
  | { webhook: true }
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
  /** Banco da empresa da requisição (Row-Level Security; core/tenant.ts). */
  prisma: PrismaClient;
  /** Banco do sistema: atravessa empresas. Só autenticação, fila de eventos e manutenção. */
  system: PrismaClient;
  hashToken: (token: string) => string;
  hub: RealtimeHub;
  storage: FileStorage;
  processor: EventProcessor;
  cookies: { session: string; device: string };
  /** Proxy confiável e avisos de configuração do IP real (core/client-ip.ts). */
  clientIp: ClientIpConfig;
}

/** Metadados do autor de uma alteração (auditoria e eventos). */
export interface ActorContext {
  userId: string | null;
  sessionId: string | null;
  ip: string | null;
  requestId: string | null;
  /** Aplicativo/organização/pessoa por meio de quem a ação veio (acesso delegado). */
  via?: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext | null;
    device: DeviceContext | null;
    tenant: TenantStore | null;
  }
  interface FastifyInstance {
    ctx: AppContext;
    /** Todas as rotas /api com a regra de acesso declarada (auditoria). */
    routeCatalog: { method: string; url: string; access: AccessRule }[];
  }
  interface FastifyContextConfig {
    access?: AccessRule;
    idempotent?: boolean;
  }
}

export type { FastifyBaseLogger };
