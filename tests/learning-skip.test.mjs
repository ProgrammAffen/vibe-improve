import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {createPlanning, confirmRoute} from '../packages/domain/planning.mjs';

await mkdir('tmp/checks/learning-skip', {recursive:true});
const directory = await mkdtemp(resolve('tmp/checks/learning-skip/browser-'));
const output = join(directory, 'learning.mjs');
await build({
  entryPoints:[resolve('apps/local-ui/src/routes/learning.ts')], bundle:true, platform:'node', format:'esm', outfile:output,
  plugins:[{name:'synthetic-progress-transactions',setup(plugin){
    plugin.onResolve({filter:/planning\/browser-store$/},()=>({path:'store',namespace:'synthetic'}));
    plugin.onLoad({filter:/.*/,namespace:'synthetic'},()=>({loader:'ts',resolveDir:process.cwd(),contents:`
      import {parseProgress} from ${JSON.stringify(resolve('apps/local-ui/src/routes/learning-record.ts'))};
      export const legacyProgressKey=(project,route)=>project+'/'+route;
      export const withProjectLock=(_project,work)=>work();
      export async function browserProjectTransaction(_project,work){
        const fixture=globalThis.__skipFixture;
        return work({state:structuredClone(fixture.state),progress:parseProgress(JSON.parse(JSON.stringify(fixture.record))),
          saveProgress(next){fixture.record={progressRevision:next.progressRevision,notebookResetRevision:next.notebookResetRevision,
            startedNodeIds:[...next.startedNodeIds],completedNodeIds:[...next.completedNodeIds],skippedReasons:Object.fromEntries(next.skippedReasons)};},
          savePlan(next){fixture.state=next;}});
      }`}));
  }}],
});
const {learningService, prerequisiteMet} = await import(pathToFileURL(output));
const project = 'proj_11111111-1111-4111-8111-111111111111';
const node = (id,prerequisites=[])=>({id,title:id,objectives:[{id:'goal',description:'Explain this concept.'}],prerequisites,estimatedMinutes:20});
const route = {format:'vibe-improve.route',schemaVersion:2,id:'synthetic-skip',revision:1,title:'Synthetic skip route',locale:'en',sourceLanguage:'en',
  chapters:[{id:'chapter',title:'Chapter',stageGoal:'Practice the ideas.',nodes:[node('a'),node('b',['a']),node('legacy')]}]};

test('no-reason skipping survives progress serialization, stays idempotent and unlocks the next lesson', async () => {
  globalThis.window = {};
  globalThis.__skipFixture = {state:confirmRoute(createPlanning(project,null,'en',route),0),record:{progressRevision:0,notebookResetRevision:0,
    startedNodeIds:[],completedNodeIds:[],skippedReasons:{legacy:'Kept from an older version'}}};
  const saved = await learningService.skip(project,route,'a','',0);
  assert.equal(saved.progressRevision,1);
  assert.equal(saved.skippedReasons.has('a'),true);
  assert.equal(saved.skippedReasons.get('a'),'');
  assert.equal(prerequisiteMet(saved,'a'),true);
  assert.deepEqual([...saved.completedNodeIds],[]);
  const reopened = await learningService.read(project,route);
  assert.equal(reopened.skippedReasons.has('a'),true);
  assert.equal(reopened.skippedReasons.get('legacy'),'Kept from an older version');
  const repeat = await learningService.skip(project,route,'a','Do not replace',saved.progressRevision);
  assert.equal(repeat.progressRevision,saved.progressRevision);
  assert.equal(repeat.skippedReasons.get('a'),'');
  const next = await learningService.start(project,route,'b',reopened.progressRevision);
  assert.equal(next.startedNodeIds.has('b'),true);
  const started = await learningService.start(project,route,'a',next.progressRevision);
  const complete = await learningService.complete(project,route,'a',started.progressRevision);
  assert.equal(complete.completedNodeIds.has('a'),true);
  assert.equal(complete.skippedReasons.has('a'),false);
  assert.equal(Object.hasOwn(globalThis.__skipFixture.record.skippedReasons,'a'),false);
  const again = await learningService.read(project,route);
  assert.equal(again.completedNodeIds.has('a'),true);
  assert.equal(again.skippedReasons.has('a'),false);
  await assert.rejects(learningService.skip(project,route,'a','',again.progressRevision),/PLANNING_CONFLICT/);
  await assert.rejects(learningService.skip(project,route,'b','x'.repeat(241),again.progressRevision),/PLANNING_INVALID/);
  delete globalThis.__skipFixture;delete globalThis.window;
});
