import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export async function privateCloudApi({ service = 'tcb', action, body, region = 'ap-shanghai', version = '2018-06-08' }) {
  const wrapper = fileURLToPath(new URL('./cloudbase-cli.mjs', import.meta.url));
  const args = [wrapper, '--private-body-stdin', 'api', service, action, '--api-version', version, '--body', '__VIBE_PRIVATE_BODY__', '--json', '-r', region];
  return new Promise((resolveCall, reject) => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    let errorOutput = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', data => { errorOutput += data; });
    child.once('error', () => reject(new Error('CLOUDBASE_CLI_START_FAILED')));
    child.once('exit', code => {
      if (code !== 0) {
        const safeCode = /"code"\s*:\s*"([A-Za-z0-9_.-]+)"/.exec(output + errorOutput)?.[1];
        reject(new Error(safeCode ? `CLOUDBASE_${safeCode}` : 'CLOUDBASE_CLI_REQUEST_FAILED'));
        return;
      }
      try {
        const clean = output.replace(/\x1b\[[0-9;]*m/g, '');
        const parsed = JSON.parse(clean.slice(clean.indexOf('{')));
        if (parsed.success === false || (parsed.code && ![0, '0', 'SUCCESS'].includes(parsed.code))) throw new Error('CLOUDBASE_REQUEST_FAILED');
        let result = parsed.data && !parsed.Data && !parsed.EnvList ? parsed.data : parsed;
        if (result.Response) result = result.Response;
        if (result.Error) throw new Error(`CLOUDBASE_${result.Error.Code || 'API_ERROR'}`);
        resolveCall(result);
      } catch { reject(new Error('CLOUDBASE_RESPONSE_FAILED')); }
    });
    child.stdin.end(JSON.stringify(body));
  });
}
function decodeExtended(value) {
  if (Array.isArray(value)) return value.map(decodeExtended);
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length === 1 && ['$numberInt', '$numberLong', '$numberDouble'].includes(keys[0])) {
      const number = Number(value[keys[0]]);
      if (Number.isFinite(number) && (keys[0] === '$numberDouble' || Number.isSafeInteger(number))) return number;
      return value;
    }
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, decodeExtended(nested)]));
  }
  return value;
}
export function unpackCloudData(value) {
  if (typeof value === 'string' && /^\s*[\[{]/.test(value)) {
    try { return unpackCloudData(JSON.parse(value)); } catch { return value; }
  }
  if (Array.isArray(value)) return value.flatMap(item => {
    const unpacked = unpackCloudData(item);
    return Array.isArray(unpacked) ? unpacked : [unpacked];
  });
  return decodeExtended(value);
}
export const workspaceRoot = resolve(root);
