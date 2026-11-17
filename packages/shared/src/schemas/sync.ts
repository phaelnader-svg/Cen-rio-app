import { z } from 'zod';

export const syncSignalSchema = z.object({
  message: z.string().trim().min(1).max(140),
});
export type SyncSignalInput = z.infer<typeof syncSignalSchema>;

export const eventsSinceSchema = z.object({
  since: z
    .string()
    .regex(/^\d{1,19}$/)
    .default('0'),
  limit: z.coerce.number().int().min(1).max(500).default(200),
  /** Segundos que a consulta pode esperar por evento novo quando não há nada (consulta longa). */
  wait: z.coerce.number().int().min(0).max(25).default(0),
});
