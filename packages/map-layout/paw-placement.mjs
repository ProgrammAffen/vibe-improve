function normalized(x, y) {
  const length = Math.hypot(x, y);
  return Number.isFinite(length) && length > 1e-9 ? { x: x / length, y: y / length } : undefined;
}

function direction(from, to) {
  return normalized(to.x - from.x, to.y - from.y);
}

function nearestDirection(page, node) {
  const index = page.nodes.findIndex(candidate => candidate.key === node.key);
  let nearest;
  let distance = Infinity;
  for (const [otherIndex, other] of page.nodes.entries()) {
    if (other.key === node.key) continue;
    const length = Math.hypot(other.x - node.x, other.y - node.y);
    const tangent = otherIndex < index ? direction(other, node) : direction(node, other);
    if (!tangent || length >= distance) continue;
    distance = length;
    nearest = tangent;
  }
  return nearest;
}

export function pawPlacement(page, node, projection = 0.65) {
  if (!Number.isFinite(projection) || projection <= 0) throw new TypeError('Projection must be a finite positive number');
  const outgoing = page.paths.find(path => path.from === node.key);
  const incoming = page.paths.find(path => path.to === node.key);
  const after = outgoing && direction(outgoing.start, outgoing.control1);
  const before = incoming && direction(incoming.control2, incoming.end);
  const tangent = normalized((after?.x ?? 0) + (before?.x ?? 0), (after?.y ?? 0) + (before?.y ?? 0))
    ?? (outgoing && direction(outgoing.start, outgoing.end))
    ?? (incoming && direction(incoming.start, incoming.end))
    ?? nearestDirection(page, node)
    ?? { x: 0, y: -1 };
  const angle = Math.atan2(tangent.y / projection, tangent.x) + Math.PI / 2;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  return {
    x: node.x,
    y: node.y,
    top: node.y - node.height / (node.kind === 'lesson' ? 2 : 1),
    left: node.x - node.width / 2,
    tangent,
    angle,
    matrix: [cosine, projection * sine, -sine / projection, cosine],
    center: { x: 620, y: 570 },
  };
}
