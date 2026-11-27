import { z } from 'zod';
import { PLANS, planPriceCents, type PlanKey } from './billing';
import { EMAIL_MAX } from './schemas/auth';

/**
 * LGPD e dados legais (2026-11-25). Os dados da empresa que vende o Cenário Gestão ficam aqui,
 * num lugar só: o site (rodapé, política de privacidade, termos, reembolso) e a API (e-mail do
 * encarregado de dados) leem daqui. `null` = ainda não informado pelo dono; NUNCA um valor
 * inventado. Enquanto faltar algum, as páginas legais aparecem com "[PREENCHER]" no
 * desenvolvimento e na homologação, e ficam fora do ar em produção.
 */
export const LEGAL = {
  /** Razão social de quem vende o sistema (como está no CNPJ). */
  razaoSocial: null as string | null,
  /** Nome que aparece para o público (marca). */
  nomeFantasia: 'Cenário Estofados',
  /** CNPJ com pontuação (00.000.000/0000-00). */
  cnpj: null as string | null,
  /** Endereço completo: rua, número, bairro, cidade, UF e CEP. */
  endereco: null as string | null,
  /** E-mail do encarregado de dados (LGPD, art. 41): recebe os pedidos sobre dados pessoais. */
  emailPrivacidade: null as string | null,
  /** Nome do encarregado (pessoa ou área). Vazio: "Encarregado de dados da Cenário Estofados". */
  encarregado: null as string | null,
  /** Cidade do foro dos termos de uso (normalmente a da sede). */
  foro: null as string | null,
};

/** Data da versão atual dos textos legais (muda quando o texto muda; vai para a auditoria). */
export const LEGAL_VERSION = '2026-11-25';

/** Itens que faltam para os textos legais irem ao ar em produção. */
export function legalPending(legal: typeof LEGAL = LEGAL): string[] {
  const out: string[] = [];
  if (!legal.razaoSocial) out.push('Razão social');
  if (!legal.cnpj) out.push('CNPJ');
  if (!legal.endereco) out.push('Endereço');
  if (!legal.emailPrivacidade) out.push('E-mail do encarregado de dados');
  if (!legal.foro) out.push('Cidade do foro');
  return out;
}

/** Prazo da resposta a um pedido sobre dados (LGPD, art. 19, II: até 15 dias). */
export const PRIVACY_RESPONSE_DAYS = 15;

/** Direitos do titular (LGPD, art. 18), em português simples. */
export const PRIVACY_REQUEST_KINDS = [
  'EXCLUIR',
  'ACESSAR',
  'CORRIGIR',
  'PORTABILIDADE',
  'REVOGAR',
  'OUTRO',
] as const;
export type PrivacyRequestKind = (typeof PRIVACY_REQUEST_KINDS)[number];
export const PRIVACY_REQUEST_KIND_LABEL: Record<PrivacyRequestKind, string> = {
  EXCLUIR: 'Apagar os meus dados',
  ACESSAR: 'Saber quais dados meus vocês têm',
  CORRIGIR: 'Corrigir um dado errado',
  PORTABILIDADE: 'Receber uma cópia dos meus dados',
  REVOGAR: 'Retirar uma autorização que eu dei',
  OUTRO: 'Outra dúvida sobre os meus dados',
};

/** Quem está pedindo (muda quem decide: a tapeçaria é dona dos dados dos clientes dela). */
export const PRIVACY_REQUESTER_KINDS = ['USUARIO', 'CLIENTE_TAPECARIA', 'OUTRO'] as const;
export type PrivacyRequesterKind = (typeof PRIVACY_REQUESTER_KINDS)[number];
export const PRIVACY_REQUESTER_KIND_LABEL: Record<PrivacyRequesterKind, string> = {
  USUARIO: 'Tenho conta no Cenário Gestão (ou trabalho numa empresa que tem)',
  CLIENTE_TAPECARIA: 'Sou cliente de uma tapeçaria que usa o Cenário Gestão',
  OUTRO: 'Outro (por exemplo, falei com vocês pelo WhatsApp)',
};

export const PRIVACY_REQUEST_STATUSES = ['NOVO', 'EM_ANDAMENTO', 'ATENDIDO', 'RECUSADO'] as const;
export type PrivacyRequestStatus = (typeof PRIVACY_REQUEST_STATUSES)[number];
export const PRIVACY_REQUEST_STATUS_LABEL: Record<PrivacyRequestStatus, string> = {
  NOVO: 'Novo',
  EM_ANDAMENTO: 'Em andamento',
  ATENDIDO: 'Atendido',
  RECUSADO: 'Não pôde ser atendido',
};

/** Pedido feito pela página pública /privacidade/pedido (sem login). */
export const privacyRequestPublicSchema = z.object({
  name: z
    .string()
    .trim()
    .min(2, { message: 'Informe o seu nome.' })
    .max(120, { message: 'Nome muito longo.' }),
  email: z.string().trim().toLowerCase().email({ message: 'E-mail inválido.' }).max(EMAIL_MAX),
  kind: z.enum(PRIVACY_REQUEST_KINDS, { message: 'Escolha o que você quer.' }),
  requester: z.enum(PRIVACY_REQUESTER_KINDS, { message: 'Conte quem você é.' }),
  /** Nome da tapeçaria, quando é cliente de uma (ajuda a achar os dados). */
  company: z.string().trim().max(120).optional(),
  message: z.string().trim().max(2000, { message: 'Texto muito longo.' }).optional(),
  captcha: z.string().max(4096).optional(),
  /** Campo-isca: só robô preenche. */
  website: z.string().max(200).optional(),
});
export type PrivacyRequestPublicInput = z.infer<typeof privacyRequestPublicSchema>;

/** Pedido feito de dentro do painel (a pessoa já está identificada pelo login). */
export const privacyRequestAccountSchema = z.object({
  /** MINHA_CONTA: só os dados da pessoa. EMPRESA: a conta da empresa inteira (só o gestor). */
  scope: z.enum(['MINHA_CONTA', 'EMPRESA']),
  kind: z.enum(PRIVACY_REQUEST_KINDS),
  message: z.string().trim().max(2000, { message: 'Texto muito longo.' }).optional(),
});
export type PrivacyRequestAccountInput = z.infer<typeof privacyRequestAccountSchema>;

export interface PrivacyRequestDto {
  id: string;
  protocol: string;
  companyId: number;
  companyName: string | null;
  scope: 'PUBLICO' | 'MINHA_CONTA' | 'EMPRESA';
  kind: PrivacyRequestKind;
  requester: PrivacyRequesterKind | null;
  name: string;
  email: string;
  company: string | null;
  message: string | null;
  status: PrivacyRequestStatus;
  createdAt: string;
  dueAt: string;
}

/** Número do protocolo mostrado à pessoa (os 8 primeiros caracteres do id, em maiúsculas). */
export const privacyProtocol = (id: string) => id.replace(/-/g, '').slice(0, 8).toUpperCase();

/**
 * Devolução do plano anual cancelado depois dos 7 dias (decisão do dono, 2026-11-25): os meses
 * usados são cobrados pelo preço do plano mensal (sem o desconto do anual) e o resto volta ao
 * cliente. Mês começado conta como usado. Nunca negativo.
 */
export function annualRefundCents(plan: PlanKey, monthsUsed: number): number {
  const paid = planPriceCents(plan, 'ANUAL');
  const used = Math.min(12, Math.max(0, Math.ceil(monthsUsed))) * PLANS[plan].monthlyCents;
  return Math.max(0, paid - used);
}

/** Dias depois do vencimento até bloquear (o mesmo padrão de BILLING_GRACE_DAYS da API). */
export const BILLING_GRACE_DAYS_DEFAULT = 5;
