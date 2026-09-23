---
Review-status: Warnings
One-Sentence-Summary: "Internal-only test worker with no secrets, database or outbound HTTP; one warning on the internal health endpoint."
---

## Pre-deploy guardrails report

- [x] Security (OWASP Top 10): 1 warning
  - No hardcoded secrets: the worker authenticates with the platform's workload identity token, and no `SERVER_API_TOKEN` is set. No `.env` is in the deploy directory.
  - No shell execution, eval or HTML rendering. Function inputs are validated with Zod schemas before any handler runs.
  - Payloads are not logged; the SDK logs event names only.
  - WARNING: the `/health` endpoint (`entry.ts`) sets no security headers. It is not public (`--no-public`, cluster DNS only) and returns a fixed "ok".
- [x] Database usage: OK. There is no database; the store function uses the platform key-value store through the SDK.
- [x] REST/API calls: OK. There are no outbound HTTP calls. Store, OAuth and RPC requests go over the SDK's gRPC stream, each with a 10-60 s timeout, and reconnects use jittered exponential backoff.
- [x] External writes: OK. The only write is one store set per `store_append` call.
- [x] Multi-service manifest: not applicable (no `dibbla.yaml`).
- [x] User handbook: `APP.md` with a subtitle.

**Result: WARNINGS.** One warning, accepted for an internal test worker.
