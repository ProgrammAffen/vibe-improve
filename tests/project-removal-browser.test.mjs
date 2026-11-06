import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import ts from 'typescript';

const source=async file=>ts.transpileModule(await readFile(new URL('../'+file,import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const domain={exports:{}};
vm.runInNewContext(await source('apps/local-ui/src/projects/domain.ts'),{module:domain,exports:domain.exports,TextEncoder});
const serviceSource=await source('apps/local-ui/src/projects/service.ts');
const now='2026-10-23T06:00:00.000Z';
function entry(){
  const id='proj_'+randomUUID();
  return {id,kind:'draft',parent:{name:'PRIVATE_DIRECTORY'},record:{format:'vibe-improve.project',schemaVersion:1,id,name:'PRIVATE_PROJECT',revision:1,createdAt:now,updatedAt:now,lastOpenedAt:now,state:'draft',kind:'draft',path:'PRIVATE_PATH',available:true,completedNodes:0,totalNodes:0}};
}
function storage(initial){
  const state={projects:new Map(initial.map(value=>[value.id,value])),form:new Map()},controls={failDelete:false,beforeWrite:undefined,modes:[]};
  const database={transaction(name,mode='readonly'){
    controls.modes.push(mode);
    if(mode==='readwrite'){const before=controls.beforeWrite;controls.beforeWrite=undefined;before?.();}
    const snapshot=new Map(state[name]);
    let pending=0,closed=false;
    const tx={abort(){if(closed)return;closed=true;queueMicrotask(()=>tx.onabort?.());},objectStore(){
      function request(operation){
        const result={};pending++;
        queueMicrotask(()=>{
          if(closed)return;
          try{result.result=operation();result.onsuccess?.();}
          catch{tx.abort();}
          finally{pending--;queueMicrotask(()=>{if(!closed&&pending===0){closed=true;if(mode==='readwrite')state[name]=snapshot;tx.oncomplete?.();}});}
        });return result;
      }
      return {get:id=>request(()=>snapshot.get(id)),getAll:()=>request(()=>[...snapshot.values()]),delete:id=>request(()=>{if(controls.failDelete)throw new Error('SYNTHETIC_STORAGE_FAILURE');snapshot.delete(id);}),put:(value,key)=>request(()=>snapshot.set(key??value.id,value))};
    }};return tx;
  }};
  return {state,controls,indexedDB:{open(){const result={result:database};queueMicrotask(()=>result.onsuccess?.());return result;}}};
}
function service(storage,picker){
  const module={exports:{}},logs=[];
  vm.runInNewContext(serviceSource,{module,exports:module.exports,window:{showDirectoryPicker:picker},navigator:{},crypto:{randomUUID},DOMException,indexedDB:storage.indexedDB,performance,TextEncoder,require:name=>name==='./domain'?domain.exports:{logEvent:(...args)=>logs.push(args)}});
  return {...module.exports.projectService,logs};
}

test('browser index removal persists across service restarts, retries safely, and logs no project details',async()=>{
  const value=entry(),db=storage([value]),first=service(db);
  await first.remove(value.record);
  assert.equal(db.state.projects.size,0);
  assert.equal((await service(db).list()).length,0);
  await service(db).remove(value.record);
  assert.equal(db.state.projects.size,0);
  assert.ok(db.controls.modes.includes('readwrite'));
  assert.ok(!JSON.stringify(first.logs).includes('PRIVATE_'));
  assert.equal(value.parent.name,'PRIVATE_DIRECTORY');
});

test('browser removal rejects stale snapshots and preserves the record on transaction failure',async()=>{
  const value=entry(),db=storage([value]),api=service(db);
  db.controls.beforeWrite=()=>db.state.projects.set(value.id,{...value,record:{...value.record,revision:2}});
  await assert.rejects(api.remove(value.record),/^Error: PROJECT_CONFLICT$/);
  assert.equal(db.state.projects.get(value.id).record.revision,2);
  db.controls.failDelete=true;
  await assert.rejects(api.remove({...value.record,revision:2}),/^Error: PROJECT_STORAGE_UNAVAILABLE$/);
  assert.equal(db.state.projects.size,1);
  assert.equal(db.state.projects.get(value.id).record.revision,2);
  db.controls.failDelete=false;
  await api.remove({...value.record,revision:2});
  assert.equal(db.state.projects.size,0);
});

test('browser removal validates the command before accepting missing or invalid IDs',async()=>{
  const value=entry(),db=storage([value]),api=service(db);
  for(const change of [{id:'../index'},{revision:0},{revision:1.5},{revision:1_000_000}])await assert.rejects(api.remove({...value.record,...change}),/^Error: PROJECT_INVALID$/);
  assert.equal(db.state.projects.size,1);
});

test('a browser open that finishes after index removal cannot recreate the removed entry',async()=>{
  const value=entry(),db=storage([value]),api=service(db);
  db.controls.beforeWrite=()=>db.state.projects.delete(value.id);
  await assert.rejects(api.open(value.id),/^Error: PROJECT_UNAVAILABLE$/);
  assert.equal((await api.list()).length,0);
});

test('browser creation and legacy restore use the selected folder itself without appending the project name',async()=>{
  const folder={name:'Chosen folder',queryPermission:async()=> 'granted',isSameEntry:async other=>other===folder,getDirectoryHandle:async()=>{throw new DOMException('missing','NotFoundError')}};
  const db=storage([]),api=service(db,async()=>folder),choice=await api.chooseParent();
  const record=await api.create('A title, not a subdirectory',choice,randomUUID());
  assert.equal(record.path,folder.name);assert.equal(record.directory.path,folder.name);
  const old=db.state.projects.get(record.id);old.record.path='Chosen folder/Legacy title';
  const restarted=service(db);
  assert.equal((await restarted.list())[0].path,folder.name);
  assert.equal((await restarted.open(record.id)).path,folder.name);
  await assert.rejects(api.create('Different title, same directory',choice,randomUUID()),/^Error: PROJECT_EXISTS$/);
  const renamed=await api.update(record,'Renamed');
  assert.equal(renamed.path,folder.name);assert.equal(renamed.directory.path,folder.name);
});
