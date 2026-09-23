import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRufloMcpClient, RUFLO_ALLOWED_TOOLS } from '../runtime-client';

describe('Ruflo HTTP/MCP runtime client', () => {
  it('exposes only the allowlisted runtime tools', () => {
    assert.ok(RUFLO_ALLOWED_TOOLS.includes('tasks/create'));
    assert.ok(RUFLO_ALLOWED_TOOLS.includes('swarm/init'));
    assert.equal((RUFLO_ALLOWED_TOOLS as readonly string[]).includes('terminal/execute'), false);
  });

  it('rejects non-http runtime URLs', () => {
    assert.throws(
      () => createRufloMcpClient({ baseUrl: 'file:///tmp/ruflo' }),
      /HTTP or HTTPS/,
    );
  });

  it('normalizes and accepts an HTTPS runtime URL', () => {
    const client = createRufloMcpClient({
      baseUrl: 'https://ruflo.internal/',
      timeoutMs: 60_000,
    });
    assert.ok(client);
  });
});
