import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdir, mkdtemp, stat, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import test from 'node:test';
import {
  acceptAnswer, appendUser, applyGenerated, applyInterview, cancelPlanningRequest, createPlanning,
  generationProgress, saveEditor, saveGenerationProgress, setProvider, setRouteMaterial, startGeneration, undoEditor
} from '../packages/domain/planning.mjs';
import {validateRoute} from '../packages/domain/route-validation.mjs';
import planningSchema from '../contracts/planning.schema.json' with {type:'json'};

const project = 'proj_12345678-1234-4234-8234-123456789abc';
const resource = {id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', version: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'};
const route = {
  format: 'vibe-improve.route', schemaVersion: 2, id: 'route_12345678-1234-4234-8234-123456789abc', revision: 1,
  title: 'Order lookup', locale: 'en', sourceLanguage: 'en',
  chapters: [{
    id: 'ch_1', title: 'Safe order lookup', stageGoal: 'Validate input and check lookup permissions.',
    nodes: [{id: 'node_1_1', title: 'Validate input', estimatedMinutes: 30, prerequisites: [],
      objectives: [{id: 'node_1_1_o1', description: 'Reject a malformed order number.'}],
      activities: ['Read the input format and test a failed lookup.']}]
  }]
};
const outline = {status: 'ok', reply: 'Ready.', missing: [], result: {
  title: route.title, chapters: [{title: route.chapters[0].title, stageGoal: route.chapters[0].stageGoal,
    lessons: [{title: route.chapters[0].nodes[0].title, focus: 'Validate input and show a rejection.'}]}]
}};

function collected() {
  const answers = {goal: {topic: 'Tool use', outcome: 'Build order lookup'}, purpose: {context: 'Team support', criteria: 'Verify lookup and permission handling'},
    baseline: {experience: 'Can call an API'}, time: {weekly: 'Five hours', session: 'One hour'}};
  let state = createPlanning(project, 'codex', 'en');
  for (const {id} of state.questions) {
    const fields = answers[id], summary = Object.values(fields).join(' / ');
    state = appendUser(state, summary, 'm_' + id, 'r_' + id, state.revision);
    state = applyInterview(state, {reply: 'Review this answer.', summary,
      updates: [{id, fields, evidence: Object.keys(fields).map(field => ({field, messageId: 'm_' + id, quote: fields[field]})),
        missing: [], complete: true}], consistency: {status: 'consistent', issues: []}}, 'r_' + id, state.revision);
    state = acceptAnswer(state, id, 'assistant_r_' + id, state.revision);
  }
  return state;
}

test('source versions survive resume, and approved attachments commit with a private route index', () => {
  const ai = {...resource, kind: 'lesson', targetId: 'node_1_1', origin: 'ai', segmentId: 's1'};
  let state = collected();
  state = startGeneration(state, 'generate_sample', state.revision, false, 'new', {provider: 'codex', items: [resource]});
  const progress = {routeId: route.id, outline, chapters: [{...route.chapters[0], materialLinks: [ai]}]};
  state = saveGenerationProgress(state, progress, 'generate_sample', state.revision);
  state = cancelPlanningRequest(state, 'generate_sample', state.revision);
  assert.equal(generationProgress(state).resumable, true);
  const switched = setProvider(state, 'codebuddy', state.revision);
  assert.equal(generationProgress(switched).resumable, false);
  assert.throws(() => startGeneration(switched, 'resume_changed', switched.revision, false, 'resume'), /STALE/);
  state = startGeneration(state, 'resume_sample', state.revision, false, 'resume');
  assert.throws(() => applyGenerated(state, route, 'resume_sample', state.revision, [], [],
    [{...ai, version: ai.id}]), /GENERATION_INVALID/);
  assert.throws(() => applyGenerated(state, route, 'resume_sample', state.revision, [], [],
    [{...ai, targetId: 'unknown_lesson'}]), /GENERATION_INVALID/);
  const editor = applyGenerated(state, route, 'resume_sample', state.revision, [], [], [ai]);
  assert.equal(editor.resourceSnapshot, undefined);
  assert.deepEqual(editor.routeMaterials, [{routeId: route.id, links: [ai]}]);
  assert.deepEqual(validateRoute(editor.routeDraft), route);
  const detached = setRouteMaterial(editor, route.id, {...ai, origin: 'editor'}, false, editor.revision);
  assert.equal(detached.routeMaterials, undefined);
  assert.deepEqual(detached.routeDraft, editor.routeDraft);
  const manual = {...resource, kind: 'chapter', targetId: 'ch_1', origin: 'editor'};
  const added = setRouteMaterial(detached, route.id, manual, true, detached.revision);
  assert.deepEqual(added.routeMaterials[0].links, [manual]);
});

test('restoring a chapter restores its resource link by the stable route target', () => {
  const editor = createPlanning(project, null, 'en', route);
  const link = {...resource, kind: 'lesson', targetId: 'node_1_1', origin: 'editor'};
  const linked = setRouteMaterial(editor, route.id, link, true, editor.revision);
  const empty = {...route, chapters: [{...route.chapters[0], nodes: []}]};
  const removed = saveEditor(linked, empty, linked.revision);
  assert.equal(removed.routeDraft.chapters[0].nodes.length, 0);
  const restored = undoEditor(removed, removed.revision);
  assert.equal(restored.routeDraft.chapters[0].nodes[0].id, link.targetId);
  assert.deepEqual(restored.routeMaterials[0].links, [link]);
});

test('the planning snapshot accepts all 20 files and 20 links', () => {
  const state = collected();
  const items = Array.from({length: 41}, (_, index) => ({
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-' + String(index).padStart(12, '0'),
    version: resource.version
  }));
  const snapshot = {provider: 'codex', items: items.slice(0, 40)};
  assert.equal(planningSchema.properties.resourceSnapshot.properties.items.maxItems, snapshot.items.length);
  const started = startGeneration(state, 'full_selection', state.revision, false, 'new', snapshot);
  assert.deepEqual(started.resourceSnapshot, snapshot);
  assert.throws(() => startGeneration(state, 'over_selection', state.revision, false, 'new',
    {provider: 'codex', items}), /PLANNING_INVALID/);
});

function samplePdf() {
  const body = 'BT /F1 16 Tf 50 700 Td (Validate the order number and verify lookup permissions.) Tj ET\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    '<< /Length ' + body.length + ' >>\nstream\n' + body + 'endstream'
  ];
  let source = '%PDF-1.4\n';
  const entries = ['0000000000 65535 f \n'];
  for (const [index, object] of objects.entries()) {
    entries.push(String(source.length).padStart(10, '0') + ' 00000 n \n');
    source += (index + 1) + ' 0 obj\n' + object + '\nendobj\n';
  }
  const start = source.length;
  return source + 'xref\n0 ' + entries.length + '\n' + entries.join('') + 'trailer\n<< /Size ' + entries.length +
    ' /Root 1 0 R >>\nstartxref\n' + start + '\n%%EOF\n';
}

test('native intake enforces distinct quotas and validates what goes to the agent', {skip: process.platform !== 'darwin', timeout: 160_000}, async () => {
  const directory = resolve('tmp/checks/resource-intake');
  await mkdir(directory, {recursive: true});
  const run = await mkdtemp(join(directory, 'native-'));
  const binary = join(run, 'test-resources');
  const main = join(run, 'main.swift');
  await writeFile(join(run, 'test.pdf'), samplePdf());
  await writeFile(join(run, 'tutorial-agent.py'), String.raw`import json, sys
provider, scenario = sys.argv[1:3]
if provider != 'codex':
    assert sys.argv[sys.argv.index('--tools') + 1] in ('WebSearch', 'NoDefer(WebSearch)')
    assert sys.argv[sys.argv.index('--allowedTools') + 1] == 'WebSearch'
    assert 'web-tutorial-search' in sys.argv[sys.argv.index('--system-prompt') + 1]
def emit(value):
    print(json.dumps(value), flush=True)
payload = '{"urls":["https://example.org/learning/intro"]}'
def verify(text):
    expected = {'topic': 'Python loops', 'locale': 'en', 'maxCandidates': 4}
    if scenario == 'append':
        expected['excludeUrls'] = ['https://example.org/previous']
    assert json.loads(text) == expected
for line in sys.stdin:
    message = json.loads(line)
    method = message.get('method')
    if method == 'initialize':
        emit({'id': 0, 'result': {}})
    elif method == 'thread/start':
        config = message['params']['config']
        assert config['web_search'] == 'live' and config['features']['shell_tool'] is False
        assert 'web-tutorial-search' in message['params']['developerInstructions']
        emit({'id': 1, 'result': {'thread': {'id': 'search-thread'}}})
    elif method == 'turn/start':
        verify(message['params']['input'][0]['text'])
        emit({'id': 2, 'result': {'turn': {'id': 'search-turn'}}})
        items = [{'type': 'agentMessage', 'text': payload}]
        if scenario != 'no-tool':
            items.insert(0, {'type': 'webSearch' if scenario != 'unrelated-tool' else 'commandExecution', 'query': 'Python loops tutorial'})
        emit({'method': 'turn/completed', 'params': {'threadId': 'search-thread',
            'turn': {'id': 'search-turn', 'status': 'completed', 'items': items}}})
    elif message.get('type') == 'control_request':
        emit({'type': 'control_response', 'response': {'request_id': message['request_id'], 'subtype': 'success', 'response': {}}})
    elif message.get('type') == 'user':
        verify(message['message']['content'][0]['text'])
        if scenario != 'no-tool':
            name = 'WebSearch' if scenario != 'unrelated-tool' else 'Bash'
            call = {'type': 'tool_use', 'name': name, 'id': 'query-1', 'input': {'query': 'Python loops'}}
            emit({'type': 'stream_event', 'event': {'type': 'content_block_start', 'content_block': call}})
            emit({'type': 'assistant', 'message': {'content': [call]}})
            result = {'type': 'tool_result', 'tool_use_id': 'query-1', 'content': 'Found a tutorial.', 'is_error': scenario == 'error'}
            emit({'type': 'user', 'message': {'content': [result]}})
        emit({'type': 'result', 'subtype': 'success', 'is_error': False, 'result': payload})
`);
  await writeFile(main, String.raw`import Foundation

let project = "TEST_PROJECT"
let tutorialProject = "proj_92345678-1234-4234-8234-123456789abc"
let retryProject = "proj_81345678-1234-4234-8234-123456789abc"
let base = URL(fileURLWithPath: CommandLine.arguments[1])
if CommandLine.arguments.count > 2, let url = PublicResourceWeb.address(CommandLine.arguments[2]) {
    let live = PublicResourceWeb.fetch(url)
    print("Public web \(live.status.rawValue), \(live.segments.count) snippets")
    if live.status != .ready { exit(2) }
    exit(0)
}
let pdf = ResourceExtractors.pdf(data: try Data(contentsOf: base.appendingPathComponent("test.pdf")))
precondition(pdf.status == .ready && pdf.segments.first?.location.kind == "page" && pdf.segments.first?.location.start == 1)
precondition(pdf.segments.first?.text.contains("lookup permissions") == true)
let source = base.appendingPathComponent("selected-files", isDirectory: true)
let nested = source.appendingPathComponent("nested", isDirectory: true)
let outside = base.appendingPathComponent("outside", isDirectory: true)
try FileManager.default.createDirectory(at: nested, withIntermediateDirectories: true)
try FileManager.default.createDirectory(at: outside, withIntermediateDirectories: true)
let text = "The support agent checks order permissions before tool calls. A malformed order number must produce a validation error."
try text.write(to: outside.appendingPathComponent("never import.txt"), atomically: true, encoding: .utf8)
try FileManager.default.createSymbolicLink(at: source.appendingPathComponent("shortcut"), withDestinationURL: outside)
try text.write(to: source.appendingPathComponent(".hidden.txt"), atomically: true, encoding: .utf8)
for n in 1...22 {
    let parent = n % 2 == 0 ? nested : source
    try (text + " Exercise \(n).").write(to: parent.appendingPathComponent("sample\(n).txt"), atomically: true, encoding: .utf8)
}
let runtime = try RuntimeDirectory(url: base.appendingPathComponent("Runtime"))
final class Attempts {
    private let lock = NSLock()
    private var counts: [String: Int] = [:]
    func record(_ origin: String) -> Int {
        lock.lock()
        defer { lock.unlock() }
        counts[origin, default: 0] += 1
        return counts[origin]!
    }
}
let attempts = Attempts()
func make() throws -> ResourceLibrary {
    try ResourceLibrary(runtime: runtime, project: { if ![project, tutorialProject, retryProject].contains($0) { throw ResourceError.unavailable } },
        extract: { item in
            if item.isLink {
                if item.origin.hasSuffix("/recoverable"), attempts.record(item.origin) == 1 { return ResourceExtractors.failure("network") }
                if item.origin.contains("/failed/") { return ResourceExtraction(status: .attachment, reason: "unsupported") }
                return PublicResourceWeb.extractText("<main><div>Code Open more actions menu</div><article><p>" + text + "</p></article></main>", html: true)
            }
            return ResourceExtractors.extract(item)
        })
}
let library = try make()
let importedTogether = try library.addFiles(tutorialProject,
    urls: [source.appendingPathComponent("sample1.txt"), nested.appendingPathComponent("sample2.txt")], folder: false, scope: nil)
precondition(importedTogether["added"] as? Int == 2)
let files = try library.addFiles(project, urls: [source], folder: true, scope: nil)
precondition(files["added"] as? Int == 20 && files["overLimit"] as? Int == 2 && files["skipped"] as? Int == 1, "Folder cap \(files)")
let again = try library.addFiles(project, urls: [source], folder: true, scope: nil)
precondition(again["duplicates"] as? Int == 20 && again["overLimit"] as? Int == 2)
let publicURLs = (1...21).map { "https://example.org/handbook/\($0)" }
let batch = (["  " + publicURLs[0] + "#excerpt  ", "", "invalid", "http://127.0.0.1/file"] + publicURLs).joined(separator: "\r\n")
let links = try library.addLinks(project, text: batch, scope: nil)
precondition(links["added"] as? Int == 20 && links["duplicates"] as? Int == 1 && links["overLimit"] as? Int == 1)
precondition(links["invalidLines"] as? [Int] == [3, 4])
let scope = ResourceScope(routeId: "preview", nodeId: "node_1_1")
let planning = try library.list(project, scope: nil)
precondition(planning.count == 40 && planning.allSatisfy { $0["status"] as? String == "pending" })
let pendingAfterReopen = try make().list(project, scope: nil)
precondition(pendingAfterReopen.allSatisfy { $0["status"] as? String == "pending" })
let admitted = Set(planning.compactMap { $0["name"] as? String })
let excess = (1...22).first { !admitted.contains("sample\($0).txt") }!
let overflowFile = (excess % 2 == 0 ? nested : source).appendingPathComponent("sample\(excess).txt")
let extras = try library.addFiles(project, urls: [overflowFile], folder: false, scope: scope)
precondition(extras["added"] as? Int == 1)
let extraLink = try library.addLinks(project, text: publicURLs[20], scope: scope)
precondition(extraLink["added"] as? Int == 1)
func awaitItems(_ scope: ResourceScope?, in projectID: String = project) throws -> [[String: Any]] {
    let end = Date().addingTimeInterval(10)
    while Date() < end {
        let list = try library.list(projectID, scope: scope)
        if list.allSatisfy({ $0["status"] as? String != "processing" }) { return list }
        Thread.sleep(forTimeInterval: 0.06)
    }
    preconditionFailure("Parsing did not finish")
}
let started = try library.parsePending(project)
let repeated = try library.parsePending(project)
precondition(started == 40 && repeated == 0)
let ready = try awaitItems(nil)
let local = try awaitItems(scope)
precondition(ready.count == 40 && ready.allSatisfy { $0["status"] as? String == "ready" })
precondition(local.count == 2 && local.allSatisfy { $0["planning"] as? Bool == false && $0["status"] as? String == "ready" })
let webRow = ready.first { $0["format"] as? String == "web" }!
let webRef = ResourceSelection(id: webRow["id"] as! String, version: webRow["version"] as! String)
let overview = try library.item(project, ref: webRef).display(details: true)["overview"] as? String
precondition(overview?.contains("checks order permissions") == true && overview?.contains("Open more actions menu") == false)
let reopened = try make()
let afterRestart = try reopened.list(project, scope: scope)
precondition(afterRestart.count == 2)
let selected = ready.first { $0["format"] as? String == "document" }!
let ref = ResourceSelection(id: selected["id"] as! String, version: selected["version"] as! String)
let materials = try library.generationReferences(project, selections: [ref])
let payload = String(decoding: try JSONSerialization.data(withJSONObject: materials), as: UTF8.self)
precondition(payload.contains(text) && !payload.contains("sample") && !payload.contains("selected-files"))
let unauthorized = ResourceSelection(id: local[0]["id"] as! String, version: local[0]["version"] as! String)
do {
    _ = try library.generationReferences(project, selections: [unauthorized])
    preconditionFailure("Lesson-only attachment entered generation")
} catch ResourceError.changed {}

let outline = try JSONSerialization.jsonObject(with: Data("""
OUTLINE_JSON
""".utf8)) as! [String: Any]
let plan = try PlanningGeneration.plan(outline, locale: "en")
let allRefs = ready.map { ResourceSelection(id: $0["id"] as! String, version: $0["version"] as! String) }
let allMaterials = try library.generationReferences(project, selections: allRefs)
let outlineInput = try PlanningGeneration.outlinePrompt(context: ["locale": "en", "questions": [], "materialSources": allMaterials])
precondition(allMaterials.count == 40 && outlineInput.contains("R40_s1"))
let context: [String: Any] = ["locale": "en", "questions": [], "materialSources": materials]
let instructions = try PlanningGeneration.chapterPrompt(context: context, plan: plan, index: 0, completed: [])
let promptInput = instructions.components(separatedBy: "CONTEXT_JSON_DATA:\n").last!
precondition(promptInput.contains("R1_s1") && promptInput.contains(text) && !promptInput.contains(ref.id))
let response: [String: Any] = ["status":"ok", "reply":"Here is the exercise.", "missing":[],
    "result":["nodes":[["ref":"L1","objectives":["Validate input."],"estimatedMinutes":30,"activities":["Check and reject one malformed order number."],
        "prerequisites":[],"assessment":NSNull()]],
        "materials":[["lessonRef":"L1","excerptRef":"R1_s1"],["lessonRef":"L3","excerptRef":"R1_s1"],["lessonRef":"L1","excerptRef":"R2_s1"]]]]
let chapter = try PlanningGeneration.chapter(response, plan: plan, index: 0, context: context)
let accepted: [String: Any] = ["status":"ok","reply":"Ready.","missing":[],"result":["ready":true,"issues":[]]]
let verified = PlanningGeneration.verifiedMaterialLinks(context: context, plan: plan, chapters: [chapter],
    review: try PlanningGeneration.review(accepted, plan: plan))
precondition(verified.count == 1 && verified.first?["targetId"] == "node_1_1" && verified.first?["segmentId"] == "s1")
let finalized = try plan.completeRoute([chapter])
precondition((finalized["chapters"] as! [[String: Any]])[0]["materialLinks"] == nil)
let other = allMaterials.first { $0["id"] as? String != ref.id }!
var reviewContext = context
reviewContext["materialSources"] = materials + [other]
let reviewInput = try PlanningGeneration.reviewPrompt(context: reviewContext, plan: plan, chapters: [chapter])
precondition(reviewInput.contains("R2_s1"))
var reviewed = accepted
reviewed["result"] = ["ready":true,"issues":[],"materials":[
    ["targetRef":"C1","excerptRef":"R1_s1"],
    ["targetRef":"C2","excerptRef":"R2_s1"],
    ["targetRef":"C1","excerptRef":"R2_s99999"],
    ["targetRef":"C1","excerptRef":"R2_s1","id":"untrusted"],
    ["targetRef":"C1","excerptRef":"R2_s1"],
    ["targetRef":"L1","excerptRef":"R2_s1"]]]
let review = try PlanningGeneration.review(reviewed, plan: plan, chapters: [chapter])
let supplemented = PlanningGeneration.verifiedMaterialLinks(context: reviewContext, plan: plan, chapters: [chapter], review: review)
precondition(supplemented.count == 2 && supplemented.first == verified.first)
precondition(supplemented.last?["kind"] == "chapter" && supplemented.last?["targetId"] == "ch_1" &&
    supplemented.last?["id"] == other["id"] as? String && supplemented.last?["segmentId"] == "s1")
let unlinked = finalized["chapters"] as! [[String: Any]]
let recoveredLinks = PlanningGeneration.verifiedMaterialLinks(context: reviewContext, plan: plan, chapters: unlinked, review: review)
precondition(recoveredLinks.count == 2 && recoveredLinks.allSatisfy { $0["targetId"] == "ch_1" })
let projectDirectory = try runtime.child("projects").child("resources").child(project)
try projectDirectory.locked {
    let data = try projectDirectory.read("library.json", maximumBytes: 24 * 1024 * 1024)!
    var old = try JSONSerialization.jsonObject(with: data) as! [String: Any]
    var rows = old["items"] as! [[String: Any]]
    for index in rows.indices { rows[index]["selected"] = false }
    old["items"] = rows
    try projectDirectory.write("library.json", data: JSONSerialization.data(withJSONObject: old))
}
let autoReferences = try reopened.generationReferences(project, selections: [ref])
precondition(autoReferences.count == 1, "Old selection flags must not exclude readable resources.")
let original = try library.item(project, ref: ref).origin
let removedRefs = try library.remove(project, ref: ref)
precondition(removedRefs == [ref])
do {
    _ = try library.generationReferences(project, selections: [ref])
    preconditionFailure("Deleted reference remained eligible")
} catch ResourceError.changed {}
let removed = try library.item(project, ref: ref)
precondition(removed.removed && removed.segments.isEmpty && FileManager.default.fileExists(atPath: original))
let removedAgain = try library.remove(project, ref: ref)
precondition(removedAgain.isEmpty)
let fresh = try library.addLinks(retryProject, text: [
    "https://example.org/recoverable", "https://example.org/failed/1", "https://example.org/failed/2", "https://example.org/failed/3"
].joined(separator: "\n"), scope: nil)
precondition(fresh["added"] as? Int == 4)
let retryStarted = try library.parsePending(retryProject)
precondition(retryStarted == 4)
let rejected = try awaitItems(nil, in: retryProject)
precondition(rejected.map { $0["status"] as? String } == ["needsAttention", "attachment", "attachment", "attachment"])
let retryRef = ResourceSelection(id: rejected[0]["id"] as! String, version: rejected[0]["version"] as! String)
let persistedFailure = try reopened.item(retryProject, ref: retryRef)
let noNewJobs = try reopened.parsePending(retryProject)
precondition(persistedFailure.parseFailed && noNewJobs == 0)
try library.change(retryProject, ref: retryRef, action: "retry")
try library.change(retryProject, ref: retryRef, action: "retry")
let retried = try awaitItems(nil, in: retryProject)
precondition(retried[0]["id"] as? String == retryRef.id && retried[0]["status"] as? String == "ready")
let newPending = try library.addLinks(retryProject, text: "https://example.org/new", scope: nil)
precondition(newPending["added"] as? Int == 1)
let oneFailure = ResourceSelection(id: rejected[1]["id"] as! String, version: rejected[1]["version"] as! String)
let individuallyRemoved = try library.remove(retryProject, ref: oneFailure)
let batchRemoved = try library.removeFailed(retryProject)
let batchRemovedAgain = try library.removeFailed(retryProject)
let kept = try reopened.list(retryProject, scope: nil)
precondition(individuallyRemoved == [oneFailure] && batchRemoved.count == 2 && batchRemovedAgain.isEmpty)
precondition(kept.map { $0["status"] as? String } == ["ready", "pending"])
let latestStarted = try library.parsePending(retryProject)
let readyAgain = try awaitItems(nil, in: retryProject)
precondition(latestStarted == 1 && readyAgain.allSatisfy { $0["status"] as? String == "ready" })
_ = try library.addLinks(retryProject, text: "https://example.org/failed/last", scope: nil)
_ = try library.parsePending(retryProject)
let withFailure = try awaitItems(nil, in: retryProject)
let batchFailure = withFailure.first { $0["status"] as? String == "attachment" }!
let failureRef = ResourceSelection(id: batchFailure["id"] as! String, version: batchFailure["version"] as! String)
_ = try library.addFiles(retryProject, urls: [overflowFile], folder: false, scope: nil)
let pendingRow = try library.list(retryProject, scope: nil).first { $0["status"] as? String == "pending" }!
let pendingRef = ResourceSelection(id: pendingRow["id"] as! String, version: pendingRow["version"] as! String)
let mixedSelection: Set<ResourceSelection> = [retryRef, failureRef, pendingRef, webRef]
let mixedDeletion = try library.remove(retryProject, refs: mixedSelection)
let afterMixedDeletion = try reopened.list(retryProject, scope: nil)
let repeatedDeletion = try library.remove(retryProject, refs: mixedSelection)
let otherProjectItem = try library.item(project, ref: webRef)
precondition(Set(mixedDeletion) == [retryRef, failureRef, pendingRef] && repeatedDeletion.isEmpty)
precondition(afterMixedDeletion.count == 1 && afterMixedDeletion[0]["status"] as? String == "ready")
precondition(!otherProjectItem.removed && FileManager.default.fileExists(atPath: overflowFile.path))
let captions = ResourceExtractors.captions(Data("1\r\n00:00:03,000 --> 00:00:06,000\r\nVerify one order number.\r\n".utf8))
precondition(captions.status == .ready && captions.segments.first?.location.start == 3000)
let locked = PublicResourceWeb.extractText("<head>Account</head><form><input type=password /></form>", html: true)
precondition(locked.status == .needsAttention && locked.reason == "requiresLogin")
let script = PublicResourceWeb.extractText("<script>window.private = '\(text)'</script><nav>\(text)</nav>", html: true)
precondition(script.segments.isEmpty)
precondition(!PublicResourceWeb.publicIPv4("169.254.169.254") && !PublicResourceWeb.publicIPv4("100.64.1.1"))
precondition(PublicResourceWeb.address("https://account:pass@example.org") == nil)

func refs(_ rows: [[String: Any]]) -> Set<ResourceSelection> {
    Set(rows.map { ResourceSelection(id: $0["id"] as! String, version: $0["version"] as! String) })
}
func draftRows(_ id: String) throws -> [[String: Any]] {
    try library.readDraft(tutorialProject, id: id)["items"] as! [[String: Any]]
}
let editing = try library.beginDraft(tutorialProject)
let draftID = editing["id"] as! String
precondition(editing["dirty"] as? Bool == false)
let manual = (1...18).map { "https://example.org/manual/\($0)" }
_ = try library.addLinks(tutorialProject, text: manual.joined(separator: "\n"), scope: nil, draftID: draftID)
let available = try library.prepareTutorialSearch(tutorialProject, draftID: draftID, restart: false)
precondition(available.slots == 2 && available.excluded.isEmpty)
let good = "https://example.org/verified/one", extra = "https://example.org/verified/two"
let blocked = "https://example.org/login", partial = "https://example.org/partial"
let safeText = PublicResourceWeb.extractText("<main><p>" + text + "</p></main>", html: true)
let additions = try library.addTutorialResults(tutorialProject, draftID: draftID, candidates: [
    "http://127.0.0.1/file", manual[0] + "#known", blocked, partial, good, good + "#same", extra
], readPage: { url, seconds in
    precondition(seconds <= 7)
    switch url.absoluteString {
    case blocked: return locked
    case partial: return ResourceExtraction(status: .partial, segments: safeText.segments)
    case good:
        _ = try! library.addLinks(tutorialProject, text: "https://example.org/manual/19", scope: nil, draftID: draftID)
        return safeText
    case extra: return safeText
    default: preconditionFailure("A duplicate or private URL was fetched.")
    }
})
precondition(additions == 1, "Search and simultaneous manual additions must share the same quota.")
let borrowed = try draftRows(draftID)
let found = borrowed.filter { $0["fromTutorialSearch"] as? Bool == true }
precondition(borrowed.filter { $0["format"] as? String == "web" }.count == 20)
precondition(found.count == 1 && found[0]["status"] as? String == "ready")
let discovered = refs(found).first!
do {
    _ = try library.generationReferences(tutorialProject, selections: [discovered])
    preconditionFailure("An unsaved tutorial was sent to generation.")
} catch ResourceError.changed {}
let committedBeforeSave = try library.list(tutorialProject, scope: nil, all: true)
precondition(committedBeforeSave.count == 2)
let afterReopen = try reopened.beginDraft(tutorialProject)
precondition(afterReopen["id"] as? String == draftID && afterReopen["dirty"] as? Bool == true)
let noSpace = try library.addTutorialResults(tutorialProject, draftID: draftID, candidates: [extra], readPage: { _, _ in
    preconditionFailure("A full project should not fetch more pages.")
})
precondition(noSpace == 0)
let oneManual = borrowed.filter { ($0["name"] as? String)?.hasSuffix(" / 19") == true }
try library.removeFromDraft(tutorialProject, id: draftID, refs: refs(oneManual))
let continued = try library.prepareTutorialSearch(tutorialProject, draftID: draftID, restart: false)
precondition(continued.slots == 1 && continued.excluded == [good])
let more = try library.addTutorialResults(tutorialProject, draftID: draftID, candidates: [good, extra], readPage: { url, _ in
    precondition(url.absoluteString == extra)
    return safeText
})
precondition(more == 1)
let readyToSave = try draftRows(draftID)
do {
    _ = try library.finishDraft(tutorialProject, id: draftID, saveRefs: refs(borrowed))
    preconditionFailure("A stale displayed list overwrote a changed draft.")
} catch ResourceError.changed {}
_ = try library.finishDraft(tutorialProject, id: draftID, saveRefs: refs(readyToSave))
let discoveredReferences = try library.generationReferences(tutorialProject, selections: [discovered])
precondition(discoveredReferences.count == 1)
let persisted = try library.list(tutorialProject, scope: nil)
precondition(refs(persisted) == refs(readyToSave))

let restartID = try library.beginDraft(tutorialProject)["id"] as! String
let cleared = try library.prepareTutorialSearch(tutorialProject, draftID: restartID, restart: true)
let withoutSearch = try draftRows(restartID)
precondition(cleared.slots == 2 && cleared.excluded.isEmpty && withoutSearch.count == readyToSave.count - 2)
let stillCommitted = try library.generationReferences(tutorialProject, selections: [discovered])
precondition(stillCommitted.count == 1)
let reused = try library.addTutorialResults(tutorialProject, draftID: restartID, candidates: [good], readPage: { _, _ in
    preconditionFailure("Restart should reuse the parsed result if search finds it again.")
})
precondition(reused == 1)
_ = try library.finishDraft(tutorialProject, id: restartID, saveRefs: nil)
let afterDiscard = try library.list(tutorialProject, scope: nil)
precondition(refs(afterDiscard) == refs(persisted))
do {
    _ = try library.addTutorialResults(tutorialProject, draftID: restartID, candidates: [extra])
    preconditionFailure("Late search results entered a closed draft.")
} catch ResourceError.changed {}

let deletionID = try library.beginDraft(tutorialProject)["id"] as! String
try library.removeFromDraft(tutorialProject, id: deletionID, refs: [discovered])
let beforeDeletion = try library.generationReferences(tutorialProject, selections: [discovered])
precondition(beforeDeletion.count == 1)
let keptResources = try draftRows(deletionID)
let changed = try library.finishDraft(tutorialProject, id: deletionID, saveRefs: refs(keptResources))
precondition(changed == [discovered])
let nextDraft = try library.beginDraft(tutorialProject)["id"] as! String
let notRediscovered = try library.addTutorialResults(tutorialProject, draftID: nextDraft, candidates: [good + "#same"], readPage: { _, _ in
    preconditionFailure("A deleted link was reintroduced by search.")
})
precondition(notRediscovered == 0)
let discardedFile = try library.addFiles(tutorialProject, urls: [overflowFile], folder: false, scope: nil, draftID: nextDraft)
precondition(discardedFile["added"] as? Int == 1)
let stagedFile = try draftRows(nextDraft).first { $0["name"] as? String == overflowFile.lastPathComponent }!
let stagedRef = refs([stagedFile]).first!
precondition(["processing", "ready"].contains(stagedFile["status"] as? String ?? ""))
_ = try library.finishDraft(tutorialProject, id: nextDraft, saveRefs: nil)
let privateItem = try? library.item(tutorialProject, ref: stagedRef)
precondition(privateItem == nil && FileManager.default.fileExists(atPath: overflowFile.path))

let skillURL = URL(fileURLWithPath: "skills/web-tutorial-search/SKILL.md", relativeTo: URL(fileURLWithPath: FileManager.default.currentDirectoryPath, isDirectory: true)).absoluteURL
let fixture = base.appendingPathComponent("tutorial-agent.py")
let agents = try AgentManager(runtime: runtime)
for (provider, scenario) in [("codex", "success"), ("codebuddy", "success"), ("claude-code", "append"),
                             ("codex", "no-tool"), ("claude-code", "error"), ("codebuddy", "unrelated-tool")] {
    let launch = try AgentSessionLaunch(provider: provider, projectID: project, executable: URL(fileURLWithPath: "/usr/bin/python3"),
        arguments: [fixture.path, provider, scenario, "--tools", ""], workspace: base, environment: ProcessInfo.processInfo.environment)
    let runner = PlanningAgentManager(agents: agents, prepare: { _ in AgentSessionPreparation(projectID: project, provider: provider, launch: launch) })
    defer { runner.shutdown() }
    do {
        let urls = try runner.searchTutorials(projectID: project, provider: provider, topic: "Python loops", locale: "en",
            maxCandidates: 4, options: [:], excluding: scenario == "append" ? ["https://example.org/previous"] : [], skillURL: skillURL)
        precondition(["success", "append"].contains(scenario) && urls == ["https://example.org/learning/intro"])
    } catch PlanningAgentError.unsupported {
        precondition(["no-tool", "error"].contains(scenario))
    } catch PlanningAgentError.permission {
        precondition(scenario == "unrelated-tool")
    }
}
print("PASS resources")
`.replace('TEST_PROJECT', project).replace('OUTLINE_JSON', JSON.stringify(outline)));
  const native = ['RuntimeDirectory', 'ResourceLibrary', 'ResourceExtractors', 'PublicResourceWeb', 'ResourceMedia', 'ResourceWhisper',
    'AgentManager', 'CodeBuddyAdapter', 'PlanningAgent', 'PlanningGeneration', 'PlanningPromptPack', 'PlanningPromptPackResources'];
  const compile = spawnSync('/usr/bin/swiftc', ['-module-cache-path', 'tmp/cache/swift',
    ...native.map(file => 'apps/macos/' + file + '.swift'), main, '-o', binary], {encoding: 'utf8', timeout: 120_000});
  assert.equal(compile.status, 0, compile.error?.message ?? compile.stderr);
  const result = spawnSync(binary, [run], {encoding: 'utf8', timeout: 23_000});
  assert.equal(result.status, 0, result.error?.message ?? result.stderr + result.stdout);
  assert.match(result.stdout, /PASS resources/);
  assert.equal((await stat(join(run, 'Runtime', 'projects', 'resources', project, 'library.json'))).mode & 0o777, 0o600);
});
