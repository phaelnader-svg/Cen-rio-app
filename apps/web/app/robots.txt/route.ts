import { robotsTxt } from '@/lib/robots';

/**
 * robots.txt (o texto e as regras ficam em lib/robots.ts: uma rota do Next.js só pode exportar
 * os campos de rota, e outro export aqui quebra o `next build`).
 */
export const dynamic = 'force-static';

export function GET() {
  return new Response(robotsTxt(), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
