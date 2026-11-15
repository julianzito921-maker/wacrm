/**
 * Notas de voz → texto, para que el agente IA las lea y conteste.
 * Usa la API de transcripción de OpenAI (OPENAI_API_KEY). Sin clave, o si algo
 * falla, devuelve null y el mensaje sigue como audio normal. Nunca lanza.
 */
const MODELO = process.env.AI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe'
const MAX_BYTES = 20 * 1024 * 1024

export async function transcribirNotaDeVoz(mediaUrl: string | null, mimeType?: string | null): Promise<string | null> {
  const clave = process.env.OPENAI_API_KEY
  if (!clave || !mediaUrl || !/^https?:\/\//.test(mediaUrl)) return null
  try {
    const audio = await fetch(mediaUrl, { signal: AbortSignal.timeout(20_000) })
    if (!audio.ok) return null
    const bytes = await audio.arrayBuffer()
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_BYTES) return null
    const tipo = (mimeType || 'audio/ogg').split(';')[0].trim()
    const ext = tipo.includes('mpeg') ? 'mp3' : tipo.includes('mp4') || tipo.includes('aac') ? 'm4a' : tipo.includes('amr') ? 'amr' : 'ogg'
    const form = new FormData()
    form.append('model', MODELO)
    form.append('language', 'es')
    form.append('file', new Blob([bytes], { type: tipo }), `nota.${ext}`)
    const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${clave}` },
      body: form,
      signal: AbortSignal.timeout(45_000),
    })
    if (!res.ok) {
      console.warn('[nota de voz] la transcripción falló:', res.status, (await res.text()).slice(0, 200))
      return null
    }
    const data = (await res.json()) as { text?: string }
    const texto = data.text?.trim()
    return texto ? texto : null
  } catch (err) {
    console.warn('[nota de voz] no se pudo transcribir:', err instanceof Error ? err.message : err)
    return null
  }
}
