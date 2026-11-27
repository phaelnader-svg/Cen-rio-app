import { redirect } from 'next/navigation';

/** A lista de empresas saiu do painel da Cenário Estofados: agora fica no painel da plataforma. */
export default function Page() {
  redirect('/plataforma/empresas');
}
