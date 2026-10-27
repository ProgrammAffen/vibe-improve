import {spawn} from 'node:child_process';
import {cp, mkdir, readFile, writeFile, chmod} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const config = JSON.parse(await readFile(join(root, 'cloud/cloudbase.json'), 'utf8'));
const mode = process.argv[2];
if (mode !== 'function') throw new Error('CLOUDBASE_BACKEND_ONLY: use function; frontend hosting is disabled.');
const logDir = join(root,'tmp/checks/2026-10-18-app/deployment');
await mkdir(logDir, {recursive: true, mode: 0o700});
function run(command, args, secrets = []) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {cwd: root, env: {...process.env, npm_config_cache: join(root, 'tmp/cache/npm')}, stdio: ['ignore','pipe','pipe']});
    let output = '';
    child.stdout.on('data', bytes => {output += bytes;});
    child.stderr.on('data', bytes => {output += bytes;});
    child.on('error', reject);
    child.on('close', async code => {
      for (const secret of secrets) if (secret) output = output.split(secret).join('[REDACTED]');
      output = output.replace(/-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/g,'[REDACTED PRIVATE KEY]');
      await writeFile(join(logDir, `${mode}.log`), output, {mode:0o600});
      if (code === 0) {console.log(`${mode} deployment completed.`); resolveResult(output);}
      else {console.error(output.slice(-4000)); reject(new Error(`${mode} deployment failed (${code}).`));}
    });
  });
}
if (mode === 'function') {
  const destination = join(root, 'tmp/build/cloud-functions/license-api');
  await mkdir(destination, {recursive: true});
  for (const name of ['index.js','service.mjs','activation-code-v2.mjs','cloud-auth.mjs','cloud-repository.mjs','diagnostics.mjs','diagnostic-contract.mjs','package.json','package-lock.json']) await cp(join(root,'cloud/functions/license-api',name),join(destination,name));
  await run('npm', ['ci','--prefix',destination,'--omit=dev','--no-audit','--no-fund']);
  const privateKey = await readFile(join(root,'tmp/private/license-signing-key.pem'),'utf8');
  const activationTrust = JSON.parse(await readFile(join(root,'cloud/public-activation-key.json'),'utf8'));
  if (activationTrust.productId !== config.license.productId || activationTrust.algorithm !== 'Ed25519') throw new Error('ACTIVATION_TRUST_INVALID');
  const manifest = {
    envId:config.envId, region:config.region, functionRoot:'tmp/build/cloud-functions',
    functions:[{
      name:config.functionName, runtime:config.runtime, handler:config.handler, timeout:20, memorySize:256,
      description:'Vibe Improve authenticated license and device service',
      envVariables:{CLOUDBASE_ENV_ID:config.envId,LICENSE_PRODUCT_ID:config.license.productId,LICENSE_ISSUER:config.license.issuer,LICENSE_AUDIENCE:config.license.audience,LICENSE_SIGNING_KEY_ID:config.license.keyId,LICENSE_SIGNING_PRIVATE_KEY_PEM:privateKey,LICENSE_LEASE_SECONDS:String(config.license.leaseSeconds),LICENSE_OFFLINE_GRACE_SECONDS:String(config.license.offlineGraceSeconds),LICENSE_MAX_DEVICES:String(config.license.maxDevices),LICENSE_ACTIVATION_PUBLIC_KEY_PEM:activationTrust.publicKeyPem}
    }]
  };
  await mkdir(join(root,'tmp/private/deploy'), {recursive:true,mode:0o700});
  const manifestPath = join(root,'tmp/private/deploy/cloudbaserc.json');
  await writeFile(manifestPath,JSON.stringify(manifest,null,2),{mode:0o600}); await chmod(manifestPath,0o600);
  await run(process.execPath,[join(root,'scripts/cloudbase-cli.mjs'),'--config-file',manifestPath,'fn','deploy',config.functionName,'--runtime',config.runtime,'--force','--json','-e',config.envId],[privateKey,JSON.stringify(privateKey).slice(1,-1)]);
}
await writeFile(join(logDir, `${mode}-release.json`), JSON.stringify({provider:'cloudbase',role:'backend-only',mode,envId:config.envId,completedAt:new Date().toISOString()},null,2)+'\n');
