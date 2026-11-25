'use client';

/**
 * Erro que derruba o próprio layout. Sem este arquivo o Next mostra a página padrão em inglês
 * ("Application error"). Aqui tudo fica em português, sem depender do layout nem do CSS.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="pt-BR">
      <body
        style={{
          margin: 0,
          minHeight: '100dvh',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          padding: '0 24px',
          textAlign: 'center',
          fontFamily: 'system-ui, sans-serif',
          background: '#f7f5f0',
          color: '#1d2a2a',
        }}
      >
        <title>Algo deu errado · Cenário Gestão</title>
        <h1 style={{ fontSize: 24, fontWeight: 600, margin: 0 }}>Algo deu errado</h1>
        <p style={{ marginTop: 8, maxWidth: 360, color: '#4a5757' }}>
          Não foi possível abrir esta tela agora. Tente de novo; se continuar, avise o suporte.
        </p>
        <button
          type="button"
          onClick={reset}
          style={{
            marginTop: 24,
            padding: '10px 20px',
            borderRadius: 8,
            border: 0,
            background: '#064a4b',
            color: '#fff',
            fontSize: 16,
            cursor: 'pointer',
          }}
        >
          Tentar de novo
        </button>
        {error.digest && (
          <p style={{ marginTop: 24, fontSize: 12, color: '#6b7777' }}>Código: {error.digest}</p>
        )}
      </body>
    </html>
  );
}
