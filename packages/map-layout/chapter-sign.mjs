const sign = { width: 105, height: 54, offsetX: 47 };
const plank = { file: 'shared/chapter-sign-weathered.png', width: 1657, height: 949, viewBox: '265 202 1112 572' };
const reef = { file: 'shared/ocean-sign-footing.png', width: 1859, height: 846, viewBox: '418 181 1021 496' };
export const chapterSignAssets = [plank.file, reef.file];

export function chapterSignBounds(point, themeId) {
  const left = point.x + sign.offsetX - sign.width / 2;
  const ocean = themeId === 'ocean';
  const ground = point.y + (ocean ? 14 : 29);
  return {
    left, right: left + sign.width, top: ground - sign.height,
    bottom: ground + (ocean ? 22 : 6),
  };
}

function graphic(asset, className, assetUrl) {
  const namespace = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(namespace, 'svg');
  svg.setAttribute('viewBox', asset.viewBox);
  svg.setAttribute('preserveAspectRatio', 'xMidYMax meet');
  svg.setAttribute('class', className);
  const image = document.createElementNS(namespace, 'image');
  image.setAttribute('href', assetUrl(asset.file));
  image.setAttribute('width', asset.width);
  image.setAttribute('height', asset.height);
  svg.append(image);
  return svg;
}

export function createChapterSign(node, themeId, assetUrl) {
  const marker = document.createElement('span');
  marker.className = 'chapter-sign';
  marker.setAttribute('aria-hidden', 'true');
  const bounds = chapterSignBounds(node, themeId);
  Object.assign(marker.style, {
    left: `${(bounds.left - node.x + node.width / 2) / node.width * 100}%`,
    top: `${(bounds.top - node.y + node.height) / node.height * 100}%`,
    width: `${sign.width / node.width * 100}%`,
    height: `${sign.height / node.height * 100}%`,
  });
  if (themeId === 'ocean') marker.append(graphic(reef, 'chapter-sign-footing', assetUrl));
  marker.append(graphic(plank, 'chapter-sign-plank', assetUrl));

  const label = document.createElement('span');
  label.className = 'chapter-sign-label';
  label.textContent = `第${node.chapter}章`;
  marker.append(label);
  return marker;
}
