-- ============================================================
-- 077_flow_smart_delay_capi.sql
--
-- Flow Builder: esperas largas y nodo de Meta CAPI, sobre el motor
-- que ya existe (flows / flow_nodes / flow_runs). No crea tablas.
--
-- 1. flow_runs.next_run_at + resume_reason: la corrida queda
--    «estacionada» y el cron de cada minuto la retoma cuando vence.
--      - 'delay'          → nodo `wait` de más de 15 s (Smart Delay).
--      - 'reply_timeout'  → nodo `save_reply` sin contestación.
-- 2. Índice parcial para que el cron lea solo las corridas vencidas.
-- 3. Nodo nuevo `meta_capi` en el CHECK de flow_nodes.
-- 4. El barrido de corridas abandonadas no toca una corrida que está
--    estacionada a propósito y todavía no vence.
--
-- Idempotente.
-- ============================================================

ALTER TABLE flow_runs ADD COLUMN IF NOT EXISTS next_run_at TIMESTAMPTZ;
ALTER TABLE flow_runs ADD COLUMN IF NOT EXISTS resume_reason TEXT;

ALTER TABLE flow_runs DROP CONSTRAINT IF EXISTS flow_runs_resume_reason_check;
ALTER TABLE flow_runs ADD CONSTRAINT flow_runs_resume_reason_check
  CHECK (resume_reason IS NULL OR resume_reason IN ('delay', 'reply_timeout'));

CREATE INDEX IF NOT EXISTS idx_flow_runs_due
  ON flow_runs(next_run_at)
  WHERE status = 'active' AND next_run_at IS NOT NULL;

ALTER TABLE flow_nodes DROP CONSTRAINT IF EXISTS flow_nodes_node_type_check;
ALTER TABLE flow_nodes ADD CONSTRAINT flow_nodes_node_type_check
  CHECK (node_type IN (
    'start',
    'send_buttons',
    'send_list',
    'send_message',
    'send_media',
    'collect_input',
    'wait',
    'save_reply',
    'condition',
    'set_tag',
    'handoff',
    'meta_capi',
    'end'
  ));

CREATE OR REPLACE FUNCTION public.list_timed_out_flow_runs(
  p_now TIMESTAMPTZ,
  p_limit INTEGER
) RETURNS TABLE (
  id UUID,
  last_advanced_at TIMESTAMPTZ,
  fallback_policy JSONB
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT r.id, r.last_advanced_at, f.fallback_policy
  FROM flow_runs r
  LEFT JOIN flows f ON f.id = r.flow_id
  WHERE r.status = 'active'
    AND (r.next_run_at IS NULL OR r.next_run_at <= p_now)
    AND r.last_advanced_at <= p_now - make_interval(secs => 3600 * (
      CASE
        WHEN jsonb_typeof(f.fallback_policy->'on_timeout_hours') = 'number'
          AND (f.fallback_policy->>'on_timeout_hours')::NUMERIC > 0
        THEN LEAST((f.fallback_policy->>'on_timeout_hours')::NUMERIC, 87600)
        ELSE 24
      END
    )::DOUBLE PRECISION)
  ORDER BY r.last_advanced_at, r.id
  LIMIT GREATEST(p_limit, 0);
$$;

REVOKE ALL ON FUNCTION public.list_timed_out_flow_runs(TIMESTAMPTZ, INTEGER) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_timed_out_flow_runs(TIMESTAMPTZ, INTEGER) TO service_role;
