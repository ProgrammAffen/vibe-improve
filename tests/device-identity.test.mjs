import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';

const root=fileURLToPath(new URL('../',import.meta.url));
const env={...process.env,CLANG_MODULE_CACHE_PATH:join(root,'tmp/cache/clang'),SWIFT_MODULECACHE_PATH:join(root,'tmp/cache/swift')};
test('hardware identity survives rebuilds, path and preference changes but rejects a copied identity from another Mac', {skip:process.platform!=='darwin',timeout:90_000},async()=>{
  const base=join(root,'tmp/checks/device-identity');await mkdir(base,{recursive:true});
  const dir=await mkdtemp(join(base,'case-')),main=join(dir,'main.swift'),binary=join(dir,'device-test');
  await writeFile(main,`import Foundation
import Darwin
let base=URL(fileURLWithPath:CommandLine.arguments[1],isDirectory:true)
let hardwareA="12345678-1234-5678-ABCD-1234567890AB"
let hardwareB="87654321-4321-8765-DCBA-BA0987654321"
let idA=try DeviceIdentity.current(hardwareUUID:{hardwareA})
let idB=try DeviceIdentity.current(hardwareUUID:{hardwareB})
precondition(DeviceIdentity.hardwareBound(idA) && idA != idB)
let normalized=try DeviceIdentity.current(hardwareUUID:{"  " + hardwareA.lowercased() + "  "})
precondition(normalized==idA)
let migrated=try RuntimeDirectory(url:base.appendingPathComponent("migrated"))
let legacy="dev_0123456789abcdef0123456789abcdef"
let old:[String:Any]=["version":1,"device_id":legacy,"created_at":"2026-10-20T00:00:00Z"]
try migrated.write("device.json",data:JSONSerialization.data(withJSONObject:old))
let first=try DeviceIdentity.load(from:migrated,hardwareUUID:{hardwareA})
precondition(first==idA && first != legacy)
let before=try migrated.read("device.json",maximumBytes:4096)!
precondition(!String(decoding:before,as:UTF8.self).contains(hardwareA))
try migrated.write("preferences.json",data:Data("{}".utf8))
let restored=try DeviceIdentity.load(from:migrated,hardwareUUID:{hardwareA})
let after=try migrated.read("device.json",maximumBytes:4096)
precondition(restored==idA && after==before)
let copy=try RuntimeDirectory(url:base.appendingPathComponent("copied"))
try copy.write("device.json",data:before)
let copied=try DeviceIdentity.load(from:copy,hardwareUUID:{hardwareB})
precondition(copied==idB && copied != first)
let sourceAfter=try migrated.read("device.json",maximumBytes:4096)
precondition(sourceAfter==before)
let fresh=try RuntimeDirectory(url:base.appendingPathComponent("fresh"))
let reinstalled=try DeviceIdentity.load(from:fresh,hardwareUUID:{hardwareA})
precondition(reinstalled==idA)
try fresh.remove("device.json")
let regenerated=try DeviceIdentity.load(from:fresh,hardwareUUID:{hardwareA})
precondition(regenerated==idA)
let path=fresh.url.appendingPathComponent("device.json").path
var attrs=stat();precondition(lstat(path,&attrs)==0 && attrs.st_mode & 0o777 == 0o600)
for value in ["", "not-uuid", "00000000-0000-0000-0000-000000000000", "FFFFFFFF-FFFF-FFFF-FFFF-FFFFFFFFFFFF"] {
    do { _=try DeviceIdentity.current(hardwareUUID:{value});fatalError("invalid hardware accepted") } catch DeviceIdentityError.hardwareUnavailable {}
}
do { _=try DeviceIdentity.load(from:fresh,hardwareUUID:{throw DeviceIdentityError.hardwareUnavailable});fatalError("cached or random fallback") } catch DeviceIdentityError.hardwareUnavailable {}
let unchanged=try fresh.read("device.json",maximumBytes:4096)
precondition(unchanged != nil)
try fresh.write("device.json",data:Data("{broken".utf8))
do { _=try DeviceIdentity.load(from:fresh,hardwareUUID:{hardwareA});fatalError("corrupt identity replaced") } catch {}
let corrupt=try fresh.read("device.json",maximumBytes:4096)
precondition(corrupt==Data("{broken".utf8))
let redirected=try RuntimeDirectory(url:base.appendingPathComponent("redirected"))
precondition(symlink(path,redirected.url.appendingPathComponent("device.json").path)==0)
do { _=try DeviceIdentity.load(from:redirected,hardwareUUID:{hardwareA});fatalError("symlink accepted") } catch {}
let live=try DeviceIdentity.current()
let liveAgain=try DeviceIdentity.current()
precondition(DeviceIdentity.hardwareBound(live) && live==liveAgain)
print("hardware identity assertions passed; live provider stable; no identifier output")
`);
  const compiled=spawnSync('/usr/bin/swiftc',['-module-cache-path',join(root,'tmp/cache/swift'),'-framework','IOKit',join(root,'apps/macos/RuntimeDirectory.swift'),join(root,'apps/macos/DeviceIdentity.swift'),main,'-o',binary],{cwd:root,env,encoding:'utf8'});
  assert.equal(compiled.status,0,compiled.stderr);
  const result=spawnSync(binary,[dir],{cwd:root,env,encoding:'utf8'});assert.equal(result.status,0,result.stderr);
});
