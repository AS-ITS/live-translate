# Production observability runbook

Metrics are stored in UTC-minute buckets in `observability_metric_buckets`. The RPC uses an atomic upsert, and cleanup removes buckets strictly older than 30 days. Labels are fixed low-cardinality values: `provider`, `operation`, and `status_class`.

Production composition wires the recorder through the translation runner, queue worker, worker runtime, Gemini provider boundary, and Viewer telemetry endpoint. Metric persistence is best-effort and never changes request or execution outcomes.

Useful dashboard queries:

```sql
select bucket_start, metric_name, provider, status_class, sum(count) as count, sum(sum_value) as total_ms
from observability_metric_buckets
where bucket_start >= now() - interval '24 hours'
group by 1, 2, 3, 4 order by 1;
```

Alert starting points: queue depth rising for 10 minutes, execution failure rate above 5% for 5 minutes, any DLQ transfer, lease reclaim above 1% of executions, Viewer gap or duplicate rate above 1%, Gemini 401/403/429 or 5xx above 1%, and metrics write failures above 0.

Run the safe deployment preflight with `SMOKE_BASE_URL=https://staging.example.com npm run test:deployment-preflight`; it checks health, readiness, and authentication rejection without creating tokens or processing queue items. For full staging validation, separately apply migrations, issue one test token, verify one metric bucket, and confirm logs contain no API key, token, audio, transcript, or execution/meeting identifiers. Roll back the application first if request behavior regresses, then revert the migration only after confirming no dependent deployment is active.

Telemetry accepts only `reconnect`, `event_gap`, `event_duplicate`, `replay_success`, and `replay_failure`; it stores counts only. Existing monitoring infrastructure owns alert delivery. 
