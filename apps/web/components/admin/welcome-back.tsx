'use client';

import { Lightbulb } from 'lucide-react';
import { useSyncExternalStore } from 'react';
import { LOGO_SOFA_PATH } from '@/components/brand';

const TZ = 'America/Sao_Paulo';
const noop = () => () => {};

/** Bom dia / Boa tarde / Boa noite pelo horário de Brasília (no servidor, só "Olá"). */
function greeting(): string {
  const h = Number(
    new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: TZ }).format(
      new Date(),
    ),
  );
  if (h >= 5 && h < 12) return 'Bom dia';
  if (h >= 12 && h < 18) return 'Boa tarde';
  return 'Boa noite';
}
function today(): string {
  const s = new Intl.DateTimeFormat('pt-BR', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    timeZone: TZ,
  }).format(new Date());
  return s.charAt(0).toUpperCase() + s.slice(1);
}
/** Número do dia (no horário de Brasília): todo mundo vê a mesma dica no mesmo dia. */
function dayIndex(): number {
  const [y, m, d] = new Intl.DateTimeFormat('en-CA', { timeZone: TZ })
    .format(new Date())
    .split('-')
    .map(Number);
  return Math.floor(Date.UTC(y!, m! - 1, d!) / 86_400_000);
}

/**
 * Dicas de uso, uma por dia, na ordem (escolha do dono em 26/11/2026). Lista fixa: sem IA e sem
 * custo. A cada versão, dá para incluir dicas do que entrou no sistema.
 */
export const DAILY_TIPS = [
  'Na Conversar do app, segure o microfone e fale: "tem retirada amanhã?". O sistema escreve e responde.',
  'A OS puxa tudo do orçamento. Não precisa digitar o cliente nem as peças de novo.',
  'Serviço feito na casa do cliente? No orçamento, marque "No local" em vez de Retirada.',
  'No tablet da oficina, cada tapeceiro vê o serviço dele, na ordem certa.',
  'Aperte Ctrl K para achar qualquer cliente, orçamento ou OS sem sair da tela.',
  'Instale o app do dono no celular e acompanhe a oficina de onde estiver.',
  'O Início mostra primeiro o que precisa de você hoje. Comece o dia por ali.',
  'Na Semana da oficina, você vê o que entra e o que sai em cada dia.',
  'O Mapa da oficina mostra onde está cada peça agora.',
  'Peça voltou com defeito? Abra um retrabalho e ele vira estatística da oficina.',
  'Antes de entregar, passe a peça pela Qualidade. Assim ela só sai aprovada.',
  'Em Expedição e entregas, você vê o que está pronto e para quando está marcada a entrega.',
  'Em Retiradas, marque o dia de buscar a peça na casa do cliente.',
  'O Roteiro do dia junta as retiradas e entregas que saem hoje.',
  'Em Estoque da oficina, você sabe o que tem e o que precisa comprar.',
  'Em Modelos de serviço, guarde os serviços que você faz sempre e monte o orçamento mais rápido.',
  'No Financeiro, você vê tudo que entra e tudo que sai do dinheiro da oficina.',
  'Cadastre as contas a pagar e o sistema avisa antes de vencer.',
  'O Resumo da semana, no Início, mostra como a oficina foi nos últimos dias.',
  'Em Tablets e acessos, ligue um tablet novo da oficina pelo QR.',
  'Em Equipe, cada funcionário tem o próprio acesso e vê só o que precisa.',
  'Em Funções e permissões, você escolhe o que cada pessoa pode ver e mexer.',
  'Em Presença da equipe, você vê quem já chegou e quem está trabalhando agora.',
  'Em Produtividade, acompanhe o trabalho de cada tapeceiro.',
  'Atrasou uma peça? Em Reprogramação, você ajeita as datas da semana.',
  'O sino no alto da tela junta os avisos. Abra quando ele mostrar um número.',
  'Em Clientes, você vê todos os orçamentos e serviços de cada cliente num lugar só.',
  'Orçamento aprovado? Use Fechar serviço e ele segue para a retirada e a OS.',
  'O cliente nunca vê custo nem lucro. Isso fica só para você.',
  'No Histórico de alterações, você vê quem mudou o quê, e quando.',
];

/**
 * Lado esquerdo da tela Entrar (pedido do dono, 26/11/2026): quem clica em Entrar já é cliente,
 * então a tela recebe a pessoa com a data, a saudação e a dica do dia.
 */
export function WelcomeBackPanel() {
  const hello = useSyncExternalStore(noop, greeting, () => 'Olá');
  const date = useSyncExternalStore(noop, today, () => '');
  const i = useSyncExternalStore(noop, dayIndex, () => 0);
  return (
    <div className="relative max-w-md" data-testid="entrar-boas-vindas">
      <svg
        viewBox="40 110 290 150"
        className="pointer-events-none absolute top-full -right-48 mt-16 w-[30rem] opacity-[0.06]"
        aria-hidden
      >
        <path fill="#ffffff" fillRule="evenodd" d={LOGO_SOFA_PATH} />
      </svg>
      <p className="text-sm font-medium text-white/70">{date}</p>
      <h2 className="mt-1 text-4xl leading-tight font-semibold tracking-tight text-balance">
        {hello}! Bom te ver de novo.
      </h2>
      <p className="mt-3 text-lg text-white/80">
        A oficina está te esperando. Entre e veja o que precisa de você hoje.
      </p>
      <figure className="mt-10 border-l-4 border-amber-300 pl-5" data-testid="dica-do-dia">
        <p className="flex items-center gap-2 text-sm font-semibold text-amber-200">
          <Lightbulb className="size-4" aria-hidden />
          Dica do dia
        </p>
        <blockquote className="mt-2 text-xl leading-snug text-white/95">
          {DAILY_TIPS[i % DAILY_TIPS.length]}
        </blockquote>
      </figure>
    </div>
  );
}
