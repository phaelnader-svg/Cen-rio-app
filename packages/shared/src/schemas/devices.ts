import { z } from 'zod';
import { idSchema, optionalText, trimmed, versionSchema } from './common';

export const DEVICE_KINDS = ['TABLET', 'COMPUTADOR', 'CELULAR'] as const;
export type DeviceKind = (typeof DEVICE_KINDS)[number];

/** O que a tela inicial do aparelho mostra (nunca mais do que o cargo da pessoa permite). */
export const DEVICE_SHOWS = ['TUDO', 'PRODUCAO', 'LOGISTICA'] as const;
export type DeviceShows = (typeof DEVICE_SHOWS)[number];

export const createDeviceSchema = z.object({
  name: trimmed(2, 60, 'Nome do dispositivo'),
  kind: z.enum(DEVICE_KINDS).default('TABLET'),
  location: optionalText(80),
  /** Funcionário a quem o tablet pertence (tablet individual). */
  assignedEmployeeId: idSchema.nullable().optional(),
  /** Se verdadeiro, apenas o funcionário atribuído pode entrar neste tablet. */
  restrictToAssigned: z.boolean().default(true),
  shows: z.enum(DEVICE_SHOWS).default('TUDO'),
});
export type CreateDeviceInput = z.input<typeof createDeviceSchema>;

export const updateDeviceSchema = z.object({
  name: trimmed(2, 60, 'Nome do dispositivo'),
  location: optionalText(80),
  assignedEmployeeId: idSchema.nullable(),
  restrictToAssigned: z.boolean(),
  /** Opcional: quem não manda o campo mantém o que já estava. */
  shows: z.enum(DEVICE_SHOWS).optional(),
  version: versionSchema,
});
export type UpdateDeviceInput = z.input<typeof updateDeviceSchema>;
