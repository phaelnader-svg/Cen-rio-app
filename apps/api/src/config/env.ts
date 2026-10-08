import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');

const envSchema = z
  .object({
    APP_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    DATABASE_URL: z.string().url().startsWith('postgresql://'),
    API_HOST: z.string().default('0.0.0.0'),
    API_PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    ALLOWED_ORIGINS: z
      .string()
      .min(1)
      .transform((v) =>
        v
          .split(',')
          .map((o) => o.trim().replace(/\/$/, ''))
          .filter(Boolean),
      )
      .pipe(z.array(z.string().url()).min(1)),
    /**
     * Proxy reverso confiável para ler o IP real (X-Forwarded-For):
     * "false" (padrão), "true" (qualquer — evite), "loopback" ou lista de IPs/CIDR.
     */
    TRUST_PROXY: z
      .string()
      .default('false')
      .transform((v): boolean | string => (v === 'true' ? true : v === 'false' ? false : v)),
    COOKIE_SECURE: bool.default(false),
    TOKEN_HASH_SECRET: z
      .string()
      .min(32, { message: 'TOKEN_HASH_SECRET deve ter ao menos 32 caracteres.' }),
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    SESSION_WEB_IDLE_HOURS: z.coerce.number().int().min(1).max(720).default(12),
    SESSION_WEB_ABSOLUTE_DAYS: z.coerce.number().int().min(1).max(90).default(30),
    SESSION_DEVICE_IDLE_DAYS: z.coerce.number().int().min(1).max(365).default(30),
    STORAGE_DIR: z.string().min(1).default('./storage'),
    MAX_UPLOAD_MB: z.coerce.number().int().min(1).max(50).default(5),
    /** Desativa tarefas em segundo plano (útil em testes). */
    DISABLE_BACKGROUND_JOBS: bool.default(false),
  })
  .superRefine((env, ctx) => {
    const strict = env.APP_ENV === 'production' || env.APP_ENV === 'staging';
    if (strict && !env.COOKIE_SECURE) {
      ctx.addIssue({
        code: 'custom',
        path: ['COOKIE_SECURE'],
        message: 'COOKIE_SECURE deve ser true em homologação e produção (HTTPS obrigatório).',
      });
    }
    if (strict && env.ALLOWED_ORIGINS.some((o) => !o.startsWith('https://'))) {
      ctx.addIssue({
        code: 'custom',
        path: ['ALLOWED_ORIGINS'],
        message: 'Em homologação e produção as origens permitidas devem usar HTTPS.',
      });
    }
    if (strict && env.NODE_ENV !== 'production') {
      ctx.addIssue({
        code: 'custom',
        path: ['NODE_ENV'],
        message: 'NODE_ENV deve ser production em homologação e produção.',
      });
    }
  });

export type Env = z.infer<typeof envSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = envSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `  - ${i.path.join('.') || '(raiz)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Configuração de ambiente inválida:\n${issues}`);
  }
  return parsed.data;
}
