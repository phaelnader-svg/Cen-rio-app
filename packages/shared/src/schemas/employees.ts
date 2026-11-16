import { z } from 'zod';
import { EMAIL_MAX, passwordPolicySchema, pinSchema } from './auth';
import { hexColorSchema, idSchema, optionalText, trimmed, versionSchema } from './common';

export const employeeBase = {
  fullName: trimmed(2, 120, 'Nome completo'),
  displayName: trimmed(2, 40, 'Nome de exibição'),
  jobTitle: trimmed(2, 80, 'Cargo/atuação'),
  responsibilities: optionalText(500),
  phone: z
    .string()
    .trim()
    .max(30)
    .regex(/^[\d\s()+-]*$/, { message: 'Telefone contém caracteres inválidos.' })
    .transform((v) => (v === '' ? null : v))
    .nullable()
    .optional(),
  color: hexColorSchema,
  roleIds: z.array(idSchema).min(1, { message: 'Atribua ao menos uma função.' }).max(10),
  extraPermissions: z.array(z.string().max(80)).max(50).default([]),
};

export const createEmployeeSchema = z
  .object({
    ...employeeBase,
    /** Acesso aos tablets por PIN (opcional no cadastro). */
    pin: pinSchema.optional(),
    /** Acesso ao painel por e-mail e senha (opcional; exige permissão de painel). */
    email: z
      .string()
      .trim()
      .toLowerCase()
      .email({ message: 'E-mail inválido.' })
      .max(EMAIL_MAX)
      .optional(),
    password: passwordPolicySchema.optional(),
  })
  .refine((v) => (v.email ? Boolean(v.password) : !v.password), {
    message: 'Informe e-mail e senha juntos para conceder acesso ao painel.',
    path: ['password'],
  });
export type CreateEmployeeInput = z.input<typeof createEmployeeSchema>;

export const updateEmployeeSchema = z.object({
  ...employeeBase,
  version: versionSchema,
});
export type UpdateEmployeeInput = z.input<typeof updateEmployeeSchema>;

export const setEmployeeStatusSchema = z.object({
  active: z.boolean(),
  version: versionSchema,
});

export const setPinSchema = z.object({ pin: pinSchema });

export const setAdminCredentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email({ message: 'E-mail inválido.' }).max(EMAIL_MAX),
  password: passwordPolicySchema,
});
