import fs from 'node:fs/promises';
import {constants} from 'node:fs';
import {randomBytes} from 'node:crypto';
import {dirname, join, relative, resolve, sep} from 'node:path';

export class MacRuntimeMigrationError extends Error {
  constructor(code) {super(code); this.code = code;}
}
const fail = code => {throw new MacRuntimeMigrationError(code);};
const owned = info => typeof process.getuid !== 'function' || info.uid === process.getuid();
async function directory(path, io) {
  try {
    const info = await io.lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink() || !owned(info)) fail('MAC_RUNTIME_UNSAFE_DIRECTORY');
    return info;
  } catch (error) {if (error.code === 'ENOENT') return null; throw error;}
}
async function checkedDirectory(root, path, io) {
  let cursor = root;
  if (!await directory(cursor, io)) return null;
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    cursor = join(cursor, part);
    if (!await directory(cursor, io)) return null;
  }
  return directory(path, io);
}
async function readAllowed(path, maximumBytes, io) {
  let before;
  try {before = await io.lstat(path);} catch (error) {if (error.code === 'ENOENT') return null; throw error;}
  const safe = info => info.isFile() && !info.isSymbolicLink() && owned(info) && info.nlink === 1 && info.size > 0 && info.size <= maximumBytes;
  if (!safe(before)) fail('MAC_RUNTIME_UNSAFE_FILE');
  const file = await io.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await file.stat();
    if (!safe(opened) || opened.ino !== before.ino || opened.dev !== before.dev) fail('MAC_RUNTIME_UNSAFE_FILE');
    const bytes = await file.readFile(), after = await file.stat(), named = await io.lstat(path);
    if (!safe(after) || !safe(named) || named.ino !== opened.ino || named.dev !== opened.dev ||
        bytes.length > maximumBytes || bytes.length !== opened.size || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) fail('MAC_RUNTIME_SOURCE_CHANGED');
    return bytes;
  } finally {await file.close();}
}
async function sourceFiles(root, source, io) {
  if (!await checkedDirectory(root, source, io)) return null;
  const files = new Map();
  for (const [name, maximum] of [['preferences.json', 65_536], ['device.json', 4096]]) {
    const bytes = await readAllowed(join(source, name), maximum, io);
    if (bytes) files.set(name, bytes);
  }
  const auth = join(source, 'auth');
  if (await directory(auth, io)) {
    const session = await readAllowed(join(auth, 'session.json'), 60_000, io);
    const key = await readAllowed(join(auth, 'session.key'), 32, io);
    if (!!session !== !!key) fail('MAC_RUNTIME_SESSION_INCOMPLETE');
    if (session && key) {
      if (key.length !== 32) fail('MAC_RUNTIME_SESSION_INVALID');
      if (!files.size) fail('MAC_RUNTIME_IDENTITY_MISSING');
      files.set('auth/session.json', session); files.set('auth/session.key', key);
    }
  }
  return files.size ? files : null;
}
async function syncDirectory(path, io) {
  const handle = await io.open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {await handle.sync();} finally {await handle.close();}
}

export async function migrateMacRuntime(root, {io = fs} = {}) {
  root = resolve(root);
  const output = join(root, 'output'), destination = join(output, 'Vibe Improve Runtime');
  if (await checkedDirectory(root, output, io) && await directory(destination, io)) return {status: 'preserved', destination};
  const candidates = ['tmp/build/Vibe Improve Runtime', 'tmp/build/macos/Vibe Improve Runtime', 'tmp/build/runtime'];
  let source, files;
  for (const candidate of candidates) {
    const path = join(root, candidate), found = await sourceFiles(root, path, io);
    if (found) {source = path; files = found; break;}
  }
  if (!source) return {status: 'not-needed', destination};
  await io.mkdir(output, {mode: 0o700}).catch(error => {if (error.code !== 'EEXIST') throw error;});
  await checkedDirectory(root, output, io);
  if (await directory(destination, io)) return {status: 'preserved', destination};
  const stage = join(output, `.runtime-migrate-${randomBytes(16).toString('hex')}`);
  await io.mkdir(stage, {mode: 0o700});
  let reservation, published = false;
  try {
    for (const [name, bytes] of files) {
      const path = join(stage, name), parent = dirname(path);
      if (parent !== stage) await io.mkdir(parent, {mode: 0o700}).catch(error => {if (error.code !== 'EEXIST') throw error;});
      const file = await io.open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try {await file.chmod(0o600); await file.writeFile(bytes); await file.sync();} finally {await file.close();}
    }
    if (files.has('auth/session.json')) await syncDirectory(join(stage, 'auth'), io);
    await syncDirectory(stage, io);
    try {await io.mkdir(destination, {mode: 0o700}); reservation = await directory(destination, io);}
    catch (error) {if (error.code === 'EEXIST') {await directory(destination, io); return {status: 'preserved', destination};} throw error;}
    const current = await directory(destination, io);
    if (!current || current.ino !== reservation.ino || current.dev !== reservation.dev) fail('MAC_RUNTIME_TARGET_CHANGED');
    await io.rename(stage, destination);
    published = true;
    await syncDirectory(output, io);
    return {status: 'migrated', source, destination, files: [...files.keys()]};
  } finally {
    await io.rm(stage, {recursive: true, force: true});
    if (reservation && !published) {
      const current = await directory(destination, io);
      if (current && current.ino === reservation.ino && current.dev === reservation.dev) {
        await io.rmdir(destination).catch(error => {if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes(error.code)) throw error;});
      }
    }
  }
}
