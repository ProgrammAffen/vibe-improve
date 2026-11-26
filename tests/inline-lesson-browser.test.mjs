import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {spawnSync} from 'node:child_process';

test('inline browsing clips to the notebook viewport without resizing the webpage', {
  skip: process.platform !== 'darwin', timeout: 60_000,
}, async () => {
  const scratch = resolve('tmp/checks/inline-lesson-browser');
  await mkdir(scratch, {recursive: true});
  const run = await mkdtemp(join(scratch, 'geometry-'));
  const main = join(run, 'main.swift');
  await writeFile(main, `import Foundation
let host = CGRect(x: 0, y: 0, width: 600, height: 400)
let frame = ["x": 100, "y": 40, "width": 400, "height": 480]
let visible = ["x": 100, "y": 160, "width": 400, "height": 280]
let viewport = ["width": 1200, "height": 800]
func geometry(clip: [String:Int]) -> [String:Any] { ["frame": frame, "clip": clip, "viewport": viewport] }
let placement = InlineBrowserPlacement(geometry(clip: visible))!
let layout = placement.layout(in: host)!
precondition(layout.container == CGRect(x: 50, y: 180, width: 200, height: 140))
precondition(layout.page == CGRect(x: 0, y: -40, width: 200, height: 240))

let outOfBounds = InlineBrowserPlacement(geometry(clip: ["x": 900, "y": 40, "width": 200, "height": 100]))!
precondition(outOfBounds.layout(in: host) == nil, "Do not draw a preview outside its webpage card")
let hidden = InlineBrowserPlacement(geometry(clip: ["x": 0, "y": 0, "width": 0, "height": 0]))!
precondition(hidden.layout(in: host) == nil, "Hidden cards must release the native hit area")
var invalid = geometry(clip: visible)
invalid["viewport"] = ["width": 0, "height": 800]
precondition(InlineBrowserPlacement(invalid) == nil)
invalid["viewport"] = ["width": true, "height": 800] as [String:Any]
precondition(InlineBrowserPlacement(invalid) == nil)
`);
  const executable = join(run, 'inline-lesson-browser');
  const sources = ['apps/macos/BrowserAddress.swift', 'apps/macos/InlineLessonBrowser.swift', 'apps/macos/InlinePageAnnotations.swift'];
  const compile = spawnSync('/usr/bin/swiftc', ['-module-cache-path', 'tmp/cache/swift', '-framework', 'Cocoa', '-framework', 'WebKit',
    ...sources, main, '-o', executable], {encoding: 'utf8'});
  assert.equal(compile.status, 0, compile.stderr);
  const result = spawnSync(executable, [], {encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
});
