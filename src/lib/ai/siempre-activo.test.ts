import { afterEach, describe, expect, it } from 'vitest'
import { buildSystemPrompt, HANDOFF_SENTINEL } from './defaults'

describe('AGENTE_SIEMPRE_ACTIVO', () => {
  afterEach(() => { delete process.env.AGENTE_SIEMPRE_ACTIVO })

  it('encendido: el prompt no enseña el código de traspaso', () => {
    process.env.AGENTE_SIEMPRE_ACTIVO = 'on'
    const p = buildSystemPrompt({ userPrompt: 'x', mode: 'auto_reply', knowledge: ['dato'] })
    expect(p).not.toContain(HANDOFF_SENTINEL)
    expect(p).toContain('never hand off')
  })

  it('apagado: se conserva el comportamiento original', () => {
    const p = buildSystemPrompt({ userPrompt: 'x', mode: 'auto_reply' })
    expect(p).toContain(HANDOFF_SENTINEL)
  })
})
