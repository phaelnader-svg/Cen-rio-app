import { openApi } from '@/components/site/agentes';
import { preflight, publicJson } from '@/lib/agentes-http';

/** Descrição OpenAPI da API pública de informações. */
export const dynamic = 'force-static';
export const GET = () => publicJson(openApi(), 'application/openapi+json');
export const OPTIONS = preflight;
