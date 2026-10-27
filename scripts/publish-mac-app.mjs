import {lstat, mkdir, rename, rm} from 'node:fs/promises';
import {join} from 'node:path';

async function directoryOrMissing(path) {
  try {
    const entry = await lstat(path);
    if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('OUTPUT_PATH_INVALID');
    return true;
  } catch (error) {if (error.code === 'ENOENT') return false; throw error;}
}

export async function publishMacApp(root, stagedBundle) {
  const output = join(root, 'output');
  if (!await directoryOrMissing(output)) await mkdir(output);
  const target = join(output, 'Vibe Improve.app');
  const backup = join(root, 'tmp/build/macos/Vibe Improve.previous.app');
  const hasBackup = await directoryOrMissing(backup);
  if (hasBackup && !await directoryOrMissing(target)) await rename(backup, target);
  if (await directoryOrMissing(backup)) await rm(backup, {recursive: true});
  const hadPrevious = await directoryOrMissing(target);
  if (hadPrevious) await rename(target, backup);
  try {await rename(stagedBundle, target);}
  catch (error) {if (hadPrevious) await rename(backup, target); throw error;}
  if (hadPrevious) await rm(backup, {recursive: true});
  return target;
}
