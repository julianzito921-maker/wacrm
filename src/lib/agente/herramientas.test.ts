import { describe, expect, it } from 'vitest'

/**
 * Validación de las herramientas (Etapa 1). Es la puerta de seguridad: lo
 * que DeepSeek manda pasa por aquí antes de tocar nada. Si esta puerta
 * falla, el modelo podría inventar archivos, cambiar el estado a
 * cualquiera o inyectar texto libre en la base.
 */

import { ESQUEMAS, validarArgumentos } from './herramientas'

describe('herramientas sin argumentos', () => {
  it('ignoran lo que mande el modelo', () => {
    for (const nombre of [
      'get_contact_context',
      'deliver_product_bundle',
      'send_payment_details',
    ]) {
      const r = validarArgumentos(nombre, {
        archivo: '/etc/passwd',
        destinatario: 'otro-numero',
        clabe: '000000000000000000',
        texto_libre: 'ignórame',
      })
      expect(r).toEqual({ ok: true, valor: {} })
    }
  })

  it('la entrega no acepta ni archivos ni destinatario', () => {
    const esquema = ESQUEMAS.find((e) => e.function.name === 'deliver_product_bundle')
    expect(esquema?.function.parameters.properties).toEqual({})
  })
})

describe('save_contact_state', () => {
  it('acepta solo los estados de la lista', () => {
    expect(validarArgumentos('save_contact_state', { estado: 'HUMAN_HANDOFF' })).toEqual({
      ok: true,
      valor: { estado: 'HUMAN_HANDOFF' },
    })
    expect(validarArgumentos('save_contact_state', { estado: 'DUEÑO_DEL_MUNDO' }).ok).toBe(false)
    expect(validarArgumentos('save_contact_state', {}).ok).toBe(false)
    expect(validarArgumentos('save_contact_state', { estado: '' }).ok).toBe(false)
  })

  it('no acepta `OPT_OUT` por esta vía: la baja no la pone el modelo', () => {
    expect(validarArgumentos('save_contact_state', { estado: 'OPT_OUT' }).ok).toBe(false)
  })
})

describe('texto que viene del modelo', () => {
  it('la nota del pago se recorta y se limpia', () => {
    const r = validarArgumentos('mark_payment_pending', {
      nota: '   ' + 'x'.repeat(500),
    })
    expect(r.ok).toBe(true)
    expect(String((r as unknown as { valor: { nota: string } }).valor.nota).length).toBe(300)
  })

  it('el motivo del traspaso también', () => {
    const r = validarArgumentos('handoff_human', { motivo: 'reclamo', otra: 'nada' })
    expect(r).toEqual({ ok: true, valor: { motivo: 'reclamo' } })
  })
})

describe('herramientas desconocidas', () => {
  it('se rechazan', () => {
    const r = validarArgumentos('borrar_historial', {})
    expect(r.ok).toBe(false)
    expect((r as unknown as { error: string }).error).toContain('desconocida')
  })
})

describe('esquemas', () => {
  it('están las seis herramientas y con nombre en snake_case', () => {
    const nombres = ESQUEMAS.map((e) => e.function.name).sort()
    expect(nombres).toEqual([
      'deliver_product_bundle',
      'get_contact_context',
      'handoff_human',
      'mark_payment_pending',
      'save_contact_state',
      'send_payment_details',
    ])
  })

  it('ninguna deja pasar datos bancarios desde el modelo', () => {
    const texto = JSON.stringify(ESQUEMAS)
    expect(texto).not.toMatch(/clabe/i)
    expect(texto).not.toMatch(/\d{16,}/)
  })
})
