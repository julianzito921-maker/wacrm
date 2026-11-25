// ============================================================
// Emparejar una conexión con Meta (suscripción de la WABA + /register)
// y mantener whatsapp_connections al día con la ruta legada.
//
// Sin la suscripción de la WABA a la app, Meta no entrega ningún
// webhook entrante (issue #505); sin /register, un número de producción
// bajo una WABA compartida tampoco recibe (issue #136). La ruta legada
// /api/whatsapp/config ya lo hacía; /api/connections no, y las islas
// nuevas quedaban «conectadas» pero mudas.
//
// Mismo criterio que la ruta legada:
//   - falla la suscripción → error (no se guarda; el usuario corrige y
//     vuelve a guardar).
//   - falla /register → advertencia: se guarda igual, como desconectada,
//     con el motivo, para reintentar con otro PIN.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js'
import { registerPhoneNumber, subscribeWabaToApp } from './meta-api'
import {
  explainMetaError,
  metaErrorPayload,
  type MetaErrorContext,
} from './meta-error-explain'

export type MetaErrorPayload = ReturnType<typeof metaErrorPayload>

export type ResultadoEmparejar =
  | {
      ok: true
      /** Se llamó a /subscribed_apps con éxito (false si no hay WABA). */
      suscrita: boolean
      /** Se registró el número con el PIN en esta llamada. */
      registrada: boolean
      /** Motivo legible si /register falló (el guardado sigue). */
      errorRegistro: string | null
      metaRegistro: MetaErrorPayload | null
    }
  | {
      ok: false
      error: string
      meta: MetaErrorPayload
      httpStatus: number
    }

/** El PIN de verificación en dos pasos de Meta son 6 dígitos. */
export function pinValido(pin: unknown): pin is string {
  return typeof pin === 'string' && /^\d{6}$/.test(pin)
}

/**
 * Suscribe la WABA a la app (si hay WABA) y registra el número (si hay
 * PIN). Nunca lanza: devuelve el error de Meta ya explicado.
 */
export async function emparejarConexionEnMeta(args: {
  phoneNumberId: string
  wabaId: string | null
  accessToken: string
  pin?: string | null
}): Promise<ResultadoEmparejar> {
  const ctx: MetaErrorContext = {
    phoneNumberId: args.phoneNumberId,
    wabaId: args.wabaId,
  }

  let registrada = false
  let errorRegistro: string | null = null
  let metaRegistro: MetaErrorPayload | null = null
  if (args.pin) {
    try {
      await registerPhoneNumber({
        phoneNumberId: args.phoneNumberId,
        accessToken: args.accessToken,
        pin: args.pin,
      })
      registrada = true
    } catch (err) {
      const explicado = explainMetaError(err, 'register', ctx)
      errorRegistro = explicado.summary
      metaRegistro = metaErrorPayload(explicado)
      console.error('[conexiones] /register falló:', explicado.metaMessage, metaRegistro)
    }
  }

  let suscrita = false
  if (args.wabaId) {
    try {
      await subscribeWabaToApp({ wabaId: args.wabaId, accessToken: args.accessToken })
      suscrita = true
    } catch (err) {
      const explicado = explainMetaError(err, 'subscribe_waba', ctx)
      console.error('[conexiones] suscripción de la WABA falló:', explicado.metaMessage, {
        code: explicado.code,
        subcode: explicado.subcode,
        fbtrace_id: explicado.fbtraceId,
      })
      return {
        ok: false,
        error: explicado.summary,
        meta: metaErrorPayload(explicado),
        httpStatus: explicado.httpStatus,
      }
    }
  }

  return { ok: true, suscrita, registrada, errorRegistro, metaRegistro }
}

/**
 * Tras guardar la config legada (whatsapp_config), deja la fila de
 * whatsapp_connections con el mismo phone_number_id igual: el webhook
 * entrante resuelve PRIMERO por whatsapp_connections, así que un token
 * rotado solo en la tabla vieja seguía descifrando el token viejo.
 *
 * - Existe y es de la cuenta → se actualizan token, verify_token (solo si
 *   hay uno; nunca se borra), WABA, estado y número visible.
 * - Existe y es de OTRA cuenta → no se toca (la ruta ya rechaza ese caso
 *   antes de guardar; esto es la red de seguridad).
 * - No existe → se crea. Si reemplaza al número anterior de la config y
 *   ese era el default, hereda el default; si la cuenta no tenía
 *   conexiones, también queda como default.
 *
 * Nunca lanza: devuelve el motivo si no pudo sincronizar.
 */
export async function sincronizarConexionDesdeConfig(
  db: SupabaseClient,
  args: {
    accountId: string
    phoneNumberId: string
    /** phone_number_id que tenía la config antes de este guardado. */
    phoneNumberIdAnterior: string | null
    wabaId: string | null
    accessTokenCifrado: string
    verifyTokenCifrado: string | null
    status: 'connected' | 'disconnected'
    displayPhoneNumber: string | null
  },
): Promise<{ ok: true; connectionId: string | null } | { ok: false; error: string }> {
  try {
    const ahora = new Date().toISOString()
    const { data: actual, error: errLectura } = await db
      .from('whatsapp_connections')
      .select('id, account_id')
      .eq('phone_number_id', args.phoneNumberId)
      .maybeSingle()
    if (errLectura) return { ok: false, error: errLectura.message }

    const fila = actual as { id: string; account_id: string } | null
    if (fila && fila.account_id !== args.accountId) {
      console.error(
        '[whatsapp/config] el phone_number_id ya pertenece a una conexión de otra cuenta; no se sincroniza',
      )
      return { ok: false, error: 'connection_owned_by_other_account' }
    }

    const comunes: Record<string, unknown> = {
      waba_id: args.wabaId,
      access_token: args.accessTokenCifrado,
      status: args.status,
      last_synced_at: ahora,
    }
    if (args.verifyTokenCifrado) comunes.verify_token = args.verifyTokenCifrado
    if (args.displayPhoneNumber) {
      comunes.display_phone_number = args.displayPhoneNumber
      comunes.phone_number = args.displayPhoneNumber
    }

    if (fila) {
      const { error } = await db
        .from('whatsapp_connections')
        .update(comunes)
        .eq('id', fila.id)
        .eq('account_id', args.accountId)
      if (error) return { ok: false, error: error.message }
      return { ok: true, connectionId: fila.id }
    }

    // Hilos legados: si la cuenta ya recibe por la config sin conexión
    // (conversaciones con connection_id NULL, creadas por el respaldo del
    // webhook), crear la conexión ahora haría que el webhook resolviera por
    // ella y abriera un hilo NUEVO por cada clienta (findOrCreateConversation
    // busca por connection_id): historial partido, IA sin contexto y flujos
    // huérfanos. En ese caso no se crea: el webhook sigue entrando por
    // whatsapp_config, que ya quedó guardada. Se avisa para hacerlo a mano.
    const { data: hilosLegados, error: errHilos } = await db
      .from('conversations')
      .select('id')
      .eq('account_id', args.accountId)
      .is('connection_id', null)
      .limit(1)
    if (errHilos) return { ok: false, error: errHilos.message }
    if ((hilosLegados ?? []).length > 0) {
      console.error(
        '[whatsapp/config] la cuenta tiene conversaciones sin conexión; no se crea la conexión para no partir los hilos',
      )
      return { ok: false, error: 'legacy_threads_without_connection' }
    }

    // Conexión nueva: ¿hereda el default?
    const { data: existentes, error: errLista } = await db
      .from('whatsapp_connections')
      .select('id, phone_number_id, is_default')
      .eq('account_id', args.accountId)
    if (errLista) return { ok: false, error: errLista.message }
    const lista = (existentes ?? []) as Array<{
      id: string
      phone_number_id: string
      is_default: boolean | null
    }>
    const defaultActual = lista.find((c) => c.is_default) ?? null
    const reemplazaAlDefault =
      !!defaultActual &&
      !!args.phoneNumberIdAnterior &&
      defaultActual.phone_number_id === args.phoneNumberIdAnterior
    const esDefault = lista.length === 0 || !defaultActual || reemplazaAlDefault

    if (esDefault && defaultActual) {
      const { error } = await db
        .from('whatsapp_connections')
        .update({ is_default: false })
        .eq('id', defaultActual.id)
        .eq('account_id', args.accountId)
      if (error) return { ok: false, error: error.message }
    }

    const { data: creada, error: errAlta } = await db
      .from('whatsapp_connections')
      .insert({
        account_id: args.accountId,
        name: `WhatsApp ${args.phoneNumberId.slice(-4)}`,
        phone_number_id: args.phoneNumberId,
        badge_color: '#6366f1',
        is_default: esDefault,
        active: true,
        ...comunes,
      })
      .select('id')
      .maybeSingle()
    if (errAlta) return { ok: false, error: errAlta.message }
    return { ok: true, connectionId: (creada as { id?: string } | null)?.id ?? null }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}
