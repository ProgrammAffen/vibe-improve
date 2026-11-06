import {readFile,writeFile,readdir} from 'node:fs/promises';
import {dirname,resolve,join} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const repositoryRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const canonical=value=>Array.isArray(value)?value.map(canonical):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])])):value;
const json=value=>JSON.stringify(canonical(value));
const readJSON=async path=>JSON.parse(await readFile(path,'utf8'));
const record=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const supportedTypes=new Set(['object','array','string','boolean','integer','null']);
const annotations=new Set(['$schema','$id','title','description','$comment','default','examples','deprecated','readOnly','writeOnly']);
const keywords=new Set([...annotations,'$ref','$defs','type','enum','const','properties','required','additionalProperties','propertyNames','items','anyOf','oneOf','allOf','if','then','not','minLength','maxLength','pattern','minimum','maximum','minItems','maxItems','uniqueItems']);
const schemaMaps=['$defs','properties'],schemaLists=['anyOf','oneOf','allOf'],schemaChildren=['propertyNames','items','if','then','not'];

function schemaReferences(rule){
  if(!record(rule))throw new Error('Unsupported planning schema: expected a schema object');
  const references=[];
  const visit=node=>{
    if(!record(node))throw new Error('Unsupported planning schema: expected a schema object');
    if(Object.hasOwn(node,'$ref')){
      if(typeof node.$ref!=='string'||!/^#\/\$defs\/[^/~]+$/.test(node.$ref))throw new Error('Unsupported planning schema reference');
      references.push(node.$ref.slice(8));
    }
    for(const key of schemaMaps)if(Object.hasOwn(node,key)){
      if(!record(node[key]))throw new Error('Invalid planning schema map: '+key);
      Object.values(node[key]).forEach(visit);
    }
    for(const key of schemaLists)if(Object.hasOwn(node,key)){
      if(!Array.isArray(node[key]))throw new Error('Invalid planning schema list: '+key);
      node[key].forEach(visit);
    }
    for(const key of schemaChildren)if(Object.hasOwn(node,key))visit(node[key]);
  };
  visit(rule);return references;
}

// Only this vocabulary may reach either of the two intentionally small validators.
// Property/definition names and const/enum/example data are not schema keywords.
export function assertSchemaVocabulary(schema){
  if(!record(schema))throw new Error('Unsupported planning schema: expected a schema object');
  const definitions=schema.$defs??{};
  if(!record(definitions))throw new Error('Invalid planning schema map: $defs');
  const active=new Set();
  const check=rule=>{
    if(!record(rule)||active.has(rule))throw new Error('Unsupported planning schema object');
    active.add(rule);
    for(const [key,value] of Object.entries(rule)){
      if(!keywords.has(key))throw new Error('Unsupported planning schema keyword: '+key);
      if(schemaMaps.includes(key)){
        if(!record(value))throw new Error('Invalid planning schema map: '+key);
        Object.values(value).forEach(check);
      }else if(schemaLists.includes(key)){
        if(!Array.isArray(value)||value.length===0)throw new Error('Invalid planning schema list: '+key);
        value.forEach(check);
      }else if(schemaChildren.includes(key)){check(value)}
      else if(key==='$ref'){
        if(typeof value!=='string'||!/^#\/\$defs\/[^/~]+$/.test(value)||!Object.hasOwn(definitions,value.slice(8)))throw new Error('Unsupported or missing planning schema reference');
      }else if(key==='type'){
        if(!supportedTypes.has(value))throw new Error('Unsupported planning schema type');
      }else if(key==='required'){
        if(!Array.isArray(value)||value.some(item=>typeof item!=='string')||new Set(value).size!==value.length)throw new Error('Invalid planning schema required list');
      }else if(['minLength','maxLength','minItems','maxItems'].includes(key)){
        if(!Number.isSafeInteger(value)||value<0)throw new Error('Invalid planning schema bound: '+key);
      }else if(['minimum','maximum'].includes(key)){
        if(typeof value!=='number'||!Number.isFinite(value))throw new Error('Invalid planning schema bound: '+key);
      }else if(['additionalProperties','uniqueItems','deprecated','readOnly','writeOnly'].includes(key)){
        if(typeof value!=='boolean')throw new Error('Unsupported planning schema flag: '+key);
      }else if(key==='enum'){
        if(!Array.isArray(value)||value.length===0)throw new Error('Invalid planning schema enum');
      }else if(key==='examples'){
        if(!Array.isArray(value))throw new Error('Invalid planning schema examples');
      }else if(key==='pattern'){
        if(typeof value!=='string')throw new Error('Invalid planning schema pattern');
        try{new RegExp(value,'u')}catch{throw new Error('Invalid planning schema pattern')}
      }else if(key==='$schema'){
        if(value!=='https://json-schema.org/draft/2020-12/schema')throw new Error('Unsupported planning schema dialect');
      }else if(key==='$id'&&rule!==schema){
        throw new Error('Unsupported scoped planning schema identifier');
      }else if(['$id','title','description','$comment'].includes(key)&&typeof value!=='string')throw new Error('Invalid planning schema annotation: '+key);
    }
    active.delete(rule);
  };
  check(schema);
  const visiting=new Set(),visited=new Set();
  const reference=name=>{
    if(visiting.has(name))throw new Error('Unsupported recursive planning schema reference');
    if(visited.has(name))return;
    visiting.add(name);for(const child of schemaReferences(definitions[name]))reference(child);
    visiting.delete(name);visited.add(name);
  };
  for(const name of Object.keys(definitions))reference(name);
  return schema;
}

export async function loadPromptPack(root=repositoryRoot){
  const directory=join(root,'packages/planning-prompts'),manifest=await readJSON(join(directory,'manifest.json'));
  const files=[...new Set([...manifest.base,manifest.learningStandard,manifest.repair,...Object.values(manifest.tasks),...Object.values(manifest.sharedRules??{}).flat()])];
  const prompts=Object.fromEntries(await Promise.all(files.map(async name=>[name,(await readFile(join(directory,'prompts',name),'utf8')).trim()])));
  const schema=await readJSON(join(directory,manifest.responseSchema)),imports={};
  for(const [name,path] of Object.entries(manifest.schemaImports??{}))imports[name]=await readJSON(resolve(directory,path));
  const rewrite=(value,namespace='')=>{
    if(!record(value))return value;
    return Object.fromEntries(Object.entries(value).map(([key,item])=>{
      if(key==='$ref'){
        if(item.startsWith('#/$defs/'))return [key,'#/$defs/'+namespace+item.slice(8)];
        const match=/^([^#]+)#\/\$defs\/(.+)$/.exec(item);
        if(!match||!imports[match[1]])throw new Error('Unknown prompt schema import');
        return [key,'#/$defs/import_'+match[1].replace(/[^A-Za-z0-9]/g,'_')+'_'+match[2]];
      }
      if(schemaMaps.includes(key)&&record(item))return [key,Object.fromEntries(Object.entries(item).map(([name,rule])=>[name,rewrite(rule,namespace)]))];
      if(schemaLists.includes(key)&&Array.isArray(item))return [key,item.map(rule=>rewrite(rule,namespace))];
      if(schemaChildren.includes(key))return [key,rewrite(item,namespace)];
      return [key,item];
    }));
  };
  const resolved=rewrite(schema);
  for(const [name,imported] of Object.entries(imports)){
    const prefix='import_'+name.replace(/[^A-Za-z0-9]/g,'_')+'_';
    for(const [key,value] of Object.entries(imported.$defs))resolved.$defs[prefix+key]=rewrite(value,prefix);
  }
  const examples=await Promise.all((await readdir(join(directory,'examples'))).filter(name=>name.endsWith('.json')).sort().map(name=>readJSON(join(directory,'examples',name))));
  return {manifest,prompts,schema:resolved,examples};
}

export function assembleTask(pack,task,{repair=false}={}){
  if(!Object.hasOwn(pack.manifest.tasks,task))throw new Error('Unknown planning task');
  const definitions=Object.create(null),pending=[task+'Response'];
  while(pending.length){
    const name=pending.pop();if(Object.hasOwn(definitions,name))continue;
    const definition=Object.hasOwn(pack.schema.$defs,name)?pack.schema.$defs[name]:null;if(!definition)throw new Error('Missing planning schema definition');
    definitions[name]=definition;pending.push(...schemaReferences(definition));
  }
  const schema={$schema:pack.schema.$schema,$ref:'#/$defs/'+task+'Response',$defs:definitions};
  assertSchemaVocabulary(schema);
  const files=[...pack.manifest.base,...(pack.manifest.learningTasks.includes(task)?[pack.manifest.learningStandard]:[]),...(pack.manifest.sharedRules?.[task]??[]),pack.manifest.tasks[task],...(repair?[pack.manifest.repair]:[])];
  const examples=pack.examples.filter(example=>example.task===task).map(({input,response})=>({input,response}));
  const system=files.map(file=>pack.prompts[file]).join('\n\n')+'\n\nPROMPT_VERSION: '+pack.manifest.version+'\n\nEXAMPLES（仅为示例，不是当前用户事实）：\n'+json(examples)+'\n\nOUTPUT_SCHEMA:\n'+json(schema);
  return {system,schema,examples};
}

// This deliberately small validator covers the complete canonical task schema vocabulary.
export function matchesSchema(value,rule,root=rule){
  assertSchemaVocabulary(root);
  // A caller may supply a subschema separately from the root definitions.
  if(rule!==root)assertSchemaVocabulary({...rule,$defs:root.$defs??{}});
  return matches(value,rule,root);
}
function matches(value,rule,root,depth=0){
  if(depth>64)return false;
  const next=(input,part)=>matches(input,part,root,depth+1);
  if(rule.$ref&&!next(value,root.$defs[rule.$ref.slice(8)]))return false;
  if(rule.anyOf&&!rule.anyOf.some(item=>next(value,item)))return false;
  if(rule.oneOf&&rule.oneOf.filter(item=>next(value,item)).length!==1)return false;
  if(rule.allOf&&!rule.allOf.every(item=>next(value,item)))return false;
  if(rule.if&&next(value,rule.if)&&rule.then&&!next(value,rule.then))return false;
  if(rule.not&&next(value,rule.not))return false;
  if(Object.hasOwn(rule,'const')&&json(value)!==json(rule.const))return false;
  if(rule.enum&&!rule.enum.some(item=>json(value)===json(item)))return false;
  const object=value!==null&&typeof value==='object'&&!Array.isArray(value);
  if(rule.type==='object'&&!object||rule.type==='array'&&!Array.isArray(value)||rule.type==='string'&&typeof value!=='string'||rule.type==='boolean'&&typeof value!=='boolean'||rule.type==='null'&&value!==null||rule.type==='integer'&&(!Number.isSafeInteger(value)||typeof value!=='number'))return false;
  if(typeof value==='string'){
    const length=[...value].length;
    if(value.includes('\0')||length<(rule.minLength??0)||length>(rule.maxLength??Infinity)||rule.pattern&&!new RegExp(rule.pattern,'u').test(value))return false;
  }
  if(typeof value==='number'&&(!Number.isFinite(value)||value<(rule.minimum??-Infinity)||value>(rule.maximum??Infinity)))return false;
  if(Array.isArray(value)){
    if(value.length<(rule.minItems??0)||value.length>(rule.maxItems??Infinity)||rule.uniqueItems&&new Set(value.map(json)).size!==value.length)return false;
    if(rule.items&&!value.every(item=>next(item,rule.items)))return false;
  }
  if(object){
    if(rule.required&&!rule.required.every(key=>Object.hasOwn(value,key)))return false;
    if(rule.additionalProperties===false&&Object.keys(value).some(key=>!Object.hasOwn(rule.properties??{},key)))return false;
    if(rule.propertyNames&&!Object.keys(value).every(key=>next(key,rule.propertyNames)))return false;
    if(rule.properties&&!Object.keys(value).every(key=>!rule.properties[key]||next(value[key],rule.properties[key])))return false;
  }
  return true;
}

function swiftLiteral(value){
  let hashes='#';while(value.includes('"""'+hashes)||value.includes('\\'+hashes+'('))hashes+='#';
  return hashes+'"""\n'+value+'\n"""'+hashes;
}

export function renderSwift(pack){
  const tasks=Object.keys(pack.manifest.tasks).sort();
  const systems=Object.fromEntries(tasks.map(task=>[task,assembleTask(pack,task).system]));
  const repairSystems=Object.fromEntries(tasks.map(task=>[task,assembleTask(pack,task,{repair:true}).system]));
  const schemas=Object.fromEntries(tasks.map(task=>[task,assembleTask(pack,task).schema]));
  return '// Generated by scripts/build-planning-prompts.mjs. Edit packages/planning-prompts instead.\nimport Foundation\n\nextension PlanningPromptPack {\n'+
    '    static let version = '+swiftLiteral(pack.manifest.version)+'\n'+
    '    static let policy = '+swiftLiteral(pack.manifest.base.map(name=>pack.prompts[name]).join('\n\n'))+'\n'+
    '    static let learning = '+swiftLiteral(pack.prompts[pack.manifest.learningStandard])+'\n'+
    '    static let repairInstructions = '+swiftLiteral(pack.prompts[pack.manifest.repair])+'\n'+
    '    static let taskSystemsJSON = '+swiftLiteral(json(systems))+'\n'+
    '    static let taskRepairSystemsJSON = '+swiftLiteral(json(repairSystems))+'\n'+
    '    static let taskSchemasJSON = '+swiftLiteral(json(schemas))+'\n'+
    '}\n';
}

async function main(){
  const pack=await loadPromptPack();
  for(const example of pack.examples){const {schema}=assembleTask(pack,example.task);if(!matchesSchema(example.response,schema,schema))throw new Error('Invalid planning example: '+example.name)}
  const destination=join(repositoryRoot,'apps/macos/PlanningPromptPackResources.swift'),output=renderSwift(pack);
  if(process.argv.includes('--check')){if(await readFile(destination,'utf8')!==output)throw new Error('Planning prompt resources are stale; run node scripts/build-planning-prompts.mjs');console.log('Planning prompt resources are current.');return}
  await writeFile(destination,output);console.log('Built planning prompt resources: '+pack.manifest.version);
}
if(process.argv[1]&&pathToFileURL(resolve(process.argv[1])).href===import.meta.url)main().catch(error=>{console.error(error.message);process.exitCode=1});
