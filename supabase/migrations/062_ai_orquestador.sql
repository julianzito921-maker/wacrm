-- ============================================================
-- 062_ai_orquestador.sql — Etapa 1 del orquestador multimodal
--
-- Todo es ADITIVO:
--   * columnas nuevas en ai_configs y ai_usage_log (ADD COLUMN IF NOT EXISTS)
--   * ampliación del CHECK de ai_usage_log.mode (vision / asr)
--   * dos tablas nuevas (product_catalog, media_understanding)
-- No se borra ni se altera el tipo de ninguna columna existente.
--
-- Catálogo de productos: precios y condiciones comerciales en filas
-- estructuradas, para inyectarlas literales en el prompt del agente y que
-- no tenga que adivinar precios desde la base de conocimiento en texto libre.
-- `precio` es NULL cuando el producto va por aporte voluntario; en ese caso
-- `valores_sugeridos` lleva los importes de referencia.
--
-- Idempotente: se puede correr varias veces.
-- ============================================================

-- ------------------------------------------------------------ ai_configs
ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS vision_model    text,
  ADD COLUMN IF NOT EXISTS asr_model       text,
  ADD COLUMN IF NOT EXISTS orquestador     boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS catalog_strict  boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN ai_configs.vision_model IS
  'Modelo con visión para leer imágenes (p. ej. deepseek-flash). Vacío = usa `model`.';
COMMENT ON COLUMN ai_configs.asr_model IS
  'Modelo/endpoint de transcripción (p. ej. deepseek asr). Vacío = usa el adaptador por defecto.';
COMMENT ON COLUMN ai_configs.orquestador IS
  'Interruptor de la Etapa 1-3 del orquestador multimodal. Apagado = comportamiento actual.';
COMMENT ON COLUMN ai_configs.catalog_strict IS
  'Cuando está en true, el prompt prohíbe expresamente decir precios que no estén en el catálogo.';

-- ------------------------------------------------------------ ai_usage_log
ALTER TABLE ai_usage_log
  ADD COLUMN IF NOT EXISTS origen      text,
  ADD COLUMN IF NOT EXISTS latency_ms  integer;

ALTER TABLE ai_usage_log DROP CONSTRAINT IF EXISTS ai_usage_log_mode_check;
ALTER TABLE ai_usage_log
  ADD CONSTRAINT ai_usage_log_mode_check
  CHECK (mode IN ('auto_reply', 'draft', 'vision', 'asr'));

COMMENT ON COLUMN ai_usage_log.origen IS
  'Etapa que gastó los tokens: texto | vision | asr | orquestador.';
COMMENT ON COLUMN ai_usage_log.latency_ms IS
  'Duración de la llamada al proveedor en milisegundos, para medir latencia por etapa.';

-- ------------------------------------------------------------ product_catalog
CREATE TABLE IF NOT EXISTS product_catalog (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  clave             text NOT NULL,
  nombre            text NOT NULL,
  precio            numeric(10, 2),
  moneda            text NOT NULL DEFAULT 'MXN',
  aporte_voluntario boolean NOT NULL DEFAULT false,
  valores_sugeridos numeric(10, 2)[] NOT NULL DEFAULT '{}',
  incluye           text[] NOT NULL DEFAULT '{}',
  notas             text,
  activo            boolean NOT NULL DEFAULT true,
  orden             integer NOT NULL DEFAULT 100,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, clave)
);

ALTER TABLE product_catalog ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS product_catalog_select ON product_catalog;
CREATE POLICY product_catalog_select ON product_catalog FOR SELECT
USING (is_account_member(account_id));

DROP POLICY IF EXISTS product_catalog_write ON product_catalog;
CREATE POLICY product_catalog_write ON product_catalog FOR ALL
USING (is_account_member(account_id, 'admin'))
WITH CHECK (is_account_member(account_id, 'admin'));

CREATE INDEX IF NOT EXISTS idx_product_catalog_account
  ON product_catalog(account_id, orden);

-- ------------------------------------------------------------ media_understanding
-- Guarda lo que el orquestador entendió de cada imagen o nota de voz:
-- sirve de caché (no volver a pagar visión por el mismo mensaje) y de
-- auditoría de lo que la IA creyó ver.
CREATE TABLE IF NOT EXISTS media_understanding (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  message_id  uuid REFERENCES messages(id) ON DELETE CASCADE,
  clase       text NOT NULL CHECK (clase IN ('comprobante', 'producto', 'conversacion', 'voz', 'otro')),
  modelo      text,
  contenido   jsonb NOT NULL DEFAULT '{}'::jsonb,
  latency_ms  integer,
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE media_understanding ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS media_understanding_select ON media_understanding;
CREATE POLICY media_understanding_select ON media_understanding FOR SELECT
USING (is_account_member(account_id));

CREATE INDEX IF NOT EXISTS idx_media_understanding_account
  ON media_understanding(account_id, created_at DESC);

-- Un mismo mensaje no se entiende dos veces.
CREATE UNIQUE INDEX IF NOT EXISTS uq_media_understanding_message
  ON media_understanding(message_id)
  WHERE message_id IS NOT NULL;
