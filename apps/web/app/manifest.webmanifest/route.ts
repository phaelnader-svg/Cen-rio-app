import { teamManifest } from '@/lib/team-manifest';

/**
 * Manifesto do app da equipe. Rota comum (não o arquivo app/manifest.ts do Next), para que só a
 * tela /tablet aponte para ele: o resto do site e o painel instalam o app do dono (/dono).
 */
export function GET() {
  return new Response(JSON.stringify(teamManifest()), {
    headers: {
      'content-type': 'application/manifest+json; charset=utf-8',
      'cache-control': 'public, max-age=3600',
    },
  });
}
