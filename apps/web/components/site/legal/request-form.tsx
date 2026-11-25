'use client';

import {
  PRIVACY_REQUEST_KINDS,
  PRIVACY_REQUEST_KIND_LABEL,
  PRIVACY_REQUESTER_KINDS,
  PRIVACY_REQUESTER_KIND_LABEL,
  PRIVACY_RESPONSE_DAYS,
  privacyRequestPublicSchema,
  type PrivacyRequestKind,
  type PrivacyRequesterKind,
} from '@cenario/shared';
import { Send } from 'lucide-react';
import { useState } from 'react';
import { Honeypot, Turnstile } from '@/components/account/turnstile';
import { Button } from '@/components/ui/button';
import { FormGrid, SelectField, TextAreaField, TextField } from '@/components/ui/form';
import { Alert } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';

/**
 * Pedido sobre dados pessoais pela página pública (LGPD, art. 18). Só pede o necessário para
 * achar os dados e responder: nome, e-mail, o que a pessoa quer e quem ela é.
 */
export function PrivacyRequestForm() {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [kind, setKind] = useState<PrivacyRequestKind | ''>('');
  const [requester, setRequester] = useState<PrivacyRequesterKind | ''>('');
  const [company, setCompany] = useState('');
  const [message, setMessage] = useState('');
  const [captcha, setCaptcha] = useState<string | undefined>();
  const [website, setWebsite] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState<{ protocol: string; dueAt: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    const body = {
      name,
      email,
      kind: kind || undefined,
      requester: requester || undefined,
      company: requester === 'CLIENTE_TAPECARIA' ? company : undefined,
      message: message || undefined,
      captcha,
      website,
    };
    const parsed = privacyRequestPublicSchema.safeParse(body);
    if (!parsed.success) {
      const map: Record<string, string> = {};
      for (const i of parsed.error.issues) map[String(i.path[0])] ??= i.message;
      setErrors(map);
      return;
    }
    setErrors({});
    setLoading(true);
    try {
      setDone(
        await api<{ protocol: string; dueAt: string }>('/api/v1/privacy/requests', {
          method: 'POST',
          body: parsed.data,
        }),
      );
    } catch (err) {
      setFormError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }

  if (done)
    return (
      <Alert tone="ok" title={`Pedido recebido. Protocolo ${done.protocol}`}>
        Mandamos uma confirmação para {email}. A resposta chega nesse e-mail até{' '}
        {new Date(done.dueAt).toLocaleDateString('pt-BR')}. Se precisarmos confirmar que é você,
        avisamos antes de mudar ou apagar qualquer coisa.
      </Alert>
    );

  return (
    <form onSubmit={submit} noValidate className="relative" data-testid="pedido-dados">
      <FormGrid>
        <TextField
          label="Seu nome"
          cols={6}
          autoComplete="name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          error={errors.name}
          required
        />
        <TextField
          label="Seu e-mail"
          hint="A resposta chega aqui."
          cols={6}
          type="email"
          inputMode="email"
          autoComplete="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          error={errors.email}
          required
        />
        <SelectField
          label="O que você quer"
          cols={12}
          value={kind}
          onChange={(e) => setKind(e.target.value as PrivacyRequestKind)}
          error={errors.kind}
          required
        >
          <option value="">Escolha</option>
          {PRIVACY_REQUEST_KINDS.map((k) => (
            <option key={k} value={k}>
              {PRIVACY_REQUEST_KIND_LABEL[k]}
            </option>
          ))}
        </SelectField>
        <SelectField
          label="Quem é você"
          cols={12}
          value={requester}
          onChange={(e) => setRequester(e.target.value as PrivacyRequesterKind)}
          error={errors.requester}
          required
        >
          <option value="">Escolha</option>
          {PRIVACY_REQUESTER_KINDS.map((k) => (
            <option key={k} value={k}>
              {PRIVACY_REQUESTER_KIND_LABEL[k]}
            </option>
          ))}
        </SelectField>
        {requester === 'CLIENTE_TAPECARIA' && (
          <TextField
            label="Nome da tapeçaria"
            hint="Ajuda a achar os seus dados. Os dados dos clientes são da tapeçaria: nós encaminhamos o pedido para ela."
            cols={12}
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            error={errors.company}
          />
        )}
        <TextAreaField
          label="Quer explicar melhor? (opcional)"
          cols={12}
          rows={3}
          maxLength={2000}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          error={errors.message}
        />
      </FormGrid>
      <Honeypot value={website} onChange={setWebsite} />
      <div className="mt-4">
        <Turnstile onToken={setCaptcha} />
      </div>
      {formError && (
        <Alert tone="danger" className="mt-4">
          {formError}
        </Alert>
      )}
      <p className="mt-4 text-sm text-ink-muted">
        Usamos esses dados só para atender o pedido. Resposta em até {PRIVACY_RESPONSE_DAYS} dias.
      </p>
      <Button
        type="submit"
        size="lg"
        className="mt-4"
        loading={loading}
        icon={<Send className="size-4" aria-hidden />}
      >
        Enviar pedido
      </Button>
    </form>
  );
}
