import { llmsTxt } from '@/components/site/agentes';
import { preflight, publicText } from '@/lib/agentes-http';

/** Resumo do produto em Markdown para modelos de linguagem (llms.txt). */
export const dynamic = 'force-static';
export const GET = () => publicText(llmsTxt(), 'text/markdown');
export const OPTIONS = preflight;
