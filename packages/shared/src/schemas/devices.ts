import { z } from 'zod';
import { idSchema, optionalText, trimmed, versionSchema } from './common';

export const DEVICE_KINDS = ['TABLET', 'COMPUTADOR', 'CELULAR'] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

export const createDeviceSchema = z.object({
  name: trimmed(2, 60, 'Nome do dispositivo'),
  kind: z.enum(DEVICE_KINDS).default('TABLET'),
  location: optionalText(80),
  /** Funcionário a quem o tablet pertence (tablet individual). */
  assignedEmployeeId: idSchema.nullable().optional(),
  /** Se verdadeiro, apenas o funcionário atribuído pode entrar neste tablet. */
  restrictToAssigned: z.boolean().default(true),
});
export type CreateDeviceInput = z.input<typeof createDeviceSchema>;

export const updateDeviceSchema = z.object({
  name: trimmed(2, 60, 'Nome do dispositivo'),
  location: optionalText(80),
  assignedEmployeeId: idSchema.nullable(),
  restrictToAssigned: z.boolean(),
  version: versionSchema,
});
export type UpdateDeviceInput = z.input<typeof updateDeviceSchema>;
