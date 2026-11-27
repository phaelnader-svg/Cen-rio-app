import { productInfo } from '@/components/site/agentes';
import { preflight, publicJson } from '@/lib/agentes-http';

/** API pública de informações do produto (a mesma informação da landing). */
export const dynamic = 'force-static';
export const GET = () => publicJson(productInfo());
export const OPTIONS = preflight;
