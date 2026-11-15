-- 060: permitir audio (notas de voz) en el bucket flow-media.
-- El nodo send_media de Flujos ahora acepta media_type = 'audio'; WhatsApp
-- muestra los OGG/Opus como nota de voz con forma de onda.
UPDATE storage.buckets
SET allowed_mime_types = array(
  SELECT DISTINCT unnest(allowed_mime_types || ARRAY['audio/ogg', 'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/amr'])
)
WHERE id = 'flow-media';
