// Run the Prisma 7 SQLite push in a bounded child process. The small heap
// prevents Windows from overcommitting memory while the schema engine starts.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const result = spawnSync(
  'npx',
  ['prisma7', 'db', 'push', '--config', 'prisma7.test.config.ts', '--schema', 'prisma/schema.test.prisma'],
  {
    cwd: root,
    env: {
      ...process.env,
      NODE_OPTIONS: '--max-old-space-size=256',
      RUST_LOG: 'debug',
    },
    stdio: 'inherit',
    shell: true,
  },
);

if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
