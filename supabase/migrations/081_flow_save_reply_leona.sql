-- ============================================================
-- 081_flow_save_reply_leona.sql
--
-- 1. `flow_runs.resume_reason` admite dos valores nuevos:
--      - 'reply_buffer'    → Mensaje compuesto de Esperar respuesta:
--                            se agrupan los mensajes de la clienta en
--                            una ventana de segundos antes de avanzar.
--      - 'awaiting_reply'  → «Esperar indefinidamente». La corrida no
--                            tiene salida por timeout; se guarda con
--                            `next_run_at` a 31 días como válvula de
--                            seguridad (cierra limpia, sin mensaje).
--
-- 2. `list_timed_out_flow_runs` no toca las corridas en
--    'awaiting_reply': las cierra su propio temporizador. Sin esto el
--    barrido de abandonadas las mataría a las 24 h.
--
-- 3. `flow_node_stats(flow_id, desde)`: ENTRADAS y AVANCES por nodo
--    para la fila de estadísticas de la tarjeta. Se calcula de
--    `flow_run_events` (SECURITY INVOKER, así que manda la RLS de
--    quien consulta) y sigue sirviendo para el histórico, porque las
--    salidas de «Esperar respuesta» ya se registraban como
--    `node_entered` con `payload.saved_key` / `payload.sin_respuesta`.
--
-- Solo agrega. Idempotente.
-- ============================================================

ALTER TABLE flow_runs DROP CONSTRAINT IF EXISTS flow_runs_resume_reason_check;
ALTER TABLE flow_runs ADD CONSTRAINT flow_runs_resume_reason_check
  CHECK (resume_reason IS NULL OR resume_reason IN (
    'delay',
    'reply_timeout',
    'payment_timeout',
    'reply_buffer',
    'awaiting_reply'
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
    -- «Esperar indefinidamente»: su válvula de 31 días la cierra
    -- resumeDueRuns como completada; el barrido no debe marcarla
    -- timed_out antes.
    AND r.resume_reason IS DISTINCT FROM 'awaiting_reply'
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

REVOKE ALL ON FUNCTION public.list_timed_out_flow_runs(TIMESTAMPTZ, INTEGER)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.list_timed_out_flow_runs(TIMESTAMPTZ, INTEGER)
  TO service_role;

CREATE OR REPLACE FUNCTION public.flow_node_stats(
  p_flow_id UUID,
  p_desde TIMESTAMPTZ DEFAULT NULL
) RETURNS TABLE (
  node_key TEXT,
  entradas BIGINT,
  avances BIGINT
)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT
    e.node_key,
    COUNT(DISTINCT e.flow_run_id) FILTER (
      WHERE e.event_type = 'node_entered'
        AND NOT (e.payload ? 'saved_key' OR e.payload ? 'sin_respuesta')
    ) AS entradas,
    COUNT(DISTINCT e.flow_run_id) FILTER (
      WHERE (e.event_type = 'node_entered'
             AND (e.payload ? 'saved_key' OR e.payload ? 'sin_respuesta'))
         OR e.event_type = 'timeout'
    ) AS avances
  FROM flow_run_events e
  JOIN flow_runs r ON r.id = e.flow_run_id
  WHERE r.flow_id = p_flow_id
    AND e.node_key IS NOT NULL
    AND (p_desde IS NULL OR e.created_at >= p_desde)
  GROUP BY e.node_key;
$$;

REVOKE ALL ON FUNCTION public.flow_node_stats(UUID, TIMESTAMPTZ)
  FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.flow_node_stats(UUID, TIMESTAMPTZ)
  TO authenticated, service_role;
