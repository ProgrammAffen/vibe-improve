import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import test from 'node:test';
import {build} from 'esbuild';

test('lesson files, links and existing resources persist without parsing or affecting planning',
  {skip: process.platform !== 'darwin', timeout: 120_000}, async () => {
  await mkdir('tmp/checks/lesson-resources', {recursive: true});
  const run = await mkdtemp(resolve('tmp/checks/lesson-resources/native-'));
  const main = join(run, 'main.swift'), binary = join(run, 'lesson-resources');
  await writeFile(main, String.raw`import Foundation
let base = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let phase = CommandLine.arguments[2]
let project = "proj_12345678-1234-4234-8234-123456789abc"
let other = "proj_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
let first = ResourceScope(routeId: "route_one", nodeId: "lesson_one")
let second = ResourceScope(routeId: "route_one", nodeId: "lesson_two")
let runtime = try RuntimeDirectory(url: base.appendingPathComponent("Runtime"))
final class Calls {
    let lock = NSLock()
    private var value = 0
    func add() { lock.lock();value += 1;lock.unlock() }
    var count: Int { lock.lock();defer { lock.unlock() };return value }
}
func check(_ condition: Bool) { precondition(condition) }
let calls = Calls()
func make() throws -> ResourceLibrary {
    try ResourceLibrary(runtime: runtime, project: { id in
        if ![project, other].contains(id) { throw ResourceError.unavailable }
    }, extract: { _ in
        calls.add()
        return ResourceExtraction(status: .ready, segments: [ResourceSegment(id: "s1",
            location: ResourceLocation(kind: "paragraph", start: 1), text: "A saved planning excerpt.")])
    })
}
let library = try make()
func ref(_ row: [String: Any]) -> ResourceSelection {
    ResourceSelection(id: row["id"] as! String, version: row["version"] as! String)
}
if phase == "initial" {
    let urls = ["notes.txt", "unreadable.pdf", "audio.wav", "video.mov"].map { base.appendingPathComponent($0) }
    for url in urls { try Data("Original content, deliberately not decoded.".utf8).write(to: url) }
    let files = try library.addFiles(project, urls: urls, folder: false, scope: first)
    check(files["added"] as? Int == 4)
    let links = try library.addLinks(project, text: "https://example.org/private\nhttps://example.org/offline\ninvalid", scope: first)
    check(links["added"] as? Int == 2 && links["invalidLines"] as? [Int] == [3])
    let rows = try library.list(project, scope: first)
    check(rows.count == 6 && calls.count == 0)
    for row in rows {
        let item = try library.item(project, ref: ref(row))
        check(item.status == .attachment && item.jobId == nil && item.reason == nil && item.segments.isEmpty && !item.planning)
        if !item.isLink { check(try ResourceExtractors.fileURL(item).path == item.origin) }
    }
    let repeated = try library.addFiles(project, urls: urls, folder: false, scope: first)
    check(repeated["duplicates"] as? Int == 4 && repeated["added"] as? Int == 0)
    let saved = ref(rows[0])
    do {
        _ = try library.generationReferences(project, selections: [saved])
        preconditionFailure("Lesson attachment became a planning reference")
    } catch ResourceError.changed {}
    let reused = try library.addExisting(project, ref: saved, scope: second)
    let reusedAgain = try library.addExisting(project, ref: saved, scope: second)
    check(reused["added"] as? Int == 1 && reusedAgain["duplicates"] as? Int == 1 && calls.count == 0)
    try library.change(project, ref: saved, action: "detach", scope: first)
    check(try library.list(project, scope: first).count == 5)
    check(try library.list(project, scope: second).count == 1)
    check(FileManager.default.fileExists(atPath: urls[0].path))
    do {
        _ = try library.addExisting(other, ref: saved, scope: first)
        preconditionFailure("A foreign project reference was accepted")
    } catch ResourceError.unavailable {}

    let draft = try library.beginDraft(project)["id"] as! String
    _ = try library.addFiles(project, urls: [urls[0]], folder: false, scope: nil, draftID: draft)
    let deadline = Date().addingTimeInterval(5)
    while try library.item(project, ref: saved).status == .processing && Date() < deadline { Thread.sleep(forTimeInterval: 0.02) }
    let parsed = try library.item(project, ref: saved)
    check(parsed.status == .ready && !parsed.segments.isEmpty && calls.count == 1)
    _ = try library.finishDraft(project, id: draft, saveRefs: [saved])
    _ = try library.addExisting(project, ref: saved, scope: first)
    check(try library.generationReferences(project, selections: [saved]).count == 1)
    let retained = try library.item(project, ref: saved)
    check(calls.count == 1 && retained.segments.count == 1)

    let many = try (1...41).map { index -> URL in
        let url = base.appendingPathComponent("file-\(index).txt")
        try Data("Attachment \(index)".utf8).write(to: url)
        return url
    }
    let cappedFiles = try library.addFiles(other, urls: many, folder: false, scope: first)
    let cappedLinks = try library.addLinks(other, text: (1...21).map { "https://example.org/\($0)" }.joined(separator: "\n"), scope: first)
    check(cappedFiles["added"] as? Int == 40 && cappedFiles["overLimit"] as? Int == 1)
    check(cappedLinks["added"] as? Int == 20 && cappedLinks["overLimit"] as? Int == 1)
    let overflow = try library.addExisting(other, ref: ref(try library.list(other, scope: first)[0]), scope: second)
    check(overflow["added"] as? Int == 1 && calls.count == 1)
    check(try library.list(other, scope: first).count == 60)
} else {
    let secondRows = try library.list(project, scope: second)
    check(secondRows.count == 1)
    let saved = try library.item(project, ref: ref(secondRows[0]))
    check(saved.status == .ready && saved.planning && saved.segments.count == 1)
    let firstRows = try library.list(project, scope: first)
    check(firstRows.count == 6)
    check(firstRows.filter { $0["status"] as? String == "attachment" }.count == 5)
    check(try library.list(other, scope: first).allSatisfy { $0["status"] as? String == "attachment" })
    check(try library.parsePending(project) == 0)
    Thread.sleep(forTimeInterval: 0.1)
    check(calls.count == 0)
}
print("PASS " + phase)
`);
  const native = ['RuntimeDirectory', 'ResourceLibrary', 'ResourceExtractors', 'PublicResourceWeb', 'ResourceMedia', 'ResourceWhisper'];
  const compile = spawnSync('/usr/bin/swiftc', ['-module-cache-path', 'tmp/cache/swift',
    ...native.map(file => 'apps/macos/' + file + '.swift'), main, '-o', binary], {encoding: 'utf8', timeout: 90_000});
  assert.equal(compile.status, 0, compile.error?.message ?? compile.stderr);
  for (const phase of ['initial', 'reopen']) {
    const result = spawnSync(binary, [run, phase], {encoding: 'utf8', timeout: 10_000});
    assert.equal(result.status, 0, result.error?.message ?? result.stderr + result.stdout);
    assert.equal(result.stdout.trim(), 'PASS ' + phase);
  }
});

test('lesson resource dialog offers all three sources without parsing controls', async () => {
  await mkdir('tmp/checks/lesson-resources', {recursive: true});
  const run = await mkdtemp(resolve('tmp/checks/lesson-resources/ui-')), bundle = join(run, 'ui.mjs');
  await build({stdin: {contents: `export {default as Dialog} from './apps/local-ui/src/components/ResourceDialog.tsx';export {renderToStaticMarkup} from 'react-dom/server';export {createElement} from 'react';`, resolveDir: process.cwd(), loader: 'tsx'},
    bundle: true, platform: 'node', format: 'esm', packages: 'external', loader: {'.css': 'empty'},
    define: {'import.meta.env.BASE_URL': '"/vibe-improve/"'}, outfile: bundle});
  const {Dialog, renderToStaticMarkup, createElement} = await import(pathToFileURL(bundle).href);
  const item = {id: 'file', version: 'one', name: 'Personal notes.pdf', format: 'pdf', status: 'attachment', planning: false, removed: false, segmentCount: 0, lessonCount: 1};
  const list = {items: [item], enabled: true, loaded: true, refresh: async () => [item], limits: {lessonFiles: 40, lessonLinks: 20}};
  for (const language of ['zh-CN', 'en']) {
    const html = renderToStaticMarkup(createElement(Dialog, {projectId: 'test', scope: {routeId: 'route', nodeId: 'node'}, language,
      list, onChooseLibrary() {}, onClose() {}}));
    assert.match(html, /Personal notes.pdf/);
    for (const label of language === 'en' ? ['Add files', 'Add links', 'Add from project', 'Open original', 'Remove']
      : ['添加文件', '添加链接', '从项目资料库添加', '打开原件', '移除']) assert.ok(html.includes(label), label);
    assert.doesNotMatch(html, /解析结果|本机转写|待解析|Parse result|Transcribe locally|Pending/);
  }
});
