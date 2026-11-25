import { SKILL_NAME, skillMarkdown } from '@/components/site/agentes';
import { preflight, publicText } from '@/lib/agentes-http';

/** O SKILL.md da habilidade pública (os mesmos bytes usados no digest do índice). */
export const dynamic = 'force-static';
export const dynamicParams = false;
export const generateStaticParams = () => [{ skill: SKILL_NAME }];

export async function GET(_req: Request, { params }: { params: Promise<{ skill: string }> }) {
  const { skill } = await params;
  if (skill !== SKILL_NAME) return new Response('Não encontrado', { status: 404 });
  return publicText(skillMarkdown(), 'text/markdown');
}
export const OPTIONS = preflight;
