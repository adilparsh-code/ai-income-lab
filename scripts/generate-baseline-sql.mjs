import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync, mkdirSync } from 'node:fs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
mkdirSync(join(root, 'prisma7', 'migrations', '0001_init'), { recursive: true });
// UTF-8, no BOM — PowerShell redirection writes UTF-16 and Postgres rejects it.
const out = execFileSync(
  'npx',
  ['prisma7', 'migrate', 'diff', '--from-empty', '--to-schema', 'prisma/schema.prisma', '--script'],
  { cwd: root, shell: true, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
);
// Keep only the SQL (strip Prisma's banner lines that precede it).
const sqlStart = out.indexOf('-- CreateSchema');
const clean = sqlStart >= 0 ? out.slice(sqlStart) : out;
writeFileSync(join(root, 'prisma7', 'migrations', '0001_init', 'migration.sql'), clean, 'utf8');
console.log('Wrote prisma/migrations/0001_init/migration.sql (utf8,', clean.length, 'bytes).');
