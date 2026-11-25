import { redirect } from 'next/navigation';

/** Atajo /settings/webhooks → la pestaña Webhooks de Configuración. */
export default function SettingsWebhooksPage() {
  redirect('/settings?tab=webhooks');
}
