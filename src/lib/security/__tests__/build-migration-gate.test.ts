// Migrations must never run implicitly on preview/dev builds, and migration
// 0013 must stay additive (release-safety invariants, pure).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = process.cwd();

describe('build-time migration gate', () => {
  const vercel = JSON.parse(readFileSync(join(root, 'vercel.json'), 'utf8')) as { buildCommand?: string };
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { scripts: Record<string, string> };

  it('vercel.json runs migrate deploy ONLY when VERCEL_ENV is production', () => {
    const cmd = vercel.buildCommand ?? '';
    const idx = cmd.indexOf('migrate deploy');
    assert.ok(idx > 0, 'expected an explicit migrate step');
    const before = cmd.slice(0, idx);
    assert.match(before, /if \[ "\$VERCEL_ENV" = "production" \]; then\s+\S*\s*$/, 'migrate deploy must sit inside the production-only branch');
    assert.match(cmd, /else echo "Skipping migrate deploy/);
  });

  it('no npm lifecycle script (build/prebuild/postinstall/start/dev) runs a migration', () => {
    for (const name of ['build', 'prebuild', 'postbuild', 'postinstall', 'preinstall', 'start', 'dev']) {
      assert.ok(!/migrate\s+(deploy|dev|reset)|db push/.test(pkg.scripts[name] ?? ''), `script ${name} must not migrate`);
    }
  });

  it('migration 0013 is additive only (no DROP/ALTER/RENAME/DELETE/TRUNCATE)', () => {
    const dir = readdirSync(join(root, 'prisma', 'migrations')).find((d) => d.startsWith('0013_'));
    assert.ok(dir);
    const sql = readFileSync(join(root, 'prisma', 'migrations', dir!, 'migration.sql'), 'utf8')
      .split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
    assert.ok(!/\b(DROP|ALTER|RENAME|DELETE|TRUNCATE|UPDATE)\b/i.test(sql));
    assert.match(sql, /CREATE TABLE "ApprovalGrant"/);
    assert.match(sql, /CREATE UNIQUE INDEX "ApprovalGrant_tokenHash_key"/);
    assert.match(sql, /CREATE TABLE "HalalReview"/);
  });
});
