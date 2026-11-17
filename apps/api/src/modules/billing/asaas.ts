/**
 * Cliente mínimo do Asaas para a assinatura do Cenário Gestão (decisão do dono: Asaas, 2026-11-17).
 * Docs: https://docs.asaas.com (clientes, assinaturas, cobranças). O valor é cobrado na conta da
 * Cenário; a pessoa escolhe Pix, boleto ou cartão na página de pagamento do Asaas (billingType
 * UNDEFINED).
 */
export interface AsaasConfig {
  apiKey: string;
  baseUrl: string;
}

export interface AsaasPayment {
  id: string;
  subscription?: string | null;
  value: number;
  dueDate: string;
  status: string;
  invoiceUrl?: string | null;
  externalReference?: string | null;
}

export class AsaasError extends Error {}

export class AsaasClient {
  constructor(
    private readonly cfg: AsaasConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.cfg.baseUrl}${path}`, {
      method,
      headers: {
        access_token: this.cfg.apiKey,
        'content-type': 'application/json',
        'user-agent': 'cenario-gestao',
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    }).catch((err: unknown) => {
      throw new AsaasError(
        `sem resposta do Asaas (${(err as Error).message}). Tente de novo em instantes.`,
      );
    });
    const text = await res.text();
    const json = text ? (JSON.parse(text) as unknown) : {};
    if (!res.ok) {
      const errors = (json as { errors?: { description?: string }[] }).errors;
      throw new AsaasError(
        errors
          ?.map((e) => e.description)
          .filter(Boolean)
          .join(' ') || `Asaas respondeu ${res.status}.`,
      );
    }
    return json as T;
  }

  createCustomer(input: {
    name: string;
    email: string;
    cpfCnpj: string;
    externalReference: string;
  }) {
    return this.call<{ id: string }>('POST', '/customers', {
      ...input,
      notificationDisabled: false,
    });
  }

  updateCustomer(id: string, input: { name?: string; email?: string; cpfCnpj?: string }) {
    return this.call<{ id: string }>('PUT', `/customers/${encodeURIComponent(id)}`, input);
  }

  createSubscription(input: {
    customer: string;
    value: number;
    nextDueDate: string;
    cycle: 'MONTHLY' | 'YEARLY';
    description: string;
    externalReference: string;
  }) {
    return this.call<{ id: string }>('POST', '/subscriptions', {
      ...input,
      billingType: 'UNDEFINED',
    });
  }

  cancelSubscription(id: string) {
    return this.call<{ deleted: boolean }>('DELETE', `/subscriptions/${encodeURIComponent(id)}`);
  }

  subscriptionPayments(id: string) {
    return this.call<{ data: AsaasPayment[] }>(
      'GET',
      `/subscriptions/${encodeURIComponent(id)}/payments`,
    );
  }
}
