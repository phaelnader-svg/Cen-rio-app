import { apiCatalog } from '@/components/site/agentes';
import { preflight, publicJson } from '@/lib/agentes-http';

/** Catálogo de APIs (RFC 9727): só a API pública de informações, o MCP e o agente A2A. */
export const dynamic = 'force-static';
export const GET = () => publicJson(apiCatalog(), 'application/linkset+json');
export const OPTIONS = preflight;
