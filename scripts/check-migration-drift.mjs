// Offline schema <-> migration drift audit. NO database required, NO credentials.
//
// `prisma7 migrate diff --from-migrations ... --to-schema ...` needs a shadow
// database, and `--from-empty --to-schema` renders nothing unless the Prisma
// config supplies a datasource URL — so neither can run in a fresh clone or CI.
// This script answers the same question statically and read-only: it parses
// prisma/schema.prisma and every prisma/migrations/<name>/migration.sql, then
// compares tables, columns (type / nullability / default), primary keys,
// indexes and foreign keys between the two.
//
// Usage:
//   node scripts/check-migration-drift.mjs
//   node scripts/check-migration-drift.mjs --schema=prisma/schema.prisma
//
// Exit code 0 = no drift, 1 = drift found (or the schema/migrations unreadable).
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const schemaArg = process.argv.find((a) => a.startsWith('--schema='));
const schemaPath = isAbsolute(schemaArg?.slice('--schema='.length) ?? '')
  ? schemaArg.slice('--schema='.length)
  : join(root, schemaArg ? schemaArg.slice('--schema='.length) : 'prisma/schema.prisma');
const migrationsDir = join(root, 'prisma', 'migrations');

// Prisma scalar -> PostgreSQL column type, matching the DDL the Prisma 7
// migrate engine emits for `provider = "postgresql"`.
const COLUMN_TYPE = {
  String: 'TEXT',
  Int: 'INTEGER',
  BigInt: 'BIGINT',
  Float: 'DOUBLE PRECISION',
  Decimal: 'DECIMAL(65,30)',
  Boolean: 'BOOLEAN',
  DateTime: 'TIMESTAMP(3)',
  Json: 'JSONB',
  Bytes: 'BYTEA',
};

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

function bareName(token) {
  return token.replace(/\[\]$/, '').replace(/\?$/, '');
}

/** Prisma model field name -> `<Model>_<field>` FK/index name, as the engine emits. */
function joinColumns(columns) {
  return columns.join('_');
}

function sorted(list) {
  return [...list].sort();
}

function diffSet(label, expected, actual, problems) {
  for (const item of sorted(expected).filter((x) => !actual.includes(x))) {
    problems.push(`${label}: missing in migrations -> ${item}`);
  }
  for (const item of sorted(actual).filter((x) => !expected.includes(x))) {
    problems.push(`${label}: present in migrations but not in schema -> ${item}`);
  }
}

// ---------------------------------------------------------------------------
// Prisma schema parsing
// ---------------------------------------------------------------------------

/** Strip a trailing `//` comment that is not inside a quoted string. */
function stripComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === quote && line[i - 1] !== '\\') quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '/' && line[i + 1] === '/') {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseSchemaModels(text) {
  const models = new Map();
  const lines = text.split(/\r?\n/).map(stripComment);
  let current = null;
  let buffer = '';
  let depth = 0;

  const flush = () => {
    const statement = buffer.replace(/\s+/g, ' ').trim();
    buffer = '';
    if (statement) statements.push(statement);
  };
  let statements = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (!current) {
      const match = /^model\s+(\w+)\s*\{/.exec(line);
      if (match) {
        current = match[1];
        statements = [];
        buffer = '';
        depth = 0;
      }
      continue;
    }
    if (line === '}') {
      flush();
      models.set(current, buildModel(current, statements));
      current = null;
      continue;
    }
    // Field/attribute statements may wrap across lines: join while parentheses
    // are unbalanced.
    buffer += (buffer ? ' ' : '') + line;
    depth += (line.match(/\(/g) ?? []).length - (line.match(/\)/g) ?? []).length;
    if (depth <= 0) flush();
  }
  if (current) throw new Error(`Unterminated model block: ${current}`);
  return models;
}

/** Attribute argument list as a string, e.g. `fields: [a], references: [id]`. */
function attributeArgs(statement, name) {
  const index = statement.indexOf(`@${name}(`);
  if (index < 0) return null;
  let depth = 0;
  const start = index + name.length + 2;
  for (let i = start; i < statement.length; i += 1) {
    if (statement[i] === '(') depth += 1;
    else if (statement[i] === ')') {
      if (depth === 0) return statement.slice(start, i);
      depth -= 1;
    }
  }
  return null;
}

function bracketList(args) {
  if (!args) return [];
  const match = /\[([^\]]*)\]/.exec(args);
  if (!match) return [];
  return match[1]
    .split(',')
    .map((entry) => entry.trim().split(/[\s(]/)[0])
    .filter(Boolean);
}

function quotedArg(args, name) {
  if (!args) return null;
  const match = new RegExp(`${name}\\s*:\\s*"([^"]*)"`).exec(args);
  return match ? match[1] : null;
}

function hasAttribute(statement, name) {
  return new RegExp(`(^|\\s)@${name}(\\s|\\(|$)`).test(statement);
}

/** `@default(...)` inner expression -> the SQL DEFAULT the engine emits (null = none). */
function sqlDefault(expression) {
  if (expression === null) return null;
  const value = expression.trim();
  if (value === 'now()') return 'CURRENT_TIMESTAMP';
  // Client-side generators and sequence-backed defaults produce no SQL DEFAULT.
  if (/^(cuid|uuid|ulid|nanoid|autoincrement)\(\)$/.test(value)) return null;
  const dbgenerated = /^dbgenerated\((?:"|')?([^"')]*)(?:"|')?\)$/.exec(value);
  if (dbgenerated) return dbgenerated[1].trim() || null;
  if (value === 'true' || value === 'false') return value;
  if (/^-?\d+(\.\d+)?$/.test(value)) return value;
  const literal = /^"([^"]*)"$/.exec(value) ?? /^'([^']*)'$/.exec(value);
  if (literal) return `'${literal[1]}'`;
  return null;
}

function buildModel(model, statements) {
  const columns = new Map(); // column name -> full DDL fragment
  const indexes = new Map(); // index name -> { columns, unique }
  const fks = new Map(); // constraint name -> { column, refTable, refColumn, onDelete }
  const primaryKey = new Set();

  for (const statement of statements) {
    if (statement.startsWith('@@')) {
      if (/^@@id/.test(statement)) {
        for (const column of bracketList(attributeArgs(statement, 'id'))) primaryKey.add(column);
        continue;
      }
      const uniqueArgs = /^@@unique/.test(statement) ? attributeArgs(statement, 'unique') : null;
      const indexArgs = /^@@index/.test(statement) ? attributeArgs(statement, 'index') : null;
      const args = uniqueArgs ?? indexArgs;
      if (!args) continue;
      const fields = bracketList(args);
      const explicit = quotedArg(args, 'name') ?? quotedArg(args, 'map');
      const suffix = uniqueArgs ? '_key' : '_idx';
      const name = explicit ?? `${model}_${joinColumns(fields)}${suffix}`;
      indexes.set(name, { columns: fields, unique: Boolean(uniqueArgs) });
      continue;
    }

    const match = /^(\w+)\s+(\S+)(?:\s+(.*))?$/.exec(statement);
    if (!match) continue;
    const [, field, typeToken, attributes = ''] = match;
    const type = bareName(typeToken);
    const nullable = typeToken.endsWith('?') || typeToken.endsWith('[]');

    const relationArgs = attributeArgs(attributes, 'relation');
    if (relationArgs) {
      const foreignFields = bracketList(/fields\s*:\s*\[[^\]]*\]/.exec(relationArgs)?.[0]);
      if (foreignFields.length === 1) {
        const referenced = bracketList(/references\s*:\s*\[[^\]]*\]/.exec(relationArgs)?.[0]);
        const onDelete = quotedArg(relationArgs, 'onDelete') ?? (nullable ? 'SET NULL' : 'RESTRICT');
        const name = `${model}_${foreignFields[0]}_fkey`;
        fks.set(name, {
          column: foreignFields[0],
          refTable: type,
          refColumn: referenced[0] ?? 'id',
          onDelete,
        });
      }
      continue;
    }

    if (!COLUMN_TYPE[type]) continue; // unknown/unsupported scalar type: skip
    const defaultExpression = attributeArgs(attributes, 'default');
    const fallback = sqlDefault(defaultExpression);
    const notNull = nullable ? '' : ' NOT NULL';
    const withDefault = fallback ? ` DEFAULT ${fallback}` : '';
    columns.set(field, `"${field}" ${COLUMN_TYPE[type]}${notNull}${withDefault}`);

    if (hasAttribute(attributes, 'id')) primaryKey.add(field);
    if (hasAttribute(attributes, 'unique')) indexes.set(`${model}_${field}_key`, { columns: [field], unique: true });
  }
  return { columns, indexes, fks, primaryKey: sorted(primaryKey) };
}

// ---------------------------------------------------------------------------
// Migration SQL parsing
// ---------------------------------------------------------------------------

function readMigrations(dir) {
  if (!existsSync(dir)) throw new Error(`No migrations directory at ${dir}`);
  const files = readdirSync(dir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const parts = files.map((name) => ({ name, sql: readFileSync(join(dir, name, 'migration.sql'), 'utf8') }));
  return { files, parts, sql: parts.map((p) => p.sql).join('\n') };
}

function parseSql(sqlText) {
  const tables = new Map();
  // Strip `-- ...` comment lines first: Prisma writes "-- CreateTable" above
  // each statement, which would otherwise prefix the statement chunk.
  const withoutComments = sqlText
    .split(/\r?\n/)
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
  const statements = withoutComments.split(/;\s*(?:\r?\n|$)/);

  for (const raw of statements) {
    const statement = raw.replace(/\s+/g, ' ').trim();
    if (!statement) continue;

    const createTable = /^CREATE TABLE "(\w+)" \((.*)\)$/.exec(statement);
    if (createTable) {
      const [, table, body] = createTable;
      const columns = new Map();
      const primaryKey = [];
      for (const part of body.split(/,\s(?="|CONSTRAINT)/)) {
        const entry = part.trim();
        const primary = /^CONSTRAINT "(\w+)" PRIMARY KEY \(([^)]*)\)$/.exec(entry);
        if (primary) {
          primaryKey.push(...primary[2].split(',').map((c) => c.trim().replace(/"/g, '')));
          continue;
        }
        const column = /^"(\w+)" (.+)$/.exec(entry);
        if (column) columns.set(column[1], entry);
      }
      tables.set(table, { columns, indexes: new Map(), fks: new Map(), primaryKey: sorted(primaryKey) });
      continue;
    }

    const index = /^CREATE (UNIQUE )?INDEX "(\w+)" ON "(\w+)" ?\(([^)]*)\)/.exec(statement);
    if (index) {
      const [, unique, name, table, cols] = index;
      const target = tables.get(table);
      if (!target) continue;
      target.indexes.set(name, {
        columns: cols.split(',').map((c) => c.trim().replace(/"/g, '')),
        unique: Boolean(unique),
      });
      continue;
    }

    const fk = /^ALTER TABLE "(\w+)" ADD CONSTRAINT "(\w+)" FOREIGN KEY \(([^)]*)\) REFERENCES "(\w+)" ?\(([^)]*)\)(.*)$/.exec(statement);
    if (fk) {
      const [, table, name, column, refTable, refColumn, tail] = fk;
      const target = tables.get(table);
      if (!target) continue;
      target.fks.set(name, {
        column: column.replace(/"/g, '').trim(),
        refTable,
        refColumn: refColumn.replace(/"/g, '').trim(),
        onDelete: (/ON DELETE ([A-Z ]+?) ON UPDATE/.exec(tail) ?? [])[1]?.trim() ?? 'NO ACTION',
      });
    }
  }
  return tables;
}

/** Destructive / non-additive SQL an operator must never see in a migration. */
function auditDestructive(parts) {
  const findings = [];
  const patterns = [
    [/\bDROP\s+(TABLE|DATABASE|SCHEMA|COLUMN|TYPE|INDEX|CONSTRAINT)\b/i, 'DROP statement'],
    [/\bTRUNCATE\b/i, 'TRUNCATE'],
    [/\bDELETE\s+FROM\b/i, 'DELETE FROM'],
    [/\bUPDATE\s+"?\w+"?\s+SET\b/i, 'data-mutating UPDATE'],
  ];
  for (const { name, sql } of parts) {
    for (const [pattern, label] of patterns) {
      const match = pattern.exec(sql);
      if (match) findings.push(`${name}: ${label} -> "${match[0].trim()}"`);
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

function compareModels(expected, actual) {
  const problems = [];
  diffSet('tables', [...expected.keys()], [...actual.keys()], problems);

  for (const [table, expectedModel] of expected) {
    const actualModel = actual.get(table);
    if (!actualModel) continue; // already reported as missing

    diffSet(`${table}.columns`, [...expectedModel.columns.keys()], [...actualModel.columns.keys()], problems);
    for (const [column, definition] of expectedModel.columns) {
      const actualDefinition = actualModel.columns.get(column);
      if (actualDefinition && actualDefinition !== definition) {
        problems.push(`${table}.${column}: schema "${definition}" vs migrations "${actualDefinition}"`);
      }
    }

    if (expectedModel.primaryKey.join(',') !== actualModel.primaryKey.join(',')) {
      problems.push(
        `${table}.primaryKey: schema (${expectedModel.primaryKey.join(', ') || 'none'}) vs migrations (${actualModel.primaryKey.join(', ') || 'none'})`,
      );
    }

    diffSet(`${table}.indexes`, [...expectedModel.indexes.keys()], [...actualModel.indexes.keys()], problems);
    for (const [name, expectedIndex] of expectedModel.indexes) {
      const actualIndex = actualModel.indexes.get(name);
      if (!actualIndex) continue;
      if (expectedIndex.columns.join(',') !== actualIndex.columns.join(',')) {
        problems.push(`${table}.${name}: columns schema (${expectedIndex.columns.join(', ')}) vs migrations (${actualIndex.columns.join(', ')})`);
      }
      if (expectedIndex.unique !== actualIndex.unique) {
        problems.push(`${table}.${name}: unique schema (${expectedIndex.unique}) vs migrations (${actualIndex.unique})`);
      }
    }

    diffSet(`${table}.foreignKeys`, [...expectedModel.fks.keys()], [...actualModel.fks.keys()], problems);
    for (const [name, expectedFk] of expectedModel.fks) {
      const actualFk = actualModel.fks.get(name);
      if (!actualFk) continue;
      if (expectedFk.refTable !== actualFk.refTable || expectedFk.refColumn !== actualFk.refColumn) {
        problems.push(`${table}.${name}: references schema (${expectedFk.refTable}.${expectedFk.refColumn}) vs migrations (${actualFk.refTable}.${actualFk.refColumn})`);
      }
      if (expectedFk.onDelete.toUpperCase() !== actualFk.onDelete.toUpperCase()) {
        problems.push(`${table}.${name}: ON DELETE schema (${expectedFk.onDelete}) vs migrations (${actualFk.onDelete})`);
      }
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------

const schemaModels = parseSchemaModels(readFileSync(schemaPath, 'utf8'));
const { files, parts, sql: migratedSql } = readMigrations(migrationsDir);
const migratedTables = parseSql(migratedSql);

const problems = compareModels(schemaModels, migratedTables);
const destructive = auditDestructive(parts);

console.log(`Schema:     ${schemaPath.replace(root, '').replace(/\\/g, '/')} (${schemaModels.size} models)`);
console.log(`Migrations: prisma/migrations (${files.length} files: ${files.join(', ')})`);
console.log(`Schema vs migrations: ${problems.length === 0 ? 'NO DRIFT' : `${problems.length} difference(s)`}`);
for (const problem of problems) console.log(`  - ${problem}`);
console.log(`Destructive SQL audit: ${destructive.length === 0 ? 'CLEAN (additive only)' : `${destructive.length} finding(s)`}`);
for (const finding of destructive) console.log(`  - ${finding}`);

if (problems.length > 0 || destructive.length > 0) {
  console.error('MIGRATION DRIFT CHECK: FAIL');
  process.exitCode = 1;
} else {
  console.log('MIGRATION DRIFT CHECK: PASS');
}
