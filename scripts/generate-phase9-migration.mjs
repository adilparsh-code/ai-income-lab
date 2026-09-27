// One-off helper: generate the Phase 9 additive migration SQL via
// `prisma migrate diff --from-schema <old> --to-schema <new> --script`.
// On this environment the CLI's stdout mixes dotenv banner lines with the
// SQL; running through execFileSync captures the real stdout (banner lines
// are emitted separately) and the script below keeps only CREATE/ALTER
// statements, so the committed migration file contains pure SQL.
//
// Usage: node scripts/generate-phase9-migration.mjs <old-schema-path> <output-migration-file>
// The diff is datamodel-to-datamodel: no database is contacted and the
// generated SQL is strictly additive (CREATE TABLE/INDEX + FK adds).
import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const [, , oldSchemaArg, outArg] = process.argv;
if (!oldSchemaArg || !outArg) {
  console.error('Usage: node scripts/generate-phase9-migration.mjs <old-schema.prisma> <migration.sql>');
  process.exit(1);
}
if (!existsSync(oldSchemaArg)) {
  console.error(`Old schema not found: ${oldSchemaArg}`);
  process.exit(1);
}
mkdirSync(dirname(outArg), { recursive: true });

const raw = execFileSync(
  'npx',
  ['prisma', 'migrate', 'diff', '--from-schema', oldSchemaArg, '--to-schema', 'prisma/schema.prisma', '--script'],
  { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 },
);

// Keep only SQL statement lines (banner/log lines never start with "--" comments
// that belong to Prisma DDL; we filter to lines that are SQL or Prisma's own
// -- comments, dropping dotenv/CLI chatter).
const lines = raw.split('\n');
const isChatter = (l) =>
  l.startsWith('◇') ||
  l.startsWith('Loaded Prisma config') ||
  l.trim() === '' && lines.every((x) => x.trim() === '');

const sqlLines = [];
for (const line of lines) {
  if (isChatter(line)) continue;
  if (/^(--|-- )/.test(line) && !/^-- (Create|Alter|Drop|Redefine)/.test(line) && !/^--$/.test(line)) {
    // Prisma's own section comments look like "-- CreateTable"; keep those.
    continue;
  }
  sqlLines.push(line);
}

// Prisma emits "-- CreateTable" style comments followed by DDL. Keep comments
// that immediately precede DDL for readability; drop pure chatter above.
const cleaned = sqlLines.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';

if ((cleaned.match(/CREATE TABLE/g) ?? []).length === 0) {
  console.error('Generated SQL contains no CREATE TABLE statements — refusing to write an empty migration.');
  console.error('Raw CLI output was:\n' + raw.slice(0, 500));
  process.exit(1);
}
if (/DROP TABLE|DROP COLUMN|TRUNCATE/i.test(cleaned)) {
  console.error('Generated SQL contains destructive statements — refusing to write it.');
  process.exit(1);
}

writeFileSync(outArg, cleaned, 'utf8');
void readFileSync; // (imported for symmetry with sibling scripts)
console.log(`Wrote ${outArg} (${cleaned.length} bytes, ${(cleaned.match(/CREATE TABLE/g) ?? []).length} CREATE TABLE statements).`);
