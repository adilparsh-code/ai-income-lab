// Verifies the application's real DB layer (src/lib/db.ts lazy proxy +
// adapter selection + config resolution) against the live database with a
// read-only query. Credentials are loaded from .env.local and never printed.
import { readFileSync } from 'node:fs';

const line = readFileSync('.env.local', 'utf8')
  .split(/\r?\n/)
  .find((l) => l.startsWith('DATABASE_URL='));
if (line) process.env.DATABASE_URL = line.slice('DATABASE_URL='.length).trim().replace(/^["']|["']$/g, '');

const { db } = await import('../src/lib/db');

const [opportunities, products, events] = await Promise.all([
  db.opportunity.count(),
  db.product.count(),
  db.productEvent.count(),
]);
console.log(`App DB layer (via PrismaClient proxy): opportunities=${opportunities} products=${products} productEvents=${events}`);
console.log('DB LAYER: PASS');
process.exit(0);
