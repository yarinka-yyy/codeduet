import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packageFiles } from './package.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const destination = join(root, 'plugin', 'skills', 'code-duet');
mkdirSync(destination, { recursive: true });
const extra = readdirSync(destination, { recursive: true, withFileTypes: true })
  .filter(item => item.isFile())
  .map(item => relative(destination, join(item.parentPath, item.name)).replaceAll('\\', '/'))
  .filter(file => !packageFiles.includes(file));
if (extra.length) throw new Error('Unexpected plugin package files: ' + extra.join(', '));
for (const file of packageFiles) {
  const source = join(root, file), target = join(destination, file);
  if (!existsSync(source)) throw new Error('Missing source file: ' + file);
  mkdirSync(dirname(target), { recursive: true });
  if (!existsSync(target) || !readFileSync(source).equals(readFileSync(target))) copyFileSync(source, target);
}
console.log(JSON.stringify({ kind: 'plugin-built', files: packageFiles.length, destination }));
