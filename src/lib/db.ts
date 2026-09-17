import { PrismaClient } from '@prisma/client';
import { PrismaLibSql } from '@prisma/adapter-libsql';
import { resolveDatabaseUrl } from './config';

// A lazy Prisma client.
//
// PrismaClient (and its adapter) must NOT be constructed at module scope:
// production builds collect page data without a runtime environment, and
// constructing eagerly makes `next build` throw when DATABASE_URL is absent
// (build machines legitimately have no DB). resolveDatabaseUrl() still throws
// at actual runtime in production when the variable is missing, preserving the
// original fail-fast behavior where it matters.
let cached: PrismaClient | undefined;

function getClient(): PrismaClient {
  if (!cached) {
    const adapter = new PrismaLibSql({
      url: resolveDatabaseUrl(),
    });
    cached = new PrismaClient({ adapter });
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
