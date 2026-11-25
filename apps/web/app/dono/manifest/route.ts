import { teamManifest as manifest } from '@/lib/team-manifest';

/**
 * App instalado (2026-11-25): o app do dono é outro ícone na tela do celular. Abre direto em
 * /dono (o app da equipe continua sendo o de /tablet; os dois têm ids diferentes).
 */
export function GET() {
  const body = {
    ...manifest(),
    id: '/dono',
    name: 'Cenário — Dono',
    short_name: 'Cenário Dono',
    description: 'O seu app do Cenário: o dia da oficina, o dinheiro e o que a IA pede para você.',
    start_url: '/dono',
    // Escopo no site inteiro: a entrada (/entrar) e a volta para /dono ficam dentro do app.
    scope: '/',
    orientation: 'portrait',
  };
  return new Response(JSON.stringify(body), {
    headers: {
      'content-type': 'application/manifest+json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}
