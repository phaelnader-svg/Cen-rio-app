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
    /**
     * Limites de requisições por minuto (core/rate-limit.ts). Teto por IP real (todas as
     * requisições; comporta a oficina atrás de um IP público), teto global com IP desconhecido,
     * por sessão/dispositivo validado e sem credencial válida (por IP / global).
     */
    RATE_LIMIT_IP_PER_MIN: z.coerce.number().int().min(1).default(3000),
    RATE_LIMIT_UNKNOWN_IP_PER_MIN: z.coerce.number().int().min(1).default(10_000),
    RATE_LIMIT_SESSION_PER_MIN: z.coerce.number().int().min(1).default(600),
    RATE_LIMIT_ANON_PER_MIN: z.coerce.number().int().min(1).default(120),
    RATE_LIMIT_UNKNOWN_ANON_PER_MIN: z.coerce.number().int().min(1).default(1200),
    COOKIE_SECURE: bool.default(false),
    /**
     * Endereço do jogo Firma Viva (aplicativo conectado). Usado para voltar ao jogo depois de
     * conectar um canal (Meta) e nos links "abrir no jogo". Vazio = links relativos.
     */
    GAME_WEB_URL: z
      .string()
      .default('')
      .transform((v) => v.replace(/\/$/, '')),
    /**
     * Endereço público do painel, usado nos links dos e-mails (confirmar e-mail, nova senha).
     * Vazio = a primeira origem de ALLOWED_ORIGINS.
     */
    PUBLIC_WEB_URL: z
      .string()
      .default('')
      .transform((v) => v.replace(/\/$/, '')),
    /**
     * Cobrança da assinatura (2026-11-17). Desligada, nenhuma empresa é bloqueada por falta de
     * pagamento (comportamento anterior); a tela de assinatura continua mostrando o plano.
     */
    BILLING_ENABLED: bool.default(false),
    /** Teste grátis das contas novas (decisão do dono: 7 dias). */
    BILLING_TRIAL_DAYS: z.coerce.number().int().min(0).max(90).default(7),
    /** Dias depois do vencimento até bloquear (decisão do dono: 5). */
    BILLING_GRACE_DAYS: z.coerce.number().int().min(0).max(60).default(5),
    /** Asaas da plataforma (a conta da Cenário). Mesma chave das cobranças do escritório. */
    ASAAS_API_KEY: z.string().default(''),
    ASAAS_BASE_URL: z
      .string()
      .default('https://api-sandbox.asaas.com/v3')
      .transform((v) => v.replace(/\/$/, '')),
    /** Token do webhook do Asaas (cabeçalho asaas-access-token). */
    ASAAS_WEBHOOK_TOKEN: z.string().default(''),
    /** E-mail pelo Resend (decisão do dono). Vazio = os e-mails ficam na fila sem enviar. */
    RESEND_API_KEY: z.string().default(''),
    EMAIL_FROM: z.string().default('Cenário Gestão <nao-responda@cenariogestao.com.br>'),
    /** Anti-robô do Criar conta e do "esqueci minha senha" (Cloudflare Turnstile). Vazio = desligado. */
    TURNSTILE_SITE_KEY: z.string().default(''),
    TURNSTILE_SECRET_KEY: z.string().default(''),
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
    /**
     * Fase 8: relógio de teste controlável (E2E de presença em qualquer horário). Só é
     * aceito com APP_ENV=test; não altera o relógio do servidor, apenas o relógio
     * operacional da aplicação, e suas rotas nem são registradas fora de teste.
     */
    ENABLE_TEST_CLOCK: bool.default(false),
  })
  .superRefine((env, ctx) => {
    if (env.BILLING_ENABLED && env.APP_ENV === 'production' && !env.ASAAS_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        path: ['ASAAS_API_KEY'],
        message: 'BILLING_ENABLED exige ASAAS_API_KEY em produção.',
      });
    }
    const strict = env.APP_ENV === 'production' || env.APP_ENV === 'staging';
    if (env.ENABLE_TEST_CLOCK && (env.APP_ENV !== 'test' || env.NODE_ENV === 'production')) {
      ctx.addIssue({
        code: 'custom',
        path: ['ENABLE_TEST_CLOCK'],
        message: 'ENABLE_TEST_CLOCK só é permitido com APP_ENV=test (nunca em produção).',
      });
    }
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
