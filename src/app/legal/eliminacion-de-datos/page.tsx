export const metadata = {
  title: 'Eliminación de datos · Aprende y Gana',
}

/**
 * Instrucciones de eliminación de datos. Meta lo exige como «URL de
 * instrucciones para la eliminación de datos» para publicar la app.
 *
 * Tiene que decir de verdad cómo se pide y qué se borra: la persona que lo
 * lea debe poder hacerlo sin ayuda.
 */
export default function EliminacionDeDatos() {
  return (
    <>
      <h1>Cómo pedir la eliminación de tus datos</h1>
      <p>
        Puedes pedir que borremos tu conversación y tus datos en cualquier momento.
        Hay dos formas, las dos gratuitas:
      </p>

      <h2>Opción 1 · Por WhatsApp</h2>
      <p>
        Escribe <strong>BAJA</strong> en la conversación (también valen «STOP»,
        «CANCELAR», «PARAR» o «ELIMINAR»). Con eso:
      </p>
      <ul>
        <li>dejamos de enviarte mensajes automáticos de inmediato, y</li>
        <li>se marca tu contacto como baja voluntaria.</li>
      </ul>
      <p>
        Si además quieres que borremos la conversación completa, pídelo por correo
        (opción 2) indicando el número desde el que escribiste.
      </p>

      <h2>Opción 2 · Por correo</h2>
      <p>
        Escribe a <strong>brandonriv99@outlook.com</strong> con el asunto
        «Eliminación de datos», desde cualquier correo, indicando el{' '}
        <strong>número de WhatsApp</strong> con el que nos escribiste. No pedimos
        más datos para atender la solicitud.
      </p>

      <h2>Qué borramos</h2>
      <ul>
        <li>Tu conversación y todos sus mensajes (texto, imágenes, notas de voz y archivos).</li>
        <li>Los archivos entregados asociados a esa conversación.</li>
        <li>Las etiquetas, las notas internas y el estado de seguimiento.</li>
        <li>Los comprobantes de pago que hayas enviado.</li>
        <li>Tu registro de contacto y tu número.</li>
      </ul>

      <h2>Qué conservamos y por qué</h2>
      <ul>
        <li>
          Si pediste la baja, guardamos únicamente la marca de «no volver a
          escribirte» para poder cumplirla.
        </li>
        <li>
          Si hubo una compra, los datos fiscales o contables que la ley nos obligue
          a conservar durante su plazo.
        </li>
      </ul>

      <h2>En cuánto tiempo</h2>
      <p>
        Atendemos la solicitud en un plazo máximo de <strong>30 días naturales</strong>{' '}
        y te confirmamos por el mismo medio por el que la pediste. El borrado es
        definitivo: no se puede deshacer.
      </p>

      <p>
        Nota: los mensajes que ya se enviaron por WhatsApp también viven en los
        servidores de Meta, fuera de nuestro alcance. Para eso puedes usar las
        herramientas de privacidad de la propia aplicación.
      </p>

      <p className="text-sm text-muted-foreground">
        Última actualización: noviembre de 2026.
      </p>
    </>
  )
}
