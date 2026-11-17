/** Páginas abertas pelo cliente da tapeçaria (links enviados pelo WhatsApp) e a página de status. */
export default function ClientLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-canvas">
      <main className="mx-auto w-full max-w-2xl px-4 py-8 sm:py-12">{children}</main>
    </div>
  );
}
