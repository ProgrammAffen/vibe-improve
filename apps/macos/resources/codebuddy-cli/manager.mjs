import {readFile,writeFile,mkdir,realpath,stat,rename,rm} from 'node:fs/promises';
import {createHash,randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
import {dirname,join,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const resources=dirname(fileURLToPath(import.meta.url));
const distribution=JSON.parse(await readFile(join(resources,'distribution.json'),'utf8'));
const [action,working,...candidates]=process.argv.slice(2);
const output=value=>process.stdout.write(JSON.stringify(value)+'\n');
const digest=data=>createHash('sha256').update(data).digest('hex');
const root=working&&resolve(working);
let child,stage,cancelled=false;
const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^npm_config_|^NODE_OPTIONS$|^NODE_PATH$/i.test(key)));
async function verified(entry){
  try{
    const actual=await realpath(entry),pkg=dirname(dirname(actual));
    if(actual!==join(pkg,'bin','codebuddy'))return null;
    const metadata=JSON.parse(await readFile(join(pkg,'package.json'),'utf8'));
    if(metadata.name!==distribution.name||metadata.version!==distribution.version)return null;
    for(const [name,hash] of Object.entries(distribution.files)){
      const file=await realpath(join(pkg,name));
      if(!file.startsWith(pkg+sep)||digest(await readFile(file))!==hash)return null;
    }
    return actual;
  }catch{return null;}
}
async function npmEntry(){
  for(const path of [...candidates,join(dirname(process.execPath),'npm')]){
    try{
      const file=await realpath(path),pkg=JSON.parse(await readFile(join(dirname(dirname(file)),'package.json'),'utf8'));
      if(pkg.name==='npm'&&file.endsWith('/bin/npm-cli.js'))return file;
    }catch{}
  }
  throw new Error('AGENT_RUNTIME_REQUIRED');
}
function run(file,args){
  return new Promise((yes,no)=>{
    let diagnostics='';
    child=spawn(file,args,{cwd:root,env:{...env,PATH:dirname(process.execPath)+':'+(env.PATH||'/usr/bin:/bin'),TMPDIR:root},stdio:['ignore','ignore','pipe']});
    child.stderr.on('data',chunk=>{diagnostics=(diagnostics+chunk).slice(-65536)});
    child.on('error',()=>no(new Error('AGENT_INSTALL_FAILED')));
    child.on('close',code=>{
      child=undefined;
      if(code===0)return yes();
      no(new Error(/ENOSPC/.test(diagnostics)?'AGENT_DISK_FULL':/EINTEGRITY/.test(diagnostics)?'AGENT_INTEGRITY_FAILED':/ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN/.test(diagnostics)?'AGENT_NETWORK_FAILED':'AGENT_INSTALL_FAILED'));
    });
  });
}
async function install(){
  const npm=await npmEntry();
  const parent=await realpath(root);
  stage=join(parent,'.install-'+randomUUID());
  await mkdir(stage,{mode:0o700});
  for(const file of ['package.json','package-lock.json'])await writeFile(join(stage,file),await readFile(join(resources,file)),{mode:0o600});
  for(const file of ['user.npmrc','global.npmrc'])await writeFile(join(stage,file),'',{mode:0o600});
  const cache=join(parent,'npm-cache');await mkdir(cache,{recursive:true,mode:0o700});
  output({stage:'downloading'});
  await run(process.execPath,[npm,'ci','--prefix',stage,'--cache',cache,'--registry',distribution.registry,'--ignore-scripts','--no-audit','--no-fund','--no-progress','--userconfig',join(stage,'user.npmrc'),'--globalconfig',join(stage,'global.npmrc')]);
  output({stage:'verifying'});
  if(cancelled)throw new Error('AGENT_INSTALL_FAILED');
  if(!await verified(join(stage,'node_modules',distribution.name,'bin/codebuddy')))throw new Error('AGENT_INTEGRITY_FAILED');
  if(cancelled)throw new Error('AGENT_INSTALL_FAILED');
  const target=join(parent,'cli-'+distribution.version),backup=join(parent,'.previous-'+randomUUID());
  let previous=false;
  try{await rename(target,backup);previous=true}catch(error){if(error.code!=='ENOENT')throw error}
  try{await rename(stage,target);stage=undefined}catch(error){if(previous)await rename(backup,target);throw error}
  if(previous)await rm(backup,{recursive:true,force:true});
  output({installed:true,version:distribution.version});
}
process.on('SIGTERM',()=>{
  cancelled=true;
  if(child)child.kill('SIGTERM');
  else if(stage)void rm(stage,{recursive:true,force:true}).finally(()=>process.exit(143));
  else process.exit(143);
});
try{
  if(!root||!['resolve','install'].includes(action))throw new Error('AGENT_INVALID');
  if(action==='resolve'){
    const managed=join(root,'cli-'+distribution.version,'node_modules',distribution.name,'bin/codebuddy');
    let found=null,unverified=false;
    for(const entry of [managed,...candidates]){
      try{await stat(entry);unverified=true}catch{continue}
      found=await verified(entry);if(found)break;
    }
    output({entry:found,state:found?'installed':unverified?'unverified':'not-installed',version:distribution.version});
  }else await install();
}catch(error){
  if(stage)await rm(stage,{recursive:true,force:true}).catch(()=>{});
  output({error:/^AGENT_[A-Z_]+$/.test(error.message)?error.message:'AGENT_INSTALL_FAILED'});process.exitCode=1;
}
