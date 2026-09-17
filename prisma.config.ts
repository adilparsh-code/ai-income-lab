import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// `env('DATABASE_URL')` throws when the variable is missing, which breaks
// `prisma generate` in a fresh clone/CI where no DATABASE_URL is configured.
// Generation never touches real data, so read the raw value (or absence) and
// fall back to the documented local SQLite default here.
const databaseUrl = process.env.DATABASE_URL && process.env.DATABASE_URL.trim().length > 0
  ? process.env.DATABASE_URL
  : 'file:./dev.db';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    url: databaseUrl,
  },
});
