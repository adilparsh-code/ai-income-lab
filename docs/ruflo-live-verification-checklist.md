# Ruflo Live Verification Checklist

**Status of this document:** the checklist is NOT yet satisfied. The Ruflo
integration in this repository is **OFFLINE-ONLY** as of the last session: the
runtime client, its configuration resolution, its reconciliation path and its
secret handling are covered by offline tests
(`src/lib/ruflo/__tests__/runtime-readiness.test.ts`,
`src/lib/ruflo/__tests__/runtime-client.test.ts`,
`src/lib/ruflo/__tests__/runtime.test.ts`). No live Ruflo runtime was
contacted and no credential was used.

The only existing live hook is the opt-in smoke test
`src/lib/ruflo/__tests__/live-runtime.test.ts`, which is **skipped** unless
`RUFLO_LIVE_TEST_URL` is set. A skipped test is not a passing test.

Do not report "Ruflo live runtime: VERIFIED" until every mandatory item below
has been executed against a real runtime and its output recorded.

---

## 0. Prerequisites

| Variable | Purpose | Required |
|---|---|---|
| `RUFLO_MCP_URL` | Base URL of the Ruflo V3 HTTP/MCP server (`/health`, `/rpc`) | yes |
| `RUFLO_MCP_TOKEN` | Bearer token for the runtime | yes (or set `RUFLO_MCP_REQUIRE_TOKEN=true` to make it mandatory) |
| `RUFLO_MCP_TIMEOUT_MS` | Per-request timeout, clamped to 1 000–30 000 ms | no |
| `RUFLO_RUNTIME_TOKEN` | Credential for *this* app's runtime API (separate from the MCP token) | yes |
| `RUFLO_RUNTIME_ENABLED` | Must be `true`/`1`/`yes` for the runtime handle to register | yes |
| `RUFLO_LIVE_TEST_URL` / `RUFLO_LIVE_TEST_TOKEN` | Opt-in for the live smoke test | for the live test only |

Never commit any of these. Never paste a token into a report, a log line, a
commit message or a chat transcript.

---

## 1. Configuration (mandatory)

- [ ] With `RUFLO_MCP_URL` unset, the app starts cleanly and the capability
      reports **NOT_CONFIGURED** — not an error, not a fake CONNECTED.
- [ ] With `RUFLO_MCP_URL` set to a non-http URL, the app refuses to
      connect and states that the URL was rejected **without echoing the URL**.
- [ ] With `RUFLO_MCP_URL` pointing at a private/loopback address, the app
      refuses to connect (SSRF guard).
- [ ] With `RUFLO_MCP_REQUIRE_TOKEN=true` and no `RUFLO_MCP_TOKEN`, the app
      refuses to connect and names the missing variable.

## 2. Health and registration (mandatory)

- [ ] `GET {RUFLO_MCP_URL}/health` returns a healthy response and the app's
      health check records it durably.
- [ ] The runtime handle registers exactly once (idempotent across restarts).
- [ ] `RUFLO_RUNTIME_ENABLED` is not `true` → the runtime API stays disabled
      (AUTH_REQUIRED posture) and no handle is registered.

## 3. Task lifecycle (mandatory)

- [ ] `tasks/create` returns a task id; the app records the task reference
      (correlation id + idempotency key) and the task id.
- [ ] The task's `metadata.idempotencyKey` and `metadata.correlationId`
      survive the round trip unchanged.
- [ ] `tasks/status` / `tasks/results` for that task id return the expected
      state.

## 4. Ambiguity and reconciliation (mandatory)

- [ ] Kill the network between the runtime accepting `tasks/create` and the
      response arriving. The client must **reconcile** (query for the existing
      task by idempotency key) and must **not** issue a second `tasks/create`.
      Verify on the runtime side that exactly ONE task exists.
- [ ] Repeat the above with the runtime returning a 5xx. Same expectation.
- [ ] With an unknown outcome and no task found, the client raises
      `RufloUnknownOutcomeError` and does **not** report the task as created.

## 5. Security (mandatory)

- [ ] A runtime error message that echoes the bearer token comes back to the
      caller redacted.
- [ ] No Ruflo token appears in any log line, audit row, HTTP response body
      or error string. Grep the application logs after a full exercise.
- [ ] The runtime API rejects unauthenticated requests with 401 and
      cross-origin browser requests with 403.

## 6. Durability and idempotency (mandatory)

- [ ] Dispatching the same `executionId` twice does NOT re-execute the
      workflow; the durable `WorkflowRun` row is returned.
- [ ] A dispatch that exceeds the timeout budget returns `TIMEOUT` and the
      partial durable state remains queryable by `executionId`.
- [ ] A dispatch that failed is never reported as completed.

## 7. Live smoke test (optional but recommended)

```bash
RUFLO_LIVE_TEST_URL="https://<ruflo-host>" \
RUFLO_LIVE_TEST_TOKEN="<token>" \
npx tsx --test src/lib/ruflo/__tests__/live-runtime.test.ts
```

Expected: the test runs (not skipped) and passes. Record the exact command and
its output in the delivery report — and state clearly that it exercises a
**non-destructive** task (`type: 'test'`, no shell commands, no file
modification).

---

## How to report the outcome

Use exactly one of:

* **VERIFIED** — every mandatory item above was executed against a live
  runtime and passed.
* **OFFLINE-ONLY** — the contract is covered by offline tests; no live runtime
  was contacted.
* **BLOCKED** — a live runtime or credential was unavailable; name what is
  missing.
* **UNVERIFIED** — the checks were not run.

Never describe a skipped live test as a passing one.
