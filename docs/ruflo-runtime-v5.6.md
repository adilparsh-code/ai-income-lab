# Ruflo V3 Runtime Integration — Phase 5.6

## What is now implemented

AI Income Lab can connect to a real Ruflo V3 MCP runtime over HTTP without installing Ruflo into the Next.js application.

The integration uses Ruflo's documented V3 HTTP transport:

- health: `GET /health`
- MCP RPC: `POST /rpc`
- MCP methods: `initialize`, `tools/call`
- allowlisted tools only
- server-side environment configuration

The application remains the authority for:

- halal screening
- human-review stops
- workflow/job lifecycle
- idempotency and correlation IDs
- AI budgets and cost controls
- publishing/deployment approval
- audit/provenance
- revenue state

Ruflo is the orchestration runtime, not the business-security boundary.

## Runtime configuration

Set these server-side only:

```text
RUFLO_MCP_URL=http://127.0.0.1:3000
RUFLO_MCP_TOKEN=<optional-token-if-runtime-auth-is-enabled>
RUFLO_MCP_TIMEOUT_MS=10000
```

Do not expose these through `NEXT_PUBLIC_*` variables.

## Start Ruflo V3

From a Ruflo checkout, the V3 MCP server supports HTTP transport:

```bash
npx tsx v3/mcp/server-entry.ts --transport http --host 127.0.0.1 --port 3000
```

Before registering it with AI Income Lab, verify that the runtime health endpoint is reachable.

## Register the runtime

Call `connectConfiguredRufloRuntime()` from a trusted server-side startup/admin path.

Registration only succeeds after the Ruflo `/health` endpoint reports healthy.

There is deliberately no import-time auto-connection and no browser-facing registration endpoint.

## Safety boundary

The runtime client only permits these Ruflo tools:

- `system/health`
- `system/info`
- `swarm/init`
- `swarm/status`
- `agent/list`
- `tasks/create`
- `tasks/list`
- `tasks/status`
- `tasks/results`

Shell execution, arbitrary tool names, credentials, and arbitrary environment injection are not exposed through this adapter.

Task creation is additionally constrained to the application-defined task categories and requires correlation/idempotency metadata.

## Current limitation

The code now contains the real HTTP/MCP runtime adapter and health-checked registration path, but a live Ruflo process is not available inside the GitHub repository environment.

Therefore the repository must not claim `RUFLO_CONNECTED` until the deployment/operator actually starts Ruflo and invokes the registration path successfully.

## Next runtime validation

1. Start Ruflo V3 HTTP server.
2. Configure `RUFLO_MCP_URL`.
3. Run the health-checked registration.
4. Call `system/info` and `swarm/status`.
5. Create two independent, non-destructive test tasks with unique correlation/idempotency metadata.
6. Verify AI Income Lab gates and audit records.
7. Only then enable production orchestration.
