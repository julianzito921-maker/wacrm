"use client";

/**
 * Barra lateral (rediseño del 22-nov-2026, guía de Julián):
 *   - 220 px, fondo `--sidebar` (#131626) y borde `--sidebar-border`.
 *   - Arriba, el selector de espacio de trabajo (la cuenta actual).
 *   - Menú en secciones: PRINCIPAL, OPERACIONES y GESTIÓN.
 *   - Abajo, el interruptor de tema Claro/Oscuro y el perfil.
 *
 * Se conserva todo lo que ya hacía: cajón en móvil (con fondo, Escape y
 * bloqueo del scroll), punto de no leídos en Chats en vivo, contador de
 * notificaciones, rol del usuario y menú de cuenta.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import { useTranslations } from "next-intl";
import {
  Bell,
  Bot,
  Check,
  ChevronsUpDown,
  Crown,
  KanbanSquare,
  LayoutDashboard,
  LogOut,
  MessageSquare,
  Moon,
  PlugZap,
  Radio,
  Settings,
  Shield,
  Sun,
  User,
  UserCog,
  Users,
  Webhook,
  Workflow,
  X,
  Zap,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { useAuth } from "@/hooks/use-auth";
import { useTheme } from "@/hooks/use-theme";
import { useTotalUnread } from "@/hooks/use-total-unread";
import { useUnreadNotifications } from "@/hooks/use-unread-notifications";
import type { AccountRole } from "@/lib/auth/roles";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

// Chip de rol: el mismo código de colores que en Miembros.
const ROLE_CHIP: Record<
  AccountRole,
  { icon: typeof Crown; labelKey: string; className: string }
> = {
  owner: {
    icon: Crown,
    labelKey: "roleOwner",
    className: "border-amber-500/40 bg-amber-500/10 text-amber-300",
  },
  admin: {
    icon: Shield,
    labelKey: "roleAdmin",
    className: "border-primary/40 bg-primary/10 text-primary",
  },
  agent: {
    icon: UserCog,
    labelKey: "roleAgent",
    className: "border-border bg-muted text-foreground",
  },
  viewer: {
    icon: User,
    labelKey: "roleViewer",
    className: "border-border bg-card text-muted-foreground",
  },
};

interface NavItem {
  /** Sin `href` = todavía no existe en el CRM: se muestra como «Pronto». */
  href?: string;
  labelKey: string;
  icon: typeof LayoutDashboard;
  /** Enlace a una pestaña de Configuración: no se marca como activo. */
  atajo?: boolean;
}

interface NavSection {
  titleKey: string;
  items: NavItem[];
}

const SECTIONS: NavSection[] = [
  {
    titleKey: "sectionMain",
    items: [
      { href: "/dashboard", labelKey: "dashboard", icon: LayoutDashboard },
      { href: "/inbox", labelKey: "liveChats", icon: MessageSquare },
      { href: "/pipelines", labelKey: "kanban", icon: KanbanSquare },
      { href: "/contacts", labelKey: "contacts", icon: Users },
      // No estaba en la guía, pero es una pantalla en uso: se conserva.
      { href: "/notifications", labelKey: "notifications", icon: Bell },
    ],
  },
  {
    titleKey: "sectionOps",
    items: [
      { href: "/flows", labelKey: "flows", icon: Workflow },
      { href: "/agents", labelKey: "aiAgents", icon: Bot },
      // Las automatizaciones están en producción (pago mañana, entregas):
      // se conservan aunque la guía no las nombraba.
      { href: "/automations", labelKey: "automations", icon: Zap },
      {
        href: "/settings?tab=whatsapp",
        labelKey: "connections",
        icon: PlugZap,
        atajo: true,
      },
      // Hoy los webhooks solo se configuran por la API pública: sin pantalla.
      { labelKey: "webhooks", icon: Webhook },
      { href: "/broadcasts", labelKey: "massSends", icon: Radio },
    ],
  },
  {
    titleKey: "sectionManage",
    items: [{ href: "/settings", labelKey: "settings", icon: Settings }],
  },
];

interface SidebarProps {
  /** Controlado en móvil por la hamburguesa de la cabecera. Se ignora en lg+. */
  open?: boolean;
  onClose?: () => void;
}

export function Sidebar({ open = false, onClose }: SidebarProps) {
  const t = useTranslations("Sidebar");
  const pathname = usePathname();
  const { profile, account, accountRole, signOut } = useAuth();
  const { mode, toggleMode } = useTheme();
  const totalUnread = useTotalUnread();
  const unreadNotifications = useUnreadNotifications();

  const esActivo = (item: NavItem) => {
    if (!item.href || item.atajo) return false;
    return (
      pathname === item.href ||
      (item.href !== "/dashboard" && pathname.startsWith(item.href))
    );
  };

  // Al navegar se cierra el cajón en móvil.
  useEffect(() => {
    onClose?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pathname]);

  // Cajón abierto en móvil: bloquea el scroll y cierra con Escape.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose?.();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  const nombreCuenta = account?.name || profile?.full_name || t("title");
  const inicialCuenta = nombreCuenta.charAt(0).toUpperCase();
  const rol = accountRole ? ROLE_CHIP[accountRole] : null;

  return (
    <>
      <button
        type="button"
        aria-label={t("closeMenu")}
        onClick={onClose}
        className={cn(
          "fixed inset-0 z-30 bg-background/70 backdrop-blur-sm transition-opacity lg:hidden",
          open ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0",
        )}
      />

      <aside
        className={cn(
          "fixed inset-y-0 left-0 z-40 flex h-full w-64 flex-col border-r border-sidebar-border bg-sidebar text-sidebar-foreground",
          "transition-transform duration-200 ease-out will-change-transform",
          open ? "translate-x-0" : "-translate-x-full",
          "lg:static lg:z-0 lg:w-[220px] lg:shrink-0 lg:translate-x-0 lg:transition-none",
        )}
        aria-label={t("primaryNav")}
      >
        {/* ---- Selector de espacio de trabajo ---- */}
        <div className="flex h-14 shrink-0 items-center gap-1 border-b border-sidebar-border px-2.5">
          <DropdownMenu>
            <DropdownMenuTrigger
              className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-sidebar-accent focus:outline-none data-popup-open:bg-sidebar-accent"
              aria-label={t("workspace")}
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary text-[13px] font-bold text-primary-foreground">
                {inicialCuenta}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] font-semibold text-foreground">
                  {nombreCuenta}
                </span>
                <span className="block truncate text-[10.5px] text-muted-foreground">
                  {t("workspace")}
                </span>
              </span>
              <ChevronsUpDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              sideOffset={6}
              className="min-w-56 bg-popover text-popover-foreground ring-border"
            >
              <DropdownMenuLabel className="text-[11px] uppercase tracking-wider text-muted-foreground">
                {t("workspaces")}
              </DropdownMenuLabel>
              <DropdownMenuItem className="gap-2 text-popover-foreground">
                <span className="flex h-6 w-6 items-center justify-center rounded bg-primary text-[11px] font-bold text-primary-foreground">
                  {inicialCuenta}
                </span>
                <span className="min-w-0 flex-1 truncate">{nombreCuenta}</span>
                <Check className="size-4 text-primary" />
              </DropdownMenuItem>
              {rol ? (
                <div className="px-2 pb-1.5 pt-0.5">
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider",
                      rol.className,
                    )}
                  >
                    <rol.icon className="size-3" />
                    {t(rol.labelKey)}
                  </span>
                </div>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
          <button
            type="button"
            onClick={onClose}
            aria-label={t("closeMenu")}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent hover:text-foreground lg:hidden"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* ---- Menú por secciones ---- */}
        <nav className="flex-1 overflow-y-auto px-2.5 py-3">
          {SECTIONS.map((seccion) => (
            <div key={seccion.titleKey} className="mb-4 last:mb-0">
              <p className="mb-1.5 px-2.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground/80">
                {t(seccion.titleKey)}
              </p>
              <ul className="flex flex-col gap-0.5">
                {seccion.items.map((item) => {
                  const Icono = item.icon;
                  if (!item.href) {
                    return (
                      <li key={item.labelKey}>
                        <span
                          aria-disabled="true"
                          title={t("soonHint")}
                          className="flex cursor-not-allowed items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium text-muted-foreground/60"
                        >
                          <Icono className="h-4 w-4" />
                          <span className="flex-1">{t(item.labelKey)}</span>
                          <span className="rounded-full border border-sidebar-border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider">
                            {t("soon")}
                          </span>
                        </span>
                      </li>
                    );
                  }
                  const activo = esActivo(item);
                  const puntoNoLeidos =
                    item.href === "/inbox" && totalUnread > 0 && !activo;
                  const contadorAvisos =
                    item.href === "/notifications" && unreadNotifications > 0;
                  return (
                    <li key={item.labelKey}>
                      <Link
                        href={item.href}
                        aria-current={activo ? "page" : undefined}
                        className={cn(
                          "group relative flex items-center gap-2.5 rounded-lg px-2.5 py-2.5 text-[13px] font-medium transition-colors lg:py-2",
                          activo
                            ? "bg-primary-soft text-foreground"
                            : "text-muted-foreground hover:bg-sidebar-accent hover:text-foreground",
                        )}
                      >
                        {activo && (
                          <span className="absolute inset-y-1.5 left-0 w-[3px] rounded-full bg-primary" />
                        )}
                        <Icono
                          className={cn(
                            "h-4 w-4",
                            activo
                              ? "text-primary"
                              : "text-muted-foreground group-hover:text-foreground",
                          )}
                        />
                        <span className="flex-1">{t(item.labelKey)}</span>
                        {puntoNoLeidos && (
                          <span
                            aria-label={t("unreadConversations", { count: totalUnread })}
                            className="relative flex h-2 w-2"
                          >
                            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary opacity-75" />
                            <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
                          </span>
                        )}
                        {contadorAvisos && (
                          <span
                            aria-label={t("unreadNotifications", { count: unreadNotifications })}
                            className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1 text-[10px] font-semibold text-primary-foreground"
                          >
                            {unreadNotifications > 9 ? "9+" : unreadNotifications}
                          </span>
                        )}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        {/* ---- Tema + perfil ---- */}
        <div className="shrink-0 border-t border-sidebar-border p-2.5">
          <div
            role="group"
            aria-label={t("theme")}
            className="mb-2 grid grid-cols-2 gap-0.5 rounded-lg border border-sidebar-border bg-background/40 p-0.5"
          >
            {(["light", "dark"] as const).map((m) => {
              const activo = mode === m;
              const Icono = m === "light" ? Sun : Moon;
              return (
                <button
                  key={m}
                  type="button"
                  aria-pressed={activo}
                  onClick={() => {
                    if (!activo) toggleMode();
                  }}
                  className={cn(
                    "inline-flex items-center justify-center gap-1.5 rounded-md py-1.5 text-[12px] font-medium transition-colors",
                    activo
                      ? "bg-sidebar-accent text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icono className={cn("h-3.5 w-3.5", activo && "text-primary")} />
                  {m === "light" ? t("themeLight") : t("themeDark")}
                </button>
              );
            })}
          </div>

          <DropdownMenu>
            <DropdownMenuTrigger className="flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left transition-colors hover:bg-sidebar-accent focus:bg-sidebar-accent focus:outline-none data-popup-open:bg-sidebar-accent">
              <Avatar className="size-8 shrink-0">
                {profile?.avatar_url ? (
                  <AvatarImage
                    src={profile.avatar_url}
                    alt={profile.full_name ?? t("defaultAvatar")}
                  />
                ) : null}
                <AvatarFallback className="bg-primary-soft text-sm font-medium text-primary">
                  {profile?.full_name?.charAt(0)?.toUpperCase() ??
                    profile?.email?.charAt(0)?.toUpperCase() ??
                    "U"}
                </AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium text-foreground">
                  {profile?.full_name ?? t("defaultUser")}
                </p>
                <p className="truncate text-[11px] text-muted-foreground">
                  {profile?.email ?? ""}
                </p>
              </div>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="end"
              side="top"
              sideOffset={6}
              className="min-w-56 bg-popover text-popover-foreground ring-border"
            >
              <DropdownMenuItem
                render={
                  <Link
                    href="/settings?tab=profile"
                    onClick={onClose}
                    className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
                  />
                }
              >
                <User className="size-4" />
                {t("menuProfile")}
              </DropdownMenuItem>
              <DropdownMenuItem
                render={
                  <Link
                    href="/settings?tab=whatsapp"
                    onClick={onClose}
                    className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
                  />
                }
              >
                <Settings className="size-4" />
                {t("menuSettings")}
              </DropdownMenuItem>
              <DropdownMenuSeparator className="bg-border" />
              <DropdownMenuItem
                onClick={signOut}
                className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
              >
                <LogOut className="size-4" />
                {t("menuSignOut")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </aside>
    </>
  );
}
