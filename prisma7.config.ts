import dotenv from 'dotenv';
import { defineConfig } from '@prisma/prisma7/config';

const isTest = process.env.NODE_ENV === 'test';

if (!isTest) {
  dotenv.config({ path: '.env.local' });
  dotenv.config({ path: '.env' });
}

function cleanUrl(value: string | undefined): string {
  return (value?.trim() ?? '').replace(/^["']|["']$/g, '');
}

const rawDatabaseUrl = isTest
  ? cleanUrl(process.env.DATABASE_URL)
  : cleanUrl(process.env.DIRECT_URL) || cleanUrl(process.env.DATABASE_URL);

export default defineConfig({
  schema: 'prisma/schema.prisma',
  ...(rawDatabaseUrl.length > 0
    ? { datasource: { url: rawDatabaseUrl } }
    : {}),
});
