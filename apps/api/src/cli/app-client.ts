/**
 * Cadastra (ou atualiza) um aplicativo autorizado a pedir acesso delegado ao Cenário Gestão.
 *
 *   pnpm --filter @cenario/api app-client -- --id firma-viva --name "Firma Viva" \
 *     --redirect https://firmaviva.com.br/api/conexoes/cenario/retorno \
 *     --scopes jogo,operacao,escritorio [--secret-env FIRMA_CENARIO_CLIENT_SECRET]
 *
 * Sem --secret-env, gera um segredo novo e o mostra UMA vez (guarde no cofre do aplicativo).
 * Com --secret-env, usa o valor da variável de ambiente indicada (o valor nunca é impresso).
 * Só o hash do segredo é gravado.
 */
import { APP_SCOPE_KEYS, parseScopes } from '@cenario/shared';
import { createPrismaClient } from '@cenario/db';
import { loadEnv } from '../config/env';
import { createTokenHasher, randomToken } from '../lib/crypto';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const env = loadEnv();
  const id = arg('id');
  const name = arg('name');
  const redirects = (arg('redirect') ?? '')
    .split(',')
    .map((r) => r.trim())
    .filter(Boolean);
  const scopes = parseScopes(arg('scopes') ?? APP_SCOPE_KEYS.join(','));
  if (!id || !name || redirects.length === 0) {
    throw new Error('Informe --id, --name e --redirect (separe vários endereços por vírgula).');
  }
  for (const r of redirects) new URL(r);
  const secretEnv = arg('secret-env');
  const secret = secretEnv ? process.env[secretEnv] : randomToken();
  if (!secret || secret.length < 32)
    throw new Error('Segredo ausente ou curto (mínimo 32 caracteres).');
  const hash = createTokenHasher(env.TOKEN_HASH_SECRET);
  const prisma = createPrismaClient({ url: env.DATABASE_URL });
  await prisma.oAuthClient.upsert({
    where: { clientId: id },
    create: {
      clientId: id,
      name,
      secretHash: hash(secret),
      redirectUris: redirects,
      allowedScopes: scopes,
    },
    update: {
      name,
      secretHash: hash(secret),
      redirectUris: redirects,
      allowedScopes: scopes,
      active: true,
    },
  });
  await prisma.$disconnect();
  process.stdout.write(`Aplicativo "${name}" (${id}) cadastrado. Escopos: ${scopes.join(', ')}.\n`);
  process.stdout.write(`Retorno: ${redirects.join(', ')}\n`);
  if (!secretEnv) process.stdout.write(`Segredo (mostrado só agora): ${secret}\n`);
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
