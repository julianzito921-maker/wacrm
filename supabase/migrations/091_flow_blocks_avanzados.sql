-- 091_flow_blocks_avanzados.sql
-- Condicional múltiple, etiquetas múltiples, pixel por nodo,
-- conexión entre flujos y bloque de IA. Aditivo.

ALTER TABLE flow_nodes DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check;
ALTER TABLE flow_nodes ADD CONSTRAINT flow_nodes_node_type_check
  CHECK (node_type IN (
    'start','send_buttons','send_list','send_message','send_media',
    'collect_input','wait','save_reply','condition','set_tag','handoff',
    'meta_capi','end','send_payment','send_template','move_kanban',
    'connect_flow','ai_block'
  ));

CREATE TABLE IF NOT EXISTS flow_ai_configs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  flow_id UUID NOT NULL UNIQUE REFERENCES flows(id) ON DELETE CASCADE,
  provider TEXT NOT NULL CHECK (provider IN ('deepseek','openai_compatible','openai','anthropic')),
  model TEXT NOT NULL,
  base_url TEXT,
  api_key TEXT NOT NULL,
  created_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_flow_ai_configs_account ON flow_ai_configs(account_id);

DROP TRIGGER IF EXISTS set_updated_at ON flow_ai_configs;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON flow_ai_configs
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE flow_ai_configs ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS flow_ai_configs_admin ON flow_ai_configs;
CREATE POLICY flow_ai_configs_admin ON flow_ai_configs FOR ALL
  USING (is_account_member(account_id, 'admin'))
  WITH CHECK (is_account_member(account_id, 'admin'));

ALTER TABLE ai_usage_log DROP CONSTRAINT IF EXISTS ai_usage_log_mode_check;
ALTER TABLE ai_usage_log ADD CONSTRAINT ai_usage_log_mode_check
  CHECK (mode IN ('auto_reply','draft','vision','asr','flow_ai'));

CREATE OR REPLACE FUNCTION public.flow_node_stats(
  p_flow_id UUID,
  p_desde TIMESTAMPTZ DEFAULT NULL
) RETURNS TABLE (node_key TEXT, entradas BIGINT, avances BIGINT)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = public AS $$
WITH entered AS (
  SELECT e.flow_run_id, e.node_key, e.created_at, e.id, r.status AS run_status
  FROM flow_run_events e
  JOIN flow_runs r ON r.id = e.flow_run_id
  WHERE r.flow_id = p_flow_id
    AND e.event_type = 'node_entered'
    AND e.node_key IS NOT NULL
    AND (p_desde IS NULL OR e.created_at >= p_desde)
),
seq AS (
  SELECT *, lead(node_key) OVER (
    PARTITION BY flow_run_id ORDER BY created_at, id
  ) AS next_key
  FROM entered
),
ent AS (SELECT node_key, count(DISTINCT flow_run_id) AS n FROM seq GROUP BY 1),
sal AS (
  SELECT node_key, count(DISTINCT flow_run_id) AS n
  FROM seq
  WHERE (next_key IS NOT NULL AND next_key <> node_key)
     OR (next_key IS NULL AND run_status <> 'active')
  GROUP BY 1
)
SELECT coalesce(e.node_key, s.node_key), coalesce(e.n, 0), coalesce(s.n, 0)
FROM ent e FULL JOIN sal s USING (node_key);
$$;
