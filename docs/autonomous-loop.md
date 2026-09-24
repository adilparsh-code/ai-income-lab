# Autonomous Loop

Status: **implemented and tested**.

The Phase 8 controller plans one transition from the existing Income Engine state. It refuses `NOT_ALLOWED` and `REVIEW_REQUIRED` opportunities, never schedules a completed stage again, and records `from`, `to`, reason, evidence, provenance, correlation ID, timestamp, and execution status in `LoopTransition`.

Execution is delegated to `runJob`; Ruflo remains orchestration rather than security authority. Missing traffic and revenue remain `AWAITING_HUMAN_INPUT` rather than being invented.

Implemented: `src/lib/operations/loop-controller.ts`, `LoopTransition` Prisma model, and deterministic primitive tests.
