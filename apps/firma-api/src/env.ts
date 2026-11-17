import { z } from 'zod';

const bool = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1');
const url = z
  .string()
  .url()
  .transform((v) => v.replace(/\/$/, ''));

/**
 * Configuração do Firma Viva por ambiente. Endereço do jogo, da API do Cenário Gestão (servidor)
 * e da tela oficial do Cenário (navegador) e a URL de retorno da conexão mudam por ambiente.
 */
const schema = z
  .object({
    FIRMA_APP_ENV: z.enum(['development', 'test', 'preview', 'production']).default('development'),
    FIRMA_DATABASE_URL: z.string().startsWith('postgresql://'),
    FIRMA_API_HOST: z.string().default('0.0.0.0'),
    FIRMA_API_PORT: z.coerce.number().int().default(4100),
    /** Endereço público do jogo (ex.: https://firmaviva.com.br). */
    FIRMA_WEB_URL: url.default('http://localhost:3100'),
    /** Outros endereços do jogo aceitos ao mesmo tempo (ex.: o provisório enquanto o domínio vira). */
    FIRMA_EXTRA_ORIGINS: z
      .string()
      .default('')
      .transform((v) =>
        v
          .split(',')
          .map((o) => o.trim().replace(/\/$/, ''))
          .filter(Boolean),
      ),
    FIRMA_TOKEN_HASH_SECRET: z.string().min(32),
    /** Chave AES-256 (base64, 32 bytes) para selar os tokens da conexão. */
    FIRMA_SEAL_KEY: z.string().min(40),
    FIRMA_COOKIE_SECURE: bool.default(false),
    FIRMA_SESSION_DAYS: z.coerce.number().int().min(1).max(90).default(30),
    /** API do Cenário Gestão vista pelo servidor do Firma Viva. */
    CENARIO_API_URL: url.default('http://localhost:4000'),
    /** Tela oficial do Cenário Gestão vista pelo navegador (login + autorização). */
    CENARIO_WEB_URL: url.default('http://localhost:3000'),
    FIRMA_CENARIO_CLIENT_ID: z.string().default('firma-viva'),
    /**
     * Só para testar contra a HOMOLOGAÇÃO do Cenário: cookie do portão do proxy (cenario_homolog=…)
     * enviado nas chamadas servidor a servidor. Vazio em produção.
     */
    FIRMA_CENARIO_COOKIE: z.string().default(''),
    /**
     * Permissões pedidas ao Cenário. "consulta" = somente leitura (mapa da oficina e OS, sem
     * alterar nada); "jogo operacao escritorio" = integração completa do jogo.
     */
    FIRMA_CENARIO_SCOPES: z
      .string()
      .default('jogo operacao escritorio')
      .transform((v) => v.split(/[\s,]+/).filter(Boolean)),
    FIRMA_CENARIO_CLIENT_SECRET: z.string().min(32),
    /** Retorno da autorização (cadastrado no Cenário). Padrão: <FIRMA_WEB_URL>/api/conexoes/cenario/retorno. */
    FIRMA_CENARIO_REDIRECT_URI: z.string().url().optional(),
    /** E-mail pelo Resend (convites e recuperação de senha). Vazio = só a caixa de saída. */
    RESEND_API_KEY: z.string().default(''),
    FIRMA_EMAIL_FROM: z.string().default('Firma Viva <nao-responda@cenariogestao.com.br>'),
    FIRMA_LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'silent']).default('info'),
  })
  .superRefine((e, ctx) => {
    if (e.FIRMA_APP_ENV === 'production' || e.FIRMA_APP_ENV === 'preview') {
      if (!e.FIRMA_COOKIE_SECURE)
        ctx.addIssue({
          code: 'custom',
          path: ['FIRMA_COOKIE_SECURE'],
          message: 'Use true com HTTPS.',
        });
      if (!e.FIRMA_WEB_URL.startsWith('https://'))
        ctx.addIssue({ code: 'custom', path: ['FIRMA_WEB_URL'], message: 'Use HTTPS.' });
    }
    if (e.FIRMA_APP_ENV === 'production' && e.FIRMA_CENARIO_COOKIE)
      ctx.addIssue({
        code: 'custom',
        path: ['FIRMA_CENARIO_COOKIE'],
        message: 'Só para homologação.',
      });
    if (Buffer.from(e.FIRMA_SEAL_KEY, 'base64').length !== 32)
      ctx.addIssue({ code: 'custom', path: ['FIRMA_SEAL_KEY'], message: '32 bytes em base64.' });
  })
  .transform((e) => ({
    ...e,
    FIRMA_CENARIO_REDIRECT_URI:
      e.FIRMA_CENARIO_REDIRECT_URI ?? `${e.FIRMA_WEB_URL}/api/conexoes/cenario/retorno`,
  }));

export type Env = z.infer<typeof schema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    throw new Error(
      `Configuração do Firma Viva inválida:\n${parsed.error.issues
        .map((i) => `  - ${i.path.join('.')}: ${i.message}`)
        .join('\n')}`,
    );
  }
  return parsed.data;
}
