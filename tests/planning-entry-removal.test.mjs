import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createPlanning,openEditor,reopenIntake,removeImportedRoute,saveEditor,importRoute,appendUser} from '../packages/domain/planning.mjs';
const id='proj_12345678-1234-4234-8234-123456789abc';
const route=JSON.parse(await readFile('contracts/examples/route.valid.json','utf8'));
test('explicit AI creation reopens intake without discarding chapters; ordinary reads keep editor',()=>{
 let state=createPlanning(id,'codex','zh-CN',route);const draft=structuredClone(state.routeDraft);
 assert.equal(state.step,'editor');state=reopenIntake(state,state.revision);
 assert.equal(state.step,'intake');assert.equal(state.currentQuestion,'goal');assert.deepEqual(state.routeDraft,draft);
 assert.throws(()=>reopenIntake(state,0),/CONFLICT/);
 assert.throws(()=>reopenIntake(createPlanning(id,null,'en'),0),/INCOMPLETE/);
});
test('deleting imported route clears its edited draft and undo, preserving interview background',()=>{
 let state=createPlanning(id,'codex','en',route);const edited=structuredClone(state.routeDraft);edited.title='Edited imported draft';state=saveEditor(state,edited,state.revision);
 assert.throws(()=>removeImportedRoute(state,0),/CONFLICT/);
 state=removeImportedRoute(state,state.revision);assert.equal(state.step,'intake');
 for(const key of ['routeDraft','importedOriginal','undoRoute','proposal','confirmedRevision'])assert.equal(state[key],undefined);
 assert.equal(removeImportedRoute(state,state.revision).revision,state.revision);
});
test('manual import deletion returns an empty editor and cannot resurrect from undo',()=>{
 let state=createPlanning(id,null,'en',route);state=removeImportedRoute(state,state.revision);
 assert.equal(state.step,'editor');assert.equal(state.routeDraft.chapters.length,0);assert.equal(state.undoRoute,undefined);
});
test('deleting an old import preserves a separately generated current route',()=>{
 let state=createPlanning(id,'codex','en',route);const other=structuredClone(route);other.id='anotherRoute';
 state=importRoute(state,other,state.revision);state.importedOriginal=structuredClone(route);
 const draft=structuredClone(state.routeDraft);state=removeImportedRoute(state,state.revision);
 assert.deepEqual(state.routeDraft,draft);assert.equal(state.importedOriginal,undefined);assert.equal(state.undoRoute,undefined);
});
test('active AI request prevents deleting its input route',()=>{
 let state=createPlanning(id,'codex','en',route);state=appendUser(state,'Rename this chapter','message1','request1',state.revision);
 assert.throws(()=>removeImportedRoute(state,state.revision),/BUSY/);
 assert.throws(()=>reopenIntake(state,state.revision),/BUSY/);
});
