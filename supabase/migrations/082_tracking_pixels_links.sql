-- ============================================================
-- 082_tracking_pixels_links.sql
--
-- Sección Seguimiento de Configuración:
--   - tracking_pixels: píxeles por cuenta (Meta real; TikTok/Kwai/Google
--     guardados para una fase posterior). El token va cifrado con el
--     mismo helper que whatsapp_config.
--   - tracking_links: enlaces públicos /r/<slug> ligados a la conexión
--     de WhatsApp de la cuenta, con UTMs por defecto.
--   - tracking_clicks: cada clic, con el token corto que viaja en el
--     mensaje prellenado para atar el clic al contacto.
--   - contact_attribution: una fila por contacto con la atribución
--     (ctwa_clid del anuncio o clic del enlace), sin tocar los campos
--     personalizados existentes (se siguen escribiendo por compatibilidad).
--
-- Solo agrega. Idempotente.
-- ============================================================

-- ------------------------------------------------------------
-- PÍXELES
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tracking_pixels (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  platform TEXT NOT NULL CHECK (platform IN ('meta', 'tiktok', 'kwai', 'google')),
  name TEXT NOT NULL,
  pixel_id TEXT NOT NULL,
  -- Cifrado con src/lib/whatsapp/encryption.ts (nunca texto plano).
  access_token TEXT,
  test_event_code TEXT,
  -- Etapa del embudo que significa «compra» (solo Meta, dispara Purchase).
  purchase_stage_id UUID REFERENCES pipeline_stages(id) ON DELETE SET NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, platform, pixel_id)
);

CREATE INDEX IF NOT EXISTS idx_tracking_pixels_account
  ON tracking_pixels(account_id);
CREATE INDEX IF NOT EXISTS idx_tracking_pixels_active
  ON tracking_pixels(account_id, platform)
  WHERE active = TRUE AND platform = 'meta';

DROP TRIGGER IF EXISTS set_updated_at ON tracking_pixels;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON tracking_pixels
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ------------------------------------------------------------
-- ENLACES
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tracking_links (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  platform TEXT NOT NULL DEFAULT 'meta'
    CHECK (platform IN ('meta', 'tiktok', 'kwai', 'google', 'organic')),
  whatsapp_config_id UUID REFERENCES whatsapp_config(id) ON DELETE SET NULL,
  -- Número E.164 sin signos (lo que espera wa.me), congelado al crear.
  phone_number TEXT,
  prefilled_text TEXT,
  default_utm JSONB NOT NULL DEFAULT '{}'::jsonb,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tracking_links_account
  ON tracking_links(account_id);

DROP TRIGGER IF EXISTS set_updated_at ON tracking_links;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON tracking_links
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ------------------------------------------------------------
-- CLICS
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS tracking_clicks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  link_id UUID NOT NULL REFERENCES tracking_links(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- 6 caracteres; viaja como «#abc123» al final del mensaje prellenado.
  click_token TEXT NOT NULL UNIQUE,
  params JSONB NOT NULL DEFAULT '{}'::jsonb,
  referrer TEXT,
  -- Solo hash: nunca la IP cruda.
  ip_hash TEXT,
  user_agent TEXT,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  claimed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tracking_clicks_link
  ON tracking_clicks(link_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tracking_clicks_account
  ON tracking_clicks(account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tracking_clicks_contact
  ON tracking_clicks(contact_id)
  WHERE contact_id IS NOT NULL;

-- ------------------------------------------------------------
-- ATRIBUCIÓN DEL CONTACTO
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS contact_attribution (
  contact_id UUID PRIMARY KEY REFERENCES contacts(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source TEXT,
  link_id UUID REFERENCES tracking_links(id) ON DELETE SET NULL,
  click_id UUID REFERENCES tracking_clicks(id) ON DELETE SET NULL,
  ctwa_clid TEXT,
  campaign TEXT,
  adset TEXT,
  ad TEXT,
  creative TEXT,
  click_ids JSONB NOT NULL DEFAULT '{}'::jsonb,
  utm JSONB NOT NULL DEFAULT '{}'::jsonb,
  raw JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contact_attribution_account
  ON contact_attribution(account_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_contact_attribution_link
  ON contact_attribution(link_id)
  WHERE link_id IS NOT NULL;

-- ------------------------------------------------------------
-- RLS
-- ------------------------------------------------------------
ALTER TABLE tracking_pixels ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracking_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE tracking_clicks ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_attribution ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tracking_pixels_select ON tracking_pixels;
CREATE POLICY tracking_pixels_select ON tracking_pixels FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS tracking_pixels_write ON tracking_pixels;
CREATE POLICY tracking_pixels_write ON tracking_pixels FOR ALL
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

DROP POLICY IF EXISTS tracking_links_select ON tracking_links;
CREATE POLICY tracking_links_select ON tracking_links FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS tracking_links_write ON tracking_links;
CREATE POLICY tracking_links_write ON tracking_links FOR ALL
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

-- Los clics y la atribución los escribe el servidor con service_role.
DROP POLICY IF EXISTS tracking_clicks_select ON tracking_clicks;
CREATE POLICY tracking_clicks_select ON tracking_clicks FOR SELECT
  USING (is_account_member(account_id));

DROP POLICY IF EXISTS contact_attribution_select ON contact_attribution;
CREATE POLICY contact_attribution_select ON contact_attribution FOR SELECT
  USING (is_account_member(account_id));
