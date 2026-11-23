"use client";

/**
 * Cabecera de página. Desde el rediseño del 22-nov-2026 el tema y el
 * perfil viven abajo en la barra lateral, así que aquí quedan solo la
 * hamburguesa (móvil) y el título de la sección.
 */

import { usePathname } from "next/navigation";
import { Menu } from "lucide-react";
import { useTranslations } from "next-intl";

const pageTitles: Record<string, string> = {
  "/dashboard": "dashboard",
  "/inbox": "inbox",
  "/notifications": "notifications",
  "/contacts": "contacts",
  "/pipelines": "pipelines",
  "/broadcasts": "broadcasts",
  "/automations": "automations",
  "/flows": "flows",
  "/agents": "aiAgents",
  "/settings": "settings",
};

function getPageTitleKey(pathname: string): string {
  if (pageTitles[pathname]) return pageTitles[pathname];
  const match = Object.entries(pageTitles).find(([path]) =>
    pathname.startsWith(path),
  );
  return match ? match[1] : "dashboard";
}

interface HeaderProps {
  /** Abre el cajón de la barra lateral. Solo en móvil. */
  onOpenSidebar?: () => void;
}

export function Header({ onOpenSidebar }: HeaderProps) {
  const t = useTranslations("Header");
  const pathname = usePathname();
  const titleKey = getPageTitleKey(pathname);

  return (
    <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border bg-background px-4 lg:px-6">
      <button
        type="button"
        onClick={onOpenSidebar}
        aria-label={t("openMenu")}
        className="flex h-10 w-10 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground lg:hidden"
      >
        <Menu className="h-5 w-5" />
      </button>
      <h1 className="truncate text-base font-semibold text-foreground sm:text-lg">
        {t(titleKey)}
      </h1>
    </header>
  );
}
