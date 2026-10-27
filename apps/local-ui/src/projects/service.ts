import {logEvent} from '../logger';
import {projectErrorCode, validateProject, validProjectName, type DirectoryChoice, type ProjectDraft, type ProjectRecord} from './domain';

type Directory = FileSystemDirectoryHandle & {queryPermission: (value: {mode: 'readwrite'}) => Promise<PermissionState>; requestPermission: (value: {mode: 'readwrite'}) => Promise<PermissionState>};
type Entry = {id: string; record: ProjectRecord; parent: Directory; kind: 'draft' | 'project'};
type SavedForm = {name: string; parent?: Directory};
const choices = new Map<string, Directory>();
let database: Promise<IDBDatabase> | undefined;
function db(): Promise<IDBDatabase> {
  return database ??= new Promise((resolve,reject) => {
    const request = indexedDB.open('vibe-improve.projects.v1', 1);
    request.onupgradeneeded = () => {request.result.createObjectStore('projects', {keyPath:'id'}); request.result.createObjectStore('form');};
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {database = undefined; reject(new Error('PROJECT_STORAGE_UNAVAILABLE'));};
  });
}
async function read<T>(store: string, key?: string): Promise<T> {
  const database = await db();
  return new Promise((resolve,reject) => {
    const request = key ? database.transaction(store).objectStore(store).get(key) : database.transaction(store).objectStore(store).getAll();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('PROJECT_STORAGE_UNAVAILABLE'));
  });
}
async function write(store: string, value: unknown, key?: string): Promise<void> {
  const database = await db();
  return new Promise((resolve,reject) => {
    const tx = database.transaction(store,'readwrite');
    if (key) tx.objectStore(store).put(value,key); else tx.objectStore(store).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(new Error('PROJECT_STORAGE_UNAVAILABLE'));
    tx.onabort = () => reject(new Error('PROJECT_STORAGE_UNAVAILABLE'));
  });
}
async function mutateEntry(id: string, expectedRevision: number, replacement?: Entry): Promise<void> {
  const database = await db();
  return new Promise((resolve,reject) => {
    const tx=database.transaction('projects','readwrite'), store=tx.objectStore('projects');
    let failure='PROJECT_STORAGE_UNAVAILABLE';
    const current=store.get(id);
    current.onsuccess=() => {
      const entry=current.result as Entry|undefined;
      if (!entry) {if (replacement) {failure='PROJECT_UNAVAILABLE';tx.abort();} return;}
      if (entry.record.revision !== expectedRevision) {failure='PROJECT_CONFLICT';tx.abort();return;}
      if (replacement) store.put(replacement); else store.delete(id);
    };
    tx.oncomplete=() => resolve();
    tx.onerror=() => reject(new Error(failure));
    tx.onabort=() => reject(new Error(failure));
  });
}
function grant(parent: Directory): DirectoryChoice {
  const token = crypto.randomUUID(); choices.set(token,parent);
  return {token,name:parent.name,path:parent.name};
}
async function permission(directory: Directory) {
  if (typeof directory.queryPermission !== 'function') return;
  if (await directory.queryPermission({mode:'readwrite'}) !== 'granted'
      && await directory.requestPermission({mode:'readwrite'}) !== 'granted') throw new Error('PROJECT_UNAVAILABLE');
}
async function choose(): Promise<Directory | null> {
  const picker = (window as unknown as {showDirectoryPicker?: (options: {mode: string; id: string}) => Promise<Directory>}).showDirectoryPicker;
  if (!picker) throw new Error('PROJECT_PICKER_UNSUPPORTED');
  try {return await picker.call(window,{mode:'readwrite',id:'vibe-improve-projects'});}
  catch (cause) {if (cause instanceof DOMException && cause.name === 'AbortError') return null; throw new Error('PROJECT_UNAVAILABLE');}
}
async function documentIn(directory: Directory) {
  const marker = await directory.getDirectoryHandle('.vibe-improve');
  const file = await (await marker.getFileHandle('project.json')).getFile();
  if (file.size > 32_768) throw new Error('PROJECT_INVALID');
  const value=JSON.parse(await file.text());
  const keys=['format','schemaVersion','id','name','revision','createdAt','updatedAt','lastOpenedAt','state'];
  if(!value||typeof value!=='object'||Object.keys(value).length!==keys.length||!keys.every(key=>Object.hasOwn(value,key)))throw new Error('PROJECT_INVALID');
  return validateProject(value);
}
async function noCollision(parent: Directory, name: string, except?: string) {
  const entries = await read<Entry[]>('projects');
  for (const entry of entries) if (entry.id !== except && entry.kind === 'draft' && entry.record.name.toLocaleLowerCase() === name.toLocaleLowerCase() && await entry.parent.isSameEntry(parent)) throw new Error('PROJECT_EXISTS');
  try {await parent.getDirectoryHandle(name); throw new Error('PROJECT_EXISTS');}
  catch (cause) {
    if (cause instanceof DOMException && cause.name === 'NotFoundError') return;
    if (cause instanceof DOMException && ['NotAllowedError','SecurityError'].includes(cause.name)) throw new Error('PROJECT_UNAVAILABLE');
    throw new Error('PROJECT_EXISTS');
  }
}
async function browserRequest(action: string, value: Record<string,unknown>): Promise<unknown> {
  if (action === 'chooseParent') {const directory=await choose(); return directory ? grant(directory) : null;}
  if (action === 'draft.read') {const draft=await read<SavedForm|undefined>('form','current'); return draft ? {name:draft.name,...(draft.parent && {directory:grant(draft.parent)})} : {name:''};}
  if (action === 'draft.save') {await write('form',{name:String(value.name ?? '').slice(0,160),parent:choices.get(String(value.parentToken))},'current'); return null;}
  if (action === 'list') {
    const entries=await read<Entry[]>('projects');
    return Promise.all(entries.map(async entry => {
      try {
        if (typeof entry.parent.queryPermission === 'function' && await entry.parent.queryPermission({mode:'readwrite'}) === 'denied') throw new Error('PROJECT_UNAVAILABLE');
        const record=entry.kind==='project'?await documentIn(entry.parent):validateProject(entry.record);
        if(record.id!==entry.id)throw new Error('PROJECT_INVALID');
        return {...record,kind:entry.kind,path:entry.record.path};
      }
      catch {return {...validateProject(entry.record),available:false};}
    }));
  }
  if (action === 'create') {
    const name=String(value.name ?? '').normalize('NFC'), parent=choices.get(String(value.parentToken));
    if (!validProjectName(name)) throw new Error('PROJECT_NAME_INVALID');
    if (!parent) throw new Error('PROJECT_DIRECTORY_REQUIRED');
    await permission(parent);
    const id='proj_'+String(value.commandId).toLowerCase(), existing=await read<Entry|undefined>('projects',id);
    if (!/^proj_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(id)) throw new Error('PROJECT_INVALID');
    if (existing) {
      if (existing.record.name !== name || !(await existing.parent.isSameEntry(parent))) throw new Error('PROJECT_CONFLICT');
      return existing.record;
    }
    if ((await read<Entry[]>('projects')).length >= 256) throw new Error('PROJECT_LIMIT');
    await noCollision(parent,name);
    const now=new Date().toISOString();
    const record:ProjectRecord={format:'vibe-improve.project',schemaVersion:1,id,name,revision:1,state:'draft',kind:'draft',createdAt:now,updatedAt:now,lastOpenedAt:now,path:parent.name+'/'+name,available:true,completedNodes:0,totalNodes:0};
    await write('projects',{id,record,parent,kind:'draft'} satisfies Entry);
    await write('form',{name:''},'current');
    return record;
  }
  if (action === 'chooseProject') {
    const parent=await choose(); if (!parent) return null;
    let record:ProjectRecord;
    try {record=await documentIn(parent);} catch {throw new Error('PROJECT_INVALID');}
    if (value.id && record.id !== value.id) throw new Error('PROJECT_INVALID');
    const existing=await read<Entry|undefined>('projects',record.id);
    if (!existing && (await read<Entry[]>('projects')).length >= 256) throw new Error('PROJECT_LIMIT');
    record={...record,kind:'project',path:parent.name,available:true};
    await write('projects',{id:record.id,record,parent,kind:'project'} satisfies Entry);
    return record;
  }
  if (action === 'remove') {
    const id=String(value.id), expectedRevision=Number(value.expectedRevision);
    if (!/^proj_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(id)
      || !Number.isInteger(expectedRevision) || expectedRevision < 1 || expectedRevision >= 1_000_000) throw new Error('PROJECT_INVALID');
    const entry=await read<Entry|undefined>('projects',id);
    if (!entry) return null;
    let revision=entry.record.revision;
    if (entry.kind === 'project') {
      let current:ProjectRecord|undefined;
      try {current=await documentIn(entry.parent);} catch {}
      if (current) {if (current.id !== id) throw new Error('PROJECT_INVALID');revision=current.revision;}
    }
    if (revision !== expectedRevision) throw new Error('PROJECT_CONFLICT');
    await mutateEntry(id,entry.record.revision);
    return null;
  }
  const entry=await read<Entry|undefined>('projects',String(value.id));
  if (!entry) throw new Error('PROJECT_UNAVAILABLE');
  if (action === 'open') {
    await permission(entry.parent);
    let record=entry.kind==='project' ? await documentIn(entry.parent) : validateProject(entry.record);
    if (record.id !== entry.id) throw new Error('PROJECT_INVALID');
    record={...record,kind:entry.kind,path:entry.record.path,lastOpenedAt:new Date().toISOString(),available:true};
    await mutateEntry(entry.id,entry.record.revision,{...entry,record});
    return {...record,...(entry.kind==='draft' && {directory:grant(entry.parent)})};
  }
  if (action === 'update') {
    const name=String(value.name ?? '').normalize('NFC'), parent=choices.get(String(value.parentToken)) ?? entry.parent;
    if (!validProjectName(name)) throw new Error('PROJECT_NAME_INVALID');
    if (entry.record.revision !== value.expectedRevision) throw new Error('PROJECT_CONFLICT');
    await permission(parent);
    if (entry.kind === 'draft') await noCollision(parent,name,entry.id);
    else {
      const current=await documentIn(entry.parent);
      if (current.id !== entry.id || current.revision !== value.expectedRevision) throw new Error('PROJECT_CONFLICT');
    }
    const record={...entry.record,name,revision:entry.record.revision+1,updatedAt:new Date().toISOString(),path:entry.kind==='draft'?parent.name+'/'+name:entry.record.path,available:true};
    if (entry.kind === 'project') {
      const marker=await entry.parent.getDirectoryHandle('.vibe-improve');
      const file=await (await marker.getFileHandle('project.json')).createWritable();
      const {path:_,available:__,completedNodes:___,totalNodes:____,directory:_____,kind:______,...document}=record;
      await file.write(JSON.stringify(document,null,2)); await file.close();
    }
    await mutateEntry(entry.id,entry.record.revision,{...entry,parent,record});
    return record;
  }
  throw new Error('PROJECT_INVALID');
}
async function request<T>(action: string, value: Record<string,unknown> = {}): Promise<T> {
  const started=performance.now();
  try {
    const native=window.vibeNative?.projects;
    const operation=() => browserRequest(action,value);
    const result=native ? await native.request(action,value) : ['create','update','open','remove'].includes(action) && navigator.locks
      ? await navigator.locks.request('vibe-improve.projects',operation) : await operation();
    if (!action.startsWith('draft.')) logEvent('operation.completed',{operation:'project.storage',resultCode:'OK',durationMs:performance.now()-started});
    return result as T;
  } catch (cause) {
    logEvent('operation.failed',{operation:'project.storage',resultCode:'DATABASE_UNAVAILABLE',durationMs:performance.now()-started});
    throw new Error(projectErrorCode(cause));
  }
}
export const projectService={
  list: async () => (await request<unknown[]>('list')).map(validateProject),
  chooseParent: () => request<DirectoryChoice|null>('chooseParent'),
  loadDraft: () => request<ProjectDraft>('draft.read'),
  saveDraft: (name: string, directory?: DirectoryChoice) => request<void>('draft.save',{name,parentToken:directory?.token}),
  create: async (name: string, directory: DirectoryChoice, commandId: string) => validateProject(await request('create',{name,parentToken:directory.token,commandId})),
  open: async (id: string) => validateProject(await request('open',{id})),
  chooseProject: async (id?: string) => {const result=await request('chooseProject',{id}); return result ? validateProject(result) : null;},
  update: async (record: ProjectRecord, name: string, directory?: DirectoryChoice) => validateProject(await request('update',{id:record.id,name,expectedRevision:record.revision,parentToken:directory?.token})),
  remove: (record: ProjectRecord) => request<void>('remove',{id:record.id,expectedRevision:record.revision}),
};
