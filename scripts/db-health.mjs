// Read-only Supabase/Postgres health probe.
//
// Connects with node-postgres (the same driver used by @prisma/adapter-pg),
// runs only SELECT/inspection queries, and NEVER prints the connection
// string or password. Run: node scripts/db-health.mjs
import pg from 'pg';
import { readFileSync } from 'node:fs';

const line = readFileSync('.env.local', 'utf8')
  .split(/\r?\n/)
  .find((l) => l.startsWith('DATABASE_URL='));
if (!line) {
  console.error('DATABASE_URL not found in .env.local');
  process.exit(1);
}
// Strip surrounding quotes: Next.js and Prisma tolerate them, but a raw value
// passed through the shell does not.
const connectionString = line
  .slice('DATABASE_URL='.length)
  .trim()
  .replace(/^["']|["']$/g, '');
if (!connectionString) {
  console.error('DATABASE_URL is empty in .env.local');
  process.exit(1);
}

// Parse with WHATWG URL (pg's legacy parser mishandles passwords containing
// URL-special characters) and pass explicit fields. Values are never printed.
const u = new URL(connectionString);
const needsSsl = !u.searchParams.has('sslmode') && !u.searchParams.has('ssl');
const client = new pg.Client({
  host: u.hostname,
  port: Number(u.port) || 5432,
  user: decodeURIComponent(u.username),
  password: decodeURIComponent(u.password),
  database: u.pathname.replace(/^\//, '') || 'postgres',
  ...(needsSsl ? { ssl: { rejectUnauthorized: false } } : {}),
});

try {
  await client.connect();
  const ping = await client.query('SELECT 1 AS ok');
  const info = await client.query(
    'SELECT current_database() AS db, current_user AS usr, version() AS version',
  );
  const tables = await client.query(
    `SELECT count(*)::int AS count FROM information_schema.tables
     WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`,
  );
  const migrations = await client.query(
    `SELECT count(*)::int AS count FROM "_prisma_migrations"`,
  ).catch(() => null);

  console.log('DB health check (read-only):');
  console.log('  ping SELECT 1:', ping.rows[0].ok === 1 ? 'OK' : 'FAIL');
  console.log('  database:', info.rows[0].db);
  console.log('  role:', info.rows[0].usr);
  console.log('  server:', String(info.rows[0].version).split(' ').slice(0, 2).join(' '));
  console.log('  recorded migrations:', migrations ? migrations.rows[0].count : 'n/a');
  console.log('  public tables:', tables.rows[0].count);
  const realCounts = await client.query(
    `SELECT (SELECT count(*) FROM "WorkflowRun") AS wr, (SELECT count(*) FROM "JobRun") AS jr,
            (SELECT count(*) FROM "AgentLog") AS al, (SELECT count(*) FROM "Opportunity") AS opp,
            (SELECT count(*) FROM "Product") AS prod, (SELECT count(*) FROM "Revenue") AS rev`,
  );
  console.log('  actual row counts (WorkflowRun/JobRun/AgentLog/Opportunity/Product/Revenue):',
    Object.values(realCounts.rows[0]).join('/'));
  const counts = await client.query(
    `SELECT relname AS t, n_live_tup::int AS rows FROM pg_stat_user_tables
     WHERE relname NOT IN ('migrations', 'schema_migrations') ORDER BY relname`,
  );
  for (const r of counts.rows) {
    if (r.rows > 0) console.log(`  rows in ${r.t}: ~${r.rows}`);
  }
  console.log('CONNECTION: PASS');
} catch (error) {
  console.error('DB health check FAILED:', error.message);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
