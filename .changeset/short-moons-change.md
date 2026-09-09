---
"@opennextjs/cloudflare": minor
---

feat: support multiple zones during automatic cache purge

Automatic cache purge previously only supported a single Cloudflare zone via `CACHE_PURGE_ZONE_ID`.
When a single worker serves multiple domains (each a separate Cloudflare zone), the cache was only
purged for one zone.

A new environment variable `CACHE_PURGE_ZONE_IDS` accepts a comma-separated list of zone IDs.
Both `CACHE_PURGE_ZONE_ID` and `CACHE_PURGE_ZONE_IDS` may be used at the same time; duplicates
are ignored. The `CACHE_PURGE_API_TOKEN` must have the `Cache Purge` permission on every
configured zone.

Existing single-zone setups that only set `CACHE_PURGE_ZONE_ID` continue to work without changes.
