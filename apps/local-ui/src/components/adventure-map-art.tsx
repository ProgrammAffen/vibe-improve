import {useId, useLayoutEffect, useRef, type CSSProperties} from 'react';
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

export function PawArt({terrain, placement, gold = false}: {terrain: MapTerrain; placement: PawPlacement; gold?: boolean}) {
  const host = useRef<HTMLSpanElement>(null);
  const filterId = 'adventure-gold-paw-' + useId().replace(/[^A-Za-z0-9_-]/g, '');
  useLayoutEffect(() => {
    const paw = markerArtwork(terrain, 'paw');
    const art = createDirectionalPaw(mapAsset(`${paw.theme}-paw`), paw.bounds, placement);
    if (gold) {
      const namespace = 'http://www.w3.org/2000/svg';
      const filter = document.createElementNS(namespace, 'filter');
      filter.id = filterId;
      filter.setAttribute('color-interpolation-filters', 'sRGB');
      const matrix = document.createElementNS(namespace, 'feColorMatrix');
      // Recolor luminance, retaining the original polygon facets, rim and alpha.
      matrix.setAttribute('type', 'matrix');
      matrix.setAttribute('values', '0.153072 0.514944 0.051984 0 0.26 0.140316 0.472032 0.047652 0 0.15 0.06378 0.21456 0.02166 0 0.015 0 0 0 1 0');
      filter.append(matrix);
      art.querySelector('defs')?.append(filter);
      const surface = document.createElementNS(namespace, 'g');
      surface.setAttribute('filter', `url(#${filterId})`);
      for (const child of Array.from(art.children)) if (child.tagName !== 'defs') surface.append(child);
      art.append(surface);
    }
    host.current?.replaceChildren(art);
  }, [terrain, placement, gold, filterId]);
  return <span ref={host} className="adventure-marker-art adventure-paw-art" data-tone={gold ? 'gold' : 'terrain'} aria-hidden="true"/>;
}

export function FinishFlagArt() {
  return <svg className="adventure-finish-art" viewBox="0 0 100 141" preserveAspectRatio="xMidYMax meet" aria-hidden="true">
    <ellipse cx="50" cy="141" rx="37" ry="9" fill="var(--map-shadow)" opacity=".42"/>
    <path d="M29 139 46 133 65 139 69 145 44 149 25 144Z" fill="var(--map-ground)"/>
    <path d="M29 139 46 133 44 143 25 144Z" fill="var(--map-sheet)" opacity=".5"/>
    <path d="M44 143 65 139 69 145 44 149Z" fill="var(--map-ink)" opacity=".2"/>
    <path d="M45 14 52 12 52 140 45 143Z" fill="#9c6d40"/>
    <path d="M49 13 52 12 52 140 49 141Z" fill="#654323"/>
    <path d="M52 19 94 25 82 44 94 64 52 57Z" fill="#ee252a"/>
    <path d="M52 19 94 25 65 40 52 35Z" fill="#ff575b"/>
    <path d="M52 35 65 40 94 64 52 57Z" fill="#f7353b"/>
    <path d="M65 40 94 25 82 44 94 64Z" fill="#c91422"/>
    <path d="M54 28 54 48 69 41Z" fill="var(--map-sheet)"/>
    <path d="M43 13 49 6 56 12 50 20Z" fill="#dfb46d"/>
    <path d="M49 6 56 12 50 20 49 13Z" fill="#ab7b3c"/>
  </svg>;
}

export function TerrainTrail({page, height = HEIGHT}: {page: MapPage; height?: number}) {
  const host = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    host.current?.replaceChildren(createTerrainTrail(page.themeId, [...page.paths, ...page.finishPaths], {seed: page.seed, width: WIDTH, height}));
  }, [page, height]);
  return <div ref={host} className="adventure-trail" aria-hidden="true"/>;
}
