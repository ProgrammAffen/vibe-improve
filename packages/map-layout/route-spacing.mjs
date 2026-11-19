import { markerArtwork } from './map-themes.mjs';

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const sum = values => values.reduce((total, value) => total + value, 0);

export function curvePoint({ start, control1, control2, end }, t) {
  const u = 1 - t;
  const coordinate = axis => start[axis] * u ** 3 + 3 * control1[axis] * u ** 2 * t +
    3 * control2[axis] * u * t ** 2 + end[axis] * t ** 3;
  return { x: coordinate('x'), y: coordinate('y') };
}

function derivative({ start, control1, control2, end }, t) {
  const u = 1 - t;
  const coordinate = axis => 3 * ((control1[axis] - start[axis]) * u ** 2 +
    2 * (control2[axis] - control1[axis]) * u * t + (end[axis] - control2[axis]) * t ** 2);
  return { x: coordinate('x'), y: coordinate('y') };
}

export function pathRecord(from, to, start, control1, control2, end) {
  return {
    from, to, start, control1, control2, end,
    d: `M ${start.x} ${start.y} C ${control1.x} ${control1.y} ${control2.x} ${control2.y} ${end.x} ${end.y}`,
  };
}

function measureRoute(paths) {
  let total = 0;
  const sections = paths.map(path => {
    const controlLength = distance(path.start, path.control1) +
      distance(path.control1, path.control2) + distance(path.control2, path.end);
    const steps = Math.max(16, Math.ceil(controlLength / 5));
    const distances = new Float64Array(steps + 1);
    const start = total;
    let previous = path.start;
    for (let step = 1; step <= steps; step++) {
      const point = curvePoint(path, step / steps);
      distances[step] = distances[step - 1] + distance(previous, point);
      previous = point;
    }
    total += distances[steps];
    return { path, start, end: total, distances, steps };
  });
  return { sections, total };
}

function locate({ sections }, at) {
  const found = sections.findIndex(section => at <= section.end);
  const index = found >= 0 ? found : sections.length - 1;
  const { path, distances, start, steps } = sections[index];
  const length = Math.max(0, Math.min(at - start, distances[steps]));
  let low = 0;
  let high = steps;
  while (high - low > 1) {
    const middle = (low + high) >>> 1;
    if (distances[middle] <= length) low = middle;
    else high = middle;
  }
  const ratio = (length - distances[low]) / (distances[high] - distances[low]);
  const t = (low + ratio) / steps;
  return { index, t, point: curvePoint(path, t) };
}

function markerRadii(source, themeId) {
  const [left, top, right, bottom] = markerArtwork(themeId, 'landmark').bounds;
  const landmarkAspect = (right - left) / (bottom - top);
  return source.map(node => {
    const width = node.kind === 'chapter' ? Math.min(node.width, node.height * landmarkAspect) : node.width;
    return width / 2;
  });
}

export function routeMarkerGap(source, paths, themeId) {
  if (source.length < 2 || !paths.length) return 0;
  const radii = markerRadii(source, themeId);
  const last = source.length - 1;
  return (measureRoute(paths).total - (2 * sum(radii) - radii[0] - radii[last])) / last;
}

function spaceStations(source, measurement, themeId, maxGap = Infinity) {
  const radii = markerRadii(source, themeId);
  const last = source.length - 1;
  const reserved = 2 * sum(radii) - radii[0] - radii[last];
  const gap = Math.min((measurement.total - reserved) / last, maxGap);
  if (gap <= 0) return null;

  let at = 0;
  return source.map((_, index) => {
    if (index > 0) at += radii[index - 1] + gap + radii[index];
    return locate(measurement, at);
  });
}

// Subdivide the original cubic at each chapter so the trail and its tangents remain exact.
function splitIntoLegs(source, guide, stations) {
  const paths = [];
  for (let leg = 0; leg < stations.length - 1; leg++) {
    const first = stations[leg];
    const last = stations[leg + 1];
    const pieces = [];
    for (let index = first.index; index <= last.index; index++) {
      const curve = guide[index];
      const a = index === first.index ? first.t : 0;
      const b = index === last.index ? last.t : 1;
      if (b - a <= 1e-9) continue;
      const start = index === first.index ? first.point : curve.start;
      const end = index === last.index ? last.point : curve.end;
      const startTangent = derivative(curve, a);
      const endTangent = derivative(curve, b);
      const third = (b - a) / 3;
      const control1 = { x: start.x + startTangent.x * third, y: start.y + startTangent.y * third };
      const control2 = { x: end.x - endTangent.x * third, y: end.y - endTangent.y * third };
      pieces.push({ ...pathRecord(null, null, start, control1, control2, end), leg });
    }
    pieces[0].from = source[leg].key;
    pieces.at(-1).to = source[leg + 1].key;
    paths.push(...pieces);
  }
  return paths;
}

export function placeRouteMarkers(source, guide, themeId, maxGap = Infinity) {
  const stations = spaceStations(source, measureRoute(guide), themeId, maxGap);
  if (!stations) return null;
  const nodes = source.map((node, index) => ({ ...node, ...stations[index].point }));
  const paths = splitIntoLegs(source, guide, stations);
  return { nodes, paths, gap: routeMarkerGap(nodes, paths, themeId) };
}
