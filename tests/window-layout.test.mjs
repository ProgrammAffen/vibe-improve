import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';

test('initial content matches the video ratio and fits the work area including window decorations', {skip:process.platform!=='darwin',timeout:60_000},async()=>{
  const root=fileURLToPath(new URL('../',import.meta.url)),base=join(root,'tmp/checks/window-layout');await mkdir(base,{recursive:true});
  const dir=await mkdtemp(join(base,'run-')),main=join(dir,'main.swift'),binary=join(dir,'window-layout-test');
  await writeFile(main,`import Foundation
for available in [CGSize(width: 2560, height: 1440), CGSize(width: 1920, height: 1080), CGSize(width: 1440, height: 900), CGSize(width: 1280, height: 720), CGSize(width: 1024, height: 640), CGSize(width: 800, height: 600)] {
    let size = WindowLayout.initialContentSize(available: available, decorationHeight: 28)
    precondition(abs(size.width / size.height - 16.0 / 9.0) < 0.000001)
    precondition(size.width <= available.width && size.height + 28 <= available.height)
    precondition(size.width <= 1920 && size.height <= 1080)
}
let fullSize = WindowLayout.initialContentSize(available: CGSize(width: 2560, height: 1440), decorationHeight: 28)
precondition(fullSize.width == 1920 && fullSize.height == 1080)
print("window layout assertions passed")
`);
  const env={...process.env,CLANG_MODULE_CACHE_PATH:join(root,'tmp/cache/clang'),SWIFT_MODULECACHE_PATH:join(root,'tmp/cache/swift')};
  const compiled=spawnSync('/usr/bin/swiftc',['-module-cache-path',join(root,'tmp/cache/swift'),join(root,'apps/macos/WindowLayout.swift'),main,'-o',binary],{cwd:root,env,encoding:'utf8'});
  assert.equal(compiled.status,0,compiled.stderr);
  const result=spawnSync(binary,[],{cwd:root,env,encoding:'utf8'});assert.equal(result.status,0,result.stderr);
});
