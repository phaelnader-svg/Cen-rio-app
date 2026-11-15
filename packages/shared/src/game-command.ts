/**
 * "Falar com a Cenário": a frase vira uma INTENÇÃO estruturada (pela IA, quando configurada, ou
 * por estas regras). O servidor valida os parâmetros, resolve com os dados reais e devolve um
 * EFEITO para a interface executar com as mesmas ações, permissões e validações do jogo.
 * Consultas abrem na hora; mudanças na planta têm prévia; atribuições pedem confirmação.
 */
import { z } from 'zod';

export const COMMAND_ACTIONS = [
  'ENCONTRAR_OS',
  'LOCALIZAR_MATERIAL',
  'MOVER_OBJETO',
  'PLANTA',
  'ATRIBUIR',
  'CONVERSAS',
  'FINANCEIRO',
  'AJUDA',
] as const;
export type CommandAction = (typeof COMMAND_ACTIONS)[number];

/** Intenção estruturada (formato único para a IA e para as regras). */
export const commandIntentSchema = z.object({
  acao: z.enum(COMMAND_ACTIONS),
  /** Número da OS citado ("OS 142"). */
  osNumero: z.number().int().positive().nullable(),
  /** Nome do cliente, descrição do móvel ou do material. */
  termo: z.string().trim().max(120).nullable(),
  /** Objeto da planta a mover ("mesa de corte"). */
  objeto: z.string().trim().max(120).nullable(),
  /** Destino na planta ("costura", "perto da expedição"). */
  destino: z.string().trim().max(120).nullable(),
  /** Funcionário da atribuição. */
  funcionario: z.string().trim().max(60).nullable(),
  /** Etapa da atribuição ("desmanche", "corte"…). */
  etapa: z.string().trim().max(60).nullable(),
  /** Data AAAA-MM-DD (atribuição) quando dita. */
  data: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  /** Pedido livre (planta, conversas, financeiro). */
  pedido: z.string().trim().max(300).nullable(),
});
export type CommandIntent = z.infer<typeof commandIntentSchema>;

export const commandRequestSchema = z.object({
  text: z.string().trim().min(1, 'Escreva o que você quer.').max(300),
  spaceKey: z.string().max(40).optional(),
});

/** JSON Schema da intenção para a saída estruturada do modelo de linguagem. */
export const COMMAND_INTENT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: [
    'acao',
    'osNumero',
    'termo',
    'objeto',
    'destino',
    'funcionario',
    'etapa',
    'data',
    'pedido',
  ],
  properties: {
    acao: { type: 'string', enum: [...COMMAND_ACTIONS] },
    osNumero: { type: ['integer', 'null'] },
    termo: { type: ['string', 'null'] },
    objeto: { type: ['string', 'null'] },
    destino: { type: ['string', 'null'] },
    funcionario: { type: ['string', 'null'] },
    etapa: { type: ['string', 'null'] },
    data: { type: ['string', 'null'] },
    pedido: { type: ['string', 'null'] },
  },
} as const;

export const COMMAND_SYSTEM_PROMPT = `Você interpreta frases em português do gestor de uma tapeçaria (Cenário Estofados) dentro de um jogo de gestão. Responda só com a intenção estruturada.
Ações:
- ENCONTRAR_OS: achar uma ordem de serviço ou móvel ("Cadê o sofá da Hadassa?", "Abre a OS 142"). osNumero quando houver número; termo = nome do cliente ou descrição do móvel.
- LOCALIZAR_MATERIAL: onde fica um material ("Onde fica o linho bege?"). termo = material (com cor/densidade).
- MOVER_OBJETO: mover um móvel da planta ("Joga a mesa de corte pra perto da costura"). objeto = móvel; destino = área, móvel ou lugar.
- PLANTA: pedidos de layout ao Mestre de Obras (mais mesas, aumentar sala, criar mesa para agente, caminho livre, bancada para novo funcionário). pedido = frase original.
- ATRIBUIR: atribuir etapa de uma OS a um funcionário ("Passa o desmanche da OS 12 pro João amanhã"). osNumero/termo, etapa, funcionario, data (AAAA-MM-DD; hoje é informado na mensagem).
- CONVERSAS: perguntas sobre conversas de clientes (WhatsApp, Instagram, Messenger). pedido = frase.
- FINANCEIRO: contratos, cobranças, Pix, entradas, saldos, contas, pagamentos, notas fiscais, fechamento do mês, entregas com saldo. pedido = frase.
- AJUDA: qualquer outra coisa.
Campos não citados ficam null. Não invente números nem nomes.`;

const STRIP = /[̀-ͯ]/g;
export const normCmd = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(STRIP, '')
    .replace(/[?!.,;:]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const FURNITURE =
  /\b(sofa|sofas|poltrona|poltronas|cabeceira|cadeira|cadeiras|pufe|banco|colchao|movel|moveis|peca|servico|pedido|reforma|chaise|canto)\b/;
const MATERIAL =
  /\b(linho|tecido|veludo|suede|couro|courino|chenille|espuma|grampo|grampos|percinta|cola|ferragem|ferragens|mecanismo|pe|pes|manta|fibra|ziper|botao|botoes|tachas?|material|materiais|d\d{2})\b/;
const NUMBERS: Record<string, number> = {
  um: 1,
  uma: 1,
  dois: 2,
  duas: 2,
  tres: 3,
  quatro: 4,
  cinco: 5,
};

const empty = (acao: CommandAction): CommandIntent => ({
  acao,
  osNumero: null,
  termo: null,
  objeto: null,
  destino: null,
  funcionario: null,
  etapa: null,
  data: null,
  pedido: null,
});

const STAGES: [RegExp, string][] = [
  [/desmanche|desmont/, 'DESMONTAGEM'],
  [/preparac/, 'PREPARACAO'],
  [/corte/, 'CORTE'],
  [/costura/, 'COSTURA'],
  [/montagem|revest/, 'MONTAGEM'],
  [/acabamento/, 'ACABAMENTO'],
  [/embala/, 'EMBALAGEM'],
];

function addDays(today: string, n: number) {
  const d = new Date(`${today}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Interpretação por regras (sem modelo configurado). `today` = AAAA-MM-DD no fuso da empresa. */
export function parseCommandRules(text: string, today: string): CommandIntent {
  const t = normCmd(text);
  const osNum = /\b(?:os|o\.s|ordem(?: de servico)?)\s*(?:n(?:o|umero)?\s*)?(\d{1,7})\b/.exec(t);

  // Financeiro e conversas (resolvidos pelo escritório).
  if (
    /\b(whatsapp|whats|zap|instagram|insta|direct|messenger|conversa|conversas|mensagens?)\b/.test(
      t,
    ) &&
    !/\bmov|joga\b/.test(t)
  )
    return { ...empty('CONVERSAS'), pedido: text.trim() };
  if (
    /\b(contrato|cobranca|cobra|pix|boleto|entrada|saldo|parcela|nota fiscal|notas?|nfs ?e|nf ?e|conta|contas|pagar|pagamento|vencem|fechar o mes|fechamento|comprovantes?|extrato|recebiveis?|fornecedor)\b/.test(
      t,
    )
  )
    return {
      ...empty('FINANCEIRO'),
      osNumero: osNum ? Number(osNum[1]) : null,
      pedido: text.trim(),
    };

  // Atribuição: "passa o desmanche da OS 12 pro João (amanhã)".
  const stage = STAGES.find(([re]) => re.test(t));
  const toWho =
    /\b(?:pro|pra|para o|para a|para|ao|a)\s+([a-z]{3,20})\b(?!.*\b(?:pro|pra|para|ao)\b)/.exec(t);
  if (
    /\b(atribui|atribua|passa|passe|manda|mande|coloca|coloque|escala|bota)\b/.test(t) &&
    stage &&
    toWho &&
    !/\bmesa|bancada|estante\b/.test(t)
  ) {
    const date = /\bamanha\b/.test(t)
      ? addDays(today, 1)
      : /\bhoje\b/.test(t)
        ? today
        : (/(\d{4}-\d{2}-\d{2})/.exec(t)?.[1] ?? null);
    const name =
      /\b(?:sofa|poltrona|cabeceira|cadeira)s?\s+d[aeo]s?\s+([a-z ]+?)(?:\s+(?:pro|pra|para|ao)\b|$)/
        .exec(t)?.[1]
        ?.trim() ?? null;
    return {
      ...empty('ATRIBUIR'),
      osNumero: osNum ? Number(osNum[1]) : null,
      termo: name,
      etapa: stage[1],
      funcionario: toWho[1]!,
      data: date,
    };
  }

  // Planta (Mestre de Obras).
  if (
    /\b(mais (\d+|uma|um|duas|dois|tres|quatro|cinco) (mesas?|bancadas?|estacoes|estantes?))\b|\b(aument|amplia|diminu|reduz)\w*\b.*\b(escritorio|oficina|sala|tapecaria|metros?)\b|\b(cri|cria|crie|nova|novo|monta|montar)\w*\b.*\b(mesa|bancada|area|estacao|marcenaria)\b|\bcaminho livre\b|\bcontratei\b|\bonde (posso|cabe|encaixo)\b|\bverific\w* (as )?passage/.test(
      t,
    )
  )
    return { ...empty('PLANTA'), pedido: text.trim() };

  // Mover objeto: "joga a mesa de corte pra perto da costura".
  const VERB =
    '(?:joga|jogar|move|mova|mover|muda|mude|mudar|leva|leve|levar|coloca|coloque|colocar|passa|passe|arrasta|arraste|bota|bote|poe|ponha|transfere)';
  const MARK =
    '(?:(?:pra|para|pro)\\s+(?:(?:perto|ao lado|junto|do lado|proximo|em frente|na frente|dentro|em cima|encostad[ao])\\s+)?(?:d[aeo]s?\\s+|a\\s+|o\\s+|as\\s+|os\\s+)?|(?:perto|ao lado|junto|do lado|proximo|em frente|na frente|em cima)\\s+d[aeo]s?\\s+|(?:na|no|nas|nos)\\s+)';
  const mv = new RegExp(`\\b${VERB}\\s+(?:a|o|as|os)?\\s*(.+?)\\s+${MARK}(.+)$`).exec(t);
  if (
    mv &&
    /\b(mesa|bancada|maquina|estante|prateleira|armario|gaveteiro|suporte|estrado|sofa de espera|balcao|palete|lixeira|planta|quadro|estacao)\b/.test(
      mv[1]!,
    )
  ) {
    const destino = mv[2]!
      .replace(
        /^(?:perto|ao lado|junto|do lado|proximo|em frente|na frente|dentro|em cima)\s+d[aeo]s?\s+/,
        '',
      )
      .trim();
    return { ...empty('MOVER_OBJETO'), objeto: mv[1]!.trim(), destino };
  }

  // OS por número.
  if (osNum) return { ...empty('ENCONTRAR_OS'), osNumero: Number(osNum[1]) };

  // Material x móvel do cliente.
  const ask =
    /\b(cade|cadê|onde|acha|ache|encontra|encontre|localiza|localize|mostra|mostre|abre|abra|abrir|ver|qual|tem)\b/.test(
      t,
    );
  if (ask && MATERIAL.test(t) && !FURNITURE.test(t)) {
    const termo = t
      .replace(
        /^.*\b(?:fica|esta|ta|tem|cade|acha|ache|encontra|encontre|localiza|localize|mostra|mostre|onde|guardad[oa]s?)\b\s*/,
        '',
      )
      .replace(/^(?:o|a|os|as|um|uma)\s+/, '')
      .replace(/\b(no estoque|guardad[oa]s?|no mapa|na oficina)\b/g, '')
      .trim();
    return { ...empty('LOCALIZAR_MATERIAL'), termo: termo || t };
  }
  if (ask || FURNITURE.test(t)) {
    const who =
      /\b(?:d[aeo]s?)\s+([a-z][a-z ]{1,60})$/.exec(t)?.[1] ??
      /\b(?:cliente)\s+([a-z][a-z ]{1,60})$/.exec(t)?.[1];
    const termo = (
      who ??
      t
        .replace(/^(cade|onde (fica|esta|ta)|abre|abra|mostra|mostre|acha|encontra)\s+/, '')
        .replace(/^(o|a|os|as)\s+/, '')
    ).trim();
    if (termo) return { ...empty('ENCONTRAR_OS'), termo };
  }
  return { ...empty('AJUDA'), pedido: text.trim() };
}

export const COMMAND_SUGGESTIONS = [
  'Cadê o sofá da Ana?',
  'Abre a OS 1',
  'Onde fica a espuma D28?',
  'Joga a mesa de corte pra perto da costura',
  'Passa o desmanche da OS 2 pro João amanhã',
  'Coloca mais duas mesas perto da janela',
  'Aumenta o escritório dois metros',
  'Cria uma mesa para o agente de compras',
];

/** Número por extenso ou dígito ("dois metros" → 2). */
export function numberWord(t: string): number | null {
  const n = normCmd(t);
  const d = /(\d+(?:[.,]\d+)?)/.exec(n);
  if (d) return Number(d[1]!.replace(',', '.'));
  for (const [w, v] of Object.entries(NUMBERS)) if (new RegExp(`\\b${w}\\b`).test(n)) return v;
  return null;
}

// ───────────────────────────── Resultado (efeito na interface) ─────────────────────────────

export interface CommandOption {
  label: string;
  detail: string;
  effect: CommandEffect;
}

export type CommandEffect =
  | { kind: 'ABRIR_PECA'; pieceId: string; serviceOrderId: string }
  | { kind: 'ABRIR_OS_SEM_POSICAO'; serviceOrderId: string; osCode: string }
  | { kind: 'ESCOLHER'; options: CommandOption[] }
  | {
      kind: 'MATERIAL';
      items: {
        stockItemId: string;
        code: string;
        description: string;
        available: number;
        onHand: number;
        reserved: number;
        unit: string;
        locations: { spaceKey: string; unitId: string; slotId: string; address: string }[];
      }[];
      exclusive: {
        serviceOrderId: string;
        osCode: string;
        description: string;
        need: number;
        received: number;
        unit: string;
      }[];
    }
  | {
      kind: 'MOVER_PREVIA';
      spaceKey: string;
      objectId: string;
      objectName: string;
      targetLabel: string;
      from: { xCm: number; yCm: number; rotation: number };
      to: { xCm: number; yCm: number; rotation: number };
      occupied: boolean;
      alternatives: { xCm: number; yCm: number; rotation: number }[];
    }
  | { kind: 'PLANTA'; spaceKey: string; text: string }
  | {
      kind: 'ATRIBUIR_PREVIA';
      mode: 'TROCAR_RESPONSAVEL' | 'PLANEJAR';
      serviceOrderId: string;
      osCode: string;
      pieceLabel: string;
      etapa: string;
      funcionario: string;
      userId: string;
      data: string;
      taskId: string | null;
      taskVersion: number | null;
      published: boolean;
      pieces: { serviceOrderItemId: string; upholstererUserId: string }[];
    }
  | {
      kind: 'LISTA';
      title: string;
      rows: { label: string; detail: string; effect: CommandEffect | null; href?: string }[];
    }
  | { kind: 'NADA' };

export interface CommandResultDto {
  interpretedBy: 'IA' | 'REGRAS';
  intent: CommandIntent;
  reply: string;
  effect: CommandEffect;
}
