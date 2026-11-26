// The background rim and route exclusions describe the same decorated corners.
export const MAP_BACKGROUND_SOURCE=[0,.26,.74,1] as const;
export const MAP_BACKGROUND_DESTINATION=[0,.21,.79,1] as const;
export const MAP_CORNER_WIDTH=MAP_BACKGROUND_DESTINATION[1]+.025;
export const MAP_CORNER_HEIGHT=MAP_BACKGROUND_DESTINATION[1]+.035;
import {WIDTH,chapterSignBounds,markerArtwork,type MapNode,type MapFinish,type MapPage} from '../../../../packages/map-layout/index.mjs';


export type MapBox={left:number;top:number;right:number;bottom:number};

// CSS clamps the visible badge to 20–44px at 2.8cqw. The board is at least
// 800px wide, so 2.8% of its logical width safely bounds every rendered badge.
// Reserve this space even for available lessons so later status changes cannot
// move a badge into scenery or an adjacent learning marker.
export function mapLessonBadgeBox(node:MapNode):MapBox{
  const size=WIDTH*.028*(node.artworkScale??1);
  const right=node.x+node.width*.68,top=node.y-node.height*.72;
  return {left:right-size,right,top,bottom:top+size};
}

export function mapCornerExclusions(height:number):MapBox[]{
  const width=WIDTH*MAP_CORNER_WIDTH,depth=height*MAP_CORNER_HEIGHT;
  return [{left:0,top:0,right:width,bottom:depth},{left:WIDTH-width,top:0,right:WIDTH,bottom:depth},
    {left:0,top:height-depth,right:width,bottom:height},{left:WIDTH-width,top:height-depth,right:WIDTH,bottom:height}];
}

export function mapArtworkBoxes(node:MapNode|MapFinish,theme:MapPage['themeId']):MapBox[]{
  if(node.kind==='chapter'){
    const {bounds:[left,top,right,bottom]}=markerArtwork(theme,'landmark');
    const aspect=(right-left)/(bottom-top),width=Math.min(node.width,node.height*aspect);
    return [{left:node.x-width/2,right:node.x+width/2,top:node.y-width/aspect,bottom:node.y+node.height*.03},
      chapterSignBounds(node,theme)];
  }
  const body={left:node.x-node.width/2,right:node.x+node.width/2,
    top:node.y-node.height/(node.kind==='lesson'?2:1),bottom:node.y+(node.kind==='lesson'?node.height/2:0)};
  return node.kind==='lesson'?[body,mapLessonBadgeBox(node)]:[body];
}
