import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {build} from 'esbuild';
import {emptyLessonWorkspace, nextLessonWorkspace, resetLessonWorkspace, validateLessonWorkspace} from '../packages/domain/lesson-workspace.mjs';
const identity = {projectId: 'proj_12345678-1234-4234-8234-123456789abc', routeId: 'route_one', nodeId: 'node_one'};
const ref = {id: '12345678-1234-4234-8234-123456789abc', version: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'};
const document = () => ({...emptyLessonWorkspace(identity), blocks: [
  {id: 'b1', kind: 'text', collapsed: false, records: [], content: {type: 'doc', content: [{type: 'paragraph', content: [{type: 'text', text: 'A note', marks: [{type: 'bold'}]}]}, {type: 'inlineMath', attrs: {latex: 'E=mc^2'}}]}},
  {id: 'b2', kind: 'resource', resource: {...ref}, collapsed: true, records: [{id: 'r1', kind: 'question', title: 'Why?', collapsed: true, source: {quote: 'A note', page: 1}, references: [{blockId: 'b1', source: {quote: 'Compare this'}}], messages: [{id: 'm1', role: 'assistant', text: 'Partial answer', status: 'pending'}]}]},
]});
test('notebook contract preserves cells, scoped references, records and formula JSON with immutable revision writes', () => {
  const initial = emptyLessonWorkspace(identity), proposed = document();
  const saved = nextLessonWorkspace(initial, identity, 0, proposed);
  assert.equal(saved.revision, 1);
  assert.equal(proposed.revision, 0);
  assert.deepEqual(saved.blocks, proposed.blocks);
  saved.blocks[0].content.content[0].content[0].text = 'Changed';
  assert.equal(proposed.blocks[0].content.content[0].content[0].text, 'A note');
  assert.throws(() => nextLessonWorkspace(saved, identity, 0, proposed), /LESSON_CONFLICT/);
  assert.throws(() => validateLessonWorkspace(proposed, {...identity, nodeId: 'node_two'}), /LESSON_CONFLICT/);
});
test('clearing a route removes authored lesson content and all questions/notes but retains original material placements', () => {
  const original = document();
  original.blocks.push({id: 'math', kind: 'math', latex: 'x^2', collapsed: false, records: []},
    {id: 'link', kind: 'link', url: 'https://example.org', collapsed: false, records: [{id: 'link_note', kind: 'note', title: 'A note', messages: [], collapsed: true}]});
  const cleared = resetLessonWorkspace(original, identity);
  assert.equal(cleared.revision, original.revision + 1);
  assert.deepEqual(cleared.blocks.map(block => block.id), ['b2', 'link']);
  assert.deepEqual(cleared.blocks.map(block => block.records), [[], []]);
  assert.deepEqual(cleared.blocks[0].resource, ref);
  assert.equal(original.blocks.length, 4);
  assert.equal(original.blocks[1].records.length, 1);
  assert.throws(() => nextLessonWorkspace(cleared, identity, original.revision, original), /LESSON_CONFLICT/);
});
test('notebook rejects executable editor nodes, injected attributes, unsafe URLs, dangling sources and duplicate identities', () => {
  const reject = mutate => {const input = document(); mutate(input); assert.throws(() => validateLessonWorkspace(input), /LESSON_INVALID/);};
  reject(input => input.blocks[0].content.content.push({type: 'html', attrs: {html: '<script>bad</script>'}}));
  reject(input => input.blocks[0].content.content[0].attrs = {style: 'position:fixed'});
  reject(input => input.blocks[0].content.content[0].content[0].marks = [{type: 'link', attrs: {href: 'javascript:alert(1)'}}]);
  reject(input => input.blocks[0].content.content[0].content[0].marks = [{type: 'link', attrs: {href: 'mailto:learner@example.org'}}]);
  reject(input => input.blocks.push({id: 'b3', kind: 'link', url: 'file:///etc/passwd', collapsed: false, records: []}));
  reject(input => input.blocks[1].records[0].references[0].blockId = 'missing');
  reject(input => input.blocks[1].records[0].source = {quote: 'time', startMs: 5000, endMs: 4000});
  reject(input => input.blocks[1].records[0].messages[0].id = 'b1');
  reject(input => input.blocks[1].resource.path = '/etc/passwd');
  reject(input => input.blocks[0].content.content[0].content[0].marks = [{type: 'link', attrs: {href: 'https://user:password@example.org'}}]);
  const tooLarge = document(); tooLarge.blocks = Array.from({length: 501}, (_, index) => ({id: 'b'+index, kind: 'math', latex: 'x', collapsed: false, records: []}));
  assert.throws(() => validateLessonWorkspace(tooLarge), /LESSON_TOO_LARGE/);
});

test('web note anchors survive workspace saves and reject unsafe or mixed source selectors', () => {
  const workspace = document();
  const source = {quote: 'Example Domains', web: {url: 'https://www.iana.org/help/example-domains', prefix: '', suffix: ' A number of domains'}};
  const note = {id: 'web-note', kind: 'note', title: 'Domain examples', collapsed: true, source, messages: []};
  workspace.blocks[1].records.push(note);
  const saved = nextLessonWorkspace(emptyLessonWorkspace(identity), identity, 0, workspace);
  assert.deepEqual(validateLessonWorkspace(saved, identity).blocks[1].records.at(-1), note);
  assert.deepEqual(resetLessonWorkspace(saved, identity).blocks[0].records, []);

  for (const invalid of [
    {...source, page: 1},
    {...source, startMs: 0},
    {...source, quote: ' '},
    {...source, quote: 'a'.repeat(1001)},
    {...source, web: {...source.web, prefix: 'a'.repeat(121)}},
    {...source, web: {...source.web, selector: 'main'}},
    {...source, web: {...source.web, url: 'javascript:void(0)'}},
    {...source, web: {...source.web, url: 'https://user:password@example.org/'}},
  ]) {
    const candidate = structuredClone(workspace);
    candidate.blocks[1].records.at(-1).source = invalid;
    assert.throws(() => validateLessonWorkspace(candidate, identity), /LESSON_INVALID/);
  }
});

test('native notebook restart, conflict, resource isolation and byte-range preview are durable and path safe', {skip: process.platform !== 'darwin', timeout: 120_000}, async () => {
  await mkdir('tmp/checks/lesson-workspace', {recursive: true});
  const run = await mkdtemp(resolve('tmp/checks/lesson-workspace/native-'));
  const validator = join(run, 'lesson.js');
  await build({entryPoints: ['packages/domain/lesson-workspace.mjs'], bundle: true, format: 'iife', globalName: 'VibeLesson', platform: 'neutral', target: 'es2022', outfile: validator});
  const main = join(run, 'main.swift'), binary = join(run, 'notebook');
  await writeFile(join(run, 'workspace.json'), JSON.stringify(document()));
  await writeFile(main, String.raw`import Foundation
let base = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let initial = CommandLine.arguments[2] == "initial"
let runtime = try RuntimeDirectory(url: base.appendingPathComponent("Runtime"))
let project = "proj_12345678-1234-4234-8234-123456789abc"
let identity = try LessonIdentity(["projectId": project, "routeId": "route_one", "nodeId": "node_one"])
let ref = ResourceSelection(id: "12345678-1234-4234-8234-123456789abc", version: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa")
let webRef = ResourceSelection(id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbd", version: "cccccccc-cccc-4ccc-8ccc-cccccccccccd")
let web = LearningResource(id: webRef.id, version: webRef.version, format: "web", name: "Guide", origin: "https://example.org/guide", planning: true, lessons: [], status: .ready)
var linkedResources = [webRef]
let file = base.appendingPathComponent("sample.txt")
if initial { try Data("A safe source document".utf8).write(to: file) }
var resource = LearningResource(id: ref.id, version: ref.version, format: "document", name: "sample.txt", origin: file.path, stamp: ResourceExtractors.stamp(file), planning: false, lessons: [ResourceScope(routeId: "route_one", nodeId: "node_one")], status: .attachment)
var resetRevision = 0
let store = try LessonStore(runtime: runtime, validatorURL: base.appendingPathComponent("lesson.js"), context: { identity in
    guard identity.projectId == project, identity.routeId == "route_one", identity.nodeId == "node_one" else { throw LessonError.target }
    return ["route": ["title": "Synthetic route"], "chapter": ["title": "Chapter"], "node": ["title": "Lesson"], "notebookResetRevision": resetRevision, "linkedResources": linkedResources]
}, resource: { identity, selected in
    guard identity.projectId == project else { throw LessonError.resource }
    if selected == ref { return resource }
    if selected == webRef { return web }
    throw LessonError.resource
})
func check(_ condition: Bool) { precondition(condition) }
if initial {
    check(try store.read(identity)["revision"] as? Int == 0)
    let guide = try LessonPreviewStore(store: store).issue(identity, ref: webRef)
    check(guide["url"] as? String == "https://example.org/guide" && guide["mimeType"] as? String == "text/uri-list")
    linkedResources = []
    do { _ = try store.previewResource(identity, webRef); preconditionFailure("Unlinked planning resource previewed") } catch LessonError.resource {}
    let proposed = try JSONSerialization.jsonObject(with: Data(contentsOf: base.appendingPathComponent("workspace.json"))) as! [String: Any]
    check(try store.save(identity, expectedRevision: 0, workspace: proposed)["revision"] as? Int == 1)
    do { _ = try store.save(identity, expectedRevision: 0, workspace: proposed); preconditionFailure("Stale write accepted") } catch LessonError.conflict {}
    check(try store.read(identity)["revision"] as? Int == 1)
} else {
    let reopened = try store.read(identity)
    check(reopened["revision"] as? Int == 2)
    let blocks = reopened["blocks"] as! [[String: Any]], record = (blocks[1]["records"] as! [[String: Any]])[0]
    check((record["messages"] as! [[String: Any]])[0]["status"] as? String == "incomplete")
    check(try store.agentContext(["projectId": project, "routeId": "route_one", "nodeId": "node_one"], expectedRevision: 2)["workspace"] != nil)
    do { _ = try store.agentContext(["projectId": project, "routeId": "route_one", "nodeId": "node_one"], expectedRevision: 1); preconditionFailure("Stale AI snapshot accepted") } catch LessonError.conflict {}
}
let other = try LessonIdentity(["projectId": project, "routeId": "route_two", "nodeId": "node_one"])
do { _ = try store.read(other); preconditionFailure("Unconfirmed route accepted") } catch LessonError.target {}
let previews = LessonPreviewStore(store: store)
let issued = try previews.issue(identity, ref: ref)
check(issued["mimeType"] as? String == "text/plain; charset=utf-8")
let path = issued["url"] as! String
check(!path.contains(base.path))
let token = String(path.split(separator: "/").last!)
let response = try previews.response(token, range: "bytes=2-5", head: false)
check(response.code == "206 Partial Content" && String(data: response.data, encoding: .utf8) == "safe")
check(try previews.response(token, range: "bytes=-8", head: false).data.count == 8)
check(try previews.response(token, range: "bytes=0-9223372036854775807", head: false).data.count == 22)
check(try previews.response(token, range: "bytes=999-1000", head: false).code == "416 Range Not Satisfiable")
check(try previews.response(token, range: nil, head: true).data.isEmpty)
do { _ = try previews.response("../../sample.txt", range: nil, head: false); preconditionFailure("Path accepted") } catch LessonError.preview {}
resource.removed = true
if !initial {
    let retained = try store.read(identity)
    let revision = retained["revision"] as! Int
    check(try store.save(identity, expectedRevision: revision, workspace: retained)["revision"] as? Int == revision + 1)
    var foreign = try store.read(identity)
    var blocks = foreign["blocks"] as! [[String: Any]]
    blocks.append(["id": "foreign", "kind": "resource", "collapsed": false, "records": [], "resource": ["id": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "version": "cccccccc-cccc-4ccc-8ccc-cccccccccccc"]])
    foreign["blocks"] = blocks
    do { _ = try store.save(identity, expectedRevision: revision + 1, workspace: foreign); preconditionFailure("Foreign new resource accepted") } catch LessonError.resource {}
}
do { _ = try previews.response(token, range: nil, head: false); preconditionFailure("Removed source accepted") } catch LessonError.resource {}
resource.removed = false
try Data("changed source".utf8).write(to: file)
do { _ = try previews.response(token, range: nil, head: false); preconditionFailure("Changed file accepted") } catch ResourceError.unavailable {}
if initial {
    let videoURL = base.appendingPathComponent("large-sparse.mp4")
    FileManager.default.createFile(atPath: videoURL.path, contents: Data())
    let video = try FileHandle(forWritingTo: videoURL)
    let videoSize = 320 * 1024 * 1024 + 123
    try video.truncate(atOffset: UInt64(videoSize))
    try video.seek(toOffset: 0);try video.write(contentsOf: Data("HEADtest".utf8))
    try video.seek(toOffset: UInt64(videoSize - 8));try video.write(contentsOf: Data("TAILtest".utf8));try video.close()
    resource = LearningResource(id: ref.id, version: ref.version, format: "video", name: "large-sparse.mp4", origin: videoURL.path, stamp: ResourceExtractors.stamp(videoURL), planning: false, lessons: [ResourceScope(routeId: "route_one", nodeId: "node_one")], status: .attachment)
    let issuedVideo = try previews.issue(identity, ref: ref)
    check(issuedVideo["mimeType"] as? String == "video/mp4")
    let videoToken = String((issuedVideo["url"] as! String).split(separator: "/").last!)
    let limit = LessonPreviewStore.maximumRangeBytes
    let openRange = try previews.response(videoToken, range: "bytes=0-", head: false)
    check(openRange.code == "206 Partial Content" && openRange.data.count == limit && openRange.stream == nil)
    check(openRange.headers["Content-Range"] == "bytes 0-\(limit - 1)/\(videoSize)")
    check(openRange.headers["Content-Length"] == String(limit))
    check(String(data: openRange.data.prefix(8), encoding: .utf8) == "HEADtest")
    let continuation = try previews.response(videoToken, range: "bytes=\(limit)-", head: false)
    check(continuation.data.count == limit)
    check(continuation.headers["Content-Range"] == "bytes \(limit)-\(2 * limit - 1)/\(videoSize)")
    let suffix = try previews.response(videoToken, range: "bytes=-8", head: false)
    check(String(data: suffix.data, encoding: .utf8) == "TAILtest")
    check(suffix.headers["Content-Range"] == "bytes \(videoSize - 8)-\(videoSize - 1)/\(videoSize)")
    let largeSuffix = try previews.response(videoToken, range: "bytes=-\(videoSize)", head: false)
    check(largeSuffix.data.count == limit && String(data: largeSuffix.data.suffix(8), encoding: .utf8) == "TAILtest")
    check(largeSuffix.headers["Content-Range"] == "bytes \(videoSize - limit)-\(videoSize - 1)/\(videoSize)")
    let entire = try previews.response(videoToken, range: nil, head: false)
    check(entire.code == "200 OK" && entire.data.isEmpty && entire.stream != nil)
    check(entire.headers["Content-Length"] == String(videoSize) && entire.headers["Content-Range"] == nil)
    let firstChunk = try entire.stream!.next()!
    check(firstChunk.count == LessonPreviewStream.maximumChunkBytes && String(data: firstChunk.prefix(8), encoding: .utf8) == "HEADtest")
    entire.stream!.close();check(try entire.stream!.next() == nil)
    let head = try previews.response(videoToken, range: nil, head: true)
    check(head.code == "200 OK" && head.data.isEmpty && head.stream == nil && head.headers["Content-Length"] == String(videoSize))
    let rangeHead = try previews.response(videoToken, range: "bytes=0-", head: true)
    check(rangeHead.code == "206 Partial Content" && rangeHead.data.isEmpty && rangeHead.stream == nil && rangeHead.headers["Content-Length"] == String(limit))
    check(try previews.response(videoToken, range: "bytes=\(videoSize)-", head: false).code == "416 Range Not Satisfiable")
}
if !initial {
    let beforeReset = try store.read(identity)
    resetRevision = 7
    let cleared = try store.read(identity)
    check(cleared["revision"] as! Int == (beforeReset["revision"] as! Int) + 1)
    let retainedBlocks = cleared["blocks"] as! [[String: Any]]
    check(retainedBlocks.count == 1 && retainedBlocks[0]["kind"] as? String == "resource")
    check((retainedBlocks[0]["records"] as! [[String: Any]]).isEmpty)
    do { _ = try store.save(identity, expectedRevision: beforeReset["revision"] as! Int, workspace: beforeReset); preconditionFailure("A stale window recreated cleared notes") } catch LessonError.conflict {}
    check(try store.read(identity)["revision"] as! Int == cleared["revision"] as! Int)
    var newLearning = cleared
    var newBlocks = retainedBlocks
    newBlocks.append(["id": "new_text", "kind": "text", "collapsed": false, "records": [], "content": ["type": "doc", "content": [["type": "paragraph", "content": [["type": "text", "text": "New notes after clearing"]]]]]])
    newLearning["blocks"] = newBlocks
    let savedNew = try store.save(identity, expectedRevision: cleared["revision"] as! Int, workspace: newLearning)
    check((try store.read(identity)["blocks"] as! [[String: Any]]).count == 2)
    check(try store.read(identity)["revision"] as? Int == savedNew["revision"] as? Int)
}
print("PASS")
`);
  const files = ['RuntimeDirectory', 'ResourceLibrary', 'ResourceExtractors', 'PublicResourceWeb', 'ResourceMedia', 'ResourceWhisper', 'LessonStore', 'LessonPreview'];
  const compile = spawnSync('/usr/bin/swiftc', ['-module-cache-path', 'tmp/cache/swift', ...files.map(name => 'apps/macos/'+name+'.swift'), main, '-o', binary], {encoding: 'utf8', timeout: 90_000});
  assert.equal(compile.status, 0, compile.error?.message ?? compile.stderr);
  for (const phase of ['initial', 'reopen']) {
    // A new process sees a modified source from the previous phase, so restore fixture identity first.
    if (phase === 'reopen') await writeFile(join(run, 'sample.txt'), 'A safe source document');
    const result = spawnSync(binary, [run, phase], {encoding: 'utf8', timeout: 15_000});
    assert.equal(result.status, 0, result.error?.message ?? result.stderr + result.stdout);
    assert.equal(result.stdout.trim(), 'PASS');
  }
});
