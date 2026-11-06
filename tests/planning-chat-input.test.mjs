import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
await mkdir('tmp/checks/chat-input-2026-11-04',{recursive:true});const dir=await mkdtemp('tmp/checks/chat-input-2026-11-04/input-'),file=resolve(dir,'input.mjs');
await build({entryPoints:['apps/local-ui/src/planning/input.ts'],bundle:true,platform:'node',format:'esm',outfile:file});
const {createImeGuard}=await import(pathToFileURL(file).href);
const enter=(overrides={})=>({key:'Enter',keyCode:13,isComposing:false,...overrides});

test('plain Enter is available for sending and ordinary typing does not enter IME mode',()=>{
 const guard=createImeGuard(()=>0);assert.equal(guard.keyDown(enter()),false);assert.equal(guard.keyDown({key:'e',keyCode:69}),false);assert.equal(guard.active(),false);
});

test('composition confirmation never sends, even when the key event reports isComposing false',()=>{
 for(const flag of [false,true]){
  let now=0;const guard=createImeGuard(()=>now);guard.start();assert.equal(guard.keyDown(enter({isComposing:flag})),true);guard.end();now+=500;
  assert.equal(guard.keyDown(enter()),true,'held confirmation key must remain blocked');guard.keyUp(enter());assert.equal(guard.keyDown(enter()),false,'the next distinct press can send');
 }
});

test('WebKit compositionend before Enter is blocked without requiring keyCode 229',()=>{
 let now=100;const guard=createImeGuard(()=>now);guard.start();guard.end();now+=5;assert.equal(guard.active(enter()),false);assert.equal(guard.keyDown(enter()),true);now+=300;assert.equal(guard.keyDown(enter()),true);guard.keyUp(enter());assert.equal(guard.keyDown(enter()),false);
});

test('legacy IME keyCode and which 229 block confirmation without composition events',()=>{
 for(const key of ['keyCode','which']){const guard=createImeGuard(()=>0),event=enter({[key]:229});assert.equal(guard.active(event),true);assert.equal(guard.keyDown(event),true);guard.keyUp(enter());assert.equal(guard.keyDown(enter()),false)}
});

test('pointer confirmation does not leave Enter permanently blocked',()=>{
 let now=0;const guard=createImeGuard(()=>now);guard.start();guard.end();now=121;assert.equal(guard.keyDown(enter()),false);
 guard.start();guard.end();guard.keyDown({key:'e',keyCode:69});assert.equal(guard.keyDown(enter()),false,'new deliberate typing ends the confirmation window');
});

test('blur clears composition state and IME editing is distinguishable from ordinary deletion',()=>{
 const guard=createImeGuard(()=>0);guard.start();assert.equal(guard.active({key:'Backspace',isComposing:false}),true);guard.end();guard.keyDown(enter());guard.reset();assert.equal(guard.active(),false);assert.equal(guard.keyDown(enter()),false);assert.equal(guard.active({key:'Delete',isComposing:false}),false);
});
