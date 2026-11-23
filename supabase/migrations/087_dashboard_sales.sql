-- ============================================================
-- 087_dashboard_sales.sql
--
-- Dashboard de ventas (estructura tipo Leona):
--   - sales: historial real de ventas (manual, deals ganados y
--     comprobantes aprobados), con origen idempotente por source_ref.
--   - ad_spend: gasto diario de Meta para ROAS/beneficio.
--   - contacts.lead_number: número de lead global y estable.
--   - RPCs dashboard_sales y dashboard_attention para KPIs, series y
--     desgloses con filtros (periodo, instancia, producto, agente,
--     moneda y zona horaria).
--
-- Nota: la 082–086 pertenecen a Seguimiento y MCP; esta es la 087.
-- ============================================================

-- ------------------------------------------------------------
-- NÚMERO DE LEAD
-- ------------------------------------------------------------
CREATE SEQUENCE IF NOT EXISTS contacts_lead_number_seq;

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS lead_number BIGINT;

WITH ordenados AS (
  SELECT id, row_number() OVER (ORDER BY created_at, id) AS rn
  FROM contacts
  WHERE lead_number IS NULL
)
UPDATE contacts c
SET lead_number = o.rn
FROM ordenados o
WHERE c.id = o.id AND c.lead_number IS NULL;

ALTER TABLE contacts
  ALTER COLUMN lead_number SET DEFAULT nextval('contacts_lead_number_seq');

SELECT setval(
  'contacts_lead_number_seq',
  GREATEST((SELECT COALESCE(MAX(lead_number), 0) FROM contacts), 1),
  (SELECT COALESCE(MAX(lead_number), 0) FROM contacts) > 0
);

ALTER TABLE contacts ALTER COLUMN lead_number SET NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS contacts_lead_number_key
  ON contacts(lead_number);

ALTER SEQUENCE contacts_lead_number_seq OWNED BY contacts.lead_number;

-- ------------------------------------------------------------
-- VENTAS
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sales (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id UUID REFERENCES contacts(id) ON DELETE SET NULL,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  product_id UUID REFERENCES product_catalog(id) ON DELETE SET NULL,
  instance_id UUID REFERENCES whatsapp_config(id) ON DELETE SET NULL,
  -- Snapshot del contacto: sobrevive si el contacto se borra.
  lead_number BIGINT,
  client_name TEXT,
  amount NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  currency TEXT NOT NULL,
  payment_id TEXT,
  meta_ref TEXT,
  region TEXT,
  status TEXT NOT NULL DEFAULT 'confirmed'
    CHECK (status IN ('confirmed', 'pending', 'refunded')),
  source TEXT NOT NULL DEFAULT 'manual'
    CHECK (source IN ('manual', 'deal', 'payment_receipt', 'import')),
  -- Idempotencia del backfill / triggers: 'deal:<uuid>',
  -- 'receipt:<uuid>'. Las ventas manuales lo dejan NULL.
  source_ref TEXT,
  sold_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS sales_source_ref_key
  ON sales(account_id, source_ref)
  WHERE source_ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sales_account_sold
  ON sales(account_id, sold_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_contact
  ON sales(contact_id, sold_at DESC);
CREATE INDEX IF NOT EXISTS idx_sales_product
  ON sales(product_id)
  WHERE product_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_sales_instance
  ON sales(instance_id)
  WHERE instance_id IS NOT NULL;

DROP TRIGGER IF EXISTS set_updated_at ON sales;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON sales
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE sales ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS sales_select ON sales;
CREATE POLICY sales_select ON sales FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS sales_insert ON sales;
CREATE POLICY sales_insert ON sales FOR INSERT
  WITH CHECK (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS sales_update ON sales;
CREATE POLICY sales_update ON sales FOR UPDATE
  USING (is_account_member(account_id, 'agent'));
DROP POLICY IF EXISTS sales_delete ON sales;
CREATE POLICY sales_delete ON sales FOR DELETE
  USING (is_account_member(account_id, 'admin'));

-- ------------------------------------------------------------
-- GASTO PUBLICITARIO
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ad_spend (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  platform TEXT NOT NULL DEFAULT 'meta' CHECK (platform IN ('meta')),
  spent_on DATE NOT NULL,
  amount NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  currency TEXT NOT NULL,
  notes TEXT,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (account_id, platform, spent_on)
);

CREATE INDEX IF NOT EXISTS idx_ad_spend_account_date
  ON ad_spend(account_id, spent_on DESC);

DROP TRIGGER IF EXISTS set_updated_at ON ad_spend;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON ad_spend
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE ad_spend ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS ad_spend_select ON ad_spend;
CREATE POLICY ad_spend_select ON ad_spend FOR SELECT
  USING (is_account_member(account_id));
DROP POLICY IF EXISTS ad_spend_write ON ad_spend;
CREATE POLICY ad_spend_write ON ad_spend FOR ALL
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

-- ------------------------------------------------------------
-- VENTAS AUTOMÁTICAS
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.registrar_venta_deal()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_contact RECORD;
  v_conn UUID;
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

  SELECT COALESCE(a.default_currency, 'USD') INTO v_currency
  FROM accounts a WHERE a.id = NEW.account_id;

  v_amount := COALESCE(NEW.value, 0);
  v_sold_at := COALESCE(NEW.closed_at, NEW.updated_at, NEW.created_at, NOW());

  -- No duplicar una venta que ya entró por comprobante el mismo día e
  -- importe (el flujo de pago y el Kanban pueden coincidir).
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
    lead_number, client_name, amount, currency, status, source, source_ref,
    sold_at, created_by
  ) VALUES (
    NEW.account_id, NEW.contact_id, NEW.conversation_id, NULL, v_conn,
    v_contact.lead_number, v_contact.name, v_amount,
    COALESCE(NULLIF(NEW.currency, ''), v_currency), 'confirmed',
    'deal', 'deal:' || NEW.id, v_sold_at, NEW.user_id
  )
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS deals_register_sale ON deals;
CREATE TRIGGER deals_register_sale
  AFTER INSERT OR UPDATE OF status ON deals
  FOR EACH ROW WHEN (NEW.status = 'won')
  EXECUTE FUNCTION public.registrar_venta_deal();

CREATE OR REPLACE FUNCTION public.registrar_venta_recibo()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_contact RECORD;
  v_conn UUID;
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
    lead_number, client_name, amount, currency, payment_id, status,
    source, source_ref, sold_at, created_by
  ) VALUES (
    NEW.account_id, NEW.contact_id, NULL, NULL, v_conn,
    v_contact.lead_number, v_contact.name, NEW.monto, v_currency,
    NEW.referencia, 'confirmed', 'payment_receipt',
    'receipt:' || NEW.id, NEW.created_at, NULL
  )
  ON CONFLICT DO NOTHING;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS payment_receipts_register_sale ON payment_receipts;
CREATE TRIGGER payment_receipts_register_sale
  AFTER INSERT ON payment_receipts
  FOR EACH ROW WHEN (NEW.resultado = 'aprobado')
  EXECUTE FUNCTION public.registrar_venta_recibo();

-- Backfill histórico. Se hace después de crear la columna lead_number.
INSERT INTO sales (
  account_id, contact_id, conversation_id, product_id, instance_id,
  lead_number, client_name, amount, currency, status, source, source_ref,
  sold_at, created_by
)
SELECT
  d.account_id, d.contact_id, d.conversation_id, NULL, w.id,
  c.lead_number, c.name, COALESCE(d.value, 0),
  COALESCE(NULLIF(d.currency, ''), a.default_currency, 'USD'),
  'confirmed', 'deal', 'deal:' || d.id,
  COALESCE(d.closed_at, d.updated_at, d.created_at), d.user_id
FROM deals d
JOIN accounts a ON a.id = d.account_id
LEFT JOIN contacts c ON c.id = d.contact_id
LEFT JOIN LATERAL (
  SELECT id FROM whatsapp_config
  WHERE account_id = d.account_id
  ORDER BY created_at, id LIMIT 1
) w ON TRUE
WHERE d.status = 'won'
ON CONFLICT DO NOTHING;

INSERT INTO sales (
  account_id, contact_id, conversation_id, product_id, instance_id,
  lead_number, client_name, amount, currency, payment_id, status,
  source, source_ref, sold_at, created_by
)
SELECT
  pr.account_id, pr.contact_id, NULL, NULL, w.id,
  c.lead_number, c.name, pr.monto,
  COALESCE(a.default_currency, 'USD'), pr.referencia, 'confirmed',
  'payment_receipt', 'receipt:' || pr.id, pr.created_at, NULL
FROM payment_receipts pr
JOIN accounts a ON a.id = pr.account_id
LEFT JOIN contacts c ON c.id = pr.contact_id
LEFT JOIN LATERAL (
  SELECT id FROM whatsapp_config
  WHERE account_id = pr.account_id
  ORDER BY created_at, id LIMIT 1
) w ON TRUE
WHERE pr.resultado = 'aprobado'
  AND pr.monto IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM sales s
    WHERE s.account_id = pr.account_id
      AND s.contact_id = pr.contact_id
      AND s.amount = pr.monto
      AND s.sold_at::date = pr.created_at::date
      AND s.source = 'deal'
  )
ON CONFLICT DO NOTHING;

-- ------------------------------------------------------------
-- RPC: DASHBOARD DE VENTAS
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dashboard_sales(
  p_from TIMESTAMPTZ,
  p_to TIMESTAMPTZ,
  p_instance_id UUID DEFAULT NULL,
  p_product_id UUID DEFAULT NULL,
  p_agent_id UUID DEFAULT NULL,
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
    by_instance AS (
      SELECT
        COALESCE(x.instance_id::text, 'sin') AS id,
        COALESCE('WhatsApp ' || right(w.phone_number_id, 4), 'Sin conexión') AS label,
        count(x.id) AS count,
        COALESCE(sum(x.amount), 0) AS revenue
      FROM base x
      LEFT JOIN whatsapp_config w ON w.id = x.instance_id
      GROUP BY x.instance_id, w.phone_number_id
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
        COALESCE('WhatsApp ' || right(w.phone_number_id, 4), 'Sin conexión') AS instance_label,
        w.phone_number_id AS instance_number,
        COALESCE(pc.nombre, 'Sin producto') AS product_name
      FROM base x
      LEFT JOIN whatsapp_config w ON w.id = x.instance_id
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
      'by_instance', COALESCE((SELECT jsonb_agg(to_jsonb(i) ORDER BY i.revenue DESC) FROM by_instance i), '[]'::jsonb),
      'by_state', COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.revenue DESC) FROM by_state s), '[]'::jsonb),
      'by_product', COALESCE((SELECT jsonb_agg(to_jsonb(p) ORDER BY p.revenue DESC) FROM by_product p), '[]'::jsonb),
      'history', COALESCE((SELECT jsonb_agg(to_jsonb(h) ORDER BY h.sold_at DESC) FROM history h), '[]'::jsonb),
      'currencies', (SELECT c FROM divisas)
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.dashboard_sales(TIMESTAMPTZ, TIMESTAMPTZ, UUID, UUID, UUID, TEXT, TEXT)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dashboard_sales(TIMESTAMPTZ, TIMESTAMPTZ, UUID, UUID, UUID, TEXT, TEXT)
  TO authenticated;

-- ------------------------------------------------------------
-- RPC: ATENCIÓN (conversaciones y tiempos de respuesta)
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.dashboard_attention(
  p_from TIMESTAMPTZ,
  p_to TIMESTAMPTZ,
  p_agent_id UUID DEFAULT NULL,
  p_tz TEXT DEFAULT 'UTC'
) RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_account UUID;
  v_target INTEGER;
  v_tz TEXT := 'UTC';
  v_prev_from TIMESTAMPTZ;
  v_prev_to TIMESTAMPTZ;
  v_unit TEXT;
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

  SELECT COALESCE(a.reply_target_minutes, 5) INTO v_target
  FROM accounts a WHERE a.id = v_account;

  v_prev_to := p_from;
  v_prev_from := p_from - (p_to - p_from);
  v_unit := CASE WHEN (p_to - p_from) <= INTERVAL '2 days' THEN 'hour' ELSE 'day' END;

  RETURN (
    WITH convs AS (
      SELECT c.* FROM conversations c
      WHERE c.account_id = v_account
        AND (p_agent_id IS NULL OR c.assigned_agent_id = p_agent_id)
    ),
    period_convs AS (
      SELECT * FROM convs WHERE created_at >= p_from AND created_at < p_to
    ),
    prev_convs AS (
      SELECT * FROM convs WHERE created_at >= v_prev_from AND created_at < v_prev_to
    ),
    period_msgs AS (
      SELECT m.* FROM messages m
      JOIN convs c ON c.id = m.conversation_id
      WHERE m.created_at >= p_from AND m.created_at < p_to
    ),
    prev_msgs AS (
      SELECT m.* FROM messages m
      JOIN convs c ON c.id = m.conversation_id
      WHERE m.created_at >= v_prev_from AND m.created_at < v_prev_to
    ),
    first_in AS (
      SELECT m.conversation_id, min(m.created_at) AS t
      FROM messages m
      JOIN period_convs c ON c.id = m.conversation_id
      WHERE m.sender_type = 'customer'
      GROUP BY m.conversation_id
    ),
    first_out AS (
      SELECT f.conversation_id, min(m.created_at) AS t
      FROM first_in f
      JOIN messages m ON m.conversation_id = f.conversation_id AND m.created_at > f.t
      WHERE (m.sender_type = 'agent' OR m.ai_generated) AND m.status <> 'failed'
      GROUP BY f.conversation_id
    ),
    responses AS (
      SELECT EXTRACT(EPOCH FROM (o.t - f.t)) / 60 AS minutos
      FROM first_in f JOIN first_out o USING (conversation_id)
      WHERE o.t - f.t <= INTERVAL '7 days'
    ),
    prev_first_in AS (
      SELECT m.conversation_id, min(m.created_at) AS t
      FROM messages m
      JOIN prev_convs c ON c.id = m.conversation_id
      WHERE m.sender_type = 'customer'
      GROUP BY m.conversation_id
    ),
    prev_first_out AS (
      SELECT f.conversation_id, min(m.created_at) AS t
      FROM prev_first_in f
      JOIN messages m ON m.conversation_id = f.conversation_id AND m.created_at > f.t
      WHERE (m.sender_type = 'agent' OR m.ai_generated) AND m.status <> 'failed'
      GROUP BY f.conversation_id
    ),
    prev_responses AS (
      SELECT EXTRACT(EPOCH FROM (o.t - f.t)) / 60 AS minutos
      FROM prev_first_in f JOIN prev_first_out o USING (conversation_id)
      WHERE o.t - f.t <= INTERVAL '7 days'
    ),
    waiting AS (
      SELECT count(*) AS n FROM convs
      WHERE status <> 'closed' AND last_inbound_at IS NOT NULL
        AND (last_reply_at IS NULL OR last_reply_at < last_inbound_at)
    ),
    unassigned AS (
      SELECT count(*) AS n FROM convs
      WHERE status = 'open' AND assigned_agent_id IS NULL
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
        count(x.id) FILTER (WHERE x.sender_type = 'customer') AS incoming,
        count(x.id) FILTER (WHERE x.sender_type <> 'customer') AS outgoing,
        (
          SELECT avg(EXTRACT(EPOCH FROM (o.t - f.t)) / 60)
          FROM first_in f JOIN first_out o USING (conversation_id)
          WHERE date_trunc(v_unit, f.t AT TIME ZONE v_tz) = bk.b
        ) AS avg_response
      FROM buckets bk
      LEFT JOIN period_msgs x
        ON date_trunc(v_unit, x.created_at AT TIME ZONE v_tz) = bk.b
      GROUP BY bk.b
      ORDER BY bk.b
    ),
    hourly AS (
      SELECT
        h.hour,
        count(x.id) FILTER (WHERE x.sender_type = 'customer') AS incoming,
        count(x.id) FILTER (WHERE x.sender_type <> 'customer') AS outgoing
      FROM generate_series(0, 23) h(hour)
      LEFT JOIN period_msgs x
        ON extract(hour FROM x.created_at AT TIME ZONE v_tz)::int = h.hour
      GROUP BY h.hour
      ORDER BY h.hour
    )
    SELECT jsonb_build_object(
      'period', jsonb_build_object(
        'from', p_from, 'to', p_to, 'unit', v_unit, 'target_minutes', v_target
      ),
      'kpis', jsonb_build_object(
        'new_conversations', (SELECT count(*) FROM period_convs),
        'waiting', (SELECT n FROM waiting),
        'unassigned', (SELECT n FROM unassigned),
        'avg_response', COALESCE((SELECT avg(minutos) FROM responses), 0),
        'within_target_pct', CASE WHEN (SELECT count(*) FROM responses) > 0
          THEN (SELECT count(*) FROM responses WHERE minutos <= v_target)::numeric
               / (SELECT count(*) FROM responses) * 100
          ELSE 0 END,
        'closed', (SELECT count(*) FROM convs WHERE closed_at >= p_from AND closed_at < p_to),
        'incoming', (SELECT count(*) FROM period_msgs WHERE sender_type = 'customer'),
        'outgoing', (SELECT count(*) FROM period_msgs WHERE sender_type <> 'customer')
      ),
      'previous', jsonb_build_object(
        'new_conversations', (SELECT count(*) FROM prev_convs),
        'closed', (SELECT count(*) FROM convs WHERE closed_at >= v_prev_from AND closed_at < v_prev_to),
        'incoming', (SELECT count(*) FROM prev_msgs WHERE sender_type = 'customer'),
        'outgoing', (SELECT count(*) FROM prev_msgs WHERE sender_type <> 'customer'),
        'avg_response', COALESCE((SELECT avg(minutos) FROM prev_responses), 0),
        'within_target_pct', CASE WHEN (SELECT count(*) FROM prev_responses) > 0
          THEN (SELECT count(*) FROM prev_responses WHERE minutos <= v_target)::numeric
               / (SELECT count(*) FROM prev_responses) * 100
          ELSE 0 END
      ),
      'series', COALESCE((SELECT jsonb_agg(to_jsonb(s) ORDER BY s.t) FROM series s), '[]'::jsonb),
      'hourly', COALESCE((SELECT jsonb_agg(to_jsonb(h) ORDER BY h.hour) FROM hourly h), '[]'::jsonb)
    )
  );
END;
$$;

REVOKE ALL ON FUNCTION public.dashboard_attention(TIMESTAMPTZ, TIMESTAMPTZ, UUID, TEXT)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.dashboard_attention(TIMESTAMPTZ, TIMESTAMPTZ, UUID, TEXT)
  TO authenticated;
