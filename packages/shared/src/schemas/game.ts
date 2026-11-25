import { z } from 'zod';
import { AREA_FUNCTIONS, DECOR_KINDS, STATION_KINDS, STORAGE_KINDS } from '../game-domain';
import { idSchema, versionSchema } from './common';

const cm = (max = 20000) => z.number().int().min(-500).max(max);
const size = (max = 20000) => z.number().int().min(1).max(max);
const rotation = z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]);
const name = (max: number) => z.string().trim().min(1, 'Informe o nome.').max(max);

export const gameAreaSchema = z.object({
  id: idSchema,
  function: z.enum(AREA_FUNCTIONS),
  name: name(80),
  xCm: cm(),
  yCm: cm(),
  wCm: size(),
  dCm: size(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .nullable()
    .optional(),
  itemLocationId: idSchema.nullable().optional(),
});

export const gameStationSchema = z.object({
  id: idSchema,
  kind: z.enum(
    Object.keys(STATION_KINDS) as [keyof typeof STATION_KINDS, ...(keyof typeof STATION_KINDS)[]],
  ),
  name: name(80),
  areaId: idSchema.nullable().optional(),
  xCm: cm(),
  yCm: cm(),
  wCm: size(2000),
  dCm: size(2000),
  rotation,
  activities: z.array(z.string().max(30)).max(20).default([]),
  shared: z.boolean().default(false),
  assigneeUserIds: z.array(idSchema).max(30).default([]),
});

export const gameStorageSlotSchema = z.object({
  id: idSchema,
  label: name(60),
  level: z.number().int().min(1).max(50),
  stockItemIds: z.array(idSchema).max(200).default([]),
});

export const gameStorageUnitSchema = z.object({
  id: idSchema,
  kind: z.enum(
    Object.keys(STORAGE_KINDS) as [keyof typeof STORAGE_KINDS, ...(keyof typeof STORAGE_KINDS)[]],
  ),
  label: name(60),
  areaId: idSchema.nullable().optional(),
  xCm: cm(),
  yCm: cm(),
  wCm: size(2000),
  dCm: size(2000),
  rotation,
  slots: z.array(gameStorageSlotSchema).max(50),
});

const wallSchema = z.object({
  id: z.string().min(1).max(40),
  x1: cm(),
  y1: cm(),
  x2: cm(),
  y2: cm(),
});
const doorSchema = z.object({
  id: z.string().min(1).max(40),
  wall: z.string().min(1).max(40),
  offsetCm: z.number().int().min(0).max(20000),
  widthCm: z.number().int().min(60).max(1000),
  label: z.string().max(60).nullable().optional(),
  toSpaceKey: z.string().max(40).nullable().optional(),
});
const decorSchema = z.object({
  id: z.string().min(1).max(40),
  kind: z.enum(
    Object.keys(DECOR_KINDS) as [keyof typeof DECOR_KINDS, ...(keyof typeof DECOR_KINDS)[]],
  ),
  name: z.string().max(60).nullable().optional(),
  xCm: cm(),
  yCm: cm(),
  wCm: size(2000),
  dCm: size(2000),
  rotation,
});

export const layoutDocSchema = z.object({
  walls: z.array(wallSchema).max(200).default([]),
  doors: z.array(doorSchema).max(50).default([]),
  decor: z.array(decorSchema).max(300).default([]),
  windows: z
    .array(
      z.object({
        id: z.string().min(1).max(40),
        wall: z.string().min(1).max(40),
        offsetCm: z.number().int().min(0).max(20000),
        widthCm: z.number().int().min(30).max(2000),
      }),
    )
    .max(50)
    .default([]),
  notes: z.string().max(1000).nullable().optional(),
});

/** Destino escolhido para os vínculos de cada objeto removido (id removido → id destino). */
export const layoutTransfersSchema = z
  .object({
    areas: z.record(z.string(), idSchema).default({}),
    stations: z.record(z.string(), idSchema).default({}),
    slots: z.record(z.string(), idSchema).default({}),
  })
  .default({ areas: {}, stations: {}, slots: {} });

export const saveLayoutSchema = z.object({
  version: versionSchema,
  name: name(80),
  widthCm: z.number().int().min(100).max(20000),
  depthCm: z.number().int().min(100).max(20000),
  gridCm: z.number().int().min(5).max(200).default(50),
  illustrative: z.boolean(),
  doc: layoutDocSchema,
  areas: z.array(gameAreaSchema).max(100),
  stations: z.array(gameStationSchema).max(300),
  storageUnits: z.array(gameStorageUnitSchema).max(200),
  transfers: layoutTransfersSchema.optional(),
  /** Resumo da mudança (vai para o histórico). */
  summary: z.string().trim().max(500).optional(),
});
export type SaveLayoutInput = z.infer<typeof saveLayoutSchema>;

export const createSpaceSchema = z.object({
  name: name(80),
  kind: z.enum(['OFICINA', 'ESCRITORIO', 'OUTRO']),
  widthCm: z.number().int().min(100).max(20000),
  depthCm: z.number().int().min(100).max(20000),
  /** Começar da planta sugerida (só para Tapeçaria/Escritório) ou em branco. */
  start: z.enum(['SUGERIDA', 'EM_BRANCO']).default('EM_BRANCO'),
});

export const resetSpaceSchema = z.object({
  version: versionSchema,
  start: z.enum(['SUGERIDA', 'EM_BRANCO']),
});

export const AGENT_ROLE_KEYS = [
  'GERENTE',
  'COMPRAS',
  'WHATSAPP',
  'ORCAMENTOS',
  'FINANCEIRO',
  'INSTAGRAM',
  'ATENDIMENTO',
  'MARKETING',
  'TRAFEGO',
  'DOCUMENTOS',
  'PERSONALIZADA',
] as const;
export const AGENT_CHANNELS = ['WHATSAPP', 'INSTAGRAM', 'MESSENGER', 'META_ADS'] as const;
export const CHANNEL_POLICY = ['CONSULTAR', 'RASCUNHO', 'EXECUTAR'] as const;
export const AUTO_SEND_RULES = ['PEDIR_FOTOS_MEDIDAS', 'CONFIRMAR_RECEBIMENTO'] as const;
export const AGENT_DATA_SCOPES = [
  'producao',
  'os',
  'estoque',
  'compras',
  'financeiro',
  'presenca',
  'clientes',
  'whatsapp',
  'instagram',
  'fiscal',
  'orcamentos',
] as const;
export const AGENT_ACTIONS = [
  'atribuir_tarefa',
  'criar_compra',
  'reservar_estoque',
  'enviar_mensagem',
  'publicar_post',
  'registrar_pagamento',
  'emitir_nota',
  'preparar_orcamento',
  'pedir_fornecedor',
  'cobrar_cliente',
] as const;
export const AGENT_POLICY = ['NUNCA', 'PROPOR', 'EXECUTAR_APROVADO'] as const;

export const agentSchema = z.object({
  name: name(60),
  roleKey: z.enum(AGENT_ROLE_KEYS),
  roleLabel: name(80),
  instructions: z.string().trim().max(4000),
  dataScopes: z.array(z.enum(AGENT_DATA_SCOPES)).max(AGENT_DATA_SCOPES.length),
  actionPolicies: z.partialRecord(z.enum(AGENT_ACTIONS), z.enum(AGENT_POLICY)).default({}),
  deskStationId: idSchema.nullable().optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .default('#7c3aed'),
  /** Canais que o agente acessa e o que pode fazer em cada um. */
  channelPolicies: z.partialRecord(z.enum(AGENT_CHANNELS), z.enum(CHANNEL_POLICY)).default({}),
  /** Casos de envio automático liberados (só valem com política EXECUTAR no canal). */
  autoSendRules: z.array(z.enum(AUTO_SEND_RULES)).max(10).default([]),
});
export const updateAgentSchema = agentSchema.partial().extend({
  version: versionSchema,
  status: z.enum(['ATIVO', 'PAUSADO', 'DESATIVADO']).optional(),
});
export const agentMessageSchema = z.object({ content: z.string().trim().min(1).max(2000) });
export const decideProposalSchema = z.object({
  decision: z.enum(['APROVAR', 'REJEITAR']),
  note: z.string().trim().max(500).optional(),
  /** Ajustes do dono antes de aprovar uma mensagem (pedido ao fornecedor, cobrança, aviso). */
  edits: z
    .object({
      text: z.string().trim().min(1).max(4000).optional(),
      supplierId: idSchema.optional(),
      /** Agendar a entrega: dia e horário escolhidos pelo dono antes de aprovar. */
      scheduledDate: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      windowStart: z
        .string()
        .regex(/^\d{2}:\d{2}$/)
        .optional(),
      windowEnd: z
        .string()
        .regex(/^\d{2}:\d{2}$/)
        .optional(),
      /** Despesa pela foto: o que o dono corrigiu do que o agente leu. */
      amountCents: z.number().int().min(1).max(100_000_000).optional(),
      date: z
        .string()
        .regex(/^\d{4}-\d{2}-\d{2}$/)
        .optional(),
      beneficiary: z.string().trim().min(2).max(160).optional(),
      description: z.string().trim().min(2).max(200).optional(),
      category: z.string().trim().min(1).max(30).optional(),
      paid: z.boolean().optional(),
    })
    .optional(),
});

export const stockMoveSchema = z.object({
  fromSlotId: idSchema.nullable(),
  toSlotId: idSchema,
  stockItemId: idSchema,
});

/** Fornecedor (cadastro do escritório do jogo, usado pelo agente de Compras). */
export const supplierSchema = z.object({
  name: name(160),
  contactName: z.string().trim().max(120).nullable().optional(),
  /** WhatsApp do fornecedor. */
  phone: z.string().trim().max(30).nullable().optional(),
  email: z.string().trim().max(160).nullable().optional(),
  categories: z
    .array(z.enum(['TECIDO', 'ESPUMA', 'OUTRO']))
    .max(3)
    .default([]),
  notes: z.string().trim().max(1000).nullable().optional(),
});
export const updateSupplierSchema = supplierSchema.partial().extend({
  version: versionSchema,
  active: z.boolean().optional(),
});
