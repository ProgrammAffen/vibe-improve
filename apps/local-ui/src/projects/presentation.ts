export function projectNameLabel(name: string): string {
  const Segmenter = (Intl as typeof Intl & {Segmenter?: new (locale: string, options: {granularity: 'grapheme'}) => {segment: (value: string) => Iterable<{segment: string}>}}).Segmenter;
  const characters = Segmenter ? Array.from(new Segmenter('und', {granularity: 'grapheme'}).segment(name), item => item.segment) : Array.from(name);
  return characters.length > 15 ? characters.slice(0, 15).join('') + '…' : name;
}
