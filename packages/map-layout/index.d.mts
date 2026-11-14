import type { RouteDocument } from '../domain/route-validation.mjs';

export type MapTheme = 'grassland' | 'snow' | 'ocean' | 'desert' | 'river-valley' | 'volcanic-belt' | 'forest' | 'yardang' | 'cavern';
export type MapThemeId = MapTheme;
export interface Point { x: number; y: number }
interface MapNodeBase extends Point {
  id: string; key: string; chapter: number; chapterId: string; title: string;
  label: string; width: number; height: number;
}
export type MapNode = MapNodeBase & ({ kind: 'chapter'; lesson?: never } | { kind: 'lesson'; lesson: number });
export interface TrailSegment {
  from: string | null; to: string | null; start: Point; control1: Point; control2: Point; end: Point; d: string; leg: number;
}
export interface ContinuedChapter { id: string; title: string; number: number; firstLesson: number; lastLesson: number }
export interface MapPage {
  pageIndex: number; pageNumber: number; totalPages: number; themeId: MapTheme;
  readonly nodes: readonly MapNode[]; readonly paths: readonly TrailSegment[]; readonly lessonIds: readonly string[];
  totalChapters: number; totalLessons: number; seed: number; continuation: boolean;
  continuedChapter: ContinuedChapter | null; continuesToNextPage: boolean;
}
export const WIDTH: number;
export const HEIGHT: number;
export const MAX_PAGE_NODES: number;
export function createRouteMapPages(route: Pick<RouteDocument, 'id' | 'chapters'>): MapPage[];
export type Bounds = readonly [number, number, number, number];
export interface PawPlacement extends Point {
  top: number; left: number; tangent: Point; angle: number; matrix: readonly [number, number, number, number]; center: Point;
}
export function pawPlacement(page: MapPage, node: MapNode, projection?: number): PawPlacement;
export function chapterSignBounds(point: Point, themeId: MapTheme): { left: number; right: number; top: number; bottom: number };
export function createDirectionalPaw(imageHref: string, bounds: Bounds, placement: PawPlacement): SVGSVGElement;
export function createTerrainTrail(themeId: MapTheme, paths: readonly TrailSegment[], options?: { seed?: number; width?: number; height?: number }): SVGSVGElement;
export function markerArtwork(themeId: MapTheme, kind: 'landmark' | 'paw'): { theme: MapTheme; file: string; width: number; height: number; bounds: Bounds };
