import { random } from './route-layout.mjs';

const svgNS = 'http://www.w3.org/2000/svg';
const surfaces = {
  grassland: {
    width: 33, edge: '#74622e', edgeOpacity: .28, base: '#b49350', baseOpacity: .83,
    lit: ['#e2cd86', '#d3ba76', '#dfbd74'], dark: ['#998047', '#b59957', '#a58b55'],
    light: { x: .9, y: -.43 }, facetOpacity: .36,
  },
  snow: {
    width: 33, edge: '#627db0', edgeOpacity: .21, base: '#91a9d5', baseOpacity: .73,
    lit: ['#f6f8ff', '#e6f1fa', '#e8edf9'], dark: ['#819ac8', '#98add5', '#a1b4db'],
    light: { x: .9, y: -.43 }, facetOpacity: .30,
  },
  desert: {
    width: 35, edge: '#a76732', edgeOpacity: .23, base: '#cc8f50', baseOpacity: .78,
    lit: ['#ffdfa1', '#ffcd85', '#f7c585'], dark: ['#bb813d', '#c38c52', '#d49850'],
    light: { x: -.9, y: -.43 }, facetOpacity: .36,
  },
  'river-valley': {
    width: 33, edge: '#6d672f', edgeOpacity: .32, base: '#d5b978', baseOpacity: .91,
    lit: ['#f0d9a0', '#e7ce91', '#ecd6a8'], dark: ['#a58c54', '#baa571', '#a99562'],
    light: { x: .9, y: -.43 }, facetOpacity: .36,
  },
  'volcanic-belt': {
    width: 35, edge: '#342825', edgeOpacity: .42, base: '#bb9a7e', baseOpacity: .86,
    lit: ['#e8c3a0', '#dcc0a5', '#e4ad86'], dark: ['#8b6e59', '#9b7b63', '#a28670'],
    light: { x: .9, y: -.43 }, facetOpacity: .43,
  },
  forest: {
    width: 34, edge: '#594625', edgeOpacity: .37, base: '#b89757', baseOpacity: .91,
    lit: ['#e1c682', '#d7bb7d', '#d1b16c'], dark: ['#886a3a', '#a4864a', '#a48350'],
    light: { x: .9, y: -.43 }, facetOpacity: .38,
  },
  yardang: {
    width: 34, edge: '#906440', edgeOpacity: .34, base: '#c19368', baseOpacity: .89,
    lit: ['#e4c59a', '#edcfa5', '#e2b789'], dark: ['#aa754b', '#ad855e', '#b78b62'],
    light: { x: .9, y: -.43 }, facetOpacity: .41,
  },
  cavern: {
    width: 35, edge: '#24273e', edgeOpacity: .49, base: '#8c8faa', baseOpacity: .89,
    lit: ['#c5ced2', '#bac4db', '#b8acc1'], dark: ['#6d7094', '#797f9d', '#79758f'],
    light: { x: .9, y: -.43 }, facetOpacity: .41,
  },
};

function svg(tag, attrs) {
  const element = document.createElementNS(svgNS, tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
  return element;
}

function polygon(target, points, color, opacity) {
  target.append(svg('polygon', {
    points: points.map(({ x, y }) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' '),
    fill: color,
    'fill-opacity': opacity,
  }));
}

const distance = (a, b) => Math.hypot(b.x - a.x, b.y - a.y);
const interpolate = (a, b, amount) => ({ x: a.x + (b.x - a.x) * amount, y: a.y + (b.y - a.y) * amount });

function bezier(path, t) {
  const { start, control1, control2, end } = path;
  const u = 1 - t;
  const evaluate = key => u ** 3 * start[key] + 3 * u ** 2 * t * control1[key] + 3 * u * t ** 2 * control2[key] + t ** 3 * end[key];
  return { x: evaluate('x'), y: evaluate('y') };
}

// Resample by distance so the ground facets stay similar in size around turns.
function createSpine(paths) {
  const points = [{ ...paths[0].start, at: 0 }];
  for (const path of paths) {
    const controlLength = distance(path.start, path.control1) + distance(path.control1, path.control2) + distance(path.control2, path.end);
    const steps = Math.max(2, Math.ceil(controlLength / 7));
    for (let step = 1; step <= steps; step++) {
      const next = bezier(path, step / steps);
      const last = points.at(-1);
      const length = distance(last, next);
      if (length > .001) points.push({ ...next, at: last.at + length });
    }
  }
  const length = points.at(-1).at;
  function sample(at) {
    const position = Math.max(0, Math.min(at, length));
    let low = 0;
    let high = points.length - 1;
    while (high - low > 1) {
      const middle = (low + high) >>> 1;
      if (points[middle].at < position) low = middle;
      else high = middle;
    }
    const a = points[low];
    const b = points[high];
    return interpolate(a, b, (position - a.at) / (b.at - a.at || 1));
  }
  function offset(at, side) {
    const point = sample(at);
    const a = sample(at - 5);
    const b = sample(at + 5);
    const span = distance(a, b) || 1;
    return { x: point.x - (b.y - a.y) * side / span, y: point.y + (b.x - a.x) * side / span };
  }
  return { length, offset };
}

function strip(graphic, sections, left, right, fill, opacity) {
  polygon(graphic, [...sections.map(s => s[left]), ...sections.map(s => s[right]).reverse()], fill, opacity);
}

function landTrail(graphic, spine, material, rng) {
  const { length, offset } = spine;
  const count = Math.max(2, Math.ceil(length / 16));
  const sections = Array.from({ length: count + 1 }, (_, index) => {
    const at = index / count * length;
    const endTaper = .42 + .58 * Math.min(1, at / 35, (length - at) / 35);
    const wave = Math.sin(at / 63) * 2.4 + Math.sin(at / 29) * 1.15;
    const radius = (material.width / 2 + wave) * endTaper;
    const left = -radius * (.76 + rng() * .34);
    const right = radius * (.74 + rng() * .4);
    const feather = 2.5 + rng() * 4;
    return {
      left: offset(at, left),
      right: offset(at, right),
      edgeLeft: offset(at, left - feather),
      edgeRight: offset(at, right + feather),
      middle: offset(at, (rng() - .5) * radius),
    };
  });

  strip(graphic, sections, 'edgeLeft', 'edgeRight', material.edge, material.edgeOpacity);
  strip(graphic, sections, 'left', 'right', material.base, material.baseOpacity);
  for (let i = 1; i < sections.length; i++) {
    const a = sections[i - 1];
    const b = sections[i];
    const leftX = b.left.x - b.right.x;
    const leftY = b.left.y - b.right.y;
    const facing = (leftX * material.light.x + leftY * material.light.y) / (Math.hypot(leftX, leftY) || 1);
    const [litEdge, darkEdge] = facing > 0 ? ['left', 'right'] : ['right', 'left'];
    const lit = material.lit[Math.floor(rng() * material.lit.length)];
    const dark = material.dark[Math.floor(rng() * material.dark.length)];
    const opacity = material.facetOpacity * (.37 + rng() * .63) * (.62 + .38 * Math.abs(facing));
    polygon(graphic, [a[litEdge], b[litEdge], b.middle], lit, opacity);
    polygon(graphic, [a.middle, a[darkEdge], b[darkEdge], b.middle], dark, opacity);
  }
}

function wake(graphic, { length, offset }, rng) {
  const count = Math.max(2, Math.ceil(length / 17));
  const surface = Array.from({ length: count + 1 }, (_, index) => {
    const at = index / count * length;
    const ripple = 13 + Math.sin(at / 46) * 2.7;
    return {
      left: offset(at, -ripple), right: offset(at, ripple),
      innerLeft: offset(at, -ripple * .63), innerRight: offset(at, ripple * .63),
    };
  });
  strip(graphic, surface, 'left', 'right', '#248d94', .28);
  strip(graphic, surface, 'innerLeft', 'innerRight', '#b8ead7', .42);

  for (let at = 4; at < length - 4;) {
    const span = Math.min(15 + rng() * 24, length - at);
    const shift = (rng() - .5) * 13;
    const width = 4 + rng() * 4;
    const center = at + span * .47;
    polygon(graphic, [
      offset(at, shift), offset(center, shift - width),
      offset(at + span, shift + width * .15), offset(center, shift + width),
    ], rng() > .3 ? '#e3f6dc' : '#b5e9d7', .52 + rng() * .30);

    if (span > 22 && rng() > .22) {
      const side = shift > 0 ? -1 : 1;
      const echo = shift + side * (9 + rng() * 4);
      polygon(graphic, [
        offset(at + span * .18, echo), offset(center, echo - side * 2.5),
        offset(at + span * .85, echo + side * 2), offset(center, echo + side * 2),
      ], '#acede0', .32);
    }
    at += span + 5 + rng() * 17;
  }
}

export function createTerrainTrail(themeId, paths, { seed = 1, width = 1672, height = 941 } = {}) {
  const graphic = svg('svg', {
    class: 'map-trail terrain-trail', viewBox: `0 0 ${width} ${height}`, 'aria-hidden': 'true',
  });
  if (!paths.length) return graphic;
  const spine = createSpine(paths);
  if (!spine.length) return graphic;
  const rng = random((Number(seed) || 1) + themeId.length * 173);
  if (themeId === 'ocean') wake(graphic, spine, rng);
  else landTrail(graphic, spine, surfaces[themeId] ?? surfaces.grassland, rng);
  return graphic;
}
