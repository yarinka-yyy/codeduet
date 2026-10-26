import { copyFileSync, existsSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const packageFiles = Object.freeze([
  'SKILL.md', 'agents/openai.yaml',
  'helper/cli.mjs', 'helper/connection.mjs', 'helper/binding.mjs',
  'helper/interaction.mjs', 'helper/PROTOCOL.md',
  'references/workflow.md', 'references/assignment-template.md',
  'references/plan-template.md', 'references/runtime.md', 'references/existing-session.md', 'tools/package.mjs',
]);
const root = realpathSync(fileURLToPath(new URL('../', import.meta.url)));

export function packageSkill(destination) {
  if (!destination || !isAbsolute(destination) || basename(destination) !== 'code-duet')
    throw new Error('Use an absolute new destination folder named code-duet');
  if (existsSync(destination)) throw new Error('Destination exists; refusing overwrite');
  const parent = realpathSync(dirname(destination));
  const rel = relative(root, parent);
  if (rel === '' || !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep))
    throw new Error('Destination must be outside the source package');
  for (const file of packageFiles) {
    if (!lstatSync(join(root, file)).isFile()) throw new Error('Missing or nonregular package file: ' + file);
  }
  mkdirSync(destination);
  for (const file of packageFiles) {
    mkdirSync(dirname(join(destination, file)), { recursive: true });
    copyFileSync(join(root, file), join(destination, file));
  }
  return { kind: 'packaged', destination: realpathSync(destination), files: packageFiles.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node tools/package.mjs <absolute-new-code-duet-folder>');
    console.log(JSON.stringify(packageSkill(process.argv[2])));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
