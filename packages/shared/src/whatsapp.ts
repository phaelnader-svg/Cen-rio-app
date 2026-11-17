/**
 * WhatsApp sem integração: link "clique para conversar" (wa.me) com o texto já escrito. Abre o
 * WhatsApp do próprio usuário (celular ou computador) e quem aperta "enviar" é a pessoa. Funciona
 * para qualquer empresa, sem conta na Meta. Com o WhatsApp conectado na Central, o envio pode sair
 * direto pelo número da empresa; o link continua sendo a alternativa.
 */

/** Só os dígitos, com o 55 do Brasil quando o número vier sem código do país. */
export function whatsappNumber(phone: string | null | undefined): string | null {
  const d = (phone ?? '').replace(/\D/g, '').replace(/^0+/, '');
  if (d.length === 10 || d.length === 11) return `55${d}`;
  if (d.length >= 12 && d.length <= 15) return d;
  return null;
}

/** Link do WhatsApp com o texto pronto. Sem número, abre a escolha do contato. */
export function whatsappLink(phone: string | null | undefined, text: string): string {
  const n = whatsappNumber(phone);
  return `https://wa.me/${n ?? ''}?text=${encodeURIComponent(text)}`;
}

const firstName = (name: string | null | undefined) => (name ?? '').trim().split(/\s+/)[0] ?? '';

export const CUSTOMER_MESSAGE_KINDS = [
  'PRONTO',
  'RETIRADA_AMANHA',
  'ENTREGA_AGENDADA',
  'ORCAMENTO_ENVIADO',
  'EM_PRODUCAO',
] as const;
export type CustomerMessageKind = (typeof CUSTOMER_MESSAGE_KINDS)[number];

export const CUSTOMER_MESSAGE_LABEL: Record<CustomerMessageKind, string> = {
  PRONTO: 'Peça pronta',
  RETIRADA_AMANHA: 'Retirada amanhã',
  ENTREGA_AGENDADA: 'Entrega agendada',
  ORCAMENTO_ENVIADO: 'Orçamento enviado',
  EM_PRODUCAO: 'Entrou em produção',
};

export interface CustomerMessageInput {
  kind: CustomerMessageKind;
  customerName: string | null;
  companyName: string;
  /** "sofá 3 lugares", "2 cadeiras"… */
  piece?: string | null;
  /** dd/mm (ou dd/mm às hh:mm). */
  date?: string | null;
  /** Saldo a pagar na entrega, já formatado. */
  balance?: string | null;
  code?: string | null;
}

/** Mensagem pronta para o cliente final (o gestor revisa antes de enviar). */
export function customerMessage(i: CustomerMessageInput): string {
  const hi = `Olá${firstName(i.customerName) ? `, ${firstName(i.customerName)}` : ''}!`;
  const what = i.piece?.trim() || 'seu estofado';
  const ref = i.code ? ` (${i.code})` : '';
  const sign = `\n\n${i.companyName}`;
  switch (i.kind) {
    case 'PRONTO':
      return `${hi} Boa notícia: ${what}${ref} está pronto. 🎉 Podemos combinar a entrega ou a retirada?${i.balance ? ` O saldo a pagar é de ${i.balance}.` : ''}${sign}`;
    case 'RETIRADA_AMANHA':
      return `${hi} Passando para confirmar a retirada de ${what}${ref} amanhã${i.date ? ` (${i.date})` : ''}. Alguém vai estar no local para nos receber?${sign}`;
    case 'ENTREGA_AGENDADA':
      return `${hi} A entrega de ${what}${ref} está agendada${i.date ? ` para ${i.date}` : ''}.${i.balance ? ` O saldo de ${i.balance} pode ser pago na entrega.` : ''} Qualquer mudança, é só avisar por aqui.${sign}`;
    case 'ORCAMENTO_ENVIADO':
      return `${hi} Enviamos o orçamento de ${what}${ref}. Ficou alguma dúvida sobre tecido, prazo ou pagamento? Estamos à disposição.${sign}`;
    case 'EM_PRODUCAO':
      return `${hi} ${what[0]!.toUpperCase()}${what.slice(1)}${ref} já entrou em produção na nossa oficina.${i.date ? ` A previsão de entrega é ${i.date}.` : ''} Avisamos assim que ficar pronto.${sign}`;
  }
}

/** Pedido de materiais para o fornecedor (o gestor aprova antes de sair). */
export function supplierOrderMessage(i: {
  supplierContact: string | null;
  companyName: string;
  items: { description: string; quantity: string | null; osCode: string }[];
  notes?: string | null;
}): string {
  const hi = `Olá${firstName(i.supplierContact) ? `, ${firstName(i.supplierContact)}` : ''}! Aqui é da ${i.companyName}.`;
  const lines = i.items.map(
    (x) => `• ${x.description}${x.quantity ? ` — ${x.quantity}` : ''} (${x.osCode})`,
  );
  return [
    hi,
    'Gostaria de fazer o pedido abaixo:',
    lines.join('\n'),
    i.notes?.trim() || null,
    'Pode me confirmar disponibilidade, valor e prazo de entrega? Obrigado!',
  ]
    .filter(Boolean)
    .join('\n\n');
}
