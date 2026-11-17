import {useLayoutEffect, useRef, type CSSProperties} from 'react';
import {chapterSignBounds, createDirectionalPaw, createTerrainTrail, HEIGHT, markerArtwork, WIDTH, type MapNode, type MapPage, type PawPlacement} from '../../../../packages/map-layout/index.mjs';

export type MapTerrain = MapPage['themeId'];
type Texture = {width: number; height: number; viewBox: string};
const terrainNames = {
  grassland: ['青野营地', 'Grassland'],
  snow: ['霜松谷', 'Snowfield'],
  ocean: ['浅海灯湾', 'Shallows'],
  desert: ['金沙丘陵', 'Desert'],
  'river-valley': ['河谷', 'River valley'],
  'volcanic-belt': ['火山带', 'Volcanic belt'],
  forest: ['森林', 'Forest'],
  yardang: ['雅丹地貌', 'Yardang'],
  cavern: ['溶洞', 'Cavern'],
} satisfies Record<MapTerrain, [string, string]>;

const signTexture = {width: 1657, height: 949, viewBox: '265 202 1112 572'};
const reefTexture = {width: 1859, height: 846, viewBox: '418 181 1021 496'};

export const mapAsset = (file: string) => `${import.meta.env.BASE_URL}assets/images/map-${file}-v1.png`;
export const terrainName = (terrain: MapTerrain, language: 'zh-CN' | 'en') => terrainNames[terrain][language === 'en' ? 1 : 0];

function TextureImage({texture, src, className}: {texture: Texture; src: string; className: string}) {
  return <svg className={className} viewBox={texture.viewBox} preserveAspectRatio="xMidYMax meet" aria-hidden="true">
    <image href={src} width={texture.width} height={texture.height}/>
  </svg>;
}

export function LandmarkArt({terrain, node, language}: {terrain: MapTerrain; node: MapNode; language: 'zh-CN' | 'en'}) {
  const {width, height, bounds: [left, top, right, bottom]} = markerArtwork(terrain, 'landmark');
  const texture = {width, height, viewBox: `${left} ${top} ${right - left} ${bottom - top}`};
  const bounds = chapterSignBounds(node, terrain);
  const signStyle = {
    left: `${(bounds.left - node.x + node.width / 2) / node.width * 100}%`,
    top: `${(bounds.top - node.y + node.height) / node.height * 100}%`,
    width: `${(bounds.right - bounds.left) / node.width * 100}%`,
    height: `${54 / node.height * 100}%`,
  } satisfies CSSProperties;

  return <>
    <TextureImage texture={texture} src={mapAsset(`${terrain}-landmark`)} className="adventure-marker-art"/>
    <span className="adventure-chapter-sign" style={signStyle} aria-hidden="true">
      {terrain === 'ocean' && <TextureImage texture={reefTexture} src={mapAsset('ocean-sign-footing')} className="adventure-sign-reef"/>}
      <TextureImage texture={signTexture} src={mapAsset('chapter-sign')} className="adventure-sign-plank"/>
      <span className="adventure-sign-label">{language === 'en' ? `Ch. ${node.chapter}` : `第${node.chapter}章`}</span>
    </span>
  </>;
}

export function PawArt({terrain, placement}: {terrain: MapTerrain; placement: PawPlacement}) {
  const host = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const paw = markerArtwork(terrain, 'paw');
    host.current?.replaceChildren(createDirectionalPaw(mapAsset(`${paw.theme}-paw`), paw.bounds, placement));
  }, [terrain, placement]);
  return <span ref={host} className="adventure-marker-art" aria-hidden="true"/>;
}

export function TerrainTrail({page}: {page: MapPage}) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    host.current?.replaceChildren(createTerrainTrail(page.themeId, page.paths, {seed: page.seed, width: WIDTH, height: HEIGHT}));
  }, [page]);
  return <div ref={host} className="adventure-trail" aria-hidden="true"/>;
}
