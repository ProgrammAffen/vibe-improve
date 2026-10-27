'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fileURLToPath } = require('node:url');
const { syncBuiltinESMExports } = require('node:module');

if (process.env.VIBE_CLOUDBASE_PRIVATE_BODY_FD === '3') {
  const body = fs.readFileSync(3, 'utf8');
  JSON.parse(body);
  const index = process.argv.indexOf('__VIBE_PRIVATE_BODY__');
  if (index < 0) throw new Error('Private CLI request body placeholder was not found.');
  process.argv[index] = body;
  delete process.env.VIBE_CLOUDBASE_PRIVATE_BODY_FD;
}

const workspace = process.env.VIBE_CLOUDBASE_WORKSPACE;
const state = process.env.VIBE_CLOUDBASE_STATE_DIR;
if (!workspace || !state || !path.resolve(state).startsWith(path.resolve(workspace) + path.sep)) {
  throw new Error('CloudBase CLI requires a workspace-local state directory.');
}
const realpath = fs.realpathSync.bind(fs);
const workspaceReal = realpath(workspace);
const inside = target => target === workspaceReal || target.startsWith(workspaceReal + path.sep);
function checkWrite(value) {
  if (typeof value === 'number') return;
  const candidate = path.resolve(value instanceof URL ? fileURLToPath(value) : Buffer.isBuffer(value) ? value.toString() : value);
  if (!inside(candidate)) throw new Error('CloudBase CLI blocked a write outside its workspace.');
  let ancestor = candidate;
  while (!fs.existsSync(ancestor)) {
    const next = path.dirname(ancestor);
    if (next === ancestor) break;
    ancestor = next;
  }
  if (!inside(realpath(ancestor))) throw new Error('CloudBase CLI blocked a write through an external symlink.');
}
function wrap(target, key, positions) {
  const original = target[key];
  if (typeof original !== 'function') return;
  target[key] = function (...args) {
    for (const position of positions) checkWrite(args[position]);
    return original.apply(this, args);
  };
}
const onePath = ['writeFile', 'appendFile', 'mkdir', 'mkdtemp', 'rm', 'rmdir', 'unlink', 'truncate', 'chmod', 'chown', 'lchmod', 'lchown', 'utimes', 'lutimes'];
for (const operation of onePath) {
  wrap(fs, operation, [0]);
  wrap(fs, `${operation}Sync`, [0]);
  wrap(fs.promises, operation, [0]);
}
for (const operation of ['rename', 'link', 'symlink']) {
  wrap(fs, operation, [0, 1]);
  wrap(fs, `${operation}Sync`, [0, 1]);
  wrap(fs.promises, operation, [0, 1]);
}
for (const operation of ['copyFile', 'cp']) {
  wrap(fs, operation, [1]);
  wrap(fs, `${operation}Sync`, [1]);
  wrap(fs.promises, operation, [1]);
}
const writeFlag = flag => typeof flag === 'number'
  ? Boolean(flag & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_APPEND))
  : /[wa+]/.test(flag || 'r');
for (const [target, method] of [[fs, 'open'], [fs, 'openSync'], [fs.promises, 'open']]) {
  const original = target[method];
  target[method] = function (...args) {
    if (writeFlag(args[1])) checkWrite(args[0]);
    return original.apply(this, args);
  };
}
wrap(fs, 'createWriteStream', [0]);
const originalUserInfo = os.userInfo.bind(os);
os.homedir = () => path.join(state, 'home');
os.userInfo = options => ({ ...originalUserInfo(options), homedir: path.join(state, 'home') });
os.tmpdir = () => path.join(state, 'temp');
syncBuiltinESMExports();
