// One-off helper: generate a scrypt hash for the single-admin credential.
//
// Usage:  node scripts/hash-admin-password.mjs            (interactive-free:
//         reads the password from stdin, or prompts via a 12-char random
//         generator if --generate is passed)
//   node scripts/hash-admin-password.mjs --generate
//
// Output format: "scrypt:<saltHex>:<hashHex>" — the exact format expected by
// ADMIN_PASSWORD_HASH in src/lib/agency/admin-auth.ts (verifyScryptHash).
//
// The password itself is NEVER printed, logged, or written to any file. Only
// the hash line goes to stdout. Copy it into your deployment's environment
// (never into a committed file).
import { randomBytes, scryptSync } from 'node:crypto';
import { createInterface } from 'node:readline';

const keyLength = 64;

function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, keyLength);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

async function main() {
  const generate = process.argv.includes('--generate');
  let password;

  if (generate) {
    // Cryptographically strong, unambiguous alphabet; ~95 bits of entropy.
    const alphabet = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const bytes = randomBytes(16);
    password = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('');
    console.error('[hash-admin-password] Generated a random admin password.');
    console.error('[hash-admin-password] Copy it NOW from the next line — it is not shown again:');
    console.error(`PASSWORD: ${password}`);
  } else {
    const rl = createInterface({ input: process.stdin });
    const chunks = [];
    for await (const line of rl) chunks.push(line);
    password = chunks.join('\n').replace(/\r?\n$/, '');
    if (!password) {
      console.error('Usage: node scripts/hash-admin-password.mjs [--generate]');
      console.error('       (pipe the password on stdin, or pass --generate)');
      process.exit(1);
    }
  }

  if (typeof password !== 'string' || password.length < 12) {
    console.error('Refusing to hash: the admin password must be at least 12 characters.');
    process.exit(1);
  }

  process.stdout.write(`\nADMIN_PASSWORD_HASH="${hashPassword(password)}"\n`);
}

main().catch((error) => {
  console.error('hash-admin-password failed:', error instanceof Error ? error.message : String(error));
  process.exit(1);
});
