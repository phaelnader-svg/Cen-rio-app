/**
 * Cria uma organização no Firma Viva e o convite do primeiro dono (acesso só por convite).
 *
 *   pnpm --filter @firma/api criar-organizacao -- --organizacao "Cenário Estofados" --email voce@exemplo.com
 *
 * Mostra o link do convite: a pessoa abre, escolhe nome e senha e já entra como DONO.
 * Para automação (demonstração), --senha-env VAR cria a conta direto com a senha da variável
 * (o valor nunca é impresso).
 */
import { createFirmaClient } from '@firma/db';
import { loadEnv } from '../env';
import { createHasher, hashPassword, randomToken } from '../lib/crypto';

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main() {
  const env = loadEnv();
  const orgName = arg('organizacao')?.trim();
  const email = arg('email')?.trim().toLowerCase();
  const name = arg('nome')?.trim();
  if (!orgName || !email) throw new Error('Informe --organizacao e --email.');
  const db = createFirmaClient(env.FIRMA_DATABASE_URL);
  const hash = createHasher(env.FIRMA_TOKEN_HASH_SECRET);
  const org =
    (await db.organization.findFirst({ where: { name: orgName } })) ??
    (await db.organization.create({ data: { name: orgName } }));
  const secretEnv = arg('senha-env');
  if (secretEnv) {
    const pw = process.env[secretEnv];
    if (!pw || pw.length < 10) throw new Error(`Variável ${secretEnv} ausente ou curta.`);
    const user = await db.user.upsert({
      where: { email },
      create: { email, name: name ?? email.split('@')[0]!, passwordHash: await hashPassword(pw) },
      update: { passwordHash: await hashPassword(pw), active: true },
    });
    await db.membership.upsert({
      where: { orgId_userId: { orgId: org.id, userId: user.id } },
      create: { orgId: org.id, userId: user.id, role: 'DONO' },
      update: { role: 'DONO' },
    });
    process.stdout.write(`Organização "${org.name}" com dono ${email} (conta criada).\n`);
  } else {
    const token = randomToken();
    await db.invite.create({
      data: {
        orgId: org.id,
        email,
        role: 'DONO',
        tokenHash: hash(token),
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
      },
    });
    process.stdout.write(
      `Organização "${org.name}" criada. Convite do dono (${email}), válido por 7 dias:\n`,
    );
    process.stdout.write(`${env.FIRMA_WEB_URL}/convite/${token}\n`);
  }
  await db.$disconnect();
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
