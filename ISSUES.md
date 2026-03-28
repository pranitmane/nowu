# Issue Register

Known operational issues, their root causes, and exact fix steps.

---

### #002 — CF Worker throws "Cannot perform I/O on behalf of a different request"

- **Date found:** 2026-03-28
- **Severity:** high
- **Symptom:** Some API routes (e.g. `/posts/stats`) return CF error 1101 "Worker threw exception" when hit in rapid succession. Works fine when hit individually with a gap.
- **Root cause:** `sharedDb` singleton in `db-ops.ts` caches the Neon DB connection from the first request. CF Workers enforces I/O isolation — any I/O object (stream, connection) created in request A's context cannot be reused by request B. The module-level singleton violates this rule.
- **Fix:** In `worker.ts`, call `initDb()` without caching: create a fresh `drizzle(neon(connectionString))` instance on every request. Since `neon-http` is stateless (pure fetch, no persistent WebSocket), this is cheap and safe.
  Change `initDb` in `db-ops.ts` to not guard with `if (sharedDb) return` when running in CF Workers. The simplest fix is to reinitialize on every request in the worker middleware.
- **Status:** open

---

### #001 — Telegram webhook unregistered after deploy

- **Date found:** 2026-03-28
- **Severity:** high
- **Symptom:** Telegram bot stops responding to all messages after a deploy
- **Root cause:** The Telegram webhook URL is not automatically re-registered when deploying with `wrangler deploy`. It must be set manually via the Telegram Bot API. If it was never set or gets cleared, the URL becomes empty and Telegram has nowhere to send updates (they queue up as pending updates instead).
- **Fix:**
  ```bash
  # 1. Check current webhook state
  curl -s "https://api.telegram.org/bot$BOT_TOKEN/getWebhookInfo" | python3 -m json.tool

  # 2. If url is empty, register it
  curl -s -X POST "https://api.telegram.org/bot$BOT_TOKEN/setWebhook" \
    -H "Content-Type: application/json" \
    -d "{\"url\":\"https://api.pranitmane.com/webhook\",\"secret_token\":\"$WEBHOOK_SECRET\"}"

  # 3. Verify
  curl -s "https://api.telegram.org/bot$BOT_TOKEN/getWebhookInfo" | python3 -m json.tool
  ```
- **Prevention:** Run `pnpm health:prod` after every deploy — check #4 and #5 will catch an unregistered or wrong webhook URL.
- **Status:** resolved
