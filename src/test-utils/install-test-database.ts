import { copyFileSync } from 'node:fs';
import { join } from 'node:path';

export function installTestDatabase(targetPath: string): void {
  copyFileSync(join(process.cwd(), 'prisma', 'test-template.db'), targetPath);
}
