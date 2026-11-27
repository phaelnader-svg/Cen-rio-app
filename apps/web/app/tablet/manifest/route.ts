import { teamManifest as manifest } from '@/lib/team-manifest';

/**
 * App instalado (2026-11-25): o mesmo manifesto do app, mas abrindo já com o código de vinculação
 * do código QR. No iPhone o app instalado não enxerga o que foi feito no Safari, então o código
 * vai junto e o app se vincula sozinho na primeira vez que abre.
 */
export function GET(request: Request) {
  const raw = new URL(request.url).searchParams.get('codigo') ?? '';
  const code = raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 8);
  const base = manifest();
  const body = code.length === 8 ? { ...base, start_url: `/tablet?codigo=${code}` } : base;
  return new Response(JSON.stringify(body), {
    headers: {
      'content-type': 'application/manifest+json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
