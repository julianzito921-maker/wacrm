"use client";

/**
 * ¿Dónde se montan los portales (hojas laterales, menús, selectores)?
 *
 * Normalmente en el `body`, que es lo correcto. Pero cuando el editor de
 * flujos entra en **pantalla completa**, el navegador solo muestra lo
 * que está dentro del elemento a pantalla completa: cualquier portal
 * colgado del `body` queda invisible (era el motivo de que el panel
 * derecho no apareciera al pulsar un nodo).
 *
 * El editor publica aquí su contenedor mientras dura la pantalla
 * completa, y los primitivos de interfaz lo respetan. Fuera de ese caso
 * el valor es null y todo sigue montándose en el `body`.
 */

import { createContext, useContext, type ReactNode } from "react";

const PortalContainerContext = createContext<HTMLElement | null>(null);

export function PortalContainerProvider({
  value,
  children,
}: {
  value: HTMLElement | null;
  children: ReactNode;
}) {
  return (
    <PortalContainerContext.Provider value={value}>
      {children}
    </PortalContainerContext.Provider>
  );
}

/** `undefined` = comportamiento por defecto (el `body`). */
export function usePortalContainer(): HTMLElement | undefined {
  return useContext(PortalContainerContext) ?? undefined;
}
