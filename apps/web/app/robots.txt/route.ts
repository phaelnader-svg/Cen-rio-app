import { robotsTxt } from '@/components/site/robots';

/** robots.txt: o conteúdo é montado em components/site/robots.ts. */
export const dynamic = 'force-static';

export function GET() {
  return new Response(robotsTxt(), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
