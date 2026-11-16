import { describe, it, expect, afterEach } from "vitest";
import { pausaHumana } from "./meta-send";

const ORIGINAL = {
  min: process.env.AI_ESPERA_MIN_MS,
  max: process.env.AI_ESPERA_MAX_MS,
};

afterEach(() => {
  process.env.AI_ESPERA_MIN_MS = ORIGINAL.min;
  process.env.AI_ESPERA_MAX_MS = ORIGINAL.max;
  if (ORIGINAL.min === undefined) delete process.env.AI_ESPERA_MIN_MS;
  if (ORIGINAL.max === undefined) delete process.env.AI_ESPERA_MAX_MS;
});

describe("pausaHumana", () => {
  it("espera entre 3 y 7 segundos por defecto", () => {
    delete process.env.AI_ESPERA_MIN_MS;
    delete process.env.AI_ESPERA_MAX_MS;
    for (let i = 0; i < 200; i++) {
      const ms = pausaHumana();
      expect(ms).toBeGreaterThanOrEqual(3_000);
      expect(ms).toBeLessThanOrEqual(7_000);
    }
  });

  it("respeta los ajustes del entorno", () => {
    process.env.AI_ESPERA_MIN_MS = "1000";
    process.env.AI_ESPERA_MAX_MS = "2000";
    for (let i = 0; i < 50; i++) {
      const ms = pausaHumana();
      expect(ms).toBeGreaterThanOrEqual(1_000);
      expect(ms).toBeLessThanOrEqual(2_000);
    }
  });

  it("no se rompe si el máximo es menor que el mínimo", () => {
    process.env.AI_ESPERA_MIN_MS = "5000";
    process.env.AI_ESPERA_MAX_MS = "1000";
    expect(pausaHumana()).toBe(5_000);
  });
});
