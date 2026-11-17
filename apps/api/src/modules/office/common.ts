import { createHash, randomUUID } from 'node:crypto';
import { EVENT_TYPES, anyPermissionAudience } from '@cenario/shared';
import type { PrismaClient, Tx } from '@cenario/db';
import { appendEvent } from '../../core/events/append';
import type { ActorContext } from '../../core/types';
import type { AppContext } from '../../core/types';

export const OFFICE_VIEW = {
  session: 'WEB',
  permissions: ['jogo.acessar'],
  anyPermissions: ['financeiro.ver', 'pedidos.ver'],
} as const;
export const OFFICE_DOCS = {
  session: 'WEB',
  permissions: ['jogo.acessar', 'pedidos.gerenciar'],
} as const;
export const OFFICE_FIN = {
  session: 'WEB',
  permissions: ['jogo.acessar', 'financeiro.gerenciar'],
} as const;
export const OFFICE_FIN_VIEW = {
  session: 'WEB',
  permissions: ['jogo.acessar', 'financeiro.ver'],
} as const;
export const OFFICE_AUDIENCE = anyPermissionAudience('financeiro.ver', 'pedidos.ver');
/** Ações disparadas pelo retorno do provedor (webhook), sem usuário. */
export const PROVIDER_ACTOR: ActorContext = {
  userId: null,
  sessionId: null,
  ip: null,
  requestId: null,
};

export const brl = (c: number) =>
  (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
export const orderCodeOf = (n: number) => `PED-${String(n).padStart(5, '0')}`;
export const osCodeOf = (n: number) => `OS-${String(n).padStart(5, '0')}`;

export async function officeEvent(
  tx: Tx,
  actor: ActorContext,
  aggregateType: string,
  aggregateId: string,
  payload: Record<string, unknown> = {},
) {
  await appendEvent(tx, actor, {
    type: EVENT_TYPES.OFFICE_CHANGED,
    aggregateType,
    aggregateId,
    payload: { id: aggregateId, ...payload },
    audience: OFFICE_AUDIENCE,
  });
}

/** Guarda um documento do escritório (PDF de contrato, XML/PDF de nota, comprovante). */
export async function storeOfficeFile(
  tx: Tx,
  storage: AppContext['storage'],
  actor: ActorContext,
  input: { name: string; mime: string; data: Buffer },
) {
  const id = randomUUID();
  const key = `office/${id}`;
  await storage.put(key, input.data);
  await tx.storedFile.create({
    data: {
      id,
      storageKey: key,
      purpose: 'office-document',
      originalName: input.name,
      mimeType: input.mime,
      sizeBytes: input.data.length,
      sha256: createHash('sha256').update(input.data).digest('hex'),
      uploadedById: actor.userId,
    },
  });
  return id;
}

export const monthOf = (d: Date) => d.toISOString().slice(0, 7);
export type Db = Tx | PrismaClient;
