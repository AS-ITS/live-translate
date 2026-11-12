\set ON_ERROR_STOP on
BEGIN READ ONLY;

SELECT id, status, lifecycle_contract_version, lifecycle_version,
       ended_at, purge_at,
       EXTRACT(EPOCH FROM purge_at - ended_at)::integer AS retention_seconds,
       status = 'completed' AND ended_at IS NOT NULL
         AND EXTRACT(EPOCH FROM purge_at - ended_at) = 1800 AS completed_retention_pass
FROM public.meetings
WHERE id = :'meeting_id'::uuid;

SELECT role, resource_type, revoked_at IS NULL AS not_revoked,
       expires_at IS NULL OR expires_at > now() AS not_expired,
       count(*) AS shares
FROM public.viewer_shares
WHERE meeting_id = :'meeting_id'::uuid
GROUP BY role, resource_type, revoked_at IS NULL,
         expires_at IS NULL OR expires_at > now();

SELECT 'subtitle_cues' AS content_location, count(*) AS rows
FROM public.subtitle_cues
WHERE session_id IN (SELECT id FROM public.sessions WHERE meeting_id = :'meeting_id'::uuid)
UNION ALL
SELECT 'meeting_events', count(*) FROM public.meeting_events
WHERE meeting_id = :'meeting_id'::uuid
UNION ALL
SELECT 'session_transcript_items', count(*) FROM public.sessions
WHERE meeting_id = :'meeting_id'::uuid AND transcript_items <> '[]'::jsonb
UNION ALL
SELECT 'session_content_payload', count(*) FROM public.sessions
WHERE meeting_id = :'meeting_id'::uuid
  AND payload ?| array['sourceText', 'translatedText', 'checkpoint', 'transcriptItems', 'audio']
UNION ALL
SELECT 'segment_checkpoint', count(*) FROM public.meeting_segments
WHERE meeting_id = :'meeting_id'::uuid AND checkpoint <> '{}'::jsonb
UNION ALL
SELECT 'meeting_storage_objects', count(*) FROM storage.objects
WHERE bucket_id IN ('meeting-audio', 'meeting-exports')
  AND name LIKE '%' || :'meeting_id' || '%';

ROLLBACK;
