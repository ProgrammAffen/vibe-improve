import schema from '../../contracts/route.schema.json' with {type:'json'};

export const MAX_ROUTE_BYTES = 1_048_576;
export const MAX_ROUTE_DEPTH = 16;
export const MAX_ROUTE_NODES = 512;
const fail = code => {throw new Error(code)};
function bytes(text) {
  let count=0;
  for(let i=0;i<text.length;i++){
    const n=text.charCodeAt(i);
    if(n>=0xd800&&n<=0xdbff){const next=text.charCodeAt(++i);if(!(next>=0xdc00&&next<=0xdfff))fail('ROUTE_INVALID_JSON');count+=4}
    else if(n>=0xdc00&&n<=0xdfff)fail('ROUTE_INVALID_JSON');
    else count+=n<128?1:n<2048?2:3;
  }
  return count;
}
function strictJSON(text) {
  if(typeof text!=='string')fail('ROUTE_INVALID_JSON');
  if(text.length>MAX_ROUTE_BYTES||bytes(text)>MAX_ROUTE_BYTES)fail('ROUTE_TOO_LARGE');
  let i=0;
  const space=()=>{while(/[\x20\t\n\r]/.test(text[i]??'!'))i++};
  function string(){
    const start=i++;let escaped=false;
    for(;i<text.length;i++){
      const c=text[i];
      if(!escaped&&c==='"'){i++;try{const value=JSON.parse(text.slice(start,i));bytes(value);return value}catch{fail('ROUTE_INVALID_JSON')}}
      if(!escaped&&c==='\\')escaped=true;else escaped=false;
    }
    fail('ROUTE_INVALID_JSON');
  }
  function value(depth){
    if(depth>MAX_ROUTE_DEPTH)fail('ROUTE_DEPTH_LIMIT');
    space();const c=text[i];
    if(c==='"'){string();return}
    if(c==='{'||c==='['){
      const object=c==='{',end=object?'}':']',keys=new Set();i++;space();
      if(text[i]===end){i++;return}
      while(i<text.length){
        if(object){if(text[i]!=='"')fail('ROUTE_INVALID_JSON');const key=string();if(keys.has(key))fail('ROUTE_DUPLICATE_KEYS');keys.add(key);space();if(text[i++]!==':')fail('ROUTE_INVALID_JSON')}
        value(depth+1);space();if(text[i]===end){i++;return}if(text[i++]!==',')fail('ROUTE_INVALID_JSON');space();
      }
      fail('ROUTE_INVALID_JSON');
    }
    const token=/^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/.exec(text.slice(i));
    if(!token)fail('ROUTE_INVALID_JSON');i+=token[0].length;
  }
  value(0);space();if(i!==text.length)fail('ROUTE_INVALID_JSON');
  try{return JSON.parse(text)}catch{fail('ROUTE_INVALID_JSON')}
}
function matches(value,rule){
  if(rule.oneOf&&rule.oneOf.filter(candidate=>matches(value,candidate)).length!==1)return false;
  if(rule.allOf&&!rule.allOf.every(candidate=>matches(value,candidate)))return false;
  if(rule.if&&matches(value,rule.if)&&rule.then&&!matches(value,rule.then))return false;
  if(rule.$ref){let target=schema;for(const key of rule.$ref.slice(2).split('/'))target=target[key];return matches(value,target)}
  if(rule.const!==undefined&&value!==rule.const)return false;
  if(rule.enum&&!rule.enum.includes(value))return false;
  if(rule.not&&matches(value,rule.not))return false;
  if(rule.type==='object'&&(!value||typeof value!=='object'||Array.isArray(value)))return false;
  if(rule.type==='array'&&!Array.isArray(value))return false;
  if(rule.type==='string'&&typeof value!=='string')return false;
  if(rule.type==='integer'&&(!Number.isSafeInteger(value)||typeof value!=='number'))return false;
  if(typeof value==='number'&&!Number.isFinite(value))return false;
  if(typeof value==='string'){
    const length=[...value].length;
    if(rule.minLength!==undefined&&length<rule.minLength||rule.maxLength!==undefined&&length>rule.maxLength)return false;
    if(rule.pattern&&!new RegExp(rule.pattern,'u').test(value))return false;
  }
  if(typeof value==='number'&&(rule.minimum!==undefined&&value<rule.minimum||rule.maximum!==undefined&&value>rule.maximum))return false;
  if(Array.isArray(value)){
    if(rule.minItems!==undefined&&value.length<rule.minItems||rule.maxItems!==undefined&&value.length>rule.maxItems)return false;
    if(rule.uniqueItems&&new Set(value.map(item=>JSON.stringify(item))).size!==value.length)return false;
    if(rule.items&&!value.every(item=>matches(item,rule.items)))return false;
  }
  if(value&&typeof value==='object'&&!Array.isArray(value)){
    if(rule.required&&!rule.required.every(key=>Object.hasOwn(value,key)))return false;
    if(rule.additionalProperties===false&&Object.keys(value).some(key=>!Object.hasOwn(rule.properties??{},key)))return false;
    if(rule.properties&&Object.keys(value).some(key=>rule.properties[key]&&!matches(value[key],rule.properties[key])))return false;
  }
  return true;
}
export function validateRoute(route){
  if(route?.format==='vibe-improve.route'&&![1,2].includes(route.schemaVersion))fail('ROUTE_VERSION_UNSUPPORTED');
  if(!matches(route,schema))fail('ROUTE_INVALID');
  const chapters=new Set(),nodes=new Map();
  for(const chapter of route.chapters){
    if(chapters.has(chapter.id))fail('ROUTE_INVALID');chapters.add(chapter.id);
    for(const node of chapter.nodes){
      if(nodes.has(node.id))fail('ROUTE_INVALID');nodes.set(node.id,node);
      const objectives=new Set(node.objectives.map(item=>item.id));
      if(objectives.size!==node.objectives.length)fail('ROUTE_INVALID');
      if(node.assessment&&(node.assessment.objectiveIds.length!==objectives.size||node.assessment.objectiveIds.some(id=>!objectives.has(id))))fail('ROUTE_INVALID');
    }
  }
  if(nodes.size>MAX_ROUTE_NODES)fail('ROUTE_TOO_MANY_NODES');
  const indegree=new Map(),dependents=new Map();
  for(const id of nodes.keys()){indegree.set(id,0);dependents.set(id,[])}
  for(const [id,node] of nodes)for(const prerequisite of node.prerequisites){
    if(prerequisite===id||!nodes.has(prerequisite))fail('ROUTE_INVALID');
    indegree.set(id,indegree.get(id)+1);dependents.get(prerequisite).push(id);
  }
  const ready=[...nodes.keys()].filter(id=>indegree.get(id)===0);let visited=0;
  for(let index=0;index<ready.length;index++){visited++;for(const id of dependents.get(ready[index])){indegree.set(id,indegree.get(id)-1);if(indegree.get(id)===0)ready.push(id)}}
  if(visited!==nodes.size)fail('ROUTE_INVALID');
  return route;
}
export function parseRoute(text){return validateRoute(strictJSON(text))}
export function routeIssues(route){
  try{validateRoute(route);return []}catch{}
  const issues=[],add=(path,code)=>{if(issues.length<100&&!issues.some(x=>x.path===path))issues.push({path,code})};
  function collect(value,rule,path){
    if(matches(value,rule))return;
    if(rule.$ref){let target=schema;for(const key of rule.$ref.slice(2).split('/'))target=target[key];collect(value,target,path);return}
    for(const item of rule.allOf??[])collect(value,item,path);
    if(rule.if&&matches(value,rule.if)&&rule.then)collect(value,rule.then,path);
    if((rule.type==='object'||rule.properties||rule.required)&&value&&typeof value==='object'&&!Array.isArray(value)){
      for(const key of rule.required??[])if(!Object.hasOwn(value,key))add(path?path+'.'+key:key,'required');
      for(const [key,item] of Object.entries(value))if(rule.properties?.[key])collect(item,rule.properties[key],path?path+'.'+key:key);else if(rule.additionalProperties===false)add(path?path+'.'+key:key,'invalid');
    }else if(rule.type==='array'&&Array.isArray(value)){
      if(value.length<(rule.minItems??0)||value.length>(rule.maxItems??Infinity))add(path,'count');
      if(rule.uniqueItems&&new Set(value.map(x=>JSON.stringify(x))).size!==value.length)add(path,'duplicate');
      if(rule.items)value.forEach((x,i)=>collect(x,rule.items,path+'.'+i));
    }else add(path,typeof value==='string'&&!value.trim()?'required':'invalid');
  }
  collect(route,schema.$defs[route?.schemaVersion===1?'routeV1':'routeV2'],'');
  if(!issues.length){
    const chapters=new Set(),nodes=new Map();
    route.chapters.forEach((ch,ci)=>{
      if(chapters.has(ch.id))add(`chapters.${ci}.id`,'duplicate');chapters.add(ch.id);
      ch.nodes.forEach((n,ni)=>{const path=`chapters.${ci}.nodes.${ni}`;
        if(nodes.has(n.id))add(path+'.id','duplicate');nodes.set(n.id,{node:n,path});
        const ids=new Set(n.objectives.map(o=>o.id));if(ids.size!==n.objectives.length)add(path+'.objectives','duplicate');
        if(n.assessment&&(n.assessment.objectiveIds.length!==ids.size||n.assessment.objectiveIds.some(id=>!ids.has(id))))add(path+'.assessment.objectiveIds','invalid');
      });
    });
    if(nodes.size>MAX_ROUTE_NODES)add('chapters','count');
    const indegree=new Map(),dependents=new Map();for(const id of nodes.keys()){indegree.set(id,0);dependents.set(id,[])}
    for(const [id,{node,path}] of nodes)for(const prerequisite of node.prerequisites){
      if(!nodes.has(prerequisite)||prerequisite===id){add(path+'.prerequisites','dependencies');continue}
      indegree.set(id,indegree.get(id)+1);dependents.get(prerequisite).push(id);
    }
    const ready=[...nodes.keys()].filter(id=>indegree.get(id)===0);
    for(let i=0;i<ready.length;i++)for(const id of dependents.get(ready[i])){indegree.set(id,indegree.get(id)-1);if(indegree.get(id)===0)ready.push(id)}
    for(const [id,count] of indegree)if(count>0)add(nodes.get(id).path+'.prerequisites','dependencies');
  }
  if(!issues.length)add('chapters','dependencies');
  return issues;
}
export function parseBoundedJSON(text){return strictJSON(text)}
export function summarizeRoute(route){validateRoute(route);return{chapters:route.chapters.length,nodes:route.chapters.reduce((sum,c)=>sum+c.nodes.length,0)}}
