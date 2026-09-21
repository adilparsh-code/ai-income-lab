// CJS interop shim for the generated SQLite test client (prisma/test-client).
// The generated client is CommonJS (`exports.PrismaClient = ...`); a direct
// ESM named import does not always survive bundler/runtime interop, so this
// shim resolves it explicitly. Regenerate with scripts/generate-test-schema.mjs.
import { createRequire } from 'node:module';

type TestClientModule = { PrismaClient: new (options: unknown) => unknown };
const nodeRequire = createRequire(import.meta.url);
const { PrismaClient } = nodeRequire('./test-client') as TestClientModule;

export const SqliteClient = PrismaClient;
export type SqliteClientInstance = InstanceType<typeof SqliteClient>;
