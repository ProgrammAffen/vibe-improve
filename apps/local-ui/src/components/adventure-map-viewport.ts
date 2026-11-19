import {HEIGHT, WIDTH, placeRouteMarkers, routeMarkerGap, type MapNode, type MapPage, type Point, type TrailSegment} from '../../../../packages/map-layout/index.mjs';

export type MapViewport = {width: number; height: number; top: number; bottom: number};

export function projectMapPage(page: MapPage, viewport: MapViewport, reference?: MapPage): {page: MapPage; height: number} {
  const scale = viewport.width / WIDTH;
  const height = viewport.height / scale;
  const top = viewport.top / scale;
  const bottom = height - viewport.bottom / scale;
  const source = [...page.nodes, ...(page.finish ? [page.finish] : [])];
  const first = Math.min(...source.map(node => node.y));
  const last = Math.max(...source.map(node => node.y));
  const upper = Math.max(first * height / HEIGHT,
    top + Math.max(...source.map(node => node.height / (node.kind === 'lesson' ? 2 : 1))));
  const lower = Math.min(last * height / HEIGHT,
    bottom - Math.max(...source.map(node => node.kind === 'lesson' ? node.height / 2 : 60)));
  const verticalScale = last > first ? Math.min(height / HEIGHT, Math.max(0, lower - upper) / (last - first)) : 1;
  const project = (point: Point): Point => ({x: point.x, y: upper + (point.y - first) * verticalScale});
  let nodes = page.nodes.map(node => ({...node, ...project(node)}));
  let finish = page.finish ? {...page.finish, ...project(page.finish)} : null;
  const projectPaths = (paths: readonly TrailSegment[]) => paths.map(path => {
    const start = project(path.start), control1 = project(path.control1), control2 = project(path.control2), end = project(path.end);
    return {...path, start, control1, control2, end,
      d: `M ${start.x} ${start.y} C ${control1.x} ${control1.y}, ${control2.x} ${control2.y}, ${end.x} ${end.y}`};
  });
  let paths = projectPaths(page.paths), finishPaths = projectPaths(page.finishPaths);
  if (page.compact) {
    const maxGap = reference ? projectMapPage(reference, viewport).page.spacing : page.spacing;
    const positioned = placeRouteMarkers([...nodes, ...(finish ? [finish] : [])], [...paths, ...finishPaths], page.themeId, maxGap);
    if (positioned) {
      nodes = positioned.nodes.filter((node): node is MapNode => node.kind !== 'finish');
      finish = positioned.nodes.find(node => node.kind === 'finish') ?? null;
      paths = positioned.paths.filter(path => path.leg < nodes.length - 1);
      finishPaths = positioned.paths.filter(path => path.leg === nodes.length - 1);
    }
    const placed = [...nodes, ...(finish ? [finish] : [])];
    const firstPixel = Math.min(...placed.map(node => node.y - node.height / (node.kind === 'lesson' ? 2 : 1)));
    const lastPixel = Math.max(...placed.map(node => node.y + (node.kind === 'lesson' ? node.height / 2 : node.kind === 'chapter' ? 60 : 12)));
    const shift = Math.max(top - firstPixel, Math.min(0, bottom - lastPixel));
    if (Math.abs(shift) > .001) {
      const translate = (point: Point): Point => ({x: point.x, y: point.y + shift});
      const translatePaths = (paths: TrailSegment[]) => paths.map(path => {
        const start=translate(path.start),control1=translate(path.control1),control2=translate(path.control2),end=translate(path.end);
        return {...path,start,control1,control2,end,d:`M ${start.x} ${start.y} C ${control1.x} ${control1.y}, ${control2.x} ${control2.y}, ${end.x} ${end.y}`};
      });
      nodes=nodes.map(node=>({...node,...translate(node)}));
      if(finish)finish={...finish,...translate(finish)};
      paths=translatePaths(paths);finishPaths=translatePaths(finishPaths);
    }
  }
  const spacing = routeMarkerGap([...nodes, ...(finish ? [finish] : [])], [...paths, ...finishPaths], page.themeId);
  return {page: {...page, nodes, paths, finish, finishPaths, spacing}, height};
}
