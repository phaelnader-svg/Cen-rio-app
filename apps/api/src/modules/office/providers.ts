/**
 * Adaptadores dos provedores do escritório.
 * - Assinatura: Clicksign API v3 (envelopes JSON:API). Implementado conforme a documentação
 *   pública; precisa ser homologado no sandbox da Clicksign com a conta da Cenário.
 * - Cobranças: Asaas API v3 (clientes, cobranças Pix/boleto/cartão, QR Code Pix).
 * Em TESTE_LOCAL (fora de produção) nada sai da máquina: os ids são gerados localmente e a
 * confirmação chega pelo MESMO webhook, autenticado como o provedor faria.
 */
import { randomUUID } from 'node:crypto';
import { Errors } from '../../lib/errors';

export interface ProviderConn {
  mode: string;
  secret: { apiKey?: string } | null;
}
const isTest = (c: ProviderConn) => c.mode === 'TESTE_LOCAL';

async function http(
  base: string,
  path: string,
  init: { method: string; headers: Record<string, string>; body?: unknown },
) {
  const r = await fetch(`${base}${path}`, {
    method: init.method,
    headers: { 'content-type': 'application/json', accept: 'application/json', ...init.headers },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await r.text();
  if (!r.ok) throw Errors.business(`Provedor recusou (${r.status}): ${text.slice(0, 300)}`);
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

// ───────────────────────────── Clicksign ─────────────────────────────

export interface Signer {
  name: string;
  email: string;
  phone?: string | null;
  role: 'CONTRATANTE' | 'CONTRATADA' | 'TESTEMUNHA';
}

export async function clicksignSend(
  c: ProviderConn,
  input: { name: string; pdf: Buffer; signers: Signer[] },
) {
  if (isTest(c)) return { envelopeId: `env-teste-${randomUUID()}`, test: true };
  const base = process.env.CLICKSIGN_BASE_URL ?? 'https://sandbox.clicksign.com';
  const token = c.secret?.apiKey ?? process.env.CLICKSIGN_ACCESS_TOKEN;
  if (!token) throw Errors.business('Clicksign sem token de API (CLICKSIGN_ACCESS_TOKEN).');
  const h = {
    Authorization: token,
    'content-type': 'application/vnd.api+json',
    accept: 'application/vnd.api+json',
  };
  const env = (await http(base, '/api/v3/envelopes', {
    method: 'POST',
    headers: h,
    body: {
      data: {
        type: 'envelopes',
        attributes: {
          name: input.name,
          locale: 'pt-BR',
          auto_close: true,
          block_after_refusal: true,
        },
      },
    },
  })) as { data: { id: string } };
  const id = env.data.id;
  const doc = (await http(base, `/api/v3/envelopes/${id}/documents`, {
    method: 'POST',
    headers: h,
    body: {
      data: {
        type: 'documents',
        attributes: {
          filename: `${input.name}.pdf`,
          content_base64: `data:application/pdf;base64,${input.pdf.toString('base64')}`,
        },
      },
    },
  })) as { data: { id: string } };
  for (const s of input.signers) {
    const signer = (await http(base, `/api/v3/envelopes/${id}/signers`, {
      method: 'POST',
      headers: h,
      body: {
        data: {
          type: 'signers',
          attributes: {
            name: s.name,
            email: s.email,
            ...(s.phone ? { phone_number: s.phone } : {}),
            communicate_events: {
              signature_request: 'email',
              signature_reminder: 'email',
              document_signed: 'email',
            },
          },
        },
      },
    })) as { data: { id: string } };
    const rel = {
      document: { data: { type: 'documents', id: doc.data.id } },
      signer: { data: { type: 'signers', id: signer.data.id } },
    };
    await http(base, `/api/v3/envelopes/${id}/requirements`, {
      method: 'POST',
      headers: h,
      body: {
        data: {
          type: 'requirements',
          attributes: {
            action: 'agree',
            role:
              s.role === 'TESTEMUNHA'
                ? 'witness'
                : s.role === 'CONTRATADA'
                  ? 'contractee'
                  : 'contractor',
          },
          relationships: rel,
        },
      },
    });
    await http(base, `/api/v3/envelopes/${id}/requirements`, {
      method: 'POST',
      headers: h,
      body: {
        data: {
          type: 'requirements',
          attributes: { action: 'provide_evidence', auth: 'email' },
          relationships: rel,
        },
      },
    });
  }
  await http(base, `/api/v3/envelopes/${id}`, {
    method: 'PATCH',
    headers: h,
    body: { data: { id, type: 'envelopes', attributes: { status: 'running' } } },
  });
  return { envelopeId: id, test: false };
}

// ───────────────────────────── Asaas ─────────────────────────────

export type BillingType = 'PIX' | 'BOLETO' | 'CARTAO' | 'LINK';
const ASAAS_TYPE: Record<BillingType, string> = {
  PIX: 'PIX',
  BOLETO: 'BOLETO',
  CARTAO: 'CREDIT_CARD',
  LINK: 'UNDEFINED',
};

function asaas(c: ProviderConn) {
  const base = process.env.ASAAS_BASE_URL ?? 'https://api-sandbox.asaas.com/v3';
  const key = c.secret?.apiKey ?? process.env.ASAAS_API_KEY;
  if (!key) throw Errors.business('Asaas sem chave de API (ASAAS_API_KEY).');
  return { base, h: { access_token: key, 'User-Agent': 'cenario-gestao' } };
}

/** Pix "copia e cola" de teste (formato EMV, não pagável). */
function testPix(amountCents: number, ref: string) {
  const v = (amountCents / 100).toFixed(2);
  return `00020126580014br.gov.bcb.pix0136teste-cenario-${ref.slice(0, 8)}5204000053039865406${v.padStart(6, '0')}5802BR5917CENARIO ESTOFADOS6015SAO JOSE CAMPOS62070503***6304TEST`;
}

export async function asaasCreateCharge(
  c: ProviderConn,
  input: {
    customer: { name: string; document: string | null; email: string | null; phone: string | null };
    billingType: BillingType;
    amountCents: number;
    dueDate: string;
    description: string;
    externalReference: string;
    installments?: number | null;
  },
) {
  if (isTest(c)) {
    const id = `pay_teste_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
    return {
      id,
      pixPayload: input.billingType === 'PIX' ? testPix(input.amountCents, id) : null,
      paymentUrl: `https://sandbox.asaas.test/i/${id}`,
      test: true,
    };
  }
  const { base, h } = asaas(c);
  if (!input.customer.document)
    throw Errors.business('O Asaas exige CPF/CNPJ do cliente para emitir a cobrança.');
  const found = (await http(
    base,
    `/customers?cpfCnpj=${encodeURIComponent(input.customer.document)}`,
    { method: 'GET', headers: h },
  )) as { data?: { id: string }[] };
  const customerId =
    found.data?.[0]?.id ??
    (
      (await http(base, '/customers', {
        method: 'POST',
        headers: h,
        body: {
          name: input.customer.name,
          cpfCnpj: input.customer.document,
          email: input.customer.email ?? undefined,
          mobilePhone: input.customer.phone ?? undefined,
        },
      })) as { id: string }
    ).id;
  const value = input.amountCents / 100;
  const card = input.billingType === 'CARTAO' && (input.installments ?? 1) > 1;
  const p = (await http(base, '/payments', {
    method: 'POST',
    headers: h,
    body: {
      customer: customerId,
      billingType: ASAAS_TYPE[input.billingType],
      dueDate: input.dueDate,
      description: input.description,
      externalReference: input.externalReference,
      ...(card ? { installmentCount: input.installments, totalValue: value } : { value }),
    },
  })) as { id: string; invoiceUrl?: string };
  let pixPayload: string | null = null;
  if (input.billingType === 'PIX')
    pixPayload =
      (
        (await http(base, `/payments/${p.id}/pixQrCode`, { method: 'GET', headers: h })) as {
          payload?: string;
        }
      ).payload ?? null;
  return { id: p.id, pixPayload, paymentUrl: p.invoiceUrl ?? null, test: false };
}

export async function asaasUpdateDue(c: ProviderConn, id: string, dueDate: string) {
  if (isTest(c)) return;
  const { base, h } = asaas(c);
  await http(base, `/payments/${id}`, { method: 'PUT', headers: h, body: { dueDate } });
}

export async function asaasCancel(c: ProviderConn, id: string) {
  if (isTest(c)) return;
  const { base, h } = asaas(c);
  await http(base, `/payments/${id}`, { method: 'DELETE', headers: h });
}
