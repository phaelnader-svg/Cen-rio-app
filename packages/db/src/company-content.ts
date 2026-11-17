import {
  DEFAULT_LOCATIONS,
  DEFAULT_PRODUCTION_TEMPLATES,
  DEFAULT_QUALITY_TEMPLATES,
  DEFAULT_ROLES,
  SIMPLIFIED_PRODUCTION_TEMPLATES,
  classifyStep,
} from '@cenario/shared';
import type { Prisma } from '@prisma/client';

/**
 * Multi-empresa — etapa 4: conteúdo inicial de uma empresa nova ("Criar conta").
 *
 * Recebe uma transação já presa à empresa nova (app.company_id = empresa, sem bypass): toda
 * linha criada aqui fica nela. Cria o mesmo ponto de partida que a Cenário Estofados recebeu
 * pelo seed e pelas migrations: funções e permissões, modelos de produção (gerais e
 * simplificados), checklists de qualidade e locais da oficina. A base de preços do orçamento
 * NÃO é copiada (é da Cenário Estofados); módulos e configurações usam os valores padrão.
 *
 * Devolve o id de cada função criada, por chave.
 */
export async function createCompanyContent(tx: Prisma.TransactionClient) {
  const roles = new Map<string, string>();
  for (const def of DEFAULT_ROLES) {
    const role = await tx.role.create({
      data: {
        key: def.key,
        name: def.name,
        description: def.description,
        system: def.system,
        permissions: { create: def.permissions.map((permission) => ({ permission })) },
      },
    });
    roles.set(def.key, role.id);
  }

  const templates = [
    ...DEFAULT_PRODUCTION_TEMPLATES.map((t) => ({ ...t, serviceTypes: [] as readonly string[] })),
    ...SIMPLIFIED_PRODUCTION_TEMPLATES,
  ];
  for (const t of templates) {
    await tx.productionTemplate.create({
      data: {
        name: t.name,
        pieceTypes: [...t.pieceTypes] as never,
        serviceTypes: [...t.serviceTypes] as never,
        steps: {
          create: t.steps.map((s, i) => ({
            activity: s.activity,
            name: s.name,
            role: s.role,
            requiresMaterials: s.requiresMaterials,
            optional: s.optional,
            dependsOn: [...s.dependsOn],
            position: i + 1,
            stepClass: classifyStep(s.activity, s.role),
          })),
        },
      },
    });
  }

  for (const t of DEFAULT_QUALITY_TEMPLATES) {
    await tx.qualityTemplate.create({
      data: {
        name: t.name,
        pieceTypes: [...t.pieceTypes],
        items: {
          create: t.items.map((item, i) => ({
            position: i + 1,
            label: item.label,
            guidance: item.guidance ?? null,
            required: item.required ?? true,
            serviceTypes: [...(item.serviceTypes ?? [])],
          })),
        },
      },
    });
  }

  await tx.itemLocation.createMany({
    data: DEFAULT_LOCATIONS.map((l, i) => ({ key: l.key, label: l.label, position: i + 1 })),
  });

  return roles;
}
