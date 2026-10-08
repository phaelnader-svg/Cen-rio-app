import { z } from 'zod';
import { optionalText, trimmed, versionSchema } from './common';

export const roleBase = {
  name: trimmed(2, 60, 'Nome da função'),
  description: optionalText(300),
  permissions: z.array(z.string().max(80)).max(100),
};

export const createRoleSchema = z.object(roleBase);
export type CreateRoleInput = z.input<typeof createRoleSchema>;

export const updateRoleSchema = z.object({ ...roleBase, version: versionSchema });
export type UpdateRoleInput = z.input<typeof updateRoleSchema>;
