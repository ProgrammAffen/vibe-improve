import {mapAsset, type MapTerrain} from './adventure-map-art';
import {MAP_BACKGROUND_SOURCE as SOURCE,MAP_BACKGROUND_DESTINATION as DESTINATION} from './map-scene-frame';
import './map-background.css';

const WIDTH=1672, HEIGHT=941;
const BLEED=1;
// Keep each corner's trees and rocks together. Compress the decorated rim by
// about one fifth and use the recovered space for the uninterrupted ground.
const patches=Array.from({length:9},(_,index)=>({column:index%3,row:Math.floor(index/3)}));

function patchAxis(index: number, size: number) {
  const sourceStart=SOURCE[index]*size,sourceSize=(SOURCE[index+1]-SOURCE[index])*size;
  const start=DESTINATION[index]*size,length=(DESTINATION[index+1]-DESTINATION[index])*size;
  const before=index>0?BLEED:0,after=index<2?BLEED:0;
  // Extend both coordinate systems by the same linear mapping. Merely growing
  // a viewport would rescale its image and misalign the neighboring terrain.
  const sourcePerPixel=sourceSize/length;
  return {start:start-before,length:length+before+after,
    sourceStart:sourceStart-before*sourcePerPixel,sourceSize:sourceSize+(before+after)*sourcePerPixel};
}

export default function MapBackground({terrain}: {terrain: MapTerrain}) {
  const source=mapAsset(`${terrain}-background`);
  return <svg className="adventure-background map-background" viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
    preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">
    {patches.map(({column,row})=>{
      const horizontal=patchAxis(column,WIDTH),vertical=patchAxis(row,HEIGHT);
      return <svg key={`${column}-${row}`} x={horizontal.start} y={vertical.start}
        width={horizontal.length} height={vertical.length}
        viewBox={`${horizontal.sourceStart} ${vertical.sourceStart} ${horizontal.sourceSize} ${vertical.sourceSize}`} preserveAspectRatio="none"
        className="map-background-patch">
        <image href={source} x="0" y="0" width={WIDTH} height={HEIGHT} preserveAspectRatio="none"/>
      </svg>;
    })}
  </svg>;
}
