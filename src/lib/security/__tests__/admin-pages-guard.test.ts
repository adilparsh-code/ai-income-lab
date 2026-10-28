// Static regression test (audit finding N1): the (admin) layout is not an
// authorization boundary, so EVERY server-rendered admin page must call
// requireAdminPageAccess() itself. This fails if a new page forgets it.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(process.cwd(), 'src', 'app', '(admin)');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (name === 'page.tsx') out.push(full);
  }
  return out;
}

describe('admin pages enforce authorization themselves', () => {
  const pages = walk(ROOT);

  it('finds the admin pages', () => assert.ok(pages.length >= 20));

  for (const file of pages) {
    const source = readFileSync(file, 'utf8');
    const isClient = /^\s*(['"])use client\1/.test(source.split('\n').slice(0, 5).join('\n'));
    if (isClient) continue; // client pages hold no server data; they call guarded /api routes
    it(`${file.slice(ROOT.length)} calls requireAdminPageAccess before any data access`, () => {
      const guardAt = source.indexOf('await requireAdminPageAccess(');
      assert.ok(guardAt >= 0, 'missing requireAdminPageAccess()');
      const firstAwaitOrData = source.search(/await (?!requireAdminPageAccess)/);
      assert.ok(firstAwaitOrData === -1 || guardAt < firstAwaitOrData, 'guard must precede every other await');
    });
  }

  it('the layout no longer claims to be an authorization boundary', () => {
    const layout = readFileSync(join(ROOT, 'layout.tsx'), 'utf8');
    assert.match(layout, /UX ONLY/);
  });
});
