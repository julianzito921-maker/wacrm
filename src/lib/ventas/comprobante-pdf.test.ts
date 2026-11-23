import { describe, expect, it } from 'vitest'
import { esComprobanteLegible, textoDePdf, ultimos4 } from './comprobante'

/** PDF mínimo de una página con una línea de texto (Helvetica). */
function pdfConTexto(linea: string): Buffer {
  const contenido = `BT /F1 12 Tf 50 700 Td (${linea}) Tj ET`
  const objetos = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${contenido.length} >>\nstream\n${contenido}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets: number[] = []
  objetos.forEach((o, i) => {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj\n${o}\nendobj\n`
  })
  const xref = pdf.length
  pdf += `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n`
  for (const off of offsets) pdf += `${String(off).padStart(10, '0')} 00000 n \n`
  pdf += `trailer\n<< /Size ${objetos.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf, 'latin1')
}

describe('comprobantes en PDF (unpdf)', () => {
  it('extrae el texto de un PDF de comprobante', async () => {
    const texto = await textoDePdf(pdfConTexto('Transferencia SPEI exitosa por 99.00 MXN CLABE 012180001234567890'))
    expect(texto).toContain('SPEI')
    expect(texto).toContain('99.00')
    expect(texto).toContain('012180001234567890')
  })

  it('imágenes y PDF se pueden leer; otros archivos no', () => {
    expect(esComprobanteLegible('image/jpeg')).toBe(true)
    expect(esComprobanteLegible('application/pdf')).toBe(true)
    expect(esComprobanteLegible('application/pdf; charset=binary')).toBe(true)
    expect(esComprobanteLegible('audio/ogg')).toBe(false)
    expect(esComprobanteLegible('application/zip')).toBe(false)
  })

  it('últimos 4 dígitos de una CLABE con espacios', () => {
    expect(ultimos4('0121 8000 1234 5678 90')).toBe('7890')
    expect(ultimos4(null)).toBe('')
  })
})
