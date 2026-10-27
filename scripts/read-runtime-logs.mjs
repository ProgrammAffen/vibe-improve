import {privateCloudApi} from './cloudbase-api-private.mjs';
import {RESULT_CODES,sanitizeDetails} from '../cloud/functions/license-api/diagnostic-contract.mjs';
import {writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const actions=new Set(['status','activate','bind','devices','revoke','renew','unknown']);
export function safeCloudRecords(raw){
 const records=new Map();let inspected=0;
 function visit(v,depth=0){
  if(depth>12||++inspected>10000||v==null)return;
  if(Array.isArray(v)){v.slice(0,1000).forEach(x=>visit(x,depth+1));return;}
  if(typeof v==='object'){
   if(v.event==='license_request'&&v.schemaVersion===1&&typeof v.traceId==='string'&&uuid.test(v.traceId)&&actions.has(v.action)&&RESULT_CODES.includes(v.resultCode)&&['info','warn','error'].includes(v.level)&&typeof v.timestamp==='string'&&/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v.timestamp)&&Number.isInteger(v.durationMs)&&v.durationMs>=0&&v.durationMs<=86400000){const r={...sanitizeDetails(v),schemaVersion:1,timestamp:v.timestamp,level:v.level,event:v.event,traceId:v.traceId,action:v.action,resultCode:v.resultCode,durationMs:v.durationMs};if(typeof v.clientTraceId==='string'&&uuid.test(v.clientTraceId))r.clientTraceId=v.clientTraceId;records.set(r.traceId,r);}else Object.values(v).slice(0,1000).forEach(x=>visit(x,depth+1));return;
  }
  if(typeof v!=='string'||v.length>1048576)return;
  try{visit(JSON.parse(v),depth+1);return;}catch{}
  for(const line of v.split('\n').slice(0,1000)){const start=line.indexOf('{');if(start>=0&&line.includes('license_request'))try{visit(JSON.parse(line.slice(start)),depth+1);}catch{}}
 }
 visit(raw);return [...records.values()];
}
export async function readRuntimeLogs({clientTraceId,minutes=30}={}){
 if(clientTraceId!==undefined&&!uuid.test(clientTraceId))throw new Error('INVALID_TRACE_ID');
 if(!Number.isInteger(minutes)||minutes<1||minutes>60)throw new Error('INVALID_TIME_RANGE');
 const format=new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
 const settings={MCP_CLOUD_MODE:'false',CLOUDBASE_MCP_CLOUD_MODE:'false',MCP_CONSOLE_LOG:'false',MCP_DEBUG:'false',DEBUG:''};
 const previous=Object.fromEntries(Object.keys(settings).map(k=>[k,process.env[k]]));Object.assign(process.env,settings);
 try {
 const environment=await privateCloudApi({action:'DescribeEnvs',body:{EnvId:'one-person-company-7dao3979fd72e'}});
 if(!environment.EnvList?.find(e=>e.EnvId==='one-person-company-7dao3979fd72e')?.LogServices?.some(l=>Boolean(l.TopicId)))throw new Error('LOG_RESOURCE_NOT_READY');
 const end=Date.now();const response=await privateCloudApi({action:'SearchClsLog',body:{EnvId:'one-person-company-7dao3979fd72e',StartTime:format.format(new Date(end-minutes*60000)),EndTime:format.format(new Date(end)),QueryString:'function_name:"license-api"'+(clientTraceId?' AND log:"'+clientTraceId+'"':''),Limit:100,Sort:'desc',TenantModel:'public'}});
 return {checkedAt:new Date().toISOString(),provider:'tcb.SearchClsLog',rawLogsStored:false,records:safeCloudRecords(response).filter(r=>!clientTraceId||r.clientTraceId?.toLowerCase()===clientTraceId.toLowerCase())};
 } finally {for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const args=process.argv.slice(2);const trace=args.includes('--client-trace')?args[args.indexOf('--client-trace')+1]:undefined;const output=args.includes('--output')?args[args.indexOf('--output')+1]:undefined;
 try{const result=await readRuntimeLogs({clientTraceId:trace});if(output){const {resolve}=await import('node:path');const target=resolve(output);const allowed=resolve('tmp')+'/';if(!target.startsWith(allowed))throw new Error('OUTPUT_REQUIRES_TMP');await writeFile(target,JSON.stringify(result,null,2)+'\n',{mode:0o600});console.log(JSON.stringify({ok:true,records:result.records.length,rawLogsStored:false}));}else console.log(JSON.stringify(result,null,2));}catch(e){console.log(JSON.stringify({ok:false,code:/^[A-Z][A-Za-z0-9_.-]+$/.test(e.message)?e.message:'QUERY_FAILED'}));process.exitCode=1;}
}
