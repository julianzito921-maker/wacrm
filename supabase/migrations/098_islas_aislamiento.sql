-- ============================================================
-- 098_islas_aislamiento.sql
--
-- Islas de WhatsApp: WABA + teléfono + token + píxel + dominio.
-- La tabla canónica es whatsapp_connections; whatsapp_config queda
-- como compatibilidad legacy.
--
-- Requiere 089 y 097. Idempotente.
-- ============================================================

-- ============================================================
-- 1. CONEXIONES: píxel, dominio, default y activo
-- ============================================================
ALTER TABLE whatsapp_connections
  ADD COLUMN IF NOT EXISTS tracking_pixel_id UUID
    REFERENCES tracking_pixels(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS custom_domain TEXT,
  ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'whatsapp_connections_custom_domain_check'
      AND conrelid = 'whatsapp_connections'::regclass
  ) THEN
    ALTER TABLE whatsapp_connections
      ADD CONSTRAINT whatsapp_connections_custom_domain_check
      CHECK (
        custom_domain IS NULL
        OR custom_domain ~ '^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$'
      );
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_connections_one_default
  ON whatsapp_connections(account_id)
  WHERE is_default;

CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_connections_domain_key
  ON whatsapp_connections(lower(custom_domain))
  WHERE custom_domain IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_whatsapp_connections_tracking_pixel
  ON whatsapp_connections(tracking_pixel_id)
  WHERE tracking_pixel_id IS NOT NULL;

-- Las conexiones desconectadas arrancan inactivas; el admin puede
-- reactivarlas sin volver a emparejar.
UPDATE whatsapp_connections
SET active = FALSE
WHERE status = 'disconnected' AND active = TRUE;

-- Primera conexión de cada cuenta como default.
WITH primera AS (
  SELECT DISTINCT ON (account_id) id, account_id
  FROM whatsapp_connections
  ORDER BY account_id, created_at, id
)
UPDATE whatsapp_connections c
SET is_default = TRUE
FROM primera p
WHERE c.id = p.id
  AND NOT EXISTS (
    SELECT 1 FROM whatsapp_connections d
    WHERE d.account_id = c.account_id AND d.is_default
  );

-- 089/097 usan grants por columna; las columnas nuevas hay que
-- exponerlas explícitamente a la sesión del dashboard.
GRANT SELECT (
  display_phone_number,
  whatsapp_business_manager_messaging_limit,
  messaging_limit_updated_at,
  health_status,
  restriction_scope,
  health_reason,
  restricted_until,
  last_health_event_at,
  warmup_enabled,
  warmup_started_at,
  tracking_pixel_id,
  custom_domain,
  is_default,
  active
) ON whatsapp_connections TO authenticated;

-- ============================================================
-- 2. VENTAS: conexión real además del instance_id legacy
-- ============================================================
ALTER TABLE sales
  ADD COLUMN IF NOT EXISTS connection_id UUID
    REFERENCES whatsapp_connections(id) ON DELETE SET NULL;

UPDATE sales s
SET connection_id = c.connection_id
FROM conversations c
WHERE s.conversation_id = c.id
  AND s.connection_id IS NULL;

-- Puente legacy: sales.instance_id -> whatsapp_config -> connection.
UPDATE sales s
SET connection_id = w.id
FROM whatsapp_config cfg
JOIN whatsapp_connections w ON w.phone_number_id = cfg.phone_number_id
WHERE s.instance_id = cfg.id
  AND s.connection_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_sales_connection
  ON sales(connection_id)
  WHERE connection_id IS NOT NULL;

-- Nuevas ventas desde deals y comprobantes deben guardar la conexión
-- de la conversación (o la default de la cuenta si no hay hilo).
CREATE OR REPLACE FUNCTION public.registrar_venta_deal()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_contact RECORD;
  v_conn UUID;
  v_connection UUID;
  v_amount NUMERIC;
  v_sold_at TIMESTAMPTZ;
  v_currency TEXT;
BEGIN
  IF NEW.status <> 'won' THEN
    RETURN NEW;
  END IF;

  SELECT c.name, c.lead_number INTO v_contact
  FROM contacts c WHERE c.id = NEW.contact_id;

  SELECT w.id INTO v_conn
  FROM whatsapp_config w
  WHERE w.account_id = NEW.account_id
  ORDER BY w.created_at, w.id
  LIMIT 1;

  SELECT COALESCE(
    (SELECT c.connection_id FROM conversations c WHERE c.id = NEW.conversation_id),
    (SELECT w.id FROM whatsapp_connections w
      WHERE w.account_id = NEW.account_id
      ORDER BY w.is_default DESC, w.created_at, w.id LIMIT 1)
  ) INTO v_connection;

  SELECT COALESCE(a.default_currency, 'USD') INTO v_currency
  FROM accounts a WHERE a.id = NEW.account_id;

  v_amount := COALESCE(NEW.value, 0);
  v_sold_at := COALESCE(NEW.closed_at, NEW.updated_at, NEW.created_at, NOW());

  IF EXISTS (
    SELECT 1 FROM sales s
    WHERE s.account_id = NEW.account_id
      AND s.contact_id = NEW.contact_id
      AND s.amount = v_amount
      AND s.sold_at::date = v_sold_at::date
      AND s.source = 'payment_receipt'
  ) THEN
    RETURN NEW;
  END IF;

  INSERT INTO sales (
    account_id, contact_id, conversation_id, product_id, instance_id,
    connection_id, lead_number, client_name, amount, currency, status,
    source, source_ref, sold_at, created_by
  ) VALUES (
    NEW.account_id, NEW.contact_id, NEW.conversation_id, NULL, v_conn,
    v_connection, v_contact.lead_number, v_contact.name, v_amount,
    COALESCE(NULLIF(NEW.currency, ''), v_currency), 'confirmed',
    'deal', 'deal:' || NEW.id, v_sold_at, NEW.user_id
  )
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.registrar_venta_recibo()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_contact RECORD;
  v_conn UUID;
  v_connection UUID;
  v_currency TEXT;
BEGIN
  IF NEW.resultado <> 'aprobado' OR NEW.monto IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT c.name, c.lead_number INTO v_contact
  FROM contacts c WHERE c.id = NEW.contact_id;

  SELECT w.id INTO v_conn
  FROM whatsapp_config w
  WHERE w.account_id = NEW.account_id
  ORDER BY w.created_at, w.id
  LIMIT 1;

  SELECT COALESCE(
    (SELECT c.connection_id FROM conversations c
      WHERE c.contact_id = NEW.contact_id AND c.account_id = NEW.account_id
      ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC LIMIT 1),
    (SELECT w.id FROM whatsapp_connections w
      WHERE w.account_id = NEW.account_id
      ORDER BY w.is_default DESC, w.created_at, w.id LIMIT 1)
  ) INTO v_connection;

  SELECT COALESCE(a.default_currency, 'USD') INTO v_currency
  FROM accounts a WHERE a.id = NEW.account_id;

  IF EXISTS (
    SELECT 1 FROM sales s
    WHERE s.account_id = NEW.account_id
      AND s.contact_id = NEW.contact_id
      AND s.amount = NEW.monto
      AND s.sold_at::date = NEW.created_at::date
      AND s.source = 'deal'
  ) THEN
    RETURN NEW;
  END IF;

  INSERT INTO sales (
    account_id, contact_id, conversation_id, product_id, instance_id,
    connection_id, lead_number, client_name, amount, currency, payment_id,
    status, source, source_ref, sold_at, created_by
  ) VALUES (
    NEW.account_id, NEW.contact_id, NULL, NULL, v_conn,
    v_connection, v_contact.lead_number, v_contact.name, NEW.monto, v_currency,
    NEW.referencia, 'confirmed', 'payment_receipt',
    'receipt:' || NEW.id, NEW.created_at, NULL
  )
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$;

-- ============================================================
-- 3. MENSAJES: conexión para auditoría directa
-- ============================================================
ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS connection_id UUID
    REFERENCES whatsapp_connections(id) ON DELETE SET NULL;

UPDATE messages m
SET connection_id = c.connection_id
FROM conversations c
WHERE m.conversation_id = c.id
  AND m.connection_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_messages_connection
  ON messages(connection_id, created_at DESC)
  WHERE connection_id IS NOT NULL;

-- ============================================================
-- 4. SEGUIMIENTO: dominio y conexión en enlaces/clics
-- ============================================================
ALTER TABLE tracking_links
  ADD COLUMN IF NOT EXISTS domain TEXT;

UPDATE tracking_links l
SET connection_id = w.id
FROM whatsapp_config cfg
JOIN whatsapp_connections w ON w.phone_number_id = cfg.phone_number_id
WHERE l.whatsapp_config_id = cfg.id
  AND l.connection_id IS NULL;

UPDATE tracking_links l
SET domain = w.custom_domain
FROM whatsapp_connections w
WHERE l.connection_id = w.id
  AND l.domain IS NULL
  AND w.custom_domain IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_tracking_links_connection_domain
  ON tracking_links(connection_id, domain)
  WHERE connection_id IS NOT NULL;

ALTER TABLE tracking_clicks
  ADD COLUMN IF NOT EXISTS connection_id UUID
    REFERENCES whatsapp_connections(id) ON DELETE SET NULL;

UPDATE tracking_clicks c
SET connection_id = l.connection_id
FROM tracking_links l
WHERE c.link_id = l.id
  AND c.connection_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_tracking_clicks_connection
  ON tracking_clicks(connection_id, created_at DESC)
  WHERE connection_id IS NOT NULL;

-- ============================================================
-- 5. ATRIBUCIÓN POR ISLA (CTWA no se mezcla entre conexiones)
-- ============================================================
CREATE TABLE IF NOT EXISTS contact_attribution_islas (
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  connection_id UUID NOT NULL REFERENCES whatsapp_connections(id) ON DELETE CASCADE,
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
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (contact_id, connection_id)
);

CREATE INDEX IF NOT EXISTS idx_attribution_islas_account
  ON contact_attribution_islas(account_id, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_attribution_islas_connection
  ON contact_attribution_islas(connection_id, last_seen_at DESC);

ALTER TABLE contact_attribution_islas ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS contact_attribution_islas_select ON contact_attribution_islas;
CREATE POLICY contact_attribution_islas_select ON contact_attribution_islas
  FOR SELECT USING (is_account_member(account_id));

-- Backfill desde la fila única vieja + la conversación con conexión
-- más reciente del contacto. La tabla vieja no se toca.
INSERT INTO contact_attribution_islas (
  contact_id, connection_id, account_id, source, link_id, click_id,
  ctwa_clid, campaign, adset, ad, creative, click_ids, utm, raw,
  first_seen_at, last_seen_at
)
SELECT
  ca.contact_id,
  conv.connection_id,
  ca.account_id,
  ca.source, ca.link_id, ca.click_id,
  ca.ctwa_clid, ca.campaign, ca.adset, ca.ad, ca.creative,
  ca.click_ids, ca.utm, ca.raw,
  ca.first_seen_at, ca.last_seen_at
FROM contact_attribution ca
JOIN LATERAL (
  SELECT c.connection_id
  FROM conversations c
  WHERE c.contact_id = ca.contact_id
    AND c.connection_id IS NOT NULL
  ORDER BY c.last_message_at DESC NULLS LAST, c.created_at DESC
  LIMIT 1
) conv ON TRUE
ON CONFLICT (contact_id, connection_id) DO NOTHING;

-- ============================================================
-- 6. PLANTILLAS: conexión de origen (WABA)
-- ============================================================
ALTER TABLE message_templates
  ADD COLUMN IF NOT EXISTS connection_id UUID
    REFERENCES whatsapp_connections(id) ON DELETE SET NULL;

UPDATE message_templates t
SET connection_id = w.id
FROM whatsapp_connections w
WHERE t.connection_id IS NULL
  AND t.account_id = w.account_id
  AND t.waba_id IS NOT NULL
  AND t.waba_id = w.waba_id;

CREATE INDEX IF NOT EXISTS idx_message_templates_connection
  ON message_templates(connection_id)
  WHERE connection_id IS NOT NULL;

-- ============================================================
-- 7. DASHBOARD V2: filtro y desglose por conexión real
-- ============================================================
DROP FUNCTION IF EXISTS public.dashboard_sales_v2(
  TIMESTAMPTZ, TIMESTAMPTZ, UUID, UUID, UUID, UUID, TEXT, TEXT
);

CREATE OR REPLACE FUNCTION public.dashboard_sales_v2(
  p_from TIMESTAMPTZ,
  p_to TIMESTAMPTZ,
  p_connection_id UUID DEFAULT NULL,
  p_product_id UUID DEFAULT NULL,
  p_agent_id UUID DEFAULT NULL,
  p_instance_id UUID DEFAULT NULL,
  p_currency TEXT DEFAULT NULL,
  p_tz TEXT DEFAULT 'UTC'
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account UUID;
  v_currency TEXT;
  v_prev_from TIMESTAMPTZ;
  v_prev_to TIMESTAMPTZ;
  v_unit TEXT;
  v_tz TEXT := 'UTC';
BEGIN
  SELECT p.account_id INTO v_account
  FROM profiles p WHERE p.user_id = auth.uid();
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'caller is not a member of an account' USING ERRCODE = '42501';
  END IF;
  IF p_from IS NULL OR p_to IS NULL OR p_to <= p_from THEN
    RAISE EXCEPTION 'invalid period' USING ERRCODE = '22023';
  END IF;
  IF p_tz IS NOT NULL THEN
    BEGIN
      PERFORM p_from AT TIME ZONE p_tz;
      v_tz := p_tz;
    EXCEPTION WHEN invalid_parameter_value THEN
      v_tz := 'UTC';
    END;
  END IF;

  SELECT COALESCE(NULLIF(p_currency, ''), a.default_currency, 'USD')
  INTO v_currency
  FROM accounts a WHERE a.id = v_account;

  v_prev_to := p_from;
  v_prev_from := p_from - (p_to - p_from);
  v_unit := CASE WHEN (p_to - p_from) <= INTERVAL '2 days' THEN 'hour' ELSE 'day' END;

  RETURN (
    WITH base AS (
      SELECT s.*, (s.sold_at AT TIME ZONE v_tz) AS local_at
      FROM sales s
      WHERE s.account_id = v_account
        AND s.status = 'confirmed'
        AND s.currency = v_currency
        AND s.sold_at >= p_from AND s.sold_at < p_to
        AND (p_connection_id IS NULL OR s.connection_id = p_connection_id)
        AND (p_instance_id IS NULL OR s.instance_id = p_instance_id)
        AND (p_product_id IS NULL OR s.product_id = p_product_id)
        AND (p_agent_id IS NULL OR s.created_by = p_agent_id)
    ),
    prev AS (
      SELECT s.* FROM sales s
      WHERE s.account_id = v_account
        AND s.status = 'confirmed'
        AND s.currency = v_currency
        AND s.sold_at >= v_prev_from AND s.sold_at < v_prev_to
        AND (p_connection_id IS NULL OR s.connection_id = p_connection_id)
        AND (p_instance_id IS NULL OR s.instance_id = p_instance_id)
        AND (p_product_id IS NULL OR s.product_id = p_product_id)
        AND (p_agent_id IS NULL OR s.created_by = p_agent_id)
    ),
    leads AS (
      SELECT count(*) AS n FROM contacts
      WHERE account_id = v_account AND created_at >= p_from AND created_at < p_to
    ),
    prev_leads AS (
      SELECT count(*) AS n FROM contacts
      WHERE account_id = v_account AND created_at >= v_prev_from AND created_at < v_prev_to
    ),
    spend AS (
      SELECT COALESCE(sum(amount), 0) AS s FROM ad_spend
      WHERE account_id = v_account AND platform = 'meta' AND currency = v_currency
        AND spent_on >= (p_from AT TIME ZONE v_tz)::date
        AND spent_on < (p_to AT TIME ZONE v_tz)::date
    ),
    prev_spend AS (
      SELECT COALESCE(sum(amount), 0) AS s FROM ad_spend
      WHERE account_id = v_account AND platform = 'meta' AND currency = v_currency
        AND spent_on >= (v_prev_from AT TIME ZONE v_tz)::date
        AND spent_on < (v_prev_to AT TIME ZONE v_tz)::date
    ),
    cur AS (
      SELECT
        COALESCE((SELECT sum(amount) FROM base), 0) AS revenue,
        (SELECT count(*) FROM base) AS sales,
        (SELECT n FROM leads) AS leads,
        (SELECT s FROM spend) AS spend
    ),
    prv AS (
      SELECT
        COALESCE((SELECT sum(amount) FROM prev), 0) AS revenue,
        (SELECT count(*) FROM prev) AS sales,
        (SELECT n FROM prev_leads) AS leads,
        (SELECT s FROM prev_spend) AS spend
    ),
    buckets AS (
      SELECT generate_series(
        date_trunc(v_unit, p_from AT TIME ZONE v_tz),
        date_trunc(v_unit, p_to AT TIME ZONE v_tz)
          - CASE WHEN v_unit = 'hour' THEN INTERVAL '1 hour' ELSE INTERVAL '1 day' END,
        CASE WHEN v_unit = 'hour' THEN INTERVAL '1 hour' ELSE INTERVAL '1 day' END
      ) AS b
    ),
    series AS (
      SELECT
        to_char(bk.b, 'YYYY-MM-DD"T"HH24:MI') AS t,
        COALESCE(sum(x.amount), 0) AS revenue,
        count(x.id) AS count
      FROM buckets bk
      LEFT JOIN base x ON date_trunc(v_unit, x.local_at) = bk.b
      GROUP BY bk.b
      ORDER BY bk.b
    ),
    hourly AS (
      SELECT
        h.hour,
        count(x.id) AS count,
        COALESCE(sum(x.amount), 0) AS revenue
      FROM generate_series(0, 23) h(hour)
      LEFT JOIN base x ON extract(hour FROM x.local_at)::int = h.hour
      GROUP BY h.hour
      ORDER BY h.hour
    ),
    by_connection AS (
      SELECT
        COALESCE(x.connection_id::text, 'sin') AS id,
        COALESCE(w.name, 'Sin conexión') AS label,
        COALESCE(w.phone_number, w.display_phone_number, w.phone_number_id) AS instance_number,
        count(x.id) AS count,
        COALESCE(sum(x.amount), 0) AS revenue
      FROM base x
      LEFT JOIN whatsapp_connections w ON w.id = x.connection_id
      GROUP BY x.connection_id, w.name, w.phone_number, w.display_phone_number, w.phone_number_id
      ORDER BY revenue DESC
    ),
    by_instance AS (
      SELECT
        COALESCE(x.instance_id::text, 'sin') AS id,
        COALESCE('WhatsApp ' || right(cfg.phone_number_id, 4), 'Sin conexión') AS label,
        count(x.id) AS count,
        COALESCE(sum(x.amount), 0) AS revenue
      FROM base x
      LEFT JOIN whatsapp_config cfg ON cfg.id = x.instance_id
      GROUP BY x.instance_id, cfg.phone_number_id
      ORDER BY revenue DESC
    ),
    by_state AS (
      SELECT
        COALESCE(NULLIF(x.region, ''), 'Sin estado') AS state,
        count(*) AS count,
        COALESCE(sum(x.amount), 0) AS revenue
      FROM base x
      GROUP BY 1
      ORDER BY revenue DESC
    ),
    by_product AS (
      SELECT
        COALESCE(x.product_id::text, 'sin') AS id,
        COALESCE(pc.nombre, 'Sin producto') AS name,
        count(*) AS count,
        COALESCE(sum(x.amount), 0) AS revenue
      FROM base x
      LEFT JOIN product_catalog pc ON pc.id = x.product_id
      GROUP BY x.product_id, pc.nombre
      ORDER BY revenue DESC
    ),
    history AS (
      SELECT
        x.id,
        x.client_name,
        x.amount,
        x.currency,
        x.payment_id,
        x.meta_ref,
        x.region,
        x.status,
        x.sold_at,
        x.lead_number,
        x.conversation_id,
        COALESCE(w.name, 'Sin conexión') AS instance_label,
        COALESCE(w.phone_number, w.display_phone_number, w.phone_number_id) AS instance_number,
        COALESCE(pc.nombre, 'Sin producto') AS product_name
      FROM base x
      LEFT JOIN whatsapp_connections w ON w.id = x.connection_id
      LEFT JOIN product_catalog pc ON pc.id = x.product_id
      ORDER BY x.sold_at DESC
      LIMIT 50
    ),
    divisas AS (
      SELECT COALESCE(jsonb_agg(DISTINCT s.currency), '[]'::jsonb) AS c
      FROM sales s
      WHERE s.account_id = v_account AND s.status = 'confirmed' AND s.currency IS NOT NULL
    )
    SELECT jsonb_build_object(
      'period', jsonb_build_object(
        'from', p_from, 'to', p_to, 'currency', v_currency, 'unit', v_unit
      ),
      'kpis', jsonb_build_object(
        'leads', (SELECT leads FROM cur),
        'revenue', (SELECT revenue FROM cur),
        'sales', (SELECT sales FROM cur),
        'spend', (SELECT spend FROM cur),
        'roas', CASE WHEN (SELECT spend FROM cur) > 0
          THEN (SELECT revenue FROM cur) / (SELECT spend FROM cur) ELSE 0 END,
        'conversion', CASE WHEN (SELECT leads FROM cur) > 0
          THEN (SELECT sales FROM cur)::numeric / (SELECT leads FROM cur) * 100 ELSE 0 END,
        'ticket', CASE WHEN (SELECT sales FROM cur) > 0
          THEN (SELECT revenue FROM cur) / (SELECT sales FROM cur) ELSE 0 END,
        'profit', (SELECT revenue FROM cur) - (SELECT spend FROM cur)
      ),
      'previous', jsonb_build_object(
        'leads', (SELECT leads FROM prv),
        'revenue', (SELECT revenue FROM prv),
        'sales', (SELECT sales FROM prv),
        'spend', (SELECT spend FROM prv)
      ),
      'series', COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.t) FROM series s), '[]'::jsonb),
      'hourly', COALESCE((SELECT jsonb_agg(to_jsonb(h) ORDER BY h.hour) FROM hourly h), '[]'::jsonb),
      'by_connection', COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.revenue DESC) FROM by_connection i), '[]'::jsonb),
      'by_instance', COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.revenue DESC) FROM by_instance i), '[]'::jsonb),
      'by_state', COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.revenue DESC) FROM by_state s), '[]'::jsonb),
      'by_product', COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.revenue DESC) FROM by_product p), '[]'::jsonb),
      'history', COALESCE((SELECT jsonb_agg(to_jsonb(h) ORDER BY h.sold_at DESC) FROM history h), '[]'::jsonb),
      'currencies', (SELECT c FROM divisas)
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.dashboard_sales_v2(
  TIMESTAMPTZ, TIMESTAMPTZ, UUID, UUID, UUID, UUID, TEXT, TEXT
) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dashboard_sales_v2(
  TIMESTAMPTZ, TIMESTAMPTZ, UUID, UUID, UUID, UUID, TEXT, TEXT
) TO authenticated;


-- ============================================================
-- 098: el redeem debe conocer la tabla nueva de atribución por isla.
-- ============================================================
CREATE OR REPLACE FUNCTION public.redeem_invitation(
  p_token_hash TEXT
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_inv account_invitations%ROWTYPE;
  v_old_account_id UUID;
  v_old_account_owner UUID;
  v_has_other_members BOOLEAN;
  v_has_data BOOLEAN;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_inv
  FROM account_invitations
  WHERE token_hash = p_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = '22023';
  END IF;
  IF v_inv.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Invitation has already been redeemed'
      USING ERRCODE = '22023';
  END IF;
  IF v_inv.expires_at <= NOW() THEN
    RAISE EXCEPTION 'Invitation has expired' USING ERRCODE = '22023';
  END IF;

  SELECT p.account_id, a.owner_user_id
  INTO v_old_account_id, v_old_account_owner
  FROM profiles p
  JOIN accounts a ON a.id = p.account_id
  WHERE p.user_id = v_caller_id
  FOR UPDATE OF p, a;

  IF v_old_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no profile' USING ERRCODE = '42501';
  END IF;

  IF v_old_account_id = v_inv.account_id THEN
    RAISE EXCEPTION 'You are already a member of this account'
      USING ERRCODE = '23505';
  END IF;

  IF v_old_account_owner <> v_caller_id THEN
    RAISE EXCEPTION 'You are already in a shared account; sign up with a different email to join this one'
      USING ERRCODE = '23505';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE account_id = v_old_account_id
      AND user_id <> v_caller_id
  ) INTO v_has_other_members;

  IF v_has_other_members THEN
    RAISE EXCEPTION 'Your account has other members; remove them or transfer ownership before joining another account'
      USING ERRCODE = '23505';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM contacts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM conversations WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM broadcasts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM automations WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM automation_logs WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM automation_pending_executions WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM flows WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM flow_runs WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM pipelines WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM deals WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM message_templates WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM tags WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM custom_fields WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM contact_notes WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM whatsapp_config WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM api_keys WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM webhook_endpoints WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM quick_replies WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM notifications WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM ai_configs WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM ai_knowledge_documents WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM ai_knowledge_chunks WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM ai_usage_log WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM product_catalog WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM media_understanding WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM outbound_message_log WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM outbound_message_queue WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM messaging_alerts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM payment_details WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM conversation_notes WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM payment_receipts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM tracking_pixels WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM tracking_links WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM tracking_clicks WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM contact_attribution WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM mcp_credentials WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM sales WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM ad_spend WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM whatsapp_connections WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM flow_ai_configs WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM flow_distributor_assignments WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM flow_distributor_state WHERE account_id = v_old_account_id
    -- 095: bloques finales del Flow Builder.
    UNION ALL SELECT 1 FROM departments WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM flow_payment_sessions WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM payment_gateway_configs WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM payment_webhook_events WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM flow_call_sessions WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM whatsapp_calling_configs WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM ai_media_configs WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM flow_credentials WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM contact_attribution_islas WHERE account_id = v_old_account_id
    LIMIT 1
  ) INTO v_has_data;

  IF v_has_data THEN
    RAISE EXCEPTION 'Your account already contains data; sign up with a different email to join this one'
      USING ERRCODE = '23505';
  END IF;

  UPDATE profiles
  SET account_id = v_inv.account_id,
      account_role = v_inv.role
  WHERE user_id = v_caller_id;

  UPDATE account_invitations
  SET accepted_at = NOW(),
      accepted_by_user_id = v_caller_id
  WHERE id = v_inv.id;

  DELETE FROM accounts WHERE id = v_old_account_id;

  RETURN v_inv.account_id;
END;
$$;

ALTER FUNCTION public.redeem_invitation(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.redeem_invitation(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_invitation(TEXT) TO authenticated;
