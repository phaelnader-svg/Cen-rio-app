import { agentCard } from '@/components/site/agentes';
import { preflight, publicJson } from '@/lib/agentes-http';

/** Cartão do agente A2A (informações públicas do produto). */
export const dynamic = 'force-static';
export const GET = () => publicJson(agentCard());
export const OPTIONS = preflight;
