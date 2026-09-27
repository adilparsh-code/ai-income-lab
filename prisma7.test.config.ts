import { defineConfig } from '@prisma/prisma7/config';
import { resolve } from 'node:path';

const sqliteUrl = `file:${resolve('prisma/test-template.db').replaceAll('\\', '/')}`;

export default defineConfig({
  schema: 'prisma/schema.test.prisma',
  datasource: { url: sqliteUrl },
});
