import {parseRoute,validateRoute,MAX_ROUTE_BYTES,type RouteDocument} from '../../../../packages/domain/route-validation.mjs';
import type {Language} from '../i18n';

export type RouteDraft={route:RouteDocument;fileName:string};
export type RouteStage=RouteDraft&{importId:string};
export type RoutePreparation={schemaVersion:1;projectId:string;revision:number;agentConfirmed:boolean;source:'create'|'import'|null;aiAssisted:boolean;routeDraft?:RouteDraft};
const codes=['ROUTE_INVALID','ROUTE_INVALID_JSON','ROUTE_DUPLICATE_KEYS','ROUTE_DEPTH_LIMIT','ROUTE_TOO_LARGE','ROUTE_VERSION_UNSUPPORTED','ROUTE_TOO_MANY_NODES','ROUTE_INVALID_UTF8','ROUTE_READ_FAILED','ROUTE_STORAGE_UNAVAILABLE','ROUTE_CONFLICT','ROUTE_PROJECT_UNAVAILABLE','ROUTE_IMPORT_EXPIRED'] as const;
export function routeCode(cause:unknown){const message=cause instanceof Error?cause.message:String(cause);return codes.find(code=>message===code)??'ROUTE_STORAGE_UNAVAILABLE'}
export function routeMessage(cause:unknown,language:Language){
  const labels:Record<typeof codes[number],[string,string]>={
    ROUTE_INVALID:['路线结构或章节依赖无效。','The route structure or chapter dependencies are invalid.'],
    ROUTE_INVALID_JSON:['请选择有效的路线 JSON 文件。','Choose a valid route JSON file.'],
    ROUTE_DUPLICATE_KEYS:['路线文件包含重复字段。','The route file contains duplicate fields.'],
    ROUTE_DEPTH_LIMIT:['路线文件层级过深。','The route file is nested too deeply.'],
    ROUTE_TOO_LARGE:['路线文件不能超过 1 MB。','The route file must be no larger than 1 MB.'],
    ROUTE_VERSION_UNSUPPORTED:['暂不支持此路线版本。','This route version is not supported.'],
    ROUTE_TOO_MANY_NODES:['路线最多包含 512 个小章节。','A route can contain up to 512 lessons.'],
    ROUTE_INVALID_UTF8:['路线文件须使用 UTF-8 编码。','The route file must use UTF-8 encoding.'],
    ROUTE_READ_FAILED:['无法读取文件，请重新选择。','Cannot read the file. Choose it again.'],
    ROUTE_STORAGE_UNAVAILABLE:['无法保存或读取路线，请重试。','Cannot save or read the route. Try again.'],
    ROUTE_CONFLICT:['项目已更新，请重新打开。','This project changed. Open it again.'],
    ROUTE_PROJECT_UNAVAILABLE:['项目目录不可用，请重新选择。','The project folder is unavailable. Choose it again.'],
    ROUTE_IMPORT_EXPIRED:['文件预览已过期，请重新选择。','The file preview expired. Choose the file again.'],
  };return labels[routeCode(cause)][language==='en'?1:0];
}
const native=()=>window.vibeNative?.projects;
function projectId(id:string){if(!/^proj_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id))throw new Error('ROUTE_INVALID')}
function empty(id:string):RoutePreparation{return{schemaVersion:1,projectId:id,revision:0,agentConfirmed:false,source:null,aiAssisted:false}}
function normalize(value:unknown,id:string):RoutePreparation{
  const s=value as RoutePreparation|null;
  if(!s||s.schemaVersion!==1||s.projectId!==id||!Number.isInteger(s.revision)||s.revision<0||s.revision>=1_000_000||typeof s.agentConfirmed!=='boolean'||typeof s.aiAssisted!=='boolean'||![null,'create','import'].includes(s.source))throw new Error('ROUTE_STORAGE_UNAVAILABLE');
  if(s.routeDraft&&(typeof s.routeDraft.fileName!=='string'||s.routeDraft.fileName.length>255))throw new Error('ROUTE_STORAGE_UNAVAILABLE');
  return{schemaVersion:1,projectId:id,revision:s.revision,agentConfirmed:s.agentConfirmed,source:s.source,aiAssisted:s.aiAssisted,...(s.routeDraft&&{routeDraft:{route:validateRoute(s.routeDraft.route),fileName:String(s.routeDraft.fileName).slice(0,255)}})};
}
let database:Promise<IDBDatabase>|undefined;
function db(){return database??=new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open('vibe-improve.routes.v1',1);request.onupgradeneeded=()=>request.result.createObjectStore('preparations',{keyPath:'projectId'});request.onsuccess=()=>resolve(request.result);request.onerror=()=>{database=undefined;reject(new Error('ROUTE_STORAGE_UNAVAILABLE'))}})}
async function browserRead(id:string){const storage=await db();return new Promise<RoutePreparation>((resolve,reject)=>{const q=storage.transaction('preparations').objectStore('preparations').get(id);q.onsuccess=()=>{try{resolve(q.result?normalize(q.result,id):empty(id))}catch(error){reject(error)}};q.onerror=()=>reject(new Error('ROUTE_STORAGE_UNAVAILABLE'))})}
async function browserMutate(id:string,change:(state:RoutePreparation)=>RoutePreparation){const storage=await db();return new Promise<RoutePreparation>((resolve,reject)=>{
  const tx=storage.transaction('preparations','readwrite'),store=tx.objectStore('preparations');let error='ROUTE_STORAGE_UNAVAILABLE',next:RoutePreparation;
  const q=store.get(id);q.onsuccess=()=>{try{const state=q.result?normalize(q.result,id):empty(id);next=change(state);store.put(next)}catch(cause){error=routeCode(cause);tx.abort()}};
  tx.oncomplete=()=>resolve(next!);tx.onerror=tx.onabort=()=>reject(new Error(error));
})}
const staged=new Map<string,{projectId:string;value:RouteStage;created:number}>();
async function request<T>(action:string,values:Record<string,unknown>):Promise<T>{try{return await native()!.request(action,values) as T}catch(cause){throw new Error(routeCode(cause))}}
export const routeService={
  read:async(id:string)=>{projectId(id);return native()?normalize(await request('route.read',{projectId:id}),id):browserRead(id)},
  confirmAgent:async(id:string)=>{projectId(id);return native()?normalize(await request('route.agent.confirm',{projectId:id}),id):browserMutate(id,s=>s.agentConfirmed?s:{...s,agentConfirmed:true,revision:s.revision+1})},
  choose:async(state:RoutePreparation,source:'create'|'import',aiAssisted:boolean)=>{
    const id=state.projectId;projectId(id);
    if(native())return normalize(await request('route.choice.save',{projectId:id,source,aiAssisted,expectedRevision:state.revision}),id);
    return browserMutate(id,s=>{if(s.revision!==state.revision)throw new Error('ROUTE_CONFLICT');if(!s.agentConfirmed)throw new Error('ROUTE_INVALID');return{...s,source,aiAssisted,revision:s.revision+1}});
  },
  chooseNative:async(id:string):Promise<RouteStage|null>=>{
    projectId(id);const value=await request<RouteStage|null>('route.import.choose',{projectId:id});
    if(!value)return null;
    if(typeof value.importId!=='string'||typeof value.fileName!=='string')throw new Error('ROUTE_INVALID');
    return{importId:value.importId,fileName:value.fileName.slice(0,255),route:validateRoute(value.route)};
  },
  stageFile:async(id:string,file:File):Promise<RouteStage>=>{
    projectId(id);if(file.size>MAX_ROUTE_BYTES)throw new Error('ROUTE_TOO_LARGE');
    let raw:ArrayBuffer;try{raw=await file.arrayBuffer()}catch{throw new Error('ROUTE_READ_FAILED')}
    let text:string;try{text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw)}catch{throw new Error('ROUTE_INVALID_UTF8')}
    const value={importId:crypto.randomUUID(),fileName:file.name.slice(0,255),route:parseRoute(text)};
    for(const [token,item] of staged)if(Date.now()-item.created>600_000||item.projectId===id)staged.delete(token);
    if(staged.size>=16)throw new Error('ROUTE_STORAGE_UNAVAILABLE');staged.set(value.importId,{projectId:id,value,created:Date.now()});return value;
  },
  saveImport:async(state:RoutePreparation,value:RouteStage)=>{
    const id=state.projectId;projectId(id);
    if(native())return normalize(await request('route.import.save',{projectId:id,importId:value.importId,expectedRevision:state.revision}),id);
    const item=staged.get(value.importId);if(!item||item.projectId!==id||Date.now()-item.created>600_000)throw new Error('ROUTE_IMPORT_EXPIRED');
    const result=await browserMutate(id,s=>{if(s.revision!==state.revision)throw new Error('ROUTE_CONFLICT');if(!s.agentConfirmed)throw new Error('ROUTE_INVALID');return{...s,source:'import',routeDraft:{route:item.value.route,fileName:item.value.fileName},revision:s.revision+1}});
    staged.delete(value.importId);return result;
  },
  removeImport:async(state:RoutePreparation,preserveCreated=false)=>{
    if(native())throw new Error('ROUTE_INVALID');
    return browserMutate(state.projectId,s=>{if(s.revision!==state.revision)throw new Error('ROUTE_CONFLICT');const next:RoutePreparation={...s,source:preserveCreated?'create':null,revision:s.revision+1};delete next.routeDraft;return next});
  },
  cancelImport:async(id:string,token:string)=>{projectId(id);if(native())await request('route.import.cancel',{projectId:id,importId:token});else if(staged.get(token)?.projectId===id)staged.delete(token)},
};
