import dotenv from 'dotenv';
import { defineConfig } from '@prisma/prisma7/config';

// Prisma CLI should use the test-provided environment during tests.
// Do not let .env.local override DATABASE_URL=file:... in test mode.
if (process.env.NODE_ENV !== 'test') {
  dotenv.config({ path: '.env.local' });
  dotenv.config({ path: '.env' });
}

function cleanUrl(value: string | undefined): string {
  return (value?.trim() ?? '').replace(/^["']|["']$/g, '');
}

// In test mode, explicitly use the DATABASE_URL supplied by the test.
// In normal/production CLI usage, prefer DIRECT_URL and fall back to DATABASE_URL.
const rawDatabaseUrl =
  process.env.NODE_ENV === 'test'
    ? cleanUrl(process.env.DATABASE_URL)
    : cleanUrl(process.env.DIRECT_URL) || cleanUrl(process.env.DATABASE_URL);

export default defineConfig({
  schema: 'prisma/schema.prisma',
  ...(rawDatabaseUrl.length > 0
    ? { datasource: { url: rawDatabaseUrl } }
    : {}),
});
