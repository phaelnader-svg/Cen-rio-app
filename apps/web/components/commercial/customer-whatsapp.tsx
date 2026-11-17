'use client';
/**
 * Mensagem pronta para o cliente final ("seu sofá está pronto", "retirada amanhã"…): o gestor
 * escolhe o aviso, ajusta o texto e o WhatsApp abre com tudo escrito. Funciona sem integração
 * (link do WhatsApp); quem envia é a pessoa.
 */
import {
  CUSTOMER_MESSAGE_KINDS,
  CUSTOMER_MESSAGE_LABEL,
  type CustomerMessageKind,
  customerMessage,
  whatsappLink,
  whatsappNumber,
} from '@cenario/shared';
import { MessageCircle } from 'lucide-react';
import { useState } from 'react';
import { BUTTON_BASE, BUTTON_SIZES, BUTTON_VARIANTS } from '@/components/ui/button-styles';
import { Button } from '@/components/ui/button';
import { Dialog } from '@/components/ui/dialog';
import { Field, Select, Textarea } from '@/components/ui/field';
import { useCustomer } from '@/lib/commercial';
import { useCompany } from '@/lib/queries';

export function CustomerWhatsApp({
  customerId,
  customerName,
  piece,
  code,
  date,
  initialKind = 'PRONTO',
  kinds = CUSTOMER_MESSAGE_KINDS,
  label = 'Avisar cliente',
}: {
  customerId: string;
  customerName: string;
  piece?: string | null;
  code?: string | null;
  /** dd/mm (prazo, retirada ou entrega). */
  date?: string | null;
  initialKind?: CustomerMessageKind;
  kinds?: readonly CustomerMessageKind[];
  label?: string;
}) {
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<CustomerMessageKind>(initialKind);
  const [edited, setEdited] = useState<string | null>(null);
  const customer = useCustomer(open ? customerId : '');
  const company = useCompany(open);
  const phone = customer.data?.whatsapp || customer.data?.phone || null;
  const companyName = company.data?.tradeName ?? '';
  // Texto gerado até o gestor editar; trocar o aviso volta ao texto gerado.
  const text = edited ?? customerMessage({ kind, customerName, companyName, piece, code, date });
  return (
    <>
      <Button
        variant="secondary"
        icon={<MessageCircle className="size-4" aria-hidden />}
        onClick={() => setOpen(true)}
        data-testid="customer-whatsapp"
      >
        {label}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Mensagem para ${customerName}`}
        description="Revise o texto. O WhatsApp abre com a mensagem pronta; quem envia é você."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Fechar
            </Button>
            <a
              className={`${BUTTON_BASE} ${BUTTON_VARIANTS.primary} ${BUTTON_SIZES.md}`}
              href={whatsappLink(phone, text)}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() => setOpen(false)}
              data-testid="customer-whatsapp-open"
            >
              <MessageCircle className="size-4" aria-hidden />
              Abrir no WhatsApp
            </a>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Aviso">
            {(f) => (
              <Select
                {...f}
                value={kind}
                onChange={(e) => {
                  setKind(e.target.value as CustomerMessageKind);
                  setEdited(null);
                }}
              >
                {kinds.map((k) => (
                  <option key={k} value={k}>
                    {CUSTOMER_MESSAGE_LABEL[k]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field
            label="Mensagem"
            hint={
              customer.isLoading
                ? 'Buscando o telefone do cliente…'
                : whatsappNumber(phone)
                  ? `Vai para ${phone}.`
                  : 'O cliente não tem WhatsApp cadastrado: o WhatsApp vai pedir para você escolher o contato.'
            }
          >
            {(f) => (
              <Textarea {...f} rows={7} value={text} onChange={(e) => setEdited(e.target.value)} />
            )}
          </Field>
        </div>
      </Dialog>
    </>
  );
}
