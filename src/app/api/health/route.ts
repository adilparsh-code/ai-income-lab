import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { APP_ENV, APP_NAME, isDeployed } from '@/lib/config';
import { logger } from '@/lib/server-log';

// Lightweight health check. Verifies the app is up and, if possible, that the
// database is reachable — without exposing connection details, credentials, or
// schema information to the caller.
export async function GET() {
  let databaseOk = false;
  try {
    // Parameter-free tagged-template query: the SQL text is fixed at compile
    // time with no interpolation, so no untrusted input can ever reach the
    // engine. Prisma tagged-template queries are sent as parameterized
    // statements; the string-building *Unsafe variants are banned from this
    // codebase (enforced by the security regression suite).
    await db.$queryRaw`SELECT 1`;
    databaseOk = true;
  } catch (error) {
    logger.warn('Health check: database connectivity failed', {
      detail: error instanceof Error ? error.message : 'unknown',
    });
  }

  const payload = {
    status: databaseOk ? 'ok' : 'degraded',
    app: APP_NAME,
    environment: APP_ENV,
    deployed: isDeployed,
    database: databaseOk ? 'ok' : 'unavailable',
    timestamp: new Date().toISOString(),
  };

  return NextResponse.json(payload, { status: databaseOk ? 200 : 503 });
}