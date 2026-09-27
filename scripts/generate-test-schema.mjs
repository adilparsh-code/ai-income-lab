// Generates the hermetic-test SQLite variant of the Prisma schema.
//
// The main schema (prisma/schema.prisma) targets PostgreSQL (Supabase) in
// production, but the test suite is hermetic: every test file points
// DATABASE_URL at a temporary `file:` database and runs `prisma db push`.
// Since the SQL dialect is baked into the generated client by the schema
// provider, tests need a SQLite variant of the SAME schema plus a SQLite
// client. This script derives prisma/schema.test.prisma mechanically from the
// main schema (only the provider changes), so the two can never drift, then
// generates the SQLite client into prisma/test-client/.
//
// DATABASE_URL is removed from the child environment before generation: the
// main config (prisma.config.ts) would otherwise pass a postgres:// URL to a
// sqlite schema. Generation never touches a database, so no URL is needed.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const mainSchemaPath = join(root, 'prisma', 'schema.prisma');
const testSchemaPath = join(root, 'prisma', 'schema.test.prisma');

const mainSchema = readFileSync(mainSchemaPath, 'utf8');

const testSchema = mainSchema.replace(
  /datasource\s+db\s*\{[\s\S]*?\}/,
  (block) => block.replace(/provider\s*=\s*"postgresql"/, 'provider = "sqlite"'),
);
if (testSchema === mainSchema) {
  throw new Error('Failed to rewrite datasource provider to sqlite for the test schema.');
}

// Give the test generator its own output directory so the production client
// (node_modules/.prisma/client) is never touched.
const withTestOutput = testSchema.replace(
  /(generator\s+client\s*\{\s*\n)/,
  '$1  output   = "./test-client"\n',
);

writeFileSync(testSchemaPath, withTestOutput);

const childEnv = { ...process.env };
delete childEnv.DATABASE_URL;
execFileSync('npx', ['prisma7', 'generate', '--schema', 'prisma/schema.test.prisma'], {
  cwd: root,
  env: childEnv,
  stdio: 'inherit',
  shell: true,
});
console.log('[generate-test-schema] SQLite test schema + client ready (prisma/test-client).');
