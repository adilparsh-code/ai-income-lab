import { PrismaClient } from '@prisma/client';
import { PrismaLibSql } from '@prisma/adapter-libsql';
import { resolveDatabaseUrl } from './config';

// resolveDatabaseUrl() throws in production if DATABASE_URL is not configured,
// preventing a silent fall-back to a non-persistent local file.
const adapter = new PrismaLibSql({
  url: resolveDatabaseUrl(),
});

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

export const db = globalForPrisma.prisma ?? new PrismaClient({ adapter });

if (process.env.NODE_ENV !== 'production') globalForPrisma.prisma = db;
