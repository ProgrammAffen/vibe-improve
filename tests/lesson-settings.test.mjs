import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, readFile, writeFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {build} from 'esbuild';
import {validateRoute, parseRoute, routeIssues} from '../packages/domain/route-validation.mjs';
import {createPlanning, saveEditor, confirmRoute, undoEditor, redoEditor, validatePlanning, agentRouteDiagnostics, assertStudiedRouteUnchanged, appendUser, applyEdit, applyProposal} from '../packages/domain/planning.mjs';
import {isRequiredLesson, learningPrerequisiteIds, learningProgressSummary} from '../packages/domain/route-learning.mjs';

const project = 'proj_12345678-1234-4234-8234-123456789abc';
const review = () => ({content:'Explain the concepts and apply them to a new example.', passCriteria:['Explain the key steps correctly.', 'Complete a similar exercise independently.']});
const lesson = (id, prerequisites = []) => ({id, title:id, objectives:[{id:'goal', description:'Apply the idea independently.'}], prerequisites, estimatedMinutes:30});
const route = () => ({format:'vibe-improve.route', schemaVersion:2, id:'synthetic', revision:1, title:'Synthetic route', locale:'en', sourceLanguage:'en', chapters:[{id:'chapter', title:'Chapter', stageGoal:'Apply the ideas.', nodes:[lesson('a'), {...lesson('b',['a']), requirement:'optional', review:review()}, lesson('c',['b'])]}]});

test('lesson settings round-trip, while legacy routes default to required and no review', async () => {
  const value = route();
  assert.deepEqual(parseRoute(JSON.stringify(value)), value);
  const legacy = parseRoute(await readFile('contracts/examples/route.valid.json','utf8'));
  for (const node of legacy.chapters.flatMap(chapter => chapter.nodes)) {
    assert.equal(isRequiredLesson(node), true);
    assert.equal(node.review, undefined);
  }
  for (const node of value.chapters[0].nodes) delete node.requirement;
  assert.deepEqual(learningProgressSummary(value.chapters[0].nodes, new Set(['a'])), {total:3, completed:1, optionalOnly:false});
});

test('settings persist through save, restart, undo, redo and AI edits', () => {
  let state = createPlanning(project, 'codex', 'en', route());
  const value = structuredClone(state.routeDraft);
  value.chapters[0].nodes[0].requirement = 'optional';
  value.chapters[0].nodes[0].review = review();
  state = saveEditor(state, value, state.revision);
  state = validatePlanning(JSON.parse(JSON.stringify(state)));
  assert.deepEqual(state.routeDraft.chapters[0].nodes[0].review, review());
  state = undoEditor(state, state.revision);
  assert.equal(state.routeDraft.chapters[0].nodes[0].review, undefined);
  state = redoEditor(state, state.revision);
  assert.equal(state.routeDraft.chapters[0].nodes[0].requirement, 'optional');
  state = appendUser(state,'Rename the route.','message','request',state.revision);
  state = applyEdit(state,{reply:'Renamed.',route:{...state.routeDraft,title:'New title'}},'request',state.revision);
  state = applyProposal(state,state.revision);
  assert.deepEqual(state.routeDraft.chapters[0].nodes[0].review,review());
  assert.doesNotThrow(() => confirmRoute(state,state.revision));
});

test('incomplete review settings save as drafts and point to their exact fields on confirmation', () => {
  let state = createPlanning(project, null, 'en', route());
  const value = structuredClone(state.routeDraft);
  value.chapters[0].nodes[0].review = {content:'',passCriteria:['', '']};
  state = saveEditor(state, value, state.revision);
  assert.equal(state.routeDraft.chapters[0].nodes[0].review.content, '');
  assert.throws(() => confirmRoute(state,state.revision), /PLANNING_ROUTE_INVALID/);
  const issues = agentRouteDiagnostics(state,state.routeDraft).issues;
  assert.ok(issues.some(issue => issue.path === 'chapters.0.nodes.0.review.content'));
  assert.ok(issues.some(issue => issue.path.startsWith('chapters.0.nodes.0.review.passCriteria')));
  for (const changes of [{requirement:'sometimes'}, {review:{content:'Review',passCriteria:[]}}, {review:{content:'Review',passCriteria:['Same','Same']}}, {review:{content:'x'.repeat(4001),passCriteria:['Correct']}}]) {
    const invalid = route(); Object.assign(invalid.chapters[0].nodes[0],changes);
    assert.throws(() => validateRoute(invalid));
    assert.ok(routeIssues(invalid).length);
  }
});

test('explicit elective prerequisites gate learning while required progress counts each completed or mastered lesson once', () => {
  const value = route();
  assert.deepEqual(learningPrerequisiteIds(value,'c'),['b']);
  assert.deepEqual(learningPrerequisiteIds(value,'b'),['a']);
  assert.deepEqual(learningProgressSummary(value.chapters[0].nodes,new Set(['a','b'])),{total:2, completed:1, optionalOnly:false});
  assert.deepEqual(learningProgressSummary(value.chapters[0].nodes,new Set(['a','b']),new Set(['a','c'])),{total:2, completed:2, optionalOnly:false});
  value.chapters[0].nodes[0].requirement = 'optional';
  assert.deepEqual(learningPrerequisiteIds(value,'c'),['b']);
  value.chapters[0].nodes[2].requirement = 'optional';
  assert.deepEqual(learningProgressSummary(value.chapters[0].nodes,new Set(['a','c'])),{total:3, completed:2, optionalOnly:true});
});

test('started lessons protect both settings, including through AI proposals', () => {
  const previous = route();
  for (const change of [node => {node.requirement='optional';}, node => {node.review=review();}]) {
    const next = structuredClone(previous); change(next.chapters[0].nodes[0]);
    assert.throws(() => assertStudiedRouteUnchanged(previous,next,new Set(['a'])),/PLANNING_STUDIED_LESSON_LOCKED/);
    assert.doesNotThrow(() => assertStudiedRouteUnchanged(previous,next,new Set(['c'])));
  }
});

test('native store restores review settings and applies explicit elective prerequisites and studied lock', {skip:process.platform!=='darwin', timeout:180_000}, async () => {
  await mkdir('tmp/checks/lesson-settings',{recursive:true});
  const dir = await mkdtemp(resolve('tmp/checks/lesson-settings/native-'));
  const validator = join(dir,'planning.js'), source = join(dir,'main.swift'), binary = join(dir,'verify');
  await mkdir(join(dir,'Workspace'));
  await writeFile(join(dir,'route.json'),JSON.stringify(route()));
  await build({entryPoints:['packages/domain/planning.mjs'],bundle:true,format:'iife',globalName:'VibePlanning',platform:'neutral',target:'es2022',outfile:validator});
  await writeFile(source,`import Foundation
let root=URL(fileURLWithPath:CommandLine.arguments[1]),id="${project}"
func store()throws->PlanningStore{try PlanningStore(runtime:RuntimeDirectory(url:root.appendingPathComponent("Runtime")),validatorURL:root.appendingPathComponent("planning.js"),workspace:{_ in root.appendingPathComponent("Workspace")})}
let value=try JSONSerialization.jsonObject(with:Data(contentsOf:root.appendingPathComponent("route.json"))) as! [String:Any]
let first=try store(),entered=try first.enter(projectID:id,provider:nil,locale:"en",route:value)
let confirmed=try first.confirmRoute(projectID:id,expectedRevision:entered["revision"] as! Int),route=confirmed["routeDraft"] as! [String:Any],revision=route["revision"] as! Int
do{_ = try first.learningProgress(projectID:id,routeID:"synthetic",revision:revision,change:.start("c"),expectedProgressRevision:0);preconditionFailure("Lost explicit prerequisite")}catch PlanningError.conflict{}
_ = try first.learningProgress(projectID:id,routeID:"synthetic",revision:revision,change:.start("a"),expectedProgressRevision:0)
_ = try first.learningProgress(projectID:id,routeID:"synthetic",revision:revision,change:.complete("a"),expectedProgressRevision:1)
do{_ = try first.learningProgress(projectID:id,routeID:"synthetic",revision:revision,change:.start("c"),expectedProgressRevision:2);preconditionFailure("Completing an ancestor bypassed an elective prerequisite")}catch PlanningError.conflict{}
_ = try first.learningProgress(projectID:id,routeID:"synthetic",revision:revision,change:.master("b"),expectedProgressRevision:2)
let started=try first.learningProgress(projectID:id,routeID:"synthetic",revision:revision,change:.start("c"),expectedProgressRevision:3)
precondition(!(started["startedNodeIds"] as! [String]).contains("b"))
precondition((started["masteredNodeIds"] as! [String]).contains("b"))
let reopened=try store(),loaded=try reopened.read(projectID:id)!,restored=loaded["routeDraft"] as! [String:Any],chapters=restored["chapters"] as! [[String:Any]],nodes=chapters[0]["nodes"] as! [[String:Any]]
precondition(nodes[1]["requirement"] as? String=="optional");precondition((nodes[1]["review"] as? [String:Any])?["content"] as? String=="Explain the concepts and apply them to a new example.")
var changed=restored,changedChapters=chapters,changedNodes=nodes
changedNodes[0]["requirement"]="optional";changedChapters[0]["nodes"]=changedNodes;changed["chapters"]=changedChapters
do{_ = try reopened.saveEditor(projectID:id,route:changed,expectedRevision:loaded["revision"] as! Int);preconditionFailure("Modified studied settings")}catch PlanningError.studiedLessonLocked{}
let cleared=try reopened.learningProgress(projectID:id,routeID:"synthetic",revision:revision,change:.reset,expectedProgressRevision:started["progressRevision"] as! Int)
precondition(cleared["notebookResetRevision"] as? Int == cleared["progressRevision"] as? Int)
precondition(cleared["recordedNodeCount"] as? Int == 0)
let afterReset=try store().learningProgress(projectID:id,routeID:"synthetic",revision:revision)
precondition(afterReset["notebookResetRevision"] as? Int == cleared["notebookResetRevision"] as? Int)
let restarted=try reopened.learningProgress(projectID:id,routeID:"synthetic",revision:revision,change:.start("a"),expectedProgressRevision:cleared["progressRevision"] as! Int)
precondition(restarted["progressRevision"] as! Int > restarted["notebookResetRevision"] as! Int)
precondition(restarted["notebookResetRevision"] as? Int == cleared["notebookResetRevision"] as? Int)
do{_ = try reopened.learningProgress(projectID:id,routeID:"synthetic",revision:revision,change:.reset,expectedProgressRevision:started["progressRevision"] as! Int);preconditionFailure("Stale clearing epoch accepted")}catch PlanningError.conflict{}
print("Native lesson settings verified")
`);
  const compile = spawnSync('/usr/bin/swiftc',['-module-cache-path','tmp/cache/swift','-framework','JavaScriptCore','apps/macos/RuntimeDirectory.swift','apps/macos/PlanningStore.swift',source,'-o',binary],{encoding:'utf8',timeout:150_000});
  await writeFile(join(dir,'compile.log'),compile.stdout+compile.stderr);
  assert.equal(compile.status,0,compile.stderr);
  const result = spawnSync(binary,[dir],{encoding:'utf8',timeout:20_000});
  assert.equal(result.status,0,result.stderr);
  assert.match(result.stdout,/Native lesson settings verified/);
});
