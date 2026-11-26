import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdir,mkdtemp,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {createRouteMapPages,WIDTH} from '../packages/map-layout/index.mjs';

await mkdir('tmp/checks/map-badges',{recursive:true});
const directory=await mkdtemp('tmp/checks/map-badges/ui-'),bundle=resolve(directory,'ui.mjs');
await build({stdin:{contents:`export {projectMapPage} from './apps/local-ui/src/components/adventure-map-viewport.ts';
 export {mapArtworkBoxes,mapLessonBadgeBox,mapCornerExclusions} from './apps/local-ui/src/components/map-scene-frame.ts';`,
 resolveDir:process.cwd(),loader:'ts'},bundle:true,platform:'node',format:'esm',outfile:bundle});
const {projectMapPage,mapArtworkBoxes,mapLessonBadgeBox,mapCornerExclusions}=await import(pathToFileURL(bundle).href);
const css=await readFile('apps/local-ui/src/components/adventure-map.css','utf8');
const rule=css.match(/\.adventure-marker-badge\s*\{([^}]+)\}/)[1];
const right=Number(rule.match(/right:\s*(-?[\d.]+)%/)[1])/100;
const top=Number(rule.match(/top:\s*(-?[\d.]+)%/)[1])/100;
const [,minimum,percent,maximum]=rule.match(/clamp\(([\d.]+)px,\s*([\d.]+)cqw,\s*([\d.]+)px\)/).map(Number);
const overlaps=(a,b)=>Math.min(a.right,b.right)-Math.max(a.left,b.left)>.2&&Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top)>.2;
const route=(sizes,id)=>({id,chapters:sizes.map((count,chapter)=>({id:'ch'+chapter,title:'Chapter '+chapter,
 nodes:Array.from({length:count},(_,lesson)=>({id:`n${chapter}_${lesson}`,title:'Lesson '+lesson}))}))});

test('the detached rendered badges stay outside corners and clear of other chapter artwork',()=>{
 for(const sizes of [Array(20).fill(5),Array(24).fill(1),[1,4,1,2,3,1,5]]){
  const pages=createRouteMapPages(route(sizes,'detached-badge-'+sizes.join('-')));
  for(const source of pages)for(const viewport of [
   {width:960,height:540,top:118,bottom:80},{width:1280,height:800,top:140,bottom:98},
   {width:1440,height:960,top:140,bottom:98},{width:2560,height:1080,top:146,bottom:100},
  ]){
   const projected=projectMapPage(source,viewport),page=projected.page,pixelScale=viewport.width/WIDTH;
   const corners=mapCornerExclusions(projected.height),nodes=[...page.nodes,...(page.finish?[page.finish]:[])];
   for(const node of page.nodes.filter(node=>node.kind==='lesson')){
    const size=Math.max(minimum,Math.min(maximum,viewport.width*percent/100))*(node.artworkScale??1)/pixelScale;
    const actualRight=node.x+node.width/2-right*node.width,actualTop=node.y-node.height/2+top*node.height;
    const actual={left:actualRight-size,right:actualRight,top:actualTop,bottom:actualTop+size};
    const reserved=mapLessonBadgeBox(node);
    assert.ok(actual.left>=reserved.left-.01&&actual.right<=reserved.right+.01&&actual.top>=reserved.top-.01&&actual.bottom<=reserved.bottom+.01,
     'The layout reservation must contain the actual CSS badge at every viewport');
    assert.ok((actual.left+actual.right)/2>node.x&&actual.top<node.y-node.height/2,'A status badge belongs at the outer upper-right edge');
    assert.ok(Math.hypot((actual.left+actual.right)/2-node.x,(actual.top+actual.bottom)/2-node.y)>node.width*.45,
     'The status badge must be clearly away from the footprint center');
    assert.ok(!corners.some(corner=>overlaps(actual,corner)),'A detached badge cannot enter a decorated corner');
    for(const other of nodes)if(other.key!==node.key)assert.ok(!mapArtworkBoxes(other,page.themeId).some(box=>overlaps(actual,box)),
     'A detached badge cannot cover another chapter, footprint, sign or flag');
   }
  }
 }
});
