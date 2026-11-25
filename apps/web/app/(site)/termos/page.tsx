import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { BILLING_GRACE_DAYS_DEFAULT, LEGAL } from '@cenario/shared';
import { SITE } from '@/components/site/config';
import { formatPhone } from '@/components/site/landing';
import { Dado, LegalShell, Secao, legalMode } from '@/components/site/legal/legal';
import { legalMetadata } from '@/components/site/legal/meta';

export const dynamic = 'force-dynamic';

export function generateMetadata(): Promise<Metadata> {
  return legalMetadata(
    '/termos',
    'Termos de uso',
    'As regras de uso do Cenário Gestão: conta, teste grátis, planos, pagamento, cancelamento, dados e responsabilidades.',
  );
}

const money = (v: string | null) => (v ? `R$ ${v}` : '[valor]');

export default async function Page() {
  if ((await legalMode()) === 'off') notFound();
  return (
    <LegalShell
      title="Termos de uso"
      intro={
        <p>
          Estas são as regras para usar o Cenário Gestão. Ao criar uma conta, você concorda com elas
          e com a{' '}
          <a href="/privacidade" className="font-medium text-brand-700 underline">
            política de privacidade
          </a>
          . Se algo não ficar claro, chame a gente no WhatsApp antes de assinar.
        </p>
      }
    >
      <Secao id="partes" titulo="1. Quem somos e quem é você">
        <p>
          O Cenário Gestão é oferecido pela <Dado v={LEGAL.razaoSocial} nome="razão social" /> (
          {LEGAL.nomeFantasia}), CNPJ <Dado v={LEGAL.cnpj} nome="CNPJ" />, endereço{' '}
          <Dado v={LEGAL.endereco} nome="endereço" />. Nestes termos, &quot;nós&quot; somos essa
          empresa e &quot;você&quot; é a empresa (ou a pessoa) que cria a conta e usa o sistema.
        </p>
      </Secao>

      <Secao id="servico" titulo="2. O que é o Cenário Gestão">
        <p>
          Um sistema pela internet para organizar uma tapeçaria: orçamentos, serviços, ordens de
          serviço, materiais, produção, tablets da oficina, entregas e controle financeiro. Funciona
          no navegador do computador, do tablet e do celular, e precisa de internet.
        </p>
        <p>
          O financeiro é de controle: ele não emite nota fiscal nem boleto e não se conecta ao
          banco. Os impostos e obrigações fiscais da sua empresa continuam com você e com a sua
          contabilidade.
        </p>
      </Secao>

      <Secao id="conta" titulo="3. A sua conta">
        <ul>
          <li>Cada conta criada é uma empresa nova, com os dados separados das outras.</li>
          <li>Quem cria a conta precisa ter 18 anos ou mais e informar dados verdadeiros.</li>
          <li>
            O gestor da conta decide quem da equipe tem acesso e o que cada um vê. Cada pessoa tem o
            próprio acesso; não compartilhe senhas.
          </li>
          <li>
            Se perceber um acesso estranho, troque a senha e avise a gente. Você é responsável pelo
            que é feito com os acessos da sua equipe.
          </li>
        </ul>
      </Secao>

      <Secao id="teste" titulo="4. Teste grátis">
        <p>
          Toda conta nova tem {SITE.trialDays ?? '[dias]'} dias grátis para testar, sem cartão. No
          fim do teste, para continuar usando, é preciso escolher um plano e pagar. Se não pagar, o
          acesso é bloqueado, mas os dados continuam guardados.
        </p>
      </Secao>

      <Secao id="planos" titulo="5. Planos e pagamento">
        <ul>
          <li>
            Cenário Gestão: {money(SITE.monthlyPrice)} por mês. Cenário Gestão + Firma Viva:{' '}
            {money(SITE.gameMonthlyPrice)} por mês.
          </li>
          <li>
            No pagamento anual, desconto de {SITE.annualDiscountPct ?? '[desconto]'}%, pago de uma
            vez para 12 meses.
          </li>
          <li>Não há limite de usuários nem custo a mais pelos tablets da oficina.</li>
          <li>
            O pagamento é feito pelo Asaas, por Pix, boleto ou cartão. A mensalidade é cobrada antes
            do período de uso.
          </li>
          <li>
            Se o pagamento atrasar, o sistema avisa. Depois de {BILLING_GRACE_DAYS_DEFAULT} dias do
            vencimento sem pagamento, o acesso é bloqueado até o pagamento ser confirmado. Nenhum
            dado é apagado por atraso.
          </li>
          <li>
            Se o preço mudar, avisamos por e-mail com pelo menos 30 dias de antecedência. O novo
            preço só vale a partir da próxima cobrança depois do aviso; no plano anual, só na
            renovação.
          </li>
        </ul>
      </Secao>

      <Secao id="cancelamento" titulo="6. Cancelamento e reembolso">
        <p>
          Você pode pausar por um mês ou cancelar quando quiser, sem multa, pela tela Assinatura. As
          regras de devolução de dinheiro estão na{' '}
          <a href="/reembolso">política de cancelamento e reembolso</a>.
        </p>
      </Secao>

      <Secao id="dados" titulo="7. Os dados da sua empresa">
        <ul>
          <li>
            Tudo o que a sua empresa cadastra no sistema é da sua empresa. Você pode baixar todos os
            dados num arquivo só, a qualquer hora, inclusive depois de cancelar.
          </li>
          <li>
            Nos dados pessoais que a sua empresa coloca no sistema (clientes, funcionários,
            fornecedores), a sua empresa é a controladora e nós somos a operadora, como explica a{' '}
            <a href="/privacidade#dados-da-tapecaria">política de privacidade</a>. Você é
            responsável por ter o direito de usar esses dados (por exemplo, para atender o cliente)
            e por responder aos pedidos dos seus clientes. Nós ajudamos no que o sistema permitir.
          </li>
          <li>
            Usamos esses dados só para o sistema funcionar e para o suporte que você pedir. Nossa
            equipe só entra no sistema da sua empresa quando o gestor libera o acesso do suporte,
            por tempo marcado, e tudo fica na auditoria.
          </li>
          <li>
            Para apagar a conta e os dados, faça o pedido em Minha conta ou na página de pedidos.
          </li>
        </ul>
      </Secao>

      <Secao id="uso" titulo="8. O que não é permitido">
        <ul>
          <li>Usar o sistema para algo ilegal ou para guardar dados que você não pode ter.</li>
          <li>Tentar entrar em dados de outra empresa ou atacar o sistema.</li>
          <li>Copiar, revender ou alugar o sistema para terceiros.</li>
          <li>Automatizar acessos de um jeito que atrapalhe o sistema para as outras empresas.</li>
        </ul>
        <p>Se isso acontecer, podemos suspender a conta, avisando o motivo.</p>
      </Secao>

      <Secao id="disponibilidade" titulo="9. Disponibilidade e responsabilidades">
        <p>
          Trabalhamos para o sistema ficar no ar o tempo todo, com cópias de segurança diárias.
          Manutenções planejadas são avisadas dentro do sistema. Mesmo assim, nenhum sistema pela
          internet funciona 100% do tempo: falhas de internet, de energia ou de empresas que usamos
          (como o Google Cloud) podem deixar o sistema fora do ar por algum tempo.
        </p>
        <p>
          O Cenário Gestão ajuda a organizar a tapeçaria, mas as decisões do negócio (preços,
          prazos, compras, pagamentos) são suas. Confira os números importantes antes de decidir.
          Nada nestes termos tira direitos que a lei garante a você.
        </p>
      </Secao>

      <Secao id="firma-viva" titulo="10. Firma Viva (plano com o jogo)">
        <p>
          O Firma Viva mostra a oficina e o escritório em 3D com os dados do seu sistema. Os
          assistentes do jogo usam inteligência artificial e podem errar: confira as respostas antes
          de agir com base nelas.
        </p>
      </Secao>

      <Secao id="propriedade" titulo="11. Marca e sistema">
        <p>
          O sistema, a marca Cenário Gestão, o logo e as telas são nossos. A assinatura dá o direito
          de usar o sistema enquanto ela estiver ativa, não de copiá-lo.
        </p>
      </Secao>

      <Secao id="mudancas" titulo="12. Mudanças nestes termos">
        <p>
          Quando estes termos mudarem, a data no topo muda junto, e quem tem conta recebe um aviso
          por e-mail com pelo menos 30 dias de antecedência. Se não concordar, você pode cancelar
          sem multa antes de a mudança valer.
        </p>
      </Secao>

      <Secao id="foro" titulo="13. Lei e foro">
        <p>
          Estes termos seguem as leis do Brasil. Para resolver qualquer conflito, fica escolhido o
          foro da comarca de <Dado v={LEGAL.foro} nome="cidade do foro" />, a não ser que a lei
          garanta a você o direito de usar o foro da sua cidade.
        </p>
      </Secao>

      <Secao id="contato" titulo="14. Contato">
        <p>
          WhatsApp {formatPhone(SITE.whatsappNumber)}. Assuntos de privacidade:{' '}
          <Dado v={LEGAL.emailPrivacidade} nome="e-mail do encarregado" />.
        </p>
      </Secao>
    </LegalShell>
  );
}
