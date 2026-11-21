import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {createPlanning,saveEditor,confirmRoute,undoEditor} from '../packages/domain/planning.mjs';
import {routeIssues} from '../packages/domain/route-validation.mjs';

await mkdir('tmp/checks/prelearning-settings',{recursive:true});
const dir=await mkdtemp('tmp/checks/prelearning-settings/ui-'),bundle=resolve(dir,'ui.mjs');
const browserDependencies={name:'browser-assets-for-ssr',setup(plugin){
  // CSS and PDF workers belong to the browser. Keep the component assertions
  // real while preventing Node from trying to execute those browser modules.
  plugin.onResolve({filter:/\.css$/},args=>({path:args.path,namespace:'test-css'}));
  plugin.onLoad({filter:/.*/,namespace:'test-css'},()=>({contents:'',loader:'js'}));
  plugin.onResolve({filter:/\?url$/},args=>({path:args.path,namespace:'test-url'}));
  plugin.onLoad({filter:/.*/,namespace:'test-url'},()=>({contents:'export default "/test/pdf.worker.mjs";',loader:'js'}));
  plugin.onResolve({filter:/^pdfjs-dist$/},args=>({path:args.path,namespace:'test-pdf'}));
  plugin.onLoad({filter:/.*/,namespace:'test-pdf'},()=>({contents:'export const GlobalWorkerOptions = {}; export function getDocument() { throw new Error("PDF rendering requires a browser"); } export class TextLayer {}',loader:'js'}));
}};
await build({stdin:{contents:`export {RouteEditorSurface} from './apps/local-ui/src/components/RouteEditor.tsx';export {default as LessonPage} from './apps/local-ui/src/components/LessonPage.tsx';export {default as LegacyLessonContent} from './apps/local-ui/src/components/LegacyLessonContent.tsx';export {renderToStaticMarkup} from 'react-dom/server';export {createElement} from 'react';`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'node',format:'esm',packages:'external',plugins:[browserDependencies],loader:{'.css':'empty'},define:{'import.meta.env.BASE_URL':'"/vibe-improve/"'},outfile:bundle});
const {RouteEditorSurface,LessonPage,LegacyLessonContent,renderToStaticMarkup,createElement}=await import(pathToFileURL(bundle).href);
const project='proj_12345678-1234-4234-8234-123456789abc';
const route=()=>({format:'vibe-improve.route',schemaVersion:2,id:'synthetic',revision:1,title:'Synthetic plan',locale:'en',sourceLanguage:'en',chapters:[{id:'chapter',title:'Tools',stageGoal:'Use a tool.',nodes:[{id:'lesson',title:'Tool input',objectives:[{id:'goal',description:'Choose valid input and explain its role.'}],prerequisites:[],estimatedMinutes:30}]}]});
const no=()=>{};
const editor=(state,language)=>renderToStaticMarkup(createElement(RouteEditorSurface,{state,route:state.routeDraft,language,onRoute:no,onSave:no,onConfirm:no,onSend:()=>false,onCancel:no,onApply:no,onDiscard:no,onUndo:no,onPrevious:no,onHome:no}));

test('planning settings expose requirement without premature quiz or review controls',()=>{
  const state=createPlanning(project,'codex','en',route());
  const before=structuredClone(state);
  for(const language of ['zh-CN','en']){
    const html=editor(state,language);
    assert.match(html,/data-route-field="requirement"/);
    assert.match(html,/data-route-field="description"/);
    assert.doesNotMatch(html,/data-route-section="assessment"|data-route-field="task"|data-route-field="answer"|data-route-field="reviewCriteria"/);
    assert.doesNotMatch(html,/AI生成测验|Generate quiz|启用验收|Enable assessment|启用复习|Enable review/);
  }
  assert.deepEqual(state,before);
  assert.equal(confirmRoute(state,state.revision).confirmedRevision,state.routeDraft.revision);
});

test('legacy follow-up content stays intact and readable in the lesson',()=>{
  const original=route(),node=original.chapters[0].nodes[0];
  node.assessment={task:'Legacy quiz question.',answer:'Legacy grading guidance.',objectiveIds:['goal']};
  node.review={content:'Legacy review content.',passCriteria:['Legacy correct-answer criterion.']};
  let state=createPlanning(project,null,'en',original);
  const changed=structuredClone(state.routeDraft);changed.chapters[0].nodes[0].requirement='optional';
  state=saveEditor(state,changed,state.revision);
  for(const language of ['zh-CN','en']){
    const html=editor(state,language);
    assert.doesNotMatch(html,/data-route-field="task"|data-route-field="answer"|data-route-field="reviewCriteria"/);
    const page=renderToStaticMarkup(createElement(LessonPage,{chapter:original.chapters[0],node,language,completed:false,busy:false,error:'',onComplete:no,onMap:no,onHome:no}));
    assert.match(page,/Legacy quiz question/);assert.match(page,/Legacy grading guidance/);assert.match(page,/Legacy review content/);assert.match(page,/Legacy correct-answer criterion/);
    const folded=renderToStaticMarkup(createElement(LegacyLessonContent,{node,language,collapsible:true}));
    assert.match(folded,/<details class="lesson-assessment notebook-legacy-followup">/);
    assert.match(folded,/<details class="lesson-review notebook-legacy-followup">/);
    assert.match(folded,/Legacy quiz question/);assert.match(folded,/Legacy grading guidance/);assert.match(folded,/Legacy review content/);assert.match(folded,/Legacy correct-answer criterion/);
  }
  assert.deepEqual(state.routeDraft.chapters[0].nodes[0].assessment,node.assessment);
  assert.deepEqual(state.routeDraft.chapters[0].nodes[0].review,node.review);
});

test('incomplete legacy content has an explicit reversible recovery rather than an invisible confirmation blocker',()=>{
  let state=createPlanning(project,null,'en',route());
  const draft=structuredClone(state.routeDraft);
  draft.chapters[0].nodes[0].assessment={task:'',answer:'',objectiveIds:['goal']};
  draft.chapters[0].nodes[0].review={content:'',passCriteria:['']};
  state=saveEditor(state,draft,state.revision);
  assert.ok(routeIssues(state.routeDraft).length);
  for(const language of ['zh-CN','en'])assert.match(editor(state,language),/data-route-field="legacyFollowup"/);
  const clean=structuredClone(state.routeDraft);
  delete clean.chapters[0].nodes[0].assessment;delete clean.chapters[0].nodes[0].review;
  const saved=saveEditor(state,clean,state.revision);
  assert.equal(confirmRoute(saved,saved.revision).confirmedRevision,saved.routeDraft.revision);
  const restored=undoEditor(saved,saved.revision);
  assert.deepEqual(restored.routeDraft.chapters[0].nodes[0].assessment,draft.chapters[0].nodes[0].assessment);
  assert.deepEqual(restored.routeDraft.chapters[0].nodes[0].review,draft.chapters[0].nodes[0].review);
});
