// Pure tests for per-section dashboard loading (no database).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifySectionFailure, loadDashboardSection } from '@/lib/ops/dashboard-section';

function prismaError(code: string): Error {
  return Object.assign(new Error(`prisma ${code}`), { code });
}

describe('classifySectionFailure', () => {
  it('classifies missing column/table as SCHEMA_OUT_OF_DATE', () => {
    assert.equal(classifySectionFailure(prismaError('P2022')), 'SCHEMA_OUT_OF_DATE');
    assert.equal(classifySectionFailure(prismaError('P2021')), 'SCHEMA_OUT_OF_DATE');
  });

  it('classifies everything else as LOAD_FAILED', () => {
    assert.equal(classifySectionFailure(prismaError('P1001')), 'LOAD_FAILED');
    assert.equal(classifySectionFailure(new Error('boom')), 'LOAD_FAILED');
    assert.equal(classifySectionFailure('string error'), 'LOAD_FAILED');
    assert.equal(classifySectionFailure(null), 'LOAD_FAILED');
  });
});

describe('loadDashboardSection', () => {
  it('returns data when the loader succeeds', async () => {
    const result = await loadDashboardSection('Test', async () => [1, 2, 3]);
    assert.deepEqual(result, { ok: true, data: [1, 2, 3] });
  });

  it('isolates a failing loader as an explicit failure instead of throwing', async () => {
    const originalError = console.error;
    const lines: string[] = [];
    console.error = (line: string) => lines.push(line);
    try {
      const result = await loadDashboardSection('Stats', async () => {
        throw prismaError('P2022');
      });
      assert.deepEqual(result, { ok: false, reason: 'SCHEMA_OUT_OF_DATE' });
      assert.equal(lines.length, 1);
      assert.match(lines[0], /Dashboard section "Stats" failed to load/);
      assert.match(lines[0], /P2022/);
    } finally {
      console.error = originalError;
    }
  });

  it('redacts credentials from logged failures', async () => {
    const originalError = console.error;
    const lines: string[] = [];
    console.error = (line: string) => lines.push(line);
    try {
      await loadDashboardSection('Stats', async () => {
        throw new Error('connect failed postgresql://user:hunter2secret@db.example:5432/app');
      });
      assert.equal(lines.length, 1);
      assert.doesNotMatch(lines[0], /hunter2secret/);
    } finally {
      console.error = originalError;
    }
  });

  it('rethrows Next.js control-flow errors (redirect/notFound)', async () => {
    const { redirect } = await import('next/navigation');
    await assert.rejects(() =>
      loadDashboardSection('Stats', async () => {
        redirect('/login');
      }),
    );
  });
});
