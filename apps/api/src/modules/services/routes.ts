import {
  EVENT_TYPES,
  logisticsCostCode,
  newServiceSchema,
  ownTeamSettingsSchema,
  type NewServiceDefaultsDto,
  type NewServiceResultDto,
  type OwnTeamSettingsDto,
  type PickupTeam,
} from '@cenario/shared';
import type { PrismaClient, Tx } from '@cenario/db';
import type { FastifyInstance } from 'fastify';
import { type z } from 'zod';
import { actorFrom, audit } from '../../core/audit';
import { appendEvent } from '../../core/events/append';
import { lockRow } from '../../core/locking';
import { loadUserPermissions } from '../../core/permissions';
import type { ActorContext } from '../../core/types';
import { Errors } from '../../lib/errors';
import { asSnapshot, dateOnly, orderCode, pickupCode } from '../commercial/common';
import { createCustomer } from '../customers/service';
import { createOrder } from '../orders/service';
import { createPickup } from '../pickups/service';
import { workers } from '../production/plans';
import { usersWith } from '../quality/common';

/**
 * Simplificação Fase 2 — "Novo serviço": cliente + serviço fechado + retirada em UMA operação.
 *
 * Reaproveita os serviços de domínio extraídos das rotas (cliente, pedido, retirada, custo de
 * viagem) dentro de UMA transação: qualquer falha desfaz tudo. O pedido comercial é o registro
 * do serviço fechado; a OS NÃO nasce aqui — nasce na confirmação da chegada das peças (D1).
 * Idempotente por `Idempotency-Key` (duplo clique / reenvio devolvem o mesmo resultado).
 */
const NEW_SERVICE = {
  session: 'WEB',
  permissions: ['pedidos.gerenciar', 'retiradas.gerenciar'],
} as const;
const OWN_TEAM_VIEW = {
  session: 'WEB',
  anyPermissions: ['empresa.ver', 'retiradas.gerenciar'],
} as const;
const OWN_TEAM_MANAGE = { session: 'WEB', permissions: ['empresa.configurar'] } as const;

type Person = { userId: string; displayName: string };

/** Equipe própria = funcionários ativos que executam produção (Thiago, João...). */
async function ownTeamPeople(db: Tx | PrismaClient): Promise<Person[]> {
  return (await workers(db)).map((w) => ({ userId: w.userId, displayName: w.displayName }));
}

/** Terceirizada = quem executa logística e não é da equipe própria (André, Izaías). */
async function outsourcedPeople(db: Tx | PrismaClient): Promise<Person[]> {
  const ownIds = new Set((await ownTeamPeople(db)).map((p) => p.userId));
  const ids = (await usersWith(db, 'logistica.executar')).filter((u) => !ownIds.has(u));
  const rows = await db.user.findMany({
    where: { id: { in: ids }, active: true, employee: { active: true } },
    orderBy: { displayName: 'asc' },
  });
  return rows.map((u) => ({ userId: u.id, displayName: u.displayName }));
}

async function peopleOf(db: Tx | PrismaClient, team: PickupTeam): Promise<Person[]> {
  return team === 'EQUIPE_PROPRIA' ? ownTeamPeople(db) : outsourcedPeople(db);
}

/**
 * Responsável padrão da equipe própria: referência ao usuário real, validada a cada leitura.
 * Inativo/inelegível = pendência explícita; o sistema nunca escolhe outro silenciosamente.
 */
export async function ownTeamSettings(db: Tx | PrismaClient): Promise<OwnTeamSettingsDto> {
  const settings = await db.companySettings.findUniqueOrThrow({ where: { id: 1 } });
  const candidates = await ownTeamPeople(db);
  const userId = settings.ownTeamDefaultUserId;
  if (!userId)
    return {
      userId: null,
      displayName: null,
      problem: 'NAO_CONFIGURADO',
      candidates,
      version: settings.version,
    };
  const u = await db.user.findUnique({ where: { id: userId }, include: { employee: true } });
  const inactive = !u || !u.active || (u.employee !== null && !u.employee.active);
  const eligible = candidates.some((c) => c.userId === userId);
  return {
    userId,
    displayName: u?.displayName ?? null,
    problem: inactive ? 'INATIVO' : eligible ? null : 'INELEGIVEL',
    candidates,
    version: settings.version,
  };
}

/** Recebedor configurado da logística (André), se ainda executa logística terceirizada. */
async function outsourcedDefault(db: Tx | PrismaClient): Promise<Person | null> {
  const settings = await db.companySettings.findUniqueOrThrow({ where: { id: 1 } });
  if (!settings.logisticsPayeeUserId) return null;
  return (
    (await outsourcedPeople(db)).find((p) => p.userId === settings.logisticsPayeeUserId) ?? null
  );
}

async function addCustomerAddress(
  tx: Tx,
  actor: ActorContext,
  customerId: string,
  a: z.output<typeof newServiceSchema>['customer'] & { mode: 'EXISTENTE' },
) {
  const addr = a.newAddress!;
  const created = await tx.customerAddress.create({
    data: {
      customerId,
      label: addr.label,
      street: addr.street,
      number: addr.number,
      complement: addr.complement ?? null,
      district: addr.district ?? null,
      city: addr.city,
      state: addr.state,
      postalCode: addr.postalCode ?? null,
      reference: addr.reference ?? null,
      isPrimary: false,
    },
  });
  await audit(tx, actor, {
    action: 'customer.address_added',
    entityType: 'customer',
    entityId: customerId,
    summary: `Endereço "${created.label}" cadastrado pelo Novo serviço.`,
  });
  return created;
}

export async function serviceRoutes(app: FastifyInstance) {
  const { prisma } = app.ctx;

  app.get(
    '/api/v1/services/new-defaults',
    { config: { access: NEW_SERVICE } },
    async (request): Promise<NewServiceDefaultsDto> => {
      const perms = request.auth!.permissions;
      const settings = await prisma.companySettings.findUniqueOrThrow({ where: { id: 1 } });
      const outsourced = await outsourcedDefault(prisma);
      return {
        ownTeam: await ownTeamSettings(prisma),
        outsourced: {
          userId: outsourced?.userId ?? null,
          displayName: outsourced?.displayName ?? null,
        },
        people: {
          EQUIPE_PROPRIA: await ownTeamPeople(prisma),
          LOGISTICA_TERCEIRIZADA: await outsourcedPeople(prisma),
        },
        suggestedPickupCostCents: perms.has('financeiro.gerenciar')
          ? settings.defaultPickupCostCents
          : null,
        canSetValues: perms.has('pedidos.valores'),
        canSetTripCost: perms.has('financeiro.gerenciar'),
        canCreateCustomer: perms.has('clientes.gerenciar'),
      };
    },
  );

  app.post(
    '/api/v1/services',
    { config: { access: NEW_SERVICE, idempotent: true } },
    async (request, reply) => {
      const input = newServiceSchema.parse(request.body);
      const perms = request.auth!.permissions;
      const c = input.customer;
      if (
        (c.mode === 'NOVO' || (c.mode === 'EXISTENTE' && c.newAddress)) &&
        !perms.has('clientes.gerenciar')
      )
        throw Errors.forbidden('Cadastrar cliente ou endereço exige permissão de clientes.');
      if (c.mode === 'EXISTENTE' && c.addressId && c.newAddress)
        throw Errors.validation(undefined, 'Escolha um endereço existente OU informe um novo.');
      const p = input.pickup;
      const actor = actorFrom(request);

      const result = await prisma.$transaction(async (tx) => {
        // 1. Cliente: novo (mesma deduplicação do cadastro) ou existente (+ endereço novo).
        let customerId: string;
        let customerName: string;
        let addressId: string | null = null;
        let created = false;
        if (c.mode === 'NOVO') {
          const cust = await createCustomer(tx, actor, {
            kind: c.kind,
            name: c.name,
            tradeName: c.tradeName,
            document: c.document,
            phone: c.phone,
            whatsapp: c.whatsapp,
            email: c.email,
            notes: c.notes,
            addresses: [{ ...c.address, isPrimary: true }],
            allowSimilar: c.allowSimilar,
          });
          customerId = cust.id;
          customerName = cust.name;
          addressId = cust.addresses[0]!.id;
          created = true;
        } else {
          const cust = await tx.customer.findUnique({ where: { id: c.customerId } });
          if (!cust || !cust.active)
            throw Errors.validation(undefined, 'Cliente inválido ou arquivado.');
          customerId = cust.id;
          customerName = cust.name;
          if (c.newAddress) addressId = (await addCustomerAddress(tx, actor, cust.id, c)).id;
          else if (c.addressId) addressId = c.addressId;
          else {
            const primary = await tx.customerAddress.findFirst({
              where: { customerId: cust.id, archivedAt: null },
              orderBy: [{ isPrimary: 'desc' }, { createdAt: 'asc' }],
            });
            if (!primary)
              throw Errors.validation(
                [{ path: 'customer.newAddress', message: 'Informe o endereço de retirada.' }],
                'Informe o endereço de retirada.',
              );
            addressId = primary.id;
          }
        }

        // 2. Pedido = serviço fechado (valores só com pedidos.valores; OS automática na chegada).
        const s = input.service;
        const order = await createOrder(tx, actor, perms, {
          customerId,
          pickupAddressId: addressId,
          contractedService: s.contractedService,
          description: s.description,
          agreedValueCents: s.agreedValueCents,
          paymentTerms: s.paymentTerms,
          notes: s.notes,
          promisedDate: s.promisedDate,
          technicalNotes: s.technicalNotes,
          autoServiceOrder: true,
          items: s.items,
        });

        // 3. Responsável: escolhido, ou o padrão da equipe (nunca um qualquer).
        const people = await peopleOf(tx, p.team);
        let responsible: Person | null = null;
        if (p.logisticsUserId) {
          responsible = people.find((x) => x.userId === p.logisticsUserId) ?? null;
          if (!responsible)
            throw Errors.validation(
              [
                {
                  path: 'pickup.logisticsUserId',
                  message: 'Responsável não pertence à equipe escolhida.',
                },
              ],
              'Responsável não pertence à equipe escolhida.',
            );
        } else if (p.team === 'EQUIPE_PROPRIA') {
          const own = await ownTeamSettings(tx);
          if (own.problem)
            throw Errors.business(
              own.problem === 'NAO_CONFIGURADO'
                ? 'Responsável padrão da equipe própria não configurado. Escolha o responsável (ou configure em Empresa).'
                : `Responsável padrão da equipe própria (${own.displayName ?? '—'}) está ${own.problem === 'INATIVO' ? 'inativo' : 'sem permissão para executar'}. Escolha outro responsável.`,
            );
          responsible = { userId: own.userId!, displayName: own.displayName! };
        } else {
          responsible = await outsourcedDefault(tx);
        }
        const allPeople = [...(await ownTeamPeople(tx)), ...(await outsourcedPeople(tx))];
        const participants = p.participantUserIds.map((id) => {
          const person = allPeople.find((x) => x.userId === id);
          if (!person)
            throw Errors.validation(
              [{ path: 'pickup.participantUserIds', message: 'Participante inválido.' }],
              'Participante inválido ou inativo.',
            );
          return person;
        });
        const hasCost = Boolean(p.amountCents);
        const teamNotes = [
          p.notes,
          !hasCost && participants.length
            ? `Participantes: ${participants.map((x) => x.displayName).join(', ')}`
            : null,
        ]
          .filter(Boolean)
          .join(' · ')
          .slice(0, 200);

        // 4. Retirada de TODAS as peças, com o custo total único da viagem (Fase 6).
        const items = await tx.commercialOrderItem.findMany({
          where: { orderId: order.id },
          orderBy: { position: 'asc' },
        });
        const pickup = await createPickup(tx, actor, perms, {
          orderId: order.id,
          addressId,
          scheduledDate: p.scheduledDate ?? null,
          windowStart: p.windowStart ?? null,
          windowEnd: null,
          team: p.team,
          teamNotes: teamNotes || null,
          instructions: p.instructions ?? null,
          externalReference: null,
          items: items.map((i) => ({ orderItemId: i.id, quantity: i.quantity })),
          logisticsUserId: responsible?.userId ?? null,
          tripCost: hasCost
            ? { amountCents: p.amountCents!, participantUserIds: p.participantUserIds }
            : undefined,
        });
        const cost = hasCost
          ? await tx.logisticsCost.findFirst({
              where: { pickupId: pickup.id, status: { not: 'CANCELADO' } },
            })
          : null;

        await audit(tx, actor, {
          action: 'service.created',
          entityType: 'commercial_order',
          entityId: order.id,
          summary: `Novo serviço: ${customerName} — pedido ${orderCode(order.number)} e retirada ${pickupCode(pickup.number)}${created ? ' (cliente novo)' : ''}.`,
          changes: {
            customerId,
            customerCreated: created,
            orderId: order.id,
            pickupId: pickup.id,
            team: p.team,
            responsible: responsible?.userId ?? null,
            tripCostId: cost?.id ?? null,
          },
        });
        await appendEvent(tx, actor, {
          type: EVENT_TYPES.ORDER_UPDATED,
          aggregateType: 'commercial_order',
          aggregateId: order.id,
          payload: { id: order.id, code: orderCode(order.number), newService: true },
          audience: 'permission:pedidos.ver',
        });

        const fresh = await tx.pickupRequest.findUniqueOrThrow({ where: { id: pickup.id } });
        const dto: NewServiceResultDto = {
          customer: { id: customerId, name: customerName, created },
          order: {
            id: order.id,
            code: orderCode(order.number),
            totalPieces: items.reduce((a, i) => a + i.quantity, 0),
            agreedValueCents: perms.has('pedidos.valores') ? order.agreedValueCents : null,
          },
          pickup: {
            id: fresh.id,
            code: pickupCode(fresh.number),
            status: fresh.status,
            scheduledDate: dateOnly(fresh.scheduledDate),
            windowStart: fresh.windowStart,
            team: fresh.team,
            responsible: responsible?.displayName ?? null,
            participants: participants.map((x) => x.displayName),
            address: asSnapshot(fresh.addressSnapshot),
          },
          tripCost:
            cost && perms.has('financeiro.ver')
              ? {
                  code: logisticsCostCode(cost.number),
                  amountCents: cost.amountCents,
                  status: cost.status,
                }
              : null,
        };
        return dto;
      });
      return reply.status(201).send(result);
    },
  );

  app.get('/api/v1/company/own-team', { config: { access: OWN_TEAM_VIEW } }, async () =>
    ownTeamSettings(prisma),
  );

  app.put('/api/v1/company/own-team', { config: { access: OWN_TEAM_MANAGE } }, async (request) => {
    const input = ownTeamSettingsSchema.parse(request.body);
    return prisma.$transaction(async (tx) => {
      if (!(await lockRow(tx, 'company_settings', 1)))
        throw Errors.notFound('Configuração da empresa');
      const before = await tx.companySettings.findUniqueOrThrow({ where: { id: 1 } });
      if (before.version !== input.version) throw Errors.versionConflict(before.version);
      if (input.userId) {
        const candidates = await ownTeamPeople(tx);
        if (!candidates.some((c) => c.userId === input.userId)) {
          const perms = await loadUserPermissions(tx, input.userId);
          throw Errors.business(
            perms.has('producao.executar')
              ? 'Funcionário inativo: escolha um responsável ativo.'
              : 'Funcionário sem permissão para executar serviços da equipe própria.',
          );
        }
      }
      const actor = actorFrom(request);
      const updated = await tx.companySettings.update({
        where: { id: 1 },
        data: {
          ownTeamDefaultUserId: input.userId,
          updatedById: actor.userId,
          version: { increment: 1 },
        },
      });
      await audit(tx, actor, {
        action: 'company.own_team_default_changed',
        entityType: 'company_settings',
        entityId: '1',
        summary: 'Responsável padrão da equipe própria alterado.',
        changes: { ownTeamDefaultUserId: { from: before.ownTeamDefaultUserId, to: input.userId } },
      });
      await appendEvent(tx, actor, {
        type: EVENT_TYPES.COMPANY_SETTINGS_UPDATED,
        aggregateType: 'company_settings',
        aggregateId: '1',
        payload: { version: updated.version, ownTeamDefault: true },
      });
      return ownTeamSettings(tx);
    });
  });
}
