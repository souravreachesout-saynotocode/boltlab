import { cp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(join(root, 'dist/src/web'), { recursive: true });
await cp(join(root, 'src/web'), join(root, 'dist/src/web'), { recursive: true });
console.log('assets copied -> dist/src/web');
