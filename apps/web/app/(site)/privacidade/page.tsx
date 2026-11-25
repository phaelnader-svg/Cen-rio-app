import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { LEGAL, PRIVACY_RESPONSE_DAYS } from '@cenario/shared';
import { Dado, LegalShell, Secao, legalMode } from '@/components/site/legal/legal';
import { legalMetadata } from '@/components/site/legal/meta';

export const dynamic = 'force-dynamic';

export function generateMetadata(): Promise<Metadata> {
  return legalMetadata(
    '/privacidade',
    'Política de privacidade',
    'Quais dados o Cenário Gestão usa, por quê, com quem compartilha e como pedir para ver, corrigir ou apagar os seus dados.',
  );
}

export default async function Page() {
  if ((await legalMode()) === 'off') notFound();
  return (
    <LegalShell
      title="Política de privacidade"
      intro={
        <p>
          Aqui explicamos, sem juridiquês, quais dados pessoais o Cenário Gestão usa, para quê, com
          quem eles são compartilhados e como você pede para ver, corrigir ou apagar os seus dados.
          Ela segue a Lei Geral de Proteção de Dados (Lei 13.709/2018, a LGPD).
        </p>
      }
    >
      <Secao id="resumo" titulo="Em poucas palavras">
        <ul>
          <li>Pedimos só o que precisa: para criar a conta, só e-mail e senha.</li>
          <li>Não vendemos dados de ninguém e não usamos os dados para anúncios.</li>
          <li>
            Os dados que a sua tapeçaria coloca no sistema (clientes, funcionários, serviços) são da
            sua tapeçaria. Nós só guardamos e processamos para o sistema funcionar.
          </li>
          <li>
            O Google Analytics só funciona se você aceitar no aviso de cookies. Sem aceite, nada de
            medição.
          </li>
          <li>
            Você pode pedir para ver, corrigir ou apagar os seus dados a qualquer hora, pela página{' '}
            <a href="/privacidade/pedido">Pedir sobre os seus dados</a>. Respondemos em até{' '}
            {PRIVACY_RESPONSE_DAYS} dias.
          </li>
        </ul>
      </Secao>

      <Secao id="quem-somos" titulo="1. Quem cuida dos seus dados">
        <p>
          O Cenário Gestão é feito e vendido pela <Dado v={LEGAL.razaoSocial} nome="razão social" />{' '}
          ({LEGAL.nomeFantasia}), CNPJ <Dado v={LEGAL.cnpj} nome="CNPJ" />, com endereço em{' '}
          <Dado v={LEGAL.endereco} nome="endereço" />.
        </p>
        <p>
          Encarregado de dados (a pessoa que atende os pedidos sobre dados pessoais):{' '}
          {LEGAL.encarregado ?? `encarregado de dados da ${LEGAL.nomeFantasia}`}, pelo e-mail{' '}
          <Dado v={LEGAL.emailPrivacidade} nome="e-mail do encarregado" />.
        </p>
      </Secao>

      <Secao id="dados" titulo="2. Quais dados usamos e por quê">
        <p>
          <strong>Quem visita o site.</strong> Sem o seu aceite, não guardamos nada que identifique
          você. Com o aceite, o Google Analytics registra páginas vistas, tipo de aparelho e
          navegador e a cidade aproximada, para sabermos quantas pessoas visitam o site e o que
          leem. Base legal: o seu consentimento (LGPD, art. 7º, I), que pode ser retirado a qualquer
          hora.
        </p>
        <p>
          <strong>Quem chama no WhatsApp.</strong> O seu número e as mensagens ficam no WhatsApp,
          para responder e apresentar o sistema. Base legal: providências antes de um contrato que
          você pediu (art. 7º, V).
        </p>
        <p>
          <strong>Quem cria uma conta.</strong> E-mail e senha. A senha é guardada embaralhada
          (ninguém, nem nós, consegue lê-la). Depois, dentro do sistema, você pode completar os
          dados da empresa (nome, CNPJ, endereço, telefone). Base legal: execução do contrato (art.
          7º, V).
        </p>
        <p>
          <strong>Quem usa o sistema.</strong> Guardamos o registro de cada acesso (endereço IP,
          data, hora e navegador) e o que cada pessoa fez no sistema (auditoria). A lei manda
          guardar os registros de acesso por pelo menos 6 meses (Marco Civil da Internet, Lei
          12.965/2014, art. 15). Também servem para a segurança da sua conta. Base legal: obrigação
          legal e legítimo interesse (art. 7º, II e IX).
        </p>
        <p>
          <strong>Quem assina um plano.</strong> Nome da empresa, CPF ou CNPJ de quem paga, e-mail,
          plano, valores e datas de pagamento. O pagamento é feito no Asaas: dados de cartão vão
          direto para eles e nunca passam pelo Cenário Gestão. Base legal: execução do contrato e
          obrigações fiscais (art. 7º, II e V).
        </p>
        <p>
          <strong>Anti-robô.</strong> Nas telas de criar conta e de esqueci a senha, o Cloudflare
          Turnstile confere se quem está do outro lado é uma pessoa, olhando sinais do navegador.
          Base legal: legítimo interesse, para proteger as contas (art. 7º, IX).
        </p>
        <p>
          <strong>Quem faz um pedido sobre dados ou pede suporte.</strong> Nome, e-mail e o que você
          escreveu, para atender o pedido e provar que ele foi atendido. Base legal: obrigação legal
          (art. 7º, II).
        </p>
      </Secao>

      <Secao id="dados-da-tapecaria" titulo="3. Dados que a sua tapeçaria coloca no sistema">
        <p>
          Clientes, endereços, telefones, fotos das peças, funcionários, ponto, fornecedores e
          valores que uma tapeçaria cadastra no Cenário Gestão pertencem àquela tapeçaria. Nesses
          dados, a tapeçaria é a <strong>controladora</strong> (quem decide o que fazer com eles) e
          nós somos a <strong>operadora</strong> (art. 5º, VI e VII): guardamos e processamos só
          para o sistema funcionar, seguindo o que a tapeçaria faz no sistema.
        </p>
        <ul>
          <li>Os dados de cada empresa ficam separados no banco; uma empresa não vê a outra.</li>
          <li>Não usamos esses dados para nada nosso: nem venda, nem anúncio, nem marketing.</li>
          <li>
            Nossa equipe de suporte só entra no sistema de uma empresa quando o gestor libera, por
            tempo marcado, e tudo fica registrado na auditoria.
          </li>
          <li>
            O gestor pode baixar todos os dados da empresa num arquivo só, a qualquer hora (tela
            Empresa, &quot;Baixar todos os dados&quot;).
          </li>
        </ul>
        <p>
          Se você é cliente de uma tapeçaria e quer saber, corrigir ou apagar os seus dados, o
          caminho mais rápido é falar com a própria tapeçaria. Se preferir, faça o pedido com a
          gente e nós encaminhamos para ela.
        </p>
      </Secao>

      <Secao id="compartilhamento" titulo="4. Com quem os dados são compartilhados">
        <p>
          Só com empresas que ajudam o sistema a funcionar, e só o necessário para cada uma fazer a
          sua parte:
        </p>
        <ul>
          <li>
            <strong>Google Cloud</strong>: servidor e cópias de segurança, em São Paulo (Brasil).
          </li>
          <li>
            <strong>Cloudflare</strong>: proteção e entrega do site, e o anti-robô (Turnstile).
          </li>
          <li>
            <strong>Asaas</strong>: cobrança da mensalidade (Pix, boleto e cartão).
          </li>
          <li>
            <strong>Resend</strong>: envio dos e-mails do sistema (confirmar e-mail, senha nova,
            avisos de cobrança).
          </li>
          <li>
            <strong>Google Analytics</strong>: medição de visitas do site, só com o seu aceite.
          </li>
          <li>
            <strong>WhatsApp (Meta)</strong>: quando você chama a gente no WhatsApp. Se a sua
            empresa ligar a integração com WhatsApp Business, Instagram ou Facebook, as mensagens
            dessas contas passam pela Meta.
          </li>
          <li>
            <strong>Clicksign</strong>: só se a sua empresa usar a assinatura digital de contratos.
          </li>
          <li>
            <strong>Anthropic</strong>: só no plano com o Firma Viva. Os assistentes do jogo usam
            inteligência artificial da Anthropic; o texto da conversa e os dados do sistema
            necessários para responder são enviados para gerar a resposta.
          </li>
          <li>Autoridades públicas, quando uma lei ou ordem judicial obrigar.</li>
        </ul>
        <p>
          Algumas dessas empresas guardam ou processam dados fora do Brasil (por exemplo, nos
          Estados Unidos). Isso acontece só para prestar o serviço, nos casos permitidos pela LGPD
          (art. 33).
        </p>
      </Secao>

      <Secao id="cookies" titulo="5. Cookies e dados guardados no seu aparelho">
        <p>
          <strong>Necessários (sem aceite).</strong> O cookie de login (mantém você conectado e não
          pode ser lido por outros sites), o anti-robô nas telas de criar conta e de senha, e
          preferências guardadas no seu aparelho, como o tema claro ou escuro e o rascunho de um
          orçamento. Sem eles, o sistema não funciona.
        </p>
        <p>
          <strong>Medição (só com aceite).</strong> Os cookies do Google Analytics (nomes que
          começam com _ga), usados só para contar visitas do site. Não usamos cookies de anúncio.
        </p>
        <p>
          Para mudar a sua escolha, toque em &quot;Preferências de cookies&quot; no rodapé do site.
          Se recusar depois de ter aceitado, apagamos os cookies do Analytics do seu navegador.
        </p>
      </Secao>

      <Secao id="prazos" titulo="6. Por quanto tempo guardamos">
        <ul>
          <li>
            Dados da conta e da empresa: enquanto a conta existir. Se a assinatura for cancelada, os
            dados continuam guardados para a empresa poder voltar, até que ela peça para apagar.
          </li>
          <li>Registros de acesso: pelo menos 6 meses, como manda o Marco Civil da Internet.</li>
          <li>
            Cobranças e pagamentos: 5 anos, por causa das regras fiscais, mesmo depois de a conta
            ser apagada.
          </li>
          <li>Pedidos sobre dados pessoais: 5 anos, para provar que foram atendidos.</li>
          <li>
            Cópias de segurança: são feitas todos os dias e as antigas são apagadas sozinhas em até
            30 dias. Um dado apagado do sistema some das cópias nesse prazo.
          </li>
          <li>
            Google Analytics: pelo prazo configurado na conta do Analytics, no máximo 14 meses.
          </li>
        </ul>
      </Secao>

      <Secao id="direitos" titulo="7. Os seus direitos e como pedir">
        <p>Pela LGPD (art. 18), você pode pedir, sem custo:</p>
        <ul>
          <li>para saber se temos dados seus e receber uma cópia;</li>
          <li>para corrigir dados errados ou desatualizados;</li>
          <li>para apagar dados desnecessários ou tratados com o seu consentimento;</li>
          <li>para levar os seus dados para outro serviço (portabilidade);</li>
          <li>para saber com quem compartilhamos os seus dados;</li>
          <li>para retirar uma autorização (consentimento) que você deu.</li>
        </ul>
        <p>
          Como pedir: pela página <a href="/privacidade/pedido">Pedir sobre os seus dados</a>, pelo
          e-mail <Dado v={LEGAL.emailPrivacidade} nome="e-mail do encarregado" /> ou, se você tem
          conta, dentro do sistema em Minha conta. Você recebe um protocolo na hora e a resposta em
          até {PRIVACY_RESPONSE_DAYS} dias. Antes de mudar ou apagar qualquer coisa, podemos pedir
          para confirmar que é você mesmo.
        </p>
        <p>
          Alguns dados não podem ser apagados enquanto a lei mandar guardar (como registros de
          acesso e dados de cobrança). Nesse caso, explicamos qual dado ficou e até quando.
        </p>
        <p>
          Se não ficar satisfeito com a nossa resposta, você pode reclamar na Autoridade Nacional de
          Proteção de Dados (ANPD), pelo site gov.br/anpd.
        </p>
      </Secao>

      <Secao id="seguranca" titulo="8. Como protegemos os dados">
        <ul>
          <li>Conexão sempre criptografada (HTTPS).</li>
          <li>Senhas guardadas embaralhadas; verificação em duas etapas disponível.</li>
          <li>Trava no banco de dados que separa os dados de cada empresa.</li>
          <li>Cada funcionário com o próprio acesso, vendo só o que a função dele permite.</li>
          <li>Registro de quem fez o quê (auditoria) e cópias de segurança diárias.</li>
        </ul>
        <p>
          Se acontecer um incidente de segurança que possa causar risco ou dano relevante, avisamos
          as pessoas e empresas afetadas e a ANPD, como manda a LGPD (art. 48).
        </p>
      </Secao>

      <Secao id="menores" titulo="9. Menores de idade">
        <p>
          O Cenário Gestão é um sistema para empresas e não é feito para menores de 18 anos. Para
          criar uma conta é preciso ter 18 anos ou mais.
        </p>
      </Secao>

      <Secao id="mudancas" titulo="10. Mudanças nesta política">
        <p>
          Quando esta política mudar, a data no topo muda junto. Se a mudança for importante, quem
          tem conta recebe um aviso por e-mail antes de ela valer.
        </p>
      </Secao>
    </LegalShell>
  );
}
