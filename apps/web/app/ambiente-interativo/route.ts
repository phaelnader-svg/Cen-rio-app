/**
 * Botão "Acessar ambiente interativo" (cabeçalho do painel): leva ao Firma Viva, que entra com a
 * conta do Cenário Gestão pela autorização oficial (/autorizar com prompt=none), sem pedir senha.
 *
 * O endereço do jogo vem de FIRMA_WEB_URL, lido na hora do pedido (a mesma imagem serve
 * homologação e produção); sem a variável, vale o endereço público do Firma Viva.
 */
import { firmaEntryUrl } from '../../lib/ambiente-interativo';

export const dynamic = 'force-dynamic';

export function GET() {
  return new Response(null, {
    status: 302,
    headers: { location: firmaEntryUrl(process.env), 'cache-control': 'no-store' },
  });
}
