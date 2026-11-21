import {cp, mkdir, readFile, readdir, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

export async function preparePdfResources(root, target) {
  for (const name of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
    await cp(join(root, 'node_modules/pdfjs-dist', name), join(target, 'pdfjs', name), {recursive: true});
  }
}

/** Include attribution for the open-source editor and its installed dependencies. */
export async function packageEditorLicenses(root, target) {
  await mkdir(target, {recursive: true});
  const queue = ['@tiptap/core', '@tiptap/react', '@tiptap/pm', '@tiptap/starter-kit', '@tiptap/markdown', '@tiptap/extension-mathematics', 'katex', 'pdfjs-dist'];
  const visited = new Set(), entries = [];
  while (queue.length) {
    const name = queue.shift();
    if (visited.has(name)) continue;
    visited.add(name);
    const directory = join(root, 'node_modules', name);
    const pkg = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    const notices = (await readdir(directory)).filter(file => /^(license|copying|notice|ofl)([.\-_]|$)/i.test(file));
    if (!notices.length) throw new Error(`Missing dependency notice: ${name}`);
    const output = join(target, name.replaceAll('/', '__'));
    await mkdir(output, {recursive: true});
    for (const file of notices) await cp(join(directory, file), join(output, file), {recursive: true});
    entries.push({name, version: pkg.version, license: pkg.license, notices});
    queue.push(...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.peerDependencies ?? {}).filter(peer => ['react', 'react-dom', 'katex'].includes(peer)));
  }
  await writeFile(join(target, 'manifest.json'), JSON.stringify(entries.sort((a,b) => a.name.localeCompare(b.name)), null, 2) + '\n');
  return entries;
}
