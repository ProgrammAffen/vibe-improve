#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const state = join(root, 'tmp', 'runtime', 'cloudbase-cli');
const preload = join(root, 'scripts', 'cloudbase-cli-preload.cjs');
const candidates = [
  join(root, 'node_modules', '@cloudbase', 'cli', 'bin', 'tcb'),
  '/usr/local/lib/node_modules/@cloudbase/cli/bin/tcb',
  '/opt/homebrew/lib/node_modules/@cloudbase/cli/bin/tcb',
];
const entry = candidates.find(existsSync);
if (!entry) {
  console.error('未找到 CloudBase CLI。请在本仓库安装锁定版本的 @cloudbase/cli。');
  process.exit(1);
}
if (process.argv[2] === '--diagnose') {
  const source = realpathSync(entry);
  const pkg = JSON.parse(readFileSync(join(dirname(dirname(source)), 'package.json'), 'utf8'));
  console.log(JSON.stringify({ cliVersion: pkg.version, entry: source, stateDirectory: state, environment: 'one-person-company-7dao3979fd72e', credentialsCopied: false }, null, 2));
  process.exit(0);
}
process.umask(0o077);
for (const part of ['home', 'config', 'cache', 'data', 'logs', 'temp', 'npm-cache']) {
  mkdirSync(join(state, part), { recursive: true, mode: 0o700 });
}
const inheritedNodeOptions = process.env.NODE_OPTIONS || '';
const args = process.argv.slice(2);
const privateBody = args[0] === '--private-body-stdin';
let body;
if (privateBody) {
  args.shift();
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 1024 * 1024) throw new Error('Private CLI request is too large.');
    chunks.push(chunk);
  }
  body = Buffer.concat(chunks);
  JSON.parse(body.toString('utf8'));
  if (args.filter(value => value === '__VIBE_PRIVATE_BODY__').length !== 1) throw new Error('Private CLI request requires exactly one body placeholder.');
}
const env = {
  ...process.env,
  VIBE_CLOUDBASE_WORKSPACE: root,
  VIBE_CLOUDBASE_STATE_DIR: state,
  XDG_CONFIG_HOME: join(state, 'home', '.config'),
  XDG_CACHE_HOME: join(state, 'cache'),
  XDG_DATA_HOME: join(state, 'data'),
  XDG_STATE_HOME: join(state, 'logs'),
  CLOUDBASE_LOG_DIR: join(state, 'logs'),
  CLOUDBASE_MCP_TELEMETRY_DISABLED: 'true',
  npm_config_cache: join(state, 'npm-cache'),
  TMPDIR: join(state, 'temp'),
  TMP: join(state, 'temp'),
  TEMP: join(state, 'temp'),
  TCB_NO_BROWSER: 'true',
  NO_UPDATE_NOTIFIER: '1',
  NODE_OPTIONS: `${inheritedNodeOptions} --require=${JSON.stringify(preload)}`.trim(),
  ...(privateBody ? { VIBE_CLOUDBASE_PRIVATE_BODY_FD: '3' } : {}),
};
const child = spawn(process.execPath, [entry, ...args], { cwd: root, env, stdio: privateBody ? ['inherit', 'inherit', 'inherit', 'pipe'] : 'inherit' });
if (privateBody) child.stdio[3].end(body);
child.once('error', error => { console.error(error.message); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.once('exit', (code, signal) => { process.exitCode = code ?? (signal ? 130 : 1); });
