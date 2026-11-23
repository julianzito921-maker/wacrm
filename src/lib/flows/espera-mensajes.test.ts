import { describe, it, expect, afterEach, vi } from "vitest";
import { pausaHumana } from "./meta-send";

const ORIGINAL = {
  min: process.env.AI_ESPERA_MIN_MS,
  max: process.env.AI_ESPERA_MAX_MS,
};

afterEach(() => {
  vi.restoreAllMocks();
  process.env.AI_ESPERA_MIN_MS = ORIGINAL.min;
  process.env.AI_ESPERA_MAX_MS = ORIGINAL.max;
  if (ORIGINAL.min === undefined) delete process.env.AI_ESPERA_MIN_MS;
  if (ORIGINAL.max === undefined) delete process.env.AI_ESPERA_MAX_MS;
});

describe("pausaHumana", () => {
  it("con un mensaje corto espera un mínimo humano (2-3 s)", () => {
    delete process.env.AI_ESPERA_MIN_MS;
    delete process.env.AI_ESPERA_MAX_MS;
    for (let i = 0; i < 200; i++) {
      const ms = pausaHumana("hola");
      expect(ms).toBeGreaterThanOrEqual(2_100);
      expect(ms).toBeLessThanOrEqual(3_500);
    }
  });

  it("cuanto más largo el mensaje, más tarda en escribirlo", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    delete process.env.AI_ESPERA_MIN_MS;
    delete process.env.AI_ESPERA_MAX_MS;
    const corto = pausaHumana("hola");
    const medio = pausaHumana("x".repeat(120));
    const largo = pausaHumana("x".repeat(500));
    // El largo se topa en 12 s (con su variación de ±15 %).
    expect(medio).toBeGreaterThan(corto);
    expect(largo).toBeGreaterThan(medio);
    expect(largo).toBeLessThanOrEqual(14_000);
  });

  it("nunca pasa del tope configurado", () => {
    process.env.AI_ESPERA_MIN_MS = "1000";
    process.env.AI_ESPERA_MAX_MS = "2000";
    for (let i = 0; i < 50; i++) {
      const ms = pausaHumana("x".repeat(3000));
      expect(ms).toBeGreaterThanOrEqual(850);
      expect(ms).toBeLessThanOrEqual(2_400);
    }
  });

  it("no se rompe si el máximo es menor que el mínimo", () => {
    process.env.AI_ESPERA_MIN_MS = "5000";
    process.env.AI_ESPERA_MAX_MS = "1000";
    const ms = pausaHumana();
    expect(ms).toBeGreaterThanOrEqual(4_200);
    expect(ms).toBeLessThanOrEqual(5_800);
  });

});
