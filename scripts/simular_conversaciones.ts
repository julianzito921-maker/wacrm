// Simulador de conversaciones (NO envía nada). Uso: tsx _sim.ts <prompt.txt> <telefono> <escenarios.json>
import { readFileSync } from 'fs'
import { createClient as crear } from '@supabase/supabase-js'
import { loadAiConfig } from '../src/lib/ai/config'
import { buildSystemPrompt } from '../src/lib/ai/defaults'
import { generateReply } from '../src/lib/ai/generate'
import { splitReplyParts } from '../src/lib/ai/auto-reply'
import { separarArchivos } from '../src/lib/ai/archivos'
import { separarAcciones } from '../src/lib/ai/acciones'
import { cargarCatalogo, catalogoParaPrompt } from '../src/lib/ai/catalogo'
type M = { role: 'user' | 'assistant'; content: string }
const [promptF, tel, escF] = process.argv.slice(2)
const db = crear(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
const esc: { nombre: string; previo?: M[]; turnos: string[] }[] = JSON.parse(readFileSync(escF, 'utf-8'))
const emojis = (s: string) => (s.match(/\p{Extended_Pictographic}/gu) || []).length
;(async () => {
  const { data } = await db.from('whatsapp_config').select('account_id').eq('phone_number_id', tel).single()
  const cfg = await loadAiConfig(db, data!.account_id)
  // Igual que en producción (auto-reply): el catálogo estructurado se inyecta
  // al prompt para que la prueba refleje lo que ve el modelo de verdad.
  const productos = await cargarCatalogo(db, data!.account_id)
  const catalogo = catalogoParaPrompt(productos, { estricto: cfg?.catalogStrict ?? true })
  console.log(`catálogo: ${productos.length} producto(s)`)
  const systemPrompt = buildSystemPrompt({
    userPrompt: [readFileSync(promptF, 'utf-8'), catalogo].filter(Boolean).join('\n\n'),
    mode: 'auto_reply',
  })
  let fallas = 0
  for (const e of esc) {
    console.log(`\n################ ${e.nombre}`)
    const hist: M[] = [...(e.previo ?? [])]
    for (const t of e.turnos) {
      hist.push({ role: 'user', content: t })
      let r: Awaited<ReturnType<typeof generateReply>> | null = null
      for (let k = 0; k < 3; k++) { try { r = await generateReply({ config: cfg!, systemPrompt, messages: hist }); break } catch (err) { if (k === 2) throw err } }
      if (!r) throw new Error('el modelo no devolvió respuesta')
      const acc = separarAcciones(r.text)
      console.log(`👩 ${t}`)
      const problemas: string[] = []
      const partes = splitReplyParts(acc.texto)
      for (const p of partes) {
        const { texto, claves } = separarArchivos(p)
        const lineas = texto.split('\n').filter((l) => l.trim())
        const esDato = /^[\d ]{16,22}$/.test(texto.trim())
        console.log('   💬 ' + (esDato ? '[CLABE/TARJETA]' : texto.replace(/\n/g, ' ⏎ ')) + (claves.length ? `   📎 ${claves}` : ''))
        if (!esDato && lineas.length > 3) problemas.push(`${lineas.length} renglones`)
        if (emojis(texto) > 1) problemas.push(`${emojis(texto)} emojis`)
        if (lineas.some((l) => /^\s*(\d+[\.\)️⃣]|[•\-–])\s/.test(l))) problemas.push('lista')
        hist.push({ role: 'assistant', content: texto })
        for (const c of claves) hist.push({ role: 'assistant', content: `[Archivo PDF enviado] ${c}` })
      }
      const preguntas = (acc.texto.match(/\?/g) || []).length
      if (preguntas > 1) problemas.push(`${preguntas} preguntas`)
      if (/https?:\/\//.test(acc.texto) && !/gluteos-app|chia-app/.test(acc.texto)) problemas.push('ENLACE')
      if (/apart/i.test(acc.texto)) problemas.push('aparto')
      if (acc.etiquetas.length || acc.botones.length) console.log(`   ⚙️ etiquetas=${acc.etiquetas} botones=${acc.botones}`)
      if (problemas.length) { fallas++; console.log('   ❌ ' + problemas.join(', ')) }
    }
  }
  console.log(`\nRESPUESTAS CON PROBLEMAS: ${fallas}`)
})()
