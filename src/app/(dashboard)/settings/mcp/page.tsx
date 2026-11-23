import { redirect } from 'next/navigation';

/**
 * Atajo /settings/mcp → la sección del rail. La página de Configuración
 * usa `?tab=` como única fuente de verdad; esta ruta existe para que el
 * enlace corto funcione desde la documentación y los conectores.
 */
export default function SettingsMcpPage() {
  redirect('/settings?tab=mcp');
}
