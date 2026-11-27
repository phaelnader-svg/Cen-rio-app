import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { LEGAL } from '@cenario/shared';
import { Dado, LegalShell, Secao, legalMode } from '@/components/site/legal/legal';
import { legalMetadata } from '@/components/site/legal/meta';
import { PrivacyRequestForm } from '@/components/site/legal/request-form';

export const dynamic = 'force-dynamic';

export function generateMetadata(): Promise<Metadata> {
  return legalMetadata(
    '/privacidade/pedido',
    'Pedir sobre os seus dados',
    'Peça para ver, corrigir, receber ou apagar os seus dados pessoais no Cenário Gestão.',
  );
}

export default async function Page() {
  if ((await legalMode()) === 'off') notFound();
  return (
    <LegalShell
      title="Pedir sobre os seus dados"
      intro={
        <p>
          Quer saber quais dados seus estão no Cenário Gestão, corrigir algum ou pedir para apagar?
          Preencha abaixo. Você recebe um protocolo na hora.
        </p>
      }
    >
      <Secao id="pedido" titulo="Seu pedido">
        <PrivacyRequestForm />
      </Secao>
      <Secao id="outros-caminhos" titulo="Outros caminhos">
        <ul>
          <li>
            Tem conta? Entre no sistema e vá em Minha conta, &quot;Seus dados&quot;: o pedido já
            chega com a sua conta identificada.
          </li>
          <li>
            Gestor que quer baixar todos os dados da empresa: tela Empresa, &quot;Baixar todos os
            dados&quot;. Sai na hora.
          </li>
          <li>
            Por e-mail: <Dado v={LEGAL.emailPrivacidade} nome="e-mail do encarregado" />.
          </li>
        </ul>
        <p>
          Nada é apagado sem conferir: antes, confirmamos que o pedido é seu e avisamos o que a lei
          manda guardar (como registros de acesso e dados de cobrança). Leia a{' '}
          <a href="/privacidade">política de privacidade</a>.
        </p>
      </Secao>
    </LegalShell>
  );
}
