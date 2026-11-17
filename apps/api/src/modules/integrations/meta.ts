/**
 * Conector da Meta (WhatsApp Cloud API, Instagram, Messenger e Marketing API).
 *
 * - Autorização: diálogo OAuth oficial (facebook.com/<versão>/dialog/oauth); para o WhatsApp, o
 *   Cadastro Incorporado (config_id) com coexistência do app WhatsApp Business.
 * - Tokens trocados e guardados SÓ no servidor (cofre cifrado).
 * - Webhooks: assinatura X-Hub-Signature-256 (HMAC-SHA256 do corpo com a chave do app).
 * - Modo de teste local (desenvolvimento/homologação): as mesmas funções respondem sem rede,
 *   marcando o resultado como teste; nada sai para a Meta.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { Errors } from '../../lib/errors';

export const GRAPH = () =>
  `https://graph.facebook.com/${process.env.META_GRAPH_VERSION || 'v23.0'}`;
const DIALOG = () =>
  `https://www.facebook.com/${process.env.META_GRAPH_VERSION || 'v23.0'}/dialog/oauth`;

export interface MetaSecret {
  userToken?: string;
  pageToken?: string;
}
export interface ConnLike {
  providerKey: string;
  mode: string;
  config: Record<string, unknown>;
  secret: MetaSecret | null;
}

export const isTest = (c: { mode: string }) => c.mode === 'TESTE_LOCAL';

async function graph<T>(
  path: string,
  init: {
    method?: string;
    token: string;
    body?: Record<string, unknown>;
    query?: Record<string, string>;
  },
) {
  const url = new URL(`${GRAPH()}${path}`);
  for (const [k, v] of Object.entries(init.query ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method: init.method ?? 'GET',
    headers: {
      authorization: `Bearer ${init.token}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
  });
  const json = (await res.json().catch(() => ({}))) as T & {
    error?: { message?: string; code?: number };
  };
  if (!res.ok || json.error)
    throw Errors.business(`Meta: ${json.error?.message ?? `HTTP ${res.status}`}`);
  return json;
}

// ───────────────────────────── OAuth ─────────────────────────────

export function authorizeUrl(scopes: string[], state: string, whatsapp: boolean) {
  const u = new URL(DIALOG());
  u.searchParams.set('client_id', process.env.META_APP_ID ?? '');
  u.searchParams.set('redirect_uri', process.env.META_REDIRECT_URI ?? '');
  u.searchParams.set('state', state);
  u.searchParams.set('response_type', 'code');
  if (whatsapp && process.env.META_WA_CONFIG_ID) {
    // Cadastro Incorporado do WhatsApp com coexistência (o número continua no app do celular).
    u.searchParams.set('config_id', process.env.META_WA_CONFIG_ID);
    u.searchParams.set('override_default_response_type', 'true');
    u.searchParams.set(
      'extras',
      JSON.stringify({
        setup: {},
        featureType: 'whatsapp_business_app_onboarding',
        sessionInfoVersion: '3',
      }),
    );
  } else u.searchParams.set('scope', scopes.join(','));
  return u.toString();
}

export async function exchangeCode(code: string) {
  const short = await graph<{ access_token: string }>('/oauth/access_token', {
    token: '',
    query: {
      client_id: process.env.META_APP_ID ?? '',
      client_secret: process.env.META_APP_SECRET ?? '',
      redirect_uri: process.env.META_REDIRECT_URI ?? '',
      code,
    },
  });
  // Token de longa duração (60 dias); a Central mostra a validade e pede reconexão.
  return graph<{ access_token: string; expires_in?: number }>('/oauth/access_token', {
    token: '',
    query: {
      grant_type: 'fb_exchange_token',
      client_id: process.env.META_APP_ID ?? '',
      client_secret: process.env.META_APP_SECRET ?? '',
      fb_exchange_token: short.access_token,
    },
  });
}

export interface MetaAccounts {
  pages: {
    id: string;
    name: string;
    accessToken: string;
    instagram?: { id: string; username: string } | null;
  }[];
  wabas: { id: string; name: string; phones: { id: string; display: string; name: string }[] }[];
  adAccounts: { id: string; name: string }[];
}

export async function discoverAccounts(token: string): Promise<MetaAccounts> {
  const pages = await graph<{
    data: {
      id: string;
      name: string;
      access_token: string;
      instagram_business_account?: { id: string; username: string };
    }[];
  }>('/me/accounts', {
    token,
    query: { fields: 'id,name,access_token,instagram_business_account{id,username}' },
  }).catch(() => ({ data: [] }));
  const biz = await graph<{
    businesses?: {
      data: {
        owned_whatsapp_business_accounts?: {
          data: {
            id: string;
            name: string;
            phone_numbers?: {
              data: { id: string; display_phone_number: string; verified_name: string }[];
            };
          }[];
        };
      }[];
    };
  }>('/me', {
    token,
    query: {
      fields:
        'businesses{owned_whatsapp_business_accounts{id,name,phone_numbers{id,display_phone_number,verified_name}}}',
    },
  }).catch(() => ({ businesses: { data: [] } }));
  const ads = await graph<{ data: { id: string; name: string }[] }>('/me/adaccounts', {
    token,
    query: { fields: 'id,name' },
  }).catch(() => ({ data: [] }));
  return {
    pages: pages.data.map((p) => ({
      id: p.id,
      name: p.name,
      accessToken: p.access_token,
      instagram: p.instagram_business_account ?? null,
    })),
    wabas: (biz.businesses?.data ?? []).flatMap((b) =>
      (b.owned_whatsapp_business_accounts?.data ?? []).map((w) => ({
        id: w.id,
        name: w.name,
        phones: (w.phone_numbers?.data ?? []).map((p) => ({
          id: p.id,
          display: p.display_phone_number,
          name: p.verified_name,
        })),
      })),
    ),
    adAccounts: ads.data,
  };
}

export async function testConnection(c: ConnLike) {
  if (isTest(c))
    return { ok: true, detail: 'Modo de teste local: conexão simulada, nada sai para a Meta.' };
  const token = c.secret?.pageToken ?? c.secret?.userToken;
  if (!token) return { ok: false, detail: 'Sem token: conecte de novo.' };
  const me = await graph<{ id: string; name?: string }>('/me', {
    token,
    query: { fields: 'id,name' },
  });
  return { ok: true, detail: `Token válido para ${me.name ?? me.id}.` };
}

// ───────────────────────────── Envio ─────────────────────────────

export interface SendResult {
  externalId: string;
  test: boolean;
}

/** WhatsApp: texto livre (dentro de 24 h) ou modelo aprovado. */
export async function sendWhatsApp(
  c: ConnLike,
  to: string,
  msg: { text?: string; template?: { name: string; language: string } },
): Promise<SendResult> {
  if (isTest(c)) return { externalId: `wamid.teste.${Date.now()}`, test: true };
  const phoneId = String(c.config.phoneNumberId ?? '');
  if (!phoneId || !c.secret?.userToken) throw Errors.business('WhatsApp sem número conectado.');
  const body = msg.template
    ? {
        messaging_product: 'whatsapp',
        to,
        type: 'template',
        template: { name: msg.template.name, language: { code: msg.template.language } },
      }
    : { messaging_product: 'whatsapp', to, type: 'text', text: { body: msg.text } };
  const r = await graph<{ messages: { id: string }[] }>(`/${phoneId}/messages`, {
    method: 'POST',
    token: c.secret.userToken,
    body,
  });
  return { externalId: r.messages[0]?.id ?? '', test: false };
}

/** Instagram Direct e Messenger: resposta dentro da janela padrão de 24 h. */
export async function sendPageMessage(
  c: ConnLike,
  recipientId: string,
  text: string,
): Promise<SendResult> {
  if (isTest(c)) return { externalId: `mid.teste.${Date.now()}`, test: true };
  if (!c.secret?.pageToken) throw Errors.business('Página sem token: reconecte.');
  const r = await graph<{ message_id: string }>('/me/messages', {
    method: 'POST',
    token: c.secret.pageToken,
    body: { recipient: { id: recipientId }, messaging_type: 'RESPONSE', message: { text } },
  });
  return { externalId: r.message_id, test: false };
}

/** Publicação no Instagram (imagem pública + legenda): contêiner → publicar. */
export async function publishInstagram(
  c: ConnLike,
  imageUrl: string,
  caption: string,
): Promise<SendResult> {
  if (isTest(c)) return { externalId: `ig.media.teste.${Date.now()}`, test: true };
  const ig = String(c.config.instagramId ?? '');
  const token = c.secret?.pageToken;
  if (!ig || !token) throw Errors.business('Instagram não conectado.');
  if (!/^https:\/\//.test(imageUrl))
    throw Errors.business('A Meta só publica imagens com endereço público HTTPS.');
  const container = await graph<{ id: string }>(`/${ig}/media`, {
    method: 'POST',
    token,
    body: { image_url: imageUrl, caption },
  });
  const pub = await graph<{ id: string }>(`/${ig}/media_publish`, {
    method: 'POST',
    token,
    body: { creation_id: container.id },
  });
  return { externalId: pub.id, test: false };
}

// ───────────────────────────── Anúncios ─────────────────────────────

export interface CampaignDto {
  id: string;
  name: string;
  status: string;
  dailyBudgetCents: number | null;
  spendCents7d: number;
  impressions7d: number;
  clicks7d: number;
  leads7d: number;
  test: boolean;
}

export async function campaigns(c: ConnLike): Promise<CampaignDto[]> {
  if (isTest(c))
    return [
      {
        id: 'teste-1',
        name: 'Reforma de sofás — São José dos Campos',
        status: 'ACTIVE',
        dailyBudgetCents: 3000,
        spendCents7d: 19840,
        impressions7d: 18200,
        clicks7d: 412,
        leads7d: 9,
        test: true,
      },
      {
        id: 'teste-2',
        name: 'Cabeceiras sob medida',
        status: 'ACTIVE',
        dailyBudgetCents: 2000,
        spendCents7d: 13650,
        impressions7d: 15100,
        clicks7d: 168,
        leads7d: 2,
        test: true,
      },
      {
        id: 'teste-3',
        name: 'Remarketing site',
        status: 'PAUSED',
        dailyBudgetCents: 1500,
        spendCents7d: 0,
        impressions7d: 0,
        clicks7d: 0,
        leads7d: 0,
        test: true,
      },
    ];
  const act = String(c.config.adAccountId ?? '');
  const token = c.secret?.userToken;
  if (!act || !token) throw Errors.business('Conta de anúncios não selecionada.');
  const list = await graph<{
    data: { id: string; name: string; status: string; daily_budget?: string }[];
  }>(`/${act}/campaigns`, {
    token,
    query: { fields: 'id,name,status,daily_budget', limit: '50' },
  });
  const ins = await graph<{
    data: {
      campaign_id: string;
      spend: string;
      impressions: string;
      clicks: string;
      actions?: { action_type: string; value: string }[];
    }[];
  }>(`/${act}/insights`, {
    token,
    query: {
      level: 'campaign',
      date_preset: 'last_7d',
      fields: 'campaign_id,spend,impressions,clicks,actions',
    },
  });
  return list.data.map((x) => {
    const i = ins.data.find((y) => y.campaign_id === x.id);
    return {
      id: x.id,
      name: x.name,
      status: x.status,
      dailyBudgetCents: x.daily_budget ? Number(x.daily_budget) : null,
      spendCents7d: Math.round(Number(i?.spend ?? 0) * 100),
      impressions7d: Number(i?.impressions ?? 0),
      clicks7d: Number(i?.clicks ?? 0),
      leads7d: Number(
        i?.actions?.find((a) => /lead|messaging_conversation_started/.test(a.action_type))?.value ??
          0,
      ),
      test: false,
    };
  });
}

/** Altera o orçamento diário (centavos). Só é chamado depois da aprovação do gestor. */
export async function updateDailyBudget(c: ConnLike, campaignId: string, cents: number) {
  if (isTest(c)) return { test: true };
  if (!c.secret?.userToken) throw Errors.business('Anúncios sem token.');
  await graph(`/${campaignId}`, {
    method: 'POST',
    token: c.secret.userToken,
    body: { daily_budget: String(cents) },
  });
  return { test: false };
}

// ───────────────────────────── Webhooks ─────────────────────────────

/** Segredo usado para verificar a assinatura: o do app; no modo de teste local, um derivado. */
export function webhookSecret(testMode: boolean) {
  if (process.env.META_APP_SECRET) return process.env.META_APP_SECRET;
  if (testMode) return `teste-local:${process.env.TOKEN_HASH_SECRET ?? ''}`;
  return null;
}

export function signBody(secret: string, raw: Buffer | string) {
  return `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
}

export function verifySignature(secret: string | null, raw: Buffer, header: string | undefined) {
  if (!secret || !header) return false;
  const expected = Buffer.from(signBody(secret, raw));
  const got = Buffer.from(header);
  return expected.length === got.length && timingSafeEqual(expected, got);
}

export interface InboundMessage {
  channel: 'WHATSAPP' | 'INSTAGRAM' | 'MESSENGER';
  threadId: string;
  contactName: string | null;
  externalId: string;
  kind: string;
  text: string | null;
  media: { type: string; id?: string; url?: string; caption?: string }[];
  at: Date;
}

/** Normaliza o corpo do webhook (formato oficial de cada produto) em mensagens recebidas. */
export function parseWebhook(body: Record<string, unknown>): InboundMessage[] {
  const out: InboundMessage[] = [];
  const entries = (body.entry as Record<string, unknown>[] | undefined) ?? [];
  if (body.object === 'whatsapp_business_account') {
    for (const e of entries)
      for (const ch of (e.changes as { value: Record<string, unknown> }[] | undefined) ?? []) {
        const v = ch.value;
        const contacts =
          (v.contacts as { wa_id: string; profile?: { name?: string } }[] | undefined) ?? [];
        for (const m of (v.messages as Record<string, unknown>[] | undefined) ?? []) {
          const type = String(m.type ?? 'text');
          const media = ['image', 'audio', 'video', 'document'].includes(type)
            ? [{ type, ...(m[type] as Record<string, string>) }]
            : [];
          out.push({
            channel: 'WHATSAPP',
            threadId: String(m.from),
            contactName: contacts.find((c) => c.wa_id === m.from)?.profile?.name ?? null,
            externalId: String(m.id),
            kind: type === 'text' ? 'TEXT' : type.toUpperCase(),
            text:
              type === 'text'
                ? String((m.text as { body?: string })?.body ?? '')
                : ((m[type] as { caption?: string })?.caption ?? null),
            media,
            at: new Date(Number(m.timestamp ?? Date.now() / 1000) * 1000),
          });
        }
      }
  }
  if (body.object === 'instagram' || body.object === 'page') {
    const channel = body.object === 'instagram' ? 'INSTAGRAM' : 'MESSENGER';
    for (const e of entries)
      for (const ev of (e.messaging as Record<string, unknown>[] | undefined) ?? []) {
        const msg = ev.message as
          | {
              mid: string;
              text?: string;
              is_echo?: boolean;
              attachments?: { type: string; payload?: { url?: string } }[];
            }
          | undefined;
        if (!msg || msg.is_echo) continue;
        out.push({
          channel,
          threadId: String((ev.sender as { id: string }).id),
          contactName: null,
          externalId: msg.mid,
          kind: msg.attachments?.length
            ? (msg.attachments[0]!.type ?? 'OTHER').toUpperCase()
            : 'TEXT',
          text: msg.text ?? null,
          media: (msg.attachments ?? []).map((a) => ({ type: a.type, url: a.payload?.url })),
          at: new Date(Number(ev.timestamp ?? Date.now())),
        });
      }
  }
  return out;
}
