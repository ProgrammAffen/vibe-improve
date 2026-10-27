import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';

test('native device identity survives restart, preference changes and a copied runtime without accepting corrupt or redirected identity', {skip:process.platform!=='darwin',timeout:60_000},async()=>{
  const root=fileURLToPath(new URL('../',import.meta.url));
  const base=join(root,'tmp/checks/device-identity');await mkdir(base,{recursive:true});
  const dir=await mkdtemp(join(base,'case-')),main=join(dir,'main.swift'),binary=join(dir,'device-test');
  await writeFile(main,`import Foundation
import Darwin
let base=URL(fileURLWithPath:CommandLine.arguments[1],isDirectory:true)
let legacy="dev_0123456789abcdef0123456789abcdef"
let migrated=try RuntimeDirectory(url:base.appendingPathComponent("migrated"))
let first=try DeviceIdentity.load(from:migrated,legacyDeviceID:legacy)
precondition(first==legacy)
let before=try migrated.read("device.json",maximumBytes:4096)!
try migrated.write("preferences.json",data:Data("{}".utf8))
let restored=try DeviceIdentity.load(from:migrated,legacyDeviceID:"dev_ffffffffffffffffffffffffffffffff")
precondition(restored==first)
precondition(try migrated.read("device.json",maximumBytes:4096)==before)
let copy=try RuntimeDirectory(url:base.appendingPathComponent("copied"))
try copy.write("device.json",data:before)
precondition(try DeviceIdentity.load(from:copy,legacyDeviceID:nil)==first)
let fresh=try RuntimeDirectory(url:base.appendingPathComponent("fresh"))
let newID=try DeviceIdentity.load(from:fresh,legacyDeviceID:nil)
precondition(newID.range(of:"^dev_[a-f0-9]{48}$",options:.regularExpression) != nil && newID != first)
let path=fresh.url.appendingPathComponent("device.json").path
var attrs=stat();precondition(lstat(path,&attrs)==0 && attrs.st_mode & 0o777 == 0o600)
try fresh.write("device.json",data:Data("{broken".utf8))
do { _=try DeviceIdentity.load(from:fresh,legacyDeviceID:nil);fatalError("corrupt identity replaced") } catch {}
precondition(try fresh.read("device.json",maximumBytes:4096)==Data("{broken".utf8))
let redirected=try RuntimeDirectory(url:base.appendingPathComponent("redirected"))
precondition(symlink(path,redirected.url.appendingPathComponent("device.json").path)==0)
do { _=try DeviceIdentity.load(from:redirected,legacyDeviceID:nil);fatalError("symlink accepted") } catch {}
print("device identity assertions passed")
`);
  // Swift precondition autoclosures cannot throw.
  let source=await import('node:fs/promises').then(fs=>fs.readFile(main,'utf8'));
  source=source.replace('precondition(try migrated.read("device.json",maximumBytes:4096)==before)','let after=try migrated.read("device.json",maximumBytes:4096);precondition(after==before)').replace('precondition(try DeviceIdentity.load(from:copy,legacyDeviceID:nil)==first)','let copied=try DeviceIdentity.load(from:copy,legacyDeviceID:nil);precondition(copied==first)').replace('precondition(try fresh.read("device.json",maximumBytes:4096)==Data("{broken".utf8))','let corrupt=try fresh.read("device.json",maximumBytes:4096);precondition(corrupt==Data("{broken".utf8))');
  await writeFile(main,source);
  const env={...process.env,CLANG_MODULE_CACHE_PATH:join(root,'tmp/cache/clang'),SWIFT_MODULECACHE_PATH:join(root,'tmp/cache/swift')};
  const compiled=spawnSync('/usr/bin/swiftc',['-module-cache-path',join(root,'tmp/cache/swift'),join(root,'apps/macos/RuntimeDirectory.swift'),join(root,'apps/macos/DeviceIdentity.swift'),main,'-o',binary],{cwd:root,env,encoding:'utf8'});
  assert.equal(compiled.status,0,compiled.stderr);
  const result=spawnSync(binary,[dir],{cwd:root,env,encoding:'utf8'});assert.equal(result.status,0,result.stderr);
});
