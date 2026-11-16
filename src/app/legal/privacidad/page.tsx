export const metadata = {
  title: 'Aviso de privacidad · Aprende y Gana',
}

/**
 * Aviso de privacidad. Meta lo exige como «URL de la política de
 * privacidad» para publicar la app de WhatsApp.
 *
 * Describe lo que el sistema de verdad hace (revisar antes de cambiar:
 * si se añade un proveedor, se añade aquí).
 */
export default function Privacidad() {
  return (
    <>
      <h1>Aviso de privacidad</h1>
      <p>
        <strong>Aprende y Gana</strong> (en adelante, «nosotros») trata los datos
        personales que las personas comparten por WhatsApp para atender su
        solicitud y entregar el material que piden. Este aviso explica qué datos
        son, para qué se usan y cómo se eliminan.
      </p>

      <h2>Qué datos tratamos</h2>
      <ul>
        <li>Tu número de WhatsApp, tu nombre de perfil y el idioma de tus mensajes.</li>
        <li>
          El contenido de la conversación: mensajes de texto, imágenes, notas de
          voz y archivos que nos envías.
        </li>
        <li>
          Información de seguimiento interno: etiquetas, notas y el estado de la
          conversación (por ejemplo, «pidió hablar con una persona»).
        </li>
        <li>
          Si nos mandas un comprobante de pago, la imagen y los datos que
          aparezcan en ella, para poder verificar el pago.
        </li>
      </ul>

      <h2>Para qué los usamos</h2>
      <ul>
        <li>Responderte, enviarte la información y entregarte el material.</li>
        <li>Dar seguimiento a la conversación y a tu aporte voluntario.</li>
        <li>Mejorar las respuestas y la calidad del servicio.</li>
        <li>Cumplir obligaciones legales o fiscales, cuando apliquen.</li>
      </ul>
      <p>
        No usamos tus datos para publicidad de terceros ni los vendemos.
      </p>

      <h2>Con quién se comparten</h2>
      <p>
        Usamos proveedores que tratan los datos solo para prestarnos el servicio:
      </p>
      <ul>
        <li>
          <strong>Meta Platforms (WhatsApp Business Platform)</strong>: es el canal
          por el que se envían y reciben los mensajes.
        </li>
        <li>
          <strong>Supabase</strong>: base de datos y almacenamiento de archivos.
        </li>
        <li>
          <strong>Railway</strong>: hospedaje del sistema que gestiona la
          conversación.
        </li>
        <li>
          <strong>DeepSeek</strong>: procesamiento automático del texto e imágenes
          para redactar o entender la respuesta.
        </li>
      </ul>

      <h2>Cuánto tiempo</h2>
      <p>
        Conservamos la conversación mientras exista la relación y hasta que pidas
        su eliminación. Si pediste que no te escribamos, guardamos ese registro
        para no volver a contactarte.
      </p>

      <h2>Tus derechos</h2>
      <p>
        Puedes pedirnos acceso, corrección, eliminación u oposición al tratamiento
        escribiendo a <strong>brandonriv99@outlook.com</strong>. También puedes
        escribir <strong>BAJA</strong> (o STOP, CANCELAR, PARAR) en el propio
        WhatsApp y el sistema deja de enviarte mensajes automáticos. Encontrarás
        los detalles en{' '}
        <a href="/legal/eliminacion-de-datos">Eliminación de datos</a>.
      </p>

      <h2>Menores de edad</h2>
      <p>
        El servicio no está dirigido a menores de 18 años. Si detectamos una cuenta
        de un menor, la eliminamos.
      </p>

      <h2>Cambios</h2>
      <p>
        Si cambiamos este aviso, publicaremos la versión actualizada en esta misma
        página con su fecha.
      </p>

      <p className="text-sm text-muted-foreground">
        Última actualización: noviembre de 2026.
      </p>
    </>
  )
}
