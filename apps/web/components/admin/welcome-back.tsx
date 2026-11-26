'use client';

import { CalendarCheck, ClipboardList, Hammer } from 'lucide-react';
import { useSyncExternalStore } from 'react';

/** Bom dia / Boa tarde / Boa noite pelo horário de Brasília (no servidor, só "Olá"). */
function greeting(): string {
  const h = Number(
    new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      hourCycle: 'h23',
      timeZone: 'America/Sao_Paulo',
    }).format(new Date()),
  );
  if (h >= 5 && h < 12) return 'Bom dia';
  if (h >= 12 && h < 18) return 'Boa tarde';
  return 'Boa noite';
}
const noop = () => () => {};

/**
 * Lado esquerdo da tela Entrar (pedido do dono, 26/11/2026): quem clica em Entrar já é cliente,
 * então a tela recebe a pessoa, em vez de vender o sistema para ela.
 */
export function WelcomeBackPanel() {
  const hello = useSyncExternalStore(noop, greeting, () => 'Olá');
  return (
    <div className="max-w-md" data-testid="entrar-boas-vindas">
      <h2 className="text-4xl leading-tight font-semibold tracking-tight text-balance">
        {hello}! Bom te ver de novo.
      </h2>
      <p className="mt-4 text-lg text-white/80">
        A oficina está te esperando. Entre e veja o que precisa de você hoje.
      </p>
      <ul className="mt-8 space-y-4 text-white/85">
        {[
          { icon: ClipboardList, text: 'O que precisa de você hoje, na ordem certa.' },
          { icon: CalendarCheck, text: 'As retiradas e entregas da semana.' },
          { icon: Hammer, text: 'O que cada tapeceiro está fazendo agora.' },
        ].map(({ icon: Icon, text }) => (
          <li key={text} className="flex items-center gap-3">
            <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-white/10">
              <Icon className="size-4.5" aria-hidden />
            </span>
            <span>{text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
