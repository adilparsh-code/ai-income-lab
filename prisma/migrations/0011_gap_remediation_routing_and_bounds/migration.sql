-- ===========================================================================
-- Phase 11.9 gap remediation — routing persistence (G1) + structured
-- micro-service kind and bounds (G2, G8)
--
-- ADDITIVE ONLY. No table is dropped or renamed. No column is removed or
-- retyped. No existing row is rewritten, deleted, or backfilled: every new
-- column is NULLABLE or carries a safe default, so historical rows keep
-- working and remain honestly readable.
--
-- ── G1: persisted routing decision on Offer ─────────────────────────────────
-- Phase 11.3 shipped routeOpportunity()/executionVerdict() as pure functions
-- with no production caller, so routing was decoration: the tests exercised a
-- layer nothing actually used. Persisting the decision at offer creation makes
-- routing a real, queryable fact, and lets service execution verify that the
-- route it runs under agrees with the recorded one.
--
-- Existing rows keep route=NULL, which truthfully means "routing was never
-- resolved for this row" rather than inventing a historical decision.
ALTER TABLE "Offer" ADD COLUMN "route" TEXT;
ALTER TABLE "Offer" ADD COLUMN "routeJobTypes" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "Offer" ADD COLUMN "routeExecutable" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Offer" ADD COLUMN "routeBlockers" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "Offer" ADD COLUMN "routeReason" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Offer" ADD COLUMN "routeResolvedAt" TIMESTAMP(3);

-- ── G8: structured bounded micro-service kind ───────────────────────────────
-- Phase 11.3 persisted the kind as free text in a "[KIND] ..." prefix inside
-- scopeSummary. That was a real integrity problem, not cosmetic: the prefix is
-- user-editable prose, is not indexed, and the job runner could not read it
-- authoritatively (so it trusted a caller-supplied payload value instead). An
-- execution could therefore declare a different catalogue kind than the one
-- the engagement was admitted under.
--
-- Rows created before this migration stay NULL and are simply not
-- micro-service-kind-addressable, which is truthful.
ALTER TABLE "ServiceEngagement" ADD COLUMN "microServiceKind" TEXT;
ALTER TABLE "ServiceEngagement" ADD COLUMN "microServiceEffortHours" DOUBLE PRECISION;
ALTER TABLE "ServiceEngagement" ADD COLUMN "microServiceRevisionLimit" INTEGER;

CREATE INDEX "ServiceEngagement_microServiceKind_idx" ON "ServiceEngagement"("microServiceKind");

-- ── ServiceIssue → triggering Message traceability ───────────────────────────
-- Phase 11.3 stored `client-message:<randomUUID()>` in correlationId. That
-- generated UUID pointed at nothing, so a client-sourced dispute could not be
-- traced back to the message that caused it — the audit trail was decorative.
-- This is a REAL foreign key to the triggering Message.
--
-- Nullable: an admin-raised issue has no triggering message, and pre-existing
-- rows stay NULL rather than being backfilled with invented linkage.
--
-- Direction note: Message.treatAs is constant 'DATA', never AUTHORITY, so a
-- message can TRIGGER an issue but can never RESOLVE one. The human gate is
-- unchanged by this column.
ALTER TABLE "ServiceIssue" ADD COLUMN "messageId" TEXT;

CREATE INDEX "ServiceIssue_messageId_idx" ON "ServiceIssue"("messageId");

ALTER TABLE "ServiceIssue"
  ADD CONSTRAINT "ServiceIssue_messageId_fkey"
  FOREIGN KEY ("messageId") REFERENCES "Message"("id") ON DELETE SET NULL ON UPDATE CASCADE;