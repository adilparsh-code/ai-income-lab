# Human approvals (single-use, server-issued)

Irreversible/external actions (publish an offer, deploy, roll back, lifecycle
DEPLOY/PUBLISH) require an **approval** — not a free-form string.

## Model
- An authenticated **admin session** calls `POST /api/approvals` with
  `{ "action": "...", "subjectId": "..." }`. The operator bearer token cannot mint approvals.
- Actions → subject: `PUBLISH_OFFER`→offer, `DEPLOY_PRODUCT`/`PUBLISH_PRODUCT`/`LIFECYCLE_DEPLOY`/`LIFECYCLE_PUBLISH`→product, `ROLLBACK_DEPLOYMENT`→deployment id.
- The server binds the approval to the subject's **current state** (offers: id/title/price/currency/status/halalStatus/productId; products: id/status). Editing the subject voids outstanding approvals.
- Response contains an opaque token (shown once, 10-minute TTL, single use). Only `SHA-256(token)` is stored (`ApprovalGrant`).
- The token is then passed as `humanApprovalToken` to the existing endpoints.
- **Consumption** is one atomic conditional `UPDATE ... WHERE consumedAt IS NULL AND expiresAt > now AND action/subject/scope match`; the approver's admin session must still be live. Consumption happens immediately before the external side effect, after every refusable gate, so refused requests do not burn it.
- Adapters (Polar, Vercel) accept only an in-process `VerifiedApproval` capability, never a string.

## Known limits
- For async jobs the opaque token travels in the job payload; it is single-use and expires in 10 minutes, but a job that runs later fails closed. A grant-id-based hand-off would remove the secret from the payload.
- There is no approval UI yet; call the endpoint from an authenticated admin browser session.
- `PUBLISH_PRODUCT` and the product job path only *peek* (the publishing boundary never publishes). Any future real product-publish sink must call `consumeApproval`.
- `ApprovalGrant` rows are not pruned automatically.
