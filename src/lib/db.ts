import type { PrismaClient } from '@prisma/client';
import { resolveDatabaseUrl } from './config';

// A lazy Prisma client.
//
// PrismaClient (and its adapter) must NOT be constructed at module scope:
// production builds collect page data without a runtime environment, and
// constructing eagerly makes `next build` throw when DATABASE_URL is absent
// (build machines legitimately have no DB). resolveDatabaseUrl() still throws
// at actual runtime in production when the variable is missing, preserving the
// original fail-fast behavior where it matters.
//
// Dialect selection: the SQL dialect is baked into the generated client by the
// schema provider, so ONE client class cannot serve both databases.
// - `postgres…` URL (Supabase transaction pooler in production) → the main
//   PostgreSQL client via the official `@prisma/adapter-pg` driver adapter.
// - `file:` URL → the SQLite test client (generated from
//   prisma/schema.test.prisma by scripts/generate-test-schema.mjs, run by the
//   `pretest` script) via `@prisma/adapter-libsql`. This keeps the test suite
//   hermetic (temporary local file databases). The file branch can never run
//   in production: resolveDatabaseUrl() throws there when DATABASE_URL is unset.
// Both clients expose the identical model API, so `db.<model>.<op>()` callers
// are unchanged.
//
// Some client components transitively import this module, so the browser
// bundle must stay free of Node-only code (fs/net from `pg`). The Node
// `require` used to load the driver packages is therefore resolved through
// `process.getBuiltinModule('module')` — synchronous, and invisible to
// bundlers (no `node:module` import request enters the client graph). It is
// only ever invoked from the server-side branches below; browsers never call
// the lazy proxy's initializers, so the browser bundle carries only this
// small module.
type NodeRequire = (id: string) => Record<string, unknown>;

let nodeRequire: NodeRequire | undefined;

function getRequireFn(): NodeRequire {
  if (nodeRequire) return nodeRequire;
  const getBuiltinModule = (
    process as unknown as { getBuiltinModule?: (id: string) => unknown }
  ).getBuiltinModule;
  if (typeof getBuiltinModule !== 'function') {
    throw new Error('Database driver is unavailable: this code must run in Node.js.');
  }
  const nodeModule = getBuiltinModule.call(process, 'module') as {
    createRequire: (filename: string) => NodeRequire;
  };
  nodeRequire = nodeModule.createRequire(import.meta.url);
  return nodeRequire;
}

type PrismaCtor = new (options: { adapter: unknown }) => PrismaClient;

let cached: PrismaClient | undefined;

function getClient(): PrismaClient {
  if (!cached) {
    const url = resolveDatabaseUrl();
    const requireFn = getRequireFn();
    if (!requireFn) {
      throw new Error('Database driver is not initialized yet. Retry the request.');
    }
    if (url.startsWith('file:')) {
      const { PrismaLibSql } = requireFn('@prisma/adapter-libsql') as unknown as {
        PrismaLibSql: new (options: { url: string }) => unknown;
      };
      const { PrismaClient: SqliteClient } = requireFn('../../prisma/test-client') as unknown as {
        PrismaClient: PrismaCtor;
      };
      const adapter = new PrismaLibSql({ url });
      cached = new SqliteClient({ adapter });
    } else {
      const { PrismaPg } = requireFn('@prisma/adapter-pg') as unknown as {
        PrismaPg: new (options: { connectionString: string }) => unknown;
      };
      const { PrismaClient: PgClient } = requireFn('@prisma/client') as unknown as {
        PrismaClient: PrismaCtor;
      };
      const adapter = new PrismaPg({ connectionString: url });
      cached = new PgClient({ adapter });
    }
    if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = cached;
  }
  return cached;
}

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

// `db` is used as `db.<model>.<operation>()` everywhere; a getter-based proxy
// preserves that API exactly while deferring construction to first use.
export const db = new Proxy({} as PrismaClient, {
  get(_target, prop, receiver) {
    const client = getClient();
    const value = Reflect.get(client as object, prop, receiver);
    return typeof value === 'function' ? value.bind(client) : value;
  },
});
