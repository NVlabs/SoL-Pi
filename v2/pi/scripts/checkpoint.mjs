import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const history = readFileSync(new URL('../HISTORY.md', import.meta.url), 'utf8');
export const checkpoints = [...history.matchAll(/checkpoint is `experiments\/([^`]+)`/g)].map(m => m[1]);
export function hasCheckpoint(folder, ref = 'solpi-v2-evaluated') {
  try { execFileSync('git', ['cat-file', '-e', `${ref}:experiments/${folder}/extension.js`], { cwd: new URL('../../../', import.meta.url), stdio: 'ignore' }); return true; }
  catch { return false; }
}
export async function checkpoint(temp, folder, ref = 'solpi-v2-evaluated') {
  const tree = `${ref}:experiments/${folder}`, dest = join(temp, ref, folder);
  const git = (...args) => execFileSync('git', args, { cwd: new URL('../../../', import.meta.url) });
  mkdirSync(join(dest, 'lib'), { recursive: true });
  for (const file of ['extension.js', 'package.json', ...git('ls-tree', '-r', '--name-only', tree, 'lib').toString().trim().split('\n')])
    writeFileSync(join(dest, file), git('show', `${tree}/${file}`));
  return import(pathToFileURL(join(dest, 'extension.js')).href);
}
