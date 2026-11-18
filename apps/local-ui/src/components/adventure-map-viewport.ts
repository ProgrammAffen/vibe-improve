import {HEIGHT, WIDTH, type MapPage, type Point} from '../../../../packages/map-layout/index.mjs';

export type MapViewport = {width: number; height: number; top: number; bottom: number};

export function projectMapPage(page: MapPage, viewport: MapViewport): {page: MapPage; height: number} {
  const scale = viewport.width / WIDTH;
  const height = viewport.height / scale;
  const top = viewport.top / scale;
  const bottom = height - viewport.bottom / scale;
  const first = Math.min(...page.nodes.map(node => node.y));
  const last = Math.max(...page.nodes.map(node => node.y));
  const upper = Math.max(first * height / HEIGHT,
    top + Math.max(...page.nodes.map(node => node.height / (node.kind === 'chapter' ? 1 : 2))));
  const lower = Math.min(last * height / HEIGHT,
    bottom - Math.max(...page.nodes.map(node => node.kind === 'chapter' ? 60 : node.height / 2)));
  const verticalScale = last > first ? Math.min(height / HEIGHT, Math.max(0, lower - upper) / (last - first)) : 1;
  const project = (point: Point): Point => ({x: point.x, y: upper + (point.y - first) * verticalScale});
  const nodes = page.nodes.map(node => ({...node, ...project(node)}));
  const paths = page.paths.map(path => {
    const start = project(path.start), control1 = project(path.control1), control2 = project(path.control2), end = project(path.end);
    return {...path, start, control1, control2, end,
      d: `M ${start.x} ${start.y} C ${control1.x} ${control1.y}, ${control2.x} ${control2.y}, ${end.x} ${end.y}`};
  });
  return {page: {...page, nodes, paths}, height};
}
