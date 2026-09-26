// Read-only Supabase/Postgres connection doctor. NO credentials are printed.
//
// Answers "why does `prisma7 migrate status` fail with P1000?" without ever
// revealing a secret. It:
//   1. reports which env variables are PRESENT / EMPTY / MISSING in .env.local,
//   2. describes the STRUCTURE of DATABASE_URL / DIRECT_URL (host, port,
//      database, username shape, query-parameter names, password presence,
//      percent-encoding health) — masked,
//   3. checks the two URLs agree on the shared secret (a mismatch is the most
//      common cause of "the pooler works, the direct connection does not"),
//   4. resolves the host's DNS records and tests a raw TCP handshake so a
//      network failure is never mistaken for an authentication failure,
//   5. authenticates with node-postgres (the same driver the app uses) and
//      reports the PostgreSQL SQLSTATE code — the only authoritative answer to
//      "is the password wrong?" (`28P01` = invalid_password).
//
// Prints no URL, no password, and no password length.
// Usage: node scripts/db-connection-doctor.mjs   (npm run db:doctor)
import { readFileSync, existsSync } from 'node:fs';
import { lookup } from 'node:dns/promises';
import { connect as tcpConnect } from 'node:net';
import pg from 'pg';

/** Supabase project this repository is configured against. Not a secret. */
const PROJECT_REF = 'lzzvsprmczgdgirtpmca';
const EXPECTED = {
  direct: { host: `db.${PROJECT_REF}.supabase.co`, port: 5432, database: 'postgres', user: 'postgres' },
  pooler: {
    host: 'aws-0-ap-southeast-1.pooler.supabase.com',
    port: 6543,
    database: 'postgres',
    user: `postgres.${PROJECT_REF}`,
  },
};
const ENV_FILES = ['.env.local', '.env'];
const KEYS = [
  'DATABASE_URL',
  'DIRECT_URL',
  'NEXT_PUBLIC_SUPABASE_URL',
  'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
];
// A template value is not a credential — detect it so it is never mistaken for
// an authentication failure (same guard as scripts/db-health.mjs).
const PLACEHOLDER = /\[YOUR-PASSWORD\]|<password>|<project-ref>|<region>/i;
// Characters that MUST be percent-encoded inside a URL userinfo field.
const URL_SENSITIVE = {
  '@': 'at-sign',
  ':': 'colon',
  '/': 'slash',
  '?': 'question-mark',
  '#': 'hash',
  '&': 'ampersand',
  '+': 'plus',
  '%': 'percent',
  ' ': 'space',
  '\\': 'backslash',
};
function readEnvFile(path) {
  if (!existsSync(path)) return null;
  const vars = new Map();
  const occurrences = new Map();
  for (const [index, raw] of readFileSync(path, 'utf8').split(/\r?\n/).entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    // dotenv semantics: the LAST definition of a key wins. A naive first-wins
    // read (or a human reading top-down) sees the opposite value when a key is
    // duplicated, so duplicates are reported explicitly.
    vars.set(key, value);
    occurrences.set(key, [...(occurrences.get(key) ?? []), index + 1]);
  }
  return { vars, occurrences };
}

/** Never let credential material reach the console. */
function redact(message, secrets) {
  let text = String(message ?? '');
  for (const secret of secrets) {
    if (secret) text = text.split(secret).join('***');
  }
  return text.replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgresql://***');
}

function safeDecode(value) {
  try {
    return { ok: true, value: decodeURIComponent(value) };
  } catch {
    return { ok: false, value: '' };
  }
}

function classifyUser(username) {
  const decoded = safeDecode(username).value || username;
  if (!decoded) return 'ABSENT (no username in the URL)';
  if (decoded === 'postgres') return 'postgres (direct-connection style)';
  if (decoded === `postgres.${PROJECT_REF}`) return 'postgres.<project-ref> (pooler style, ref matches)';
  if (decoded.startsWith('postgres.')) {
    return 'postgres.<other-ref> (pooler style, ref DOES NOT match configured project)';
  }
  return 'non-postgres role (masked)';
}

function classifyHost(hostname) {
  if (hostname === EXPECTED.direct.host) return `direct host db.${PROJECT_REF}.supabase.co`;
  if (hostname === EXPECTED.pooler.host) return `pooler host ${EXPECTED.pooler.host}`;
  if (hostname.endsWith('.pooler.supabase.com')) return 'a different supabase.com pooler host';
  if (hostname.endsWith('.supabase.co')) return 'a different supabase.co direct host';
  return 'a non-Supabase host (masked)';
}

/** Structure report for one connection string. Returns the parsed pieces. */
function describe(label, value, secrets) {
  console.log(`\n${label}`);
  console.log('-'.repeat(label.length));
  if (value === undefined) {
    console.log('  status: MISSING (the variable is not defined in any env file)');
    return null;
  }
  if (!value) {
    console.log('  status: EMPTY (defined but blank — treated as not configured)');
    return null;
  }
  if (PLACEHOLDER.test(value)) {
    console.log('  status: PRESENT but still a TEMPLATE placeholder — replace it before use');
    return null;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    console.log('  status: PRESENT but UNPARSEABLE as a URL');
    console.log('  cause:  a URL-sensitive character in the password is not percent-encoded');
    return null;
  }

  const database = url.pathname.replace(/^\//, '');
  const port = url.port || '(driver default)';
  const queryParams = [...url.searchParams.keys()];
  const rawPassword = url.password;
  const decoded = safeDecode(rawPassword);
  const rawSpecials = Object.keys(URL_SENSITIVE).filter((ch) => rawPassword.includes(ch));

  console.log('  status: PRESENT');
  console.log(`  protocol: ${url.protocol.replace(':', '')}`);
  console.log(`  host: ${classifyHost(url.hostname)}`);
  console.log(`  port: ${port}`);
  console.log(`  database: ${database || '(none)'}`);
  console.log(`  username: ${classifyUser(url.username)}`);
  console.log(`  password: ${rawPassword ? 'present (masked)' : '*** ABSENT — this alone causes P1000 ***'}`);
  if (rawPassword) {
    console.log(
      `  password percent-decodes cleanly: ${decoded.ok ? 'yes' : 'NO (invalid % escape sequence — the CLI URL parser will fail)'}`,
    );
    if (rawSpecials.length > 0) {
      console.log(
        `  raw URL-sensitive characters NOT percent-encoded in password: ${rawSpecials.map((c) => URL_SENSITIVE[c]).join(', ')}`,
      );
    }
  }
  console.log(`  query parameters: ${queryParams.length > 0 ? queryParams.join(', ') : '(none)'}`);

  // Architecture expectations (docs/database-operations.md section 2).
  const expectPooler = label.startsWith('DATABASE_URL');
  const expected = expectPooler ? EXPECTED.pooler : EXPECTED.direct;
  const notes = [];
  if (url.hostname !== expected.host) notes.push(`host is not ${expected.host}`);
  if (Number(port) !== expected.port) notes.push(`port is not ${expected.port}`);
  if (database !== expected.database) notes.push(`database is not ${expected.database}`);
  const decodedUser = safeDecode(url.username).value || url.username;
  if (decodedUser !== expected.user) notes.push(`username is not ${expected.user}`);
  if (expectPooler && !queryParams.includes('pgbouncer')) notes.push('missing ?pgbouncer=true');
  if (!queryParams.some((p) => p === 'sslmode' || p === 'ssl')) notes.push('no sslmode/ssl parameter');

  let verdict = 'OK';
  if (!rawPassword) verdict = 'FAIL (no password)';
  else if (!decoded.ok) verdict = 'FAIL (password not percent-encoded)';
  else if (rawSpecials.length > 0) verdict = 'RISK (raw URL-sensitive characters in password)';
  else if (notes.some((n) => n.startsWith('host') || n.startsWith('port') || n.startsWith('username') || n.startsWith('database'))) {
    verdict = 'DEVIATES (see notes)';
  }
  console.log(`  structural verdict: ${verdict}`);
  for (const note of notes) console.log(`    - ${note}`);

  return {
    url,
    rawPassword,
    decoded: decoded.value,
    decodedOk: decoded.ok,
    database: database || 'postgres',
    port: Number(port) || expected.port,
    secrets,
  };
}

function tcpProbe(host, port, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const socket = tcpConnect({ host, port });
    const done = (result) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done({ ok: true, detail: 'TCP handshake completed' }));
    socket.once('timeout', () => done({ ok: false, detail: 'timeout (port filtered / host unreachable)' }));
    socket.once('error', (error) => done({ ok: false, detail: error.code || error.message }));
  });
}

async function dnsFamilies(hostname) {
  try {
    const addresses = await lookup(hostname, { all: true });
    const families = [...new Set(addresses.map((a) => a.family))].sort();
    if (families.length === 0) return 'no records';
    return families.map((f) => (f === 6 ? 'AAAA (IPv6)' : 'A (IPv4)')).join(' + ');
  } catch (error) {
    return error.code || 'lookup failed';
  }
}

/** Authenticate with node-postgres; report only the SQLSTATE code and a redacted message. */
async function pgProbe(label, conn, secrets) {
  if (!conn || !conn.decodedOk) return null;
  const usesExplicitSsl = conn.url.searchParams.has('sslmode') || conn.url.searchParams.has('ssl');
  const client = new pg.Client({
    host: conn.url.hostname,
    port: conn.port,
    user: safeDecode(conn.url.username).value || conn.url.username,
    password: conn.decoded,
    database: conn.database,
    connectionTimeoutMillis: 10000,
    ...(usesExplicitSsl ? {} : { ssl: { rejectUnauthorized: false } }),
  });
  try {
    await client.connect();
    const ping = await client.query('SELECT 1 AS ok');
    console.log(`${label}: PASS — authenticated, SELECT 1 returned ${ping.rows[0].ok}`);
    await client.end().catch(() => {});
    return 'pass';
  } catch (error) {
    console.log(`${label}: FAIL — SQLSTATE ${error.code || '(none)'}`);
    console.log(`  message: ${redact(error.message, secrets)}`);
    await client.end().catch(() => {});
    return error.code || 'error';
  }
}

// ---------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------
console.log('AI Income Lab — database connection doctor (read-only, secrets masked)');

const env = new Map();
const duplicateWarnings = [];
for (const path of ENV_FILES) {
  const file = readEnvFile(path);
  if (!file) {
    console.log(`\n${path}: not found`);
    continue;
  }
  let blank = 0;
  for (const value of file.vars.values()) if (!value) blank += 1;
  console.log(`\n${path}: found (${file.vars.size} variable(s) defined, ${blank} blank)`);
  for (const [key, lineNumbers] of file.occurrences) {
    if (lineNumbers.length > 1) {
      const warning = `${key} is defined ${lineNumbers.length} times in ${path} (lines ${lineNumbers.join(', ')}) — dotenv keeps the LAST definition, a first-wins reader sees the other one`;
      duplicateWarnings.push(`${path}: ${warning}`);
    }
  }
  for (const [key, value] of file.vars) {
    if (!env.has(key)) env.set(key, value); // .env.local takes precedence over .env
  }
}

console.log('\nVariables');
console.log('---------');
for (const key of KEYS) {
  const value = env.get(key);
  console.log(`  ${key}: ${value === undefined ? 'MISSING' : value ? 'PRESENT' : 'EMPTY'}`);
}
if (duplicateWarnings.length > 0) {
  console.log('\nDuplicate keys (two different values for one key — a real hazard):');
  for (const warning of duplicateWarnings) console.log(`  - ${warning}`);
}

const secrets = [];
for (const key of ['DATABASE_URL', 'DIRECT_URL']) {
  const raw = env.get(key);
  if (!raw) continue;
  try {
    const parsed = new URL(raw);
    if (parsed.password) secrets.push(parsed.password, safeDecode(parsed.password).value);
  } catch {
    secrets.push(raw);
  }
}
secrets.push(...secrets.filter((s) => s && s.includes('%')).map((s) => encodeURIComponent(s)));

const database = describe('DATABASE_URL (runtime, transaction pooler)', env.get('DATABASE_URL'), secrets);
const direct = describe('DIRECT_URL (Prisma 7 CLI, direct/session)', env.get('DIRECT_URL'), secrets);

console.log('\nCross-check');
console.log('-----------');
if (database && direct) {
  console.log(
    `  DATABASE_URL and DIRECT_URL carry the same password text: ${database.rawPassword === direct.rawPassword ? 'yes' : 'NO'}`,
  );
  console.log(`  ...after percent-decoding: ${database.decoded === direct.decoded ? 'yes' : 'NO'}`);
  if (database.rawPassword !== direct.rawPassword && database.decoded === direct.decoded) {
    console.log('  => one URL is percent-encoded and the other is not; encode both the same way');
  } else if (database.decoded !== direct.decoded) {
    console.log('  => the two URLs carry DIFFERENT credentials; either can be stale, which yields P1000');
  }
  const directOnPooler = /pooler\.supabase\.com$/.test(direct.url.hostname);
  console.log(
    `  DIRECT_URL points at a pooler host: ${directOnPooler ? 'yes (port 6543 rejects the Prisma CLI engine)' : 'no (correct for CLI use)'}`,
  );
} else if (database || direct) {
  console.log('  only one of DATABASE_URL / DIRECT_URL is usable — prisma7.config.ts falls back to the other');
} else {
  console.log('  neither connection string is usable; expect a "datasource.url required" error, not P1000');
}

console.log('\nNetwork reachability (no credentials sent)');
console.log('------------------------------------------');
for (const [label, expected] of Object.entries(EXPECTED)) {
  const dns = await dnsFamilies(expected.host);
  const tcp = await tcpProbe(expected.host, expected.port);
  console.log(`  ${label} ${expected.host}:${expected.port}`);
  console.log(`    DNS: ${dns}`);
  console.log(`    TCP: ${tcp.ok ? 'PASS' : 'FAIL'} — ${tcp.detail}`);
  if (expected.host.endsWith('.supabase.co') && !dns.includes('A (IPv4)')) {
    console.log('    note: the direct host publishes no IPv4 A record — it needs an IPv6-capable network');
  }
}

console.log('\nAuthentication probe (node-postgres, same driver as the app)');
console.log('-------------------------------------------------------------');
const directCode = await pgProbe('DIRECT_URL credentials', direct, secrets);
const poolerCode = await pgProbe('DATABASE_URL credentials', database, secrets);

console.log('\nVerdict');
console.log('-------');
console.log('  SQLSTATE: 28P01 = invalid_password (server rejected it), 3D000 = database does not exist,');
console.log('  28000 = invalid authorization, ENOTFOUND/ETIMEDOUT/ECONNREFUSED = network.');
if (directCode === 'pass' && poolerCode === 'pass') {
  console.log('  both credential sets authenticate — the database accepts the password');
} else if (directCode === '28P01' || poolerCode === '28P01') {
  console.log('  the server itself rejected the password (28P01) — the credential is stale, not the URL shape');
} else if ((directCode && directCode !== 'pass') && (poolerCode === 'pass' || directCode === 'error')) {
  console.log('  exact cause: the direct connection failed while the pooler authenticated — see the codes above');
} else if (directCode === 'pass' || poolerCode === 'pass') {
  console.log('  at least one credential set authenticates — the failing URL is stale or mistyped, not a network fault');
} else if (directCode === null && poolerCode === null) {
  console.log('  skipped — no usable connection string to authenticate with');
} else {
  console.log('  neither credential set authenticated; see the SQLSTATE codes above (network vs auth)');
}
