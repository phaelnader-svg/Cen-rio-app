/**
 * Seed idempotente da Fase 1.
 *
 * - Sincroniza as funções padrão com o catálogo de permissões do código.
 * - Cria o registro de configurações da empresa (valores operacionais informados
 *   pelo gestor no levantamento: chegada 8h30, alerta 9h30, programação e
 *   medição às sextas-feiras).
 * - Cria a conta do gestor SOMENTE se SEED_ADMIN_EMAIL/PASSWORD/NAME forem
 *   informados no ambiente (nenhuma credencial é inventada).
 * - Cria a equipe de produção informada (Ricardo, Márcio, Thiago, João) SEM PIN:
 *   o gestor define os PINs pelo painel.
 */
import { hash } from '@node-rs/argon2';
import {
  DEFAULT_PRODUCTION_TEMPLATES,
  DEFAULT_ROLES,
  GESTOR_ROLE_KEY,
  passwordPolicySchema,
} from '@cenario/shared';
import { createPrismaClient } from './index';

const ARGON2_OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

const TEAM = [
  {
    fullName: 'Ricardo',
    displayName: 'Ricardo',
    jobTitle: 'Tapeceiro',
    responsibilities: 'Corte, costura e montagem.',
    color: '#2563EB',
    roleKey: 'tapeceiro',
  },
  {
    fullName: 'Márcio',
    displayName: 'Márcio',
    jobTitle: 'Tapeceiro',
    responsibilities: 'Corte, costura e montagem.',
    color: '#059669',
    roleKey: 'tapeceiro',
  },
  {
    fullName: 'Thiago',
    displayName: 'Thiago',
    jobTitle: 'Cabeceiras, reparos e qualidade',
    responsibilities:
      'Fabricação de cabeceiras, reparos, preparação, instalações e controle de qualidade final.',
    color: '#D97706',
    roleKey: 'cabeceiras_qualidade',
  },
  {
    fullName: 'João',
    displayName: 'João',
    jobTitle: 'Ajudante',
    responsibilities: 'Desmontagem, preparação e apoio.',
    color: '#7C3AED',
    roleKey: 'ajudante',
  },
] as const;

export async function runSeed(options: { withTeam?: boolean; log?: (m: string) => void } = {}) {
  const log = options.log ?? ((m: string) => console.log(m));
  const prisma = createPrismaClient();
  try {
    // 1. Funções padrão e permissões
    for (const def of DEFAULT_ROLES) {
      const role = await prisma.role.upsert({
        where: { key: def.key },
        create: { key: def.key, name: def.name, description: def.description, system: def.system },
        update: {},
      });
      if (def.key === GESTOR_ROLE_KEY) {
        // O gestor sempre recebe o catálogo completo (inclusive permissões novas).
        await prisma.rolePermission.createMany({
          data: def.permissions.map((permission) => ({ roleId: role.id, permission })),
          skipDuplicates: true,
        });
      } else {
        const count = await prisma.rolePermission.count({ where: { roleId: role.id } });
        if (count === 0) {
          await prisma.rolePermission.createMany({
            data: def.permissions.map((permission) => ({ roleId: role.id, permission })),
            skipDuplicates: true,
          });
        }
      }
    }
    log('✔ Funções padrão sincronizadas.');

    // 2. Configurações da empresa
    await prisma.companySettings.upsert({
      where: { id: 1 },
      create: { id: 1, tradeName: 'Cenário Estofados' },
      update: {},
    });
    log('✔ Configurações da empresa presentes.');

    // 3. Gestor
    const email = process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase();
    const password = process.env.SEED_ADMIN_PASSWORD;
    const name = process.env.SEED_ADMIN_NAME?.trim();
    if (email && password && name) {
      const policy = passwordPolicySchema.safeParse(password);
      if (!policy.success) {
        throw new Error(`SEED_ADMIN_PASSWORD inválida: ${policy.error.issues[0]?.message}`);
      }
      const existing = await prisma.user.findUnique({ where: { email } });
      if (existing) {
        log(`• Gestor ${email} já existe — mantido sem alterações.`);
      } else {
        const gestorRole = await prisma.role.findUniqueOrThrow({ where: { key: GESTOR_ROLE_KEY } });
        await prisma.$transaction(async (tx) => {
          const user = await tx.user.create({
            data: {
              email,
              displayName: name.slice(0, 60),
              passwordHash: await hash(password, ARGON2_OPTIONS),
              credentialsChangedAt: new Date(),
              roles: { create: { roleId: gestorRole.id } },
            },
          });
          await tx.employee.create({
            data: {
              userId: user.id,
              fullName: name.slice(0, 120),
              displayName: name.slice(0, 40),
              jobTitle: 'Gestor',
              responsibilities:
                'Clientes, orçamentos, contratos, OS, compras, programação, decisões e entregas.',
              color: '#0F172A',
            },
          });
          await tx.auditLog.create({
            data: {
              action: 'seed.admin_created',
              entityType: 'user',
              entityId: user.id,
              summary: `Conta do gestor criada pelo seed (${email}).`,
            },
          });
        });
        log(`✔ Gestor ${email} criado.`);
      }
    } else {
      log('• SEED_ADMIN_EMAIL/SEED_ADMIN_PASSWORD/SEED_ADMIN_NAME ausentes — gestor não criado.');
    }

    // 4. Equipe de produção (sem credenciais)
    if (options.withTeam ?? process.env.SEED_TEAM !== 'false') {
      for (const member of TEAM) {
        const exists = await prisma.employee.findFirst({
          where: { displayName: member.displayName },
        });
        if (exists) continue;
        const role = await prisma.role.findUniqueOrThrow({ where: { key: member.roleKey } });
        await prisma.$transaction(async (tx) => {
          const user = await tx.user.create({
            data: { displayName: member.displayName, roles: { create: { roleId: role.id } } },
          });
          await tx.employee.create({
            data: {
              userId: user.id,
              fullName: member.fullName,
              displayName: member.displayName,
              jobTitle: member.jobTitle,
              responsibilities: member.responsibilities,
              color: member.color,
            },
          });
        });
        log(`✔ Funcionário ${member.displayName} cadastrado (sem PIN).`);
      }
    }

    // Fase 5: modelos de produção iniciais (somente se ainda não houver nenhum).
    if ((await prisma.productionTemplate.count()) === 0) {
      for (const t of DEFAULT_PRODUCTION_TEMPLATES) {
        await prisma.productionTemplate.create({
          data: {
            name: t.name,
            pieceTypes: t.pieceTypes as never,
            steps: {
              create: t.steps.map((s, i) => ({
                ...s,
                dependsOn: [...s.dependsOn],
                position: i + 1,
              })),
            },
          },
        });
      }
      log('✔ Modelos de produção iniciais criados.');
    }
  } finally {
    await prisma.$disconnect();
  }
}

const isDirectRun =
  process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/'));
if (isDirectRun) {
  runSeed().catch((error: unknown) => {
    console.error('✖ Falha no seed:', error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
