import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
async function checkedPath(destination, io) {
  const target = resolve(root, destination);
  const rel = relative(resolve(root, 'tmp'), target);
  if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !target.endsWith('.json')) throw new Error('PRIVATE_JSON_MUST_BE_TMP');
  let cursor = resolve(root);
  for (const part of relative(cursor, dirname(target)).split(sep)) {
    cursor = resolve(cursor, part);
    await io.mkdir(cursor, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const info = await io.lstat(cursor);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('PRIVATE_JSON_UNSAFE_DIRECTORY');
  }
  try {
    const info = await io.lstat(target);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o077)) throw new Error('PRIVATE_JSON_UNSAFE_FILE');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return target;
}
export async function atomicWritePrivateJson(destination, data, io = fs) {
  const serialized = JSON.stringify(data, null, 2) + '\n';
  const target = await checkedPath(destination, io);
  const parent = dirname(target);
  const temporary = resolve(parent, `.${basename(target)}.${randomBytes(16).toString('hex')}.tmp`);
  let file;
  let created = false;
  let renamed = false;
  try {
    file = await io.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    created = true;
    await file.chmod(0o600);
    await file.writeFile(serialized, 'utf8');
    await file.sync();
    await file.close();
    file = undefined;
    await io.rename(temporary, target);
    renamed = true;
    const directory = await io.open(parent, constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } finally {
    if (file) await file.close().catch(() => {});
    if (created && !renamed) await io.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
}
export async function readPrivateJson(destination, io = fs) {
  const target = await checkedPath(destination, io);
  const file = await io.open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await file.stat();
    if (!info.isFile() || (info.mode & 0o077) || info.size > 1024 * 1024) throw new Error('PRIVATE_JSON_UNSAFE_FILE');
    return { data: JSON.parse(await file.readFile('utf8')), destination: target };
  } finally { await file.close(); }
}
