import { mcpServerCard } from '@/components/site/agentes';
import { preflight, publicJson } from '@/lib/agentes-http';

/** Cartão do servidor MCP (SEP-1649). */
export const dynamic = 'force-static';
export const GET = () => publicJson(mcpServerCard());
export const OPTIONS = preflight;
