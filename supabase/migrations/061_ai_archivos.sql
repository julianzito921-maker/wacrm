-- Archivos que la agente de IA puede mandar como adjunto (13-nov-2026).
-- La IA escribe [[ARCHIVO:clave]] en su respuesta y el servidor envía ese archivo
-- (PDF, audio o imagen) en vez de pegar un enlace. Mapa por cuenta:
--   {"metodo": {"url": "https://…/Metodo.pdf", "nombre": "Metodo.pdf", "tipo": "document", "pie": "📘 Tu Método"}}
ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS archivos JSONB NOT NULL DEFAULT '{}'::jsonb;
