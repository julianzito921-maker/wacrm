import { describe, expect, it } from "vitest";

import {
  combinarDatosPago,
  textoPagoSpei,
  veredictoPago,
  type DatosPago,
} from "./bloques";
import { parametrosDePlantilla, sustituirFichas, variablesDelCuerpo } from "./fichas";
import { mensajeParaFlujo } from "./entrante";
import type { LecturaComprobante } from "@/lib/ventas/comprobante";
import type { SendPaymentNodeConfig } from "./types";

const datos = {
  contacto: { name: "Ana", phone: "5215512345678", email: null },
  personalizados: { ciudad: "CDMX" },
  vars: { edad: 41 },
};

describe("fichas", () => {
  it("sustituye contacto, campos personalizados y variables del flujo", () => {
    expect(
      sustituirFichas("Hola {{contact.name}} de {{custom.ciudad}}, {{vars.edad}} años", datos),
    ).toBe("Hola Ana de CDMX, 41 años");
  });

  it("lo que no existe queda vacío (nunca «undefined»)", () => {
    expect(sustituirFichas("[{{contact.email}}][{{custom.nada}}][{{vars.x}}]", datos)).toBe("[][][]");
  });

  it("acepta espacios dentro de las llaves", () => {
    expect(sustituirFichas("{{ contact.name }}", datos)).toBe("Ana");
  });
});

describe("Template WhatsApp", () => {
  it("ordena {{1}}…{{10}} por número, no alfabéticamente", () => {
    const vars: Record<string, string> = {};
    for (let i = 1; i <= 10; i++) vars[String(i)] = `v${i}`;
    vars["1"] = "{{contact.name}}";
    expect(parametrosDePlantilla(vars, datos)).toEqual([
      "Ana", "v2", "v3", "v4", "v5", "v6", "v7", "v8", "v9", "v10",
    ]);
  });

  it("detecta las variables del cuerpo, sin repetir y en orden", () => {
    expect(variablesDelCuerpo("Hola {{2}}, {{1}} y otra vez {{ 2 }}")).toEqual(["1", "2"]);
    expect(variablesDelCuerpo("Sin variables")).toEqual([]);
  });
});

const cfgPago = (extra: Partial<SendPaymentNodeConfig> = {}): SendPaymentNodeConfig => ({
  clabe: "",
  beneficiario: "",
  banco: "",
  monto: 99,
  con_boton: false,
  espera_minutos: 120,
  aprobado_next: "ok",
  rechazado_next: "no",
  ...extra,
});

describe("Botón Pago / SPEI: datos", () => {
  it("lo vacío del nodo se completa con los datos de pago de la cuenta", () => {
    const d = combinarDatosPago(cfgPago({ banco: "BBVA" }), {
      clabe: "0121 8000 1234 5678 90",
      holder: "Editorial Nova",
      bank: "STP",
    });
    expect(d).toEqual({
      clabe: "012180001234567890",
      beneficiario: "Editorial Nova",
      banco: "BBVA",
      monto: 99,
      referencia: "",
    });
  });

  it("el texto SPEI es limpio: CLABE sola en su renglón y sin renglones vacíos dobles", () => {
    const texto = textoPagoSpei({
      clabe: "012180001234567890",
      beneficiario: "Editorial Nova",
      banco: "",
      monto: 99,
      referencia: "",
    });
    const renglones = texto.split("\n");
    expect(renglones).toContain("012180001234567890");
    expect(texto).toContain("$99 MXN");
    expect(texto).not.toContain("Banco");
    expect(texto).not.toMatch(/\n\n\n/);
    expect(texto).not.toMatch(/https?:\/\//);
  });
});

const lecturaOk = (extra: Partial<LecturaComprobante> = {}): LecturaComprobante => ({
  es_comprobante: true,
  monto: 99,
  banco_destino: "STP",
  ultimos_digitos_destino: "7890",
  estado: "exitosa",
  fecha: "2026-11-22",
  referencia: "REF123456",
  tipo: "spei",
  ...extra,
});

const datosPago: DatosPago = {
  clabe: "012180001234567890",
  beneficiario: "Editorial Nova",
  banco: "STP",
  monto: 99,
  referencia: "",
};

describe("Botón Pago / SPEI: veredicto", () => {
  it("monto y CLABE correctos y exitosa → Aprobado", () => {
    expect(veredictoPago(lecturaOk(), datosPago, false).resultado).toBe("aprobado");
  });

  it("otro monto → Rechazado", () => {
    const v = veredictoPago(lecturaOk({ monto: 59 }), datosPago, false);
    expect(v.resultado).toBe("rechazado");
    expect(v.motivos.join()).toContain("monto");
  });

  it("transferencia a otra cuenta → Rechazado", () => {
    const v = veredictoPago(lecturaOk({ ultimos_digitos_destino: "1111" }), datosPago, false);
    expect(v.resultado).toBe("rechazado");
    expect(v.motivos.join()).toContain("destino");
  });

  it("pendiente o fallida → Rechazado", () => {
    expect(veredictoPago(lecturaOk({ estado: "pendiente" }), datosPago, false).resultado).toBe("rechazado");
  });

  it("referencia ya aprobada antes → Rechazado (antifraude)", () => {
    const v = veredictoPago(lecturaOk(), datosPago, true);
    expect(v.resultado).toBe("rechazado");
    expect(v.motivos.join()).toContain("repetida");
  });

  it("una foto que no es comprobante → se le pide otra (no se rechaza)", () => {
    expect(veredictoPago(lecturaOk({ es_comprobante: false }), datosPago, false).resultado).toBe(
      "reintentar",
    );
  });

  it("si la IA no pudo leerlo → Rechazado para revisar a mano", () => {
    const v = veredictoPago(null, datosPago, false);
    expect(v.resultado).toBe("rechazado");
    expect(v.motivos.join()).toContain("revisar a mano");
  });
});

describe("mensaje entrante para el flujo", () => {
  it("imagen → media con su id y su tipo", () => {
    expect(
      mensajeParaFlujo(
        { id: "w1", type: "image", image: { id: "m1", mime_type: "image/jpeg" } },
        null,
        "mi pago",
      ),
    ).toEqual({
      kind: "media",
      media_type: "image",
      media_id: "m1",
      mime_type: "image/jpeg",
      text: "mi pago",
      meta_message_id: "w1",
    });
  });

  it("PDF → media de tipo documento", () => {
    const m = mensajeParaFlujo(
      { id: "w2", type: "document", document: { id: "d1", mime_type: "application/pdf" } },
      null,
      "comprobante.pdf",
    );
    expect(m).toMatchObject({ kind: "media", media_type: "document", mime_type: "application/pdf" });
  });

  it("texto y botones siguen igual que antes", () => {
    expect(mensajeParaFlujo({ id: "w3", type: "text", text: { body: "hola" } }, null, "hola")).toEqual({
      kind: "text",
      text: "hola",
      meta_message_id: "w3",
    });
    expect(mensajeParaFlujo({ id: "w4", type: "interactive" }, "pago_ya", "Ya pagué ✅")).toMatchObject({
      kind: "interactive_reply",
      reply_id: "pago_ya",
    });
  });
});
