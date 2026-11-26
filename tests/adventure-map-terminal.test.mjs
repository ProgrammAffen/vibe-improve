import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir,mkdtemp} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {createRouteMapPages,MAX_PAGE_NODES,pawPlacement,routeMarkerGap} from '../packages/map-layout/index.mjs';

const route=(sizes,id='terminal-map')=>({id,format:'vibe-improve.route',schemaVersion:2,revision:1,title:'Synthetic learning route',locale:'en',sourceLanguage:'en',chapters:sizes.map((count,ch)=>({id:'ch'+ch,title:'Chapter '+ch,stageGoal:'Learn the topic.',nodes:Array.from({length:count},(_,n)=>({id:`n${ch}_${n}`,title:'Lesson '+n,objectives:[{id:'goal',description:'Apply the topic.'}],prerequisites:[],estimatedMinutes:30}))}))});
const allPaths=page=>[...page.paths,...page.finishPaths];
const allNodes=page=>[...page.nodes,...(page.finish?[page.finish]:[])];
const near=(a,b,epsilon=.15)=>assert.ok(Math.abs(a-b)<=epsilon,`${a} differs from ${b}`);

await mkdir('tmp/checks/map-terminal',{recursive:true});
const directory=await mkdtemp('tmp/checks/map-terminal/ui-'),bundle=resolve(directory,'ui.mjs');
await build({stdin:{contents:`export {projectMapPage} from './apps/local-ui/src/components/adventure-map-viewport.ts';export {default as AdventureMap} from './apps/local-ui/src/components/AdventureMap.tsx';export {renderToStaticMarkup} from 'react-dom/server';export {createElement} from 'react';`,resolveDir:process.cwd(),loader:'tsx'},bundle:true,platform:'node',format:'esm',packages:'external',loader:{'.css':'empty'},define:{'import.meta.env.BASE_URL':'"/vibe-improve/"'},outfile:bundle});
const {projectMapPage,AdventureMap,renderToStaticMarkup,createElement}=await import(pathToFileURL(bundle).href);

test('only the terminal page has a connected flag without changing lesson counts or order',()=>{
 for(const sizes of [[1],[9],[10],[40],[4,5,6,6,6,5,6],Array(9).fill(1)]){
  const original=route(sizes),pages=createRouteMapPages(original),last=pages.at(-1);
  assert.deepEqual(pages.flatMap(page=>page.lessonIds),original.chapters.flatMap(ch=>ch.nodes.map(node=>node.id)));
  assert.ok(pages.every(page=>page.nodes.length===page.totalLessons+page.totalChapters));
  for(const page of pages.slice(0,-1)){assert.equal(page.finish,null);assert.deepEqual(page.finishPaths,[]);}
  assert.equal(last.finish.kind,'finish');
  assert.ok(!last.nodes.some(node=>node.key===last.finish.key));
  assert.equal(last.finishPaths[0].from,last.nodes.at(-1).key);
  assert.equal(last.finishPaths.at(-1).to,last.finish.key);
  near(last.finishPaths[0].start.x,last.nodes.at(-1).x);near(last.finishPaths[0].start.y,last.nodes.at(-1).y);
  near(last.finishPaths.at(-1).end.x,last.finish.x);near(last.finishPaths.at(-1).end.y,last.finish.y);
 }
 assert.deepEqual(createRouteMapPages({id:'empty',chapters:[]}),[]);
});

test('sparse terminal pages unfold toward the right with uniform learning-marker gaps',()=>{
 let sparse=0;
 for(const sizes of [[10],[11],[12],[13],[14],[15],[16],[17],[40],Array(9).fill(1),[4,4,4]]){
  for(let seed=0;seed<6;seed++){
   const sample=route(sizes,'terminal-gap-'+sizes.join('-')+'-'+seed),pages=createRouteMapPages(sample),last=pages.at(-1);
   if(!last.compact||pages.length<2)continue;
   sparse++;
   assert.ok(last.spacing>=125);
   for(let i=0;i<last.nodes.length-1;i++)near(routeMarkerGap(last.nodes.slice(i,i+2),last.paths.filter(path=>path.leg===i),last.themeId),last.spacing);
   for(const path of last.paths)assert.ok(path.start.x<=path.control1.x&&path.control1.x<=path.control2.x&&path.control2.x<=path.end.x,'A sparse final page must not bend back toward its beginning');
   assert.deepEqual(createRouteMapPages(sample).at(-1).finish,last.finish);
  }
 }
 assert.ok(sparse>=24);
});

test('screen projection preserves expanded short pages and keeps flags clear of navigation',()=>{
 for(const sizes of [[10],[12],[14],[16],[40],Array(9).fill(1)]){
  const pages=createRouteMapPages(route(sizes,'projected-'+sizes.join('-'))),last=pages.at(-1),previous=pages.at(-2);
  for(const [width,height,top,bottom] of [[960,540,118,80],[1280,800,140,98],[1920,1080,142,96],[2560,1080,146,100]]){
   const viewport={width,height,top,bottom},projected=projectMapPage(last,viewport,previous),page=projected.page;
   const reference=projectMapPage(previous,viewport).page;
   if(last.compact){assert.ok(page.nodes[0].x<page.nodes.at(-1).x);assert.ok((page.nodes[0].y<page.nodes.at(-1).y)===(last.nodes[0].y<last.nodes.at(-1).y));}
   const scale=width/1672;
   assert.ok((page.finish.y-page.finish.height)*scale>=top-1);
   assert.ok(page.finish.y*scale<=height-bottom+1);
   assert.ok((page.finish.x-page.finish.width/2)*scale>=0);
   assert.ok((page.finish.x+page.finish.width/2)*scale<=width);
   for(const node of allNodes(page))assert.ok(Number.isFinite(node.x)&&Number.isFinite(node.y));
   near(page.finishPaths.at(-1).end.x,page.finish.x);near(page.finishPaths.at(-1).end.y,page.finish.y);
  }
 }
});

test('resizing preserves opposite endpoints and redistributes learning markers uniformly without cropping the page',()=>{
 for(const sizes of [[1],[4],[10],Array(20).fill(5)]){
  const pages=createRouteMapPages(route(sizes,'resized-endpoints-'+sizes.join('-')));
  for(const original of pages) for(const viewport of [{width:960,height:540,top:118,bottom:80},{width:1440,height:960,top:140,bottom:98},{width:2560,height:1080,top:146,bottom:100}]){
   const page=projectMapPage(original,viewport).page,first=page.nodes[0],last=page.nodes.at(-1);
   assert.ok(first.x<last.x,'Resizing must retain the left-to-right endpoints');
   assert.ok(first.x>=1672*.1&&last.x<=1672*.9,'Endpoints stay inside the central map frame');
   assert.equal(first.y<last.y,original.nodes[0].y<original.nodes.at(-1).y);
   for(let index=0;index<page.nodes.length-1;index++)near(routeMarkerGap(page.nodes.slice(index,index+2),page.paths.filter(path=>path.leg===index),page.themeId),page.spacing);
   near(page.paths.at(-1).end.x,last.x);near(page.paths.at(-1).end.y,last.y);
   if(page.finish){near(page.finishPaths[0].start.x,last.x);near(page.finishPaths[0].start.y,last.y);}
  }
 }
});

test('dense terminal pages retain uniform chapter spacing and a clear finish without losing markers',()=>{
 for(const count of [5,10,15,20]){
  for(let seed=0;seed<8;seed++){
   const pages=createRouteMapPages(route(Array(count).fill(1),'terminal-stress-'+seed)),page=pages.at(-1);
   assert.equal(pages.flatMap(p=>p.lessonIds).length,count);
   assert.ok(page.nodes.length<=MAX_PAGE_NODES);
   const gap=routeMarkerGap(page.nodes,page.paths,page.themeId);
   for(let i=0;i<page.nodes.length-1;i++)near(routeMarkerGap(page.nodes.slice(i,i+2),page.paths.filter(path=>path.leg===i),page.themeId),gap);
   const flag=page.finish;
   assert.ok(Number.isFinite(flag.x)&&Number.isFinite(flag.y));
   for(const node of page.nodes){
    const top=node.y-node.height/(node.kind==='lesson'?2:1),bottom=node.y+(node.kind==='lesson'?node.height/2:24);
    assert.ok(flag.x+flag.width/2<node.x-node.width/2||flag.x-flag.width/2>node.x+node.width/2||flag.y<top||flag.y-flag.height>bottom);
   }
   const end=page.finishPaths.at(-1).end;
   near(end.x,flag.x);near(end.y,flag.y);
  }
 }
 const maximum=createRouteMapPages(route(Array.from({length:24},(_,i)=>i<8?22:21),'maximum-finish-map'));
 assert.equal(maximum.flatMap(page=>page.lessonIds).length,512);
 assert.equal(maximum.at(-1).finish.kind,'finish');
});

test('a full one-page route has room for the flag after a folded trail',()=>{
 for(const [sizes,id] of [[[1,1,1,1,1],'stress-density-0-1'],[[2,1,2,1],'stress-density-2-2']]){
  const pages=createRouteMapPages(route(sizes,id));
  assert.equal(pages.length,1);
  const [page]=pages,last=page.nodes.at(-1);
  assert.equal(page.nodes.length,MAX_PAGE_NODES);
  assert.ok(page.finish.x>last.x);
  assert.equal(page.finishPaths[0].from,last.key);
  assert.equal(page.finishPaths.at(-1).to,page.finish.key);
 }
});

test('a page with one remaining lesson directs its footprint toward the finish path',()=>{
 const pages=createRouteMapPages(route([10],'one-final-lesson')),terminal=pages.at(-1);
 const last={...terminal,nodes:[terminal.nodes.at(-1)],paths:[]};
 assert.equal(last.nodes.length,1);
 const node=last.nodes[0],placement=pawPlacement(last,node),out=last.finishPaths[0];
 const dx=out.control1.x-out.start.x,dy=out.control1.y-out.start.y,length=Math.hypot(dx,dy);
 near(placement.tangent.x,dx/length,.000001);near(placement.tangent.y,dy/length,.000001);
});

test('rendered flags are localized decorations and never additional learning controls',()=>{
 const original=route([14]),lastId=original.chapters[0].nodes.at(-1).id;
 const props={route:original,onStartLesson(){},onEdit(){},onBack(){}};
 for(const language of ['zh-CN','en']){
  const first=renderToStaticMarkup(createElement(AdventureMap,{...props,language}));
  assert.doesNotMatch(first,/class="adventure-finish-flag"/);
  const final=renderToStaticMarkup(createElement(AdventureMap,{...props,language,initialNodeId:lastId}));
  assert.equal((final.match(/class="adventure-finish-flag"/g)??[]).length,1);
  assert.match(final,language==='en'?/aria-label="End of route"/:/aria-label="路线终点"/);
  assert.doesNotMatch(final,/<button[^>]*data-kind="finish"/);
 }
});
