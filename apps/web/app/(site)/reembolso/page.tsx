import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { LEGAL, PLANS, annualRefundCents, planPriceCents } from '@cenario/shared';
import { SITE } from '@/components/site/config';
import { formatPhone } from '@/components/site/landing';
import { Dado, LegalShell, Secao, legalMode } from '@/components/site/legal/legal';
import { legalMetadata } from '@/components/site/legal/meta';

export const dynamic = 'force-dynamic';

export function generateMetadata(): Promise<Metadata> {
  return legalMetadata(
    '/reembolso',
    'Cancelamento e reembolso',
    'Como cancelar o Cenário Gestão e quando o dinheiro é devolvido: teste grátis, 7 dias de arrependimento, plano mensal e plano anual.',
  );
}

const brl = (cents: number) =>
  (cents / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

/** Exemplo calculado (nunca digitado à mão): plano anual cancelado depois de 3 meses. */
const EXEMPLO_MESES = 3;

export default async function Page() {
  if ((await legalMode()) === 'off') notFound();
  const anual = planPriceCents('gestao', 'ANUAL');
  const mensal = PLANS.gestao.monthlyCents;
  const devolve = annualRefundCents('gestao', EXEMPLO_MESES);
  return (
    <LegalShell
      title="Cancelamento e reembolso"
      intro={
        <p>
          Cancelar é simples e não tem multa. Aqui está quando o dinheiro volta, quanto volta e como
          pedir.
        </p>
      }
    >
      <Secao id="teste" titulo="1. Teste grátis">
        <p>
          Os {SITE.trialDays ?? '[dias]'} dias de teste são grátis e não pedem cartão. Se você não
          escolher um plano, nada é cobrado.
        </p>
      </Secao>

      <Secao id="arrependimento" titulo="2. Desistiu em até 7 dias? Devolvemos tudo">
        <p>
          Se você desistir em até 7 dias depois do primeiro pagamento de um plano (mensal ou anual),
          devolvemos o valor inteiro, sem perguntas. É o direito de arrependimento do Código de
          Defesa do Consumidor (art. 49) e vale também para empresas.
        </p>
      </Secao>

      <Secao id="mensal" titulo="3. Plano mensal">
        <p>
          Cancele quando quiser, sem multa. O sistema continua funcionando até o fim do mês já pago,
          e a próxima mensalidade não é cobrada. O mês em andamento não é devolvido.
        </p>
      </Secao>

      <Secao id="anual" titulo="4. Plano anual">
        <p>
          Depois dos 7 dias, os meses já usados são cobrados pelo preço do plano mensal (sem o
          desconto do anual), e o resto do dinheiro volta para você. Mês começado conta como mês
          usado.
        </p>
        <p>
          <strong>Exemplo:</strong> o plano Cenário Gestão anual custa {brl(anual)}. Quem cancela no
          terceiro mês usou {EXEMPLO_MESES} meses × {brl(mensal)} = {brl(EXEMPLO_MESES * mensal)}, e
          recebe de volta <strong>{brl(devolve)}</strong>.
        </p>
        <p>
          O plano com o Firma Viva segue a mesma conta, com o preço mensal dele (
          {brl(PLANS.gestao_jogo.monthlyCents)}).
        </p>
      </Secao>

      <Secao id="pausa" titulo="5. Pausar em vez de cancelar">
        <p>
          Se for só uma fase, dá para pausar por um mês na tela Assinatura: nada é cobrado nesse mês
          e os dados ficam guardados. Para voltar, é só reativar.
        </p>
      </Secao>

      <Secao id="cobranca-errada" titulo="6. Cobrança errada">
        <p>
          Se você foi cobrado por engano (cobrança em dobro, valor errado, cobrança depois de
          cancelar), devolvemos a diferença inteira assim que confirmarmos.
        </p>
      </Secao>

      <Secao id="como-pedir" titulo="7. Como cancelar e pedir a devolução">
        <ul>
          <li>Cancelar: no sistema, tela Assinatura, botão &quot;Pausar ou cancelar&quot;.</li>
          <li>
            Pedir a devolução: pelo WhatsApp {formatPhone(SITE.whatsappNumber)} ou pelo e-mail{' '}
            <Dado v={LEGAL.emailPrivacidade} nome="e-mail de contato" />, dizendo o nome da empresa.
          </li>
          <li>
            O dinheiro volta pelo mesmo meio do pagamento em até 10 dias úteis depois de confirmado.
            No cartão de crédito, o estorno pode aparecer em até duas faturas, conforme o banco.
          </li>
        </ul>
      </Secao>

      <Secao id="dados" titulo="8. E os dados da empresa?">
        <p>
          Cancelar não apaga nada: os dados continuam guardados para você poder voltar, e você pode
          baixar tudo num arquivo só. Se quiser que os dados sejam apagados, faça o pedido em Minha
          conta ou na página <a href="/privacidade/pedido">Pedir sobre os seus dados</a>.
        </p>
      </Secao>
    </LegalShell>
  );
}
