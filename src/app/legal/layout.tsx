import type { ReactNode } from 'react'

/**
 * Envoltura de las páginas legales (privacidad, términos y eliminación de
 * datos). Son públicas a propósito: Meta las exige para publicar la app y
 * cualquiera tiene que poder abrirlas sin cuenta.
 */
export const metadata = {
  title: 'Información legal · Aprende y Gana',
}

export default function LegalLayout({ children }: { children: ReactNode }) {
  return (
    <main className="mx-auto max-w-3xl px-6 py-14 text-foreground">
      <article className="space-y-4 text-[15px] leading-relaxed [&_h1]:text-2xl [&_h1]:font-semibold [&_h2]:mt-8 [&_h2]:text-lg [&_h2]:font-semibold [&_li]:ml-5 [&_li]:list-disc [&_ul]:space-y-1">
        {children}
      </article>
      <footer className="mt-12 border-t border-border pt-6 text-[13px] text-muted-foreground">
        <nav className="flex flex-wrap gap-4">
          <a href="/legal/privacidad">Aviso de privacidad</a>
          <a href="/legal/terminos">Términos y condiciones</a>
          <a href="/legal/eliminacion-de-datos">Eliminación de datos</a>
        </nav>
      </footer>
    </main>
  )
}
