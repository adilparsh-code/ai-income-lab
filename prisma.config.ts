import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: {
    // Fall back to a local SQLite file so `prisma generate` succeeds even in a
    // fresh clone/CI without a configured DATABASE_URL. Generation never touches
    // real data; the application runtime still requires a proper DATABASE_URL.
    url: env('DATABASE_URL') ?? 'file:./dev.db',
  },
});
