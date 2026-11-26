import { landmarks } from './landmarks.js';

export const originalThemes = ['grassland', 'snow', 'ocean', 'desert'];
export const newThemes = ['river-valley', 'volcanic-belt', 'forest', 'yardang', 'cavern'];

export const regions = {
  grassland: { name: '青野营地', landmark: '苔石营地', ink: '#324526', label: '#eaf0c8', shadow: '#3b3e1aaa', paw: [169, 269, 1074, 1015] },
  snow: { name: '霜松谷', landmark: '雪屋', ink: '#2f4861', label: '#ecf3fb', shadow: '#536894a5', paw: [165, 270, 1077, 1022] },
  ocean: { name: '浅海灯湾', landmark: '灯塔', ink: '#244f5d', label: '#dcf0e7', shadow: '#16636aa1', paw: [169, 269, 1074, 1020] },
  desert: { name: '金沙丘陵', landmark: '沙丘', ink: '#62431e', label: '#f9e6ba', shadow: '#80501cab', paw: [166, 268, 1078, 1022] },
  'river-valley': { name: '河谷', landmark: '风车', pawTheme: 'grassland', ink: '#254b38', label: '#e7f3d8', shadow: '#385423b0' },
  'volcanic-belt': { name: '火山带', landmark: '火山口', pawTheme: 'desert', ink: '#573323', label: '#f9ddbc', shadow: '#291b18bb' },
  forest: { name: '森林', landmark: '老橡树', pawTheme: 'grassland', ink: '#314221', label: '#edf0ca', shadow: '#253b1abb' },
  yardang: { name: '雅丹地貌', landmark: '层状岩块', pawTheme: 'desert', ink: '#634226', label: '#fae6c5', shadow: '#694724ab' },
  cavern: { name: '溶洞', landmark: '石笋群', pawTheme: 'ocean', ink: '#253d53', label: '#e1f4f1', shadow: '#13182fcb' },
};

export function markerArtwork(themeId, kind) {
  const region = regions[themeId];
  if (kind === 'landmark') return { theme: themeId, file: 'landmark.png', ...landmarks[themeId] };
  const theme = region.pawTheme ?? themeId;
  return { theme, file: 'paw.png', width: 1254, height: 1254, bounds: regions[theme].paw };
}
