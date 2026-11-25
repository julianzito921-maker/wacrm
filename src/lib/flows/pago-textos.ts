/**
 * Datos y textos del pago SPEI (Botón Pago y Pasarela). Puros y sin
 * dependencias de servidor: los usan el motor y el simulador del editor.
 */

import type { SendPaymentNodeConfig } from "./types";

export interface DatosPago {
  clabe: string;
  beneficiario: string;
  banco: string;
  monto: number;
  referencia: string;
}

/** Completa lo vacío del nodo con `payment_details` de la cuenta. Pura. */
export function combinarDatosPago(
  cfg: SendPaymentNodeConfig,
  cuenta: { clabe?: string | null; holder?: string | null; bank?: string | null } | null,
): DatosPago {
  return {
    clabe: (cfg.clabe || cuenta?.clabe || "").replace(/\s+/g, ""),
    beneficiario: cfg.beneficiario || cuenta?.holder || "",
    banco: cfg.banco || cuenta?.bank || "",
    monto: Number(cfg.monto) || 0,
    referencia: cfg.referencia || "",
  };
}

const formatoMonto = (n: number) =>
  `$${n.toLocaleString("es-MX", { minimumFractionDigits: n % 1 ? 2 : 0, maximumFractionDigits: 2 })} MXN`;

/**
 * Texto con los datos SPEI. Corto y limpio (regla de venta conversacional):
 * la CLABE va sola en su renglón para que se pueda copiar con un toque largo.
 * Pura.
 */
export function textoPagoSpei(datos: DatosPago, mensaje?: string): string {
  const renglones = [
    (mensaje && mensaje.trim()) || "Te paso los datos para tu transferencia SPEI 👇",
    "",
    `*Monto:* ${formatoMonto(datos.monto)}`,
    datos.banco ? `*Banco:* ${datos.banco}` : "",
    datos.beneficiario ? `*Beneficiario:* ${datos.beneficiario}` : "",
    "*CLABE:*",
    datos.clabe,
    datos.referencia ? `*Concepto / referencia:* ${datos.referencia}` : "",
    "",
    "Cuando pagues, mándame la captura o el PDF del comprobante por aquí 📸",
  ];
  return renglones
    .filter((r, i, todos) => r !== "" || (i > 0 && todos[i - 1] !== ""))
    .join("\n")
    .trim();
}

/** Botones (solo si el nodo los enciende). */
export const BOTONES_PAGO = [
  { reply_id: "pago_ya", title: "Ya pagué ✅" },
  { reply_id: "pago_duda", title: "Tengo una duda" },
] as const;

export const TEXTO_PIDE_COMPROBANTE =
  "Perfecto 🙌 mándame la captura o el PDF de tu transferencia por aquí y lo reviso.";
export const TEXTO_NO_ES_COMPROBANTE =
  "Mmm 🤔 eso no parece un comprobante de pago. ¿Me mandas la captura o el PDF de tu transferencia? 📸";

