let nextMaskId = 0;
const namespace = 'http://www.w3.org/2000/svg';

function svg(tag, attributes) {
  const node = document.createElementNS(namespace, tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  return node;
}

export function createDirectionalPaw(imageHref, bounds, placement) {
  const [left, top, right, bottom] = bounds;
  const root = svg('svg', {
    viewBox: `${left} ${top} ${right - left} ${bottom - top}`,
    preserveAspectRatio: 'xMidYMax meet', class: 'marker-art', 'aria-hidden': 'true',
  });
  const maskId = `paw-surface-${nextMaskId++}`;
  const gradientId = `${maskId}-fade`;
  const definitions = svg('defs', {});
  const gradient = svg('radialGradient', { id: gradientId });
  gradient.append(
    svg('stop', { offset: '89%', 'stop-color': 'white' }),
    svg('stop', { offset: '100%', 'stop-color': 'black' }),
  );
  const mask = svg('mask', {
    id: maskId, maskUnits: 'userSpaceOnUse', x: 0, y: 0, width: 1254, height: 1254,
    'mask-type': 'luminance',
  });
  const { x: centerX, y: centerY } = placement.center;
  mask.append(svg('ellipse', {
    cx: centerX, cy: centerY, rx: 405, ry: 263.25, fill: `url(#${gradientId})`,
  }));
  definitions.append(gradient, mask);
  const original = svg('image', { href: imageHref, width: 1254, height: 1254 });
  const [a, b, c, d] = placement.matrix;
  const offsetX = centerX - a * centerX - c * centerY;
  const offsetY = centerY - b * centerX - d * centerY;
  const surface = svg('g', { mask: `url(#${maskId})` });
  const rotation = svg('g', { transform: `matrix(${a} ${b} ${c} ${d} ${offsetX} ${offsetY})` });
  rotation.append(original.cloneNode());
  surface.append(rotation);
  root.append(definitions, original, surface);
  return root;
}
