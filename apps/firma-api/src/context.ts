import type { PrismaClient } from '@firma/db';
import type { Env } from './env';

export const ROLES = ['DONO', 'ADMIN', 'GESTOR', 'MEMBRO'] as const;
export type Role = (typeof ROLES)[number];
export const ROLE_LABEL: Record<Role, string> = {
  DONO: 'Dono',
  ADMIN: 'Administrador',
  GESTOR: 'Gestor',
  MEMBRO: 'Membro (acompanha)',
};
const RANK: Record<Role, number> = { DONO: 4, ADMIN: 3, GESTOR: 2, MEMBRO: 1 };
export const atLeast = (role: Role, min: Role) => RANK[role] >= RANK[min];

/** Regra de acesso de cada rota (obrigatória). */
export type Access =
  | { public: true }
  /** Pessoa autenticada (sem exigir organização). */
  | { user: true }
  /** Organização aberta na sessão + papel mínimo. */
  | { org: Role };

export interface Ctx {
  env: Env;
  db: PrismaClient;
  hash: (t: string) => string;
  seal: (plain: string) => string;
  unseal: (sealed: string) => string;
}

export interface RequestUser {
  sessionId: string;
  id: string;
  name: string;
  email: string;
}
export interface RequestOrg {
  id: string;
  name: string;
  role: Role;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: RequestUser | null;
    org: RequestOrg | null;
  }
  interface FastifyInstance {
    firma: Ctx;
  }
  interface FastifyContextConfig {
    rule?: Access;
  }
}
