import 'dotenv/config';
// Next.js loads .env.local automatically; the Prisma CLI does not. Load it
// here so `prisma migrate deploy` / `db push` see the same DATABASE_URL the
// app sees. The value itself is never printed or logged by this module.
import dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });
dotenv.config({ path: '.env' });

import { defineConfig } from '@prisma/prisma7/config';

function cleanUrl(value: string | undefined): string {
  return (value?.trim() ?? '').replace(/^["']|["']$/g, '');
}

// `prisma generate` never touches a database, so it must keep working in a
// fresh clone/CI where no DATABASE_URL is configured. Only pass a datasource
// URL when the environment actually provides one; CLI operations that need a
// live database (migrate deploy, db push) require DATABASE_URL to be set.
// Strip surrounding quotes: a raw quoted value is not a valid URL (P1013).
//
// DIRECT_URL: Supabase's transaction pooler (port 6543, PgBouncer) rejects the
// Prisma CLI engine's named prepared statements ("prepared statement s1
// already exists"). Point DIRECT_URL at the session pooler (same host, port
// 5432) or the direct connection for CLI/migration operations; it falls back
// to DATABASE_URL. The app runtime itself uses DATABASE_URL via the pg driver
// adapter, which works through the transaction pooler.
const rawDatabaseUrl = cleanUrl(process.env.DIRECT_URL) || cleanUrl(process.env.DATABASE_URL);

export default defineConfig({
  schema: 'prisma/schema.prisma',
  ...(rawDatabaseUrl.length > 0 ? { datasource: { url: rawDatabaseUrl } } : {}),
});
