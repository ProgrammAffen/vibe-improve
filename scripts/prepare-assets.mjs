import {mkdir, copyFile, readFile, rm} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {dirname, join} from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
await rm(join(root, 'tmp/build/public/assets'), {recursive: true, force: true});
const files = [
  'images/home-volcano-background-1920x1080.png', 'video/home-volcano-loop-1080p-v1.mp4',
  'images/home-title-vibe-improve-v1.png', 'images/home-menu-primary-blank-v1.png',
  'images/home-menu-secondary-blank-v1.png', 'images/home-menu-exit-blank-v1.png',
  'images/home-icon-play-v1.svg', 'images/home-icon-folder-v1.svg', 'images/home-icon-gear-v1.svg',
  'images/home-icon-exit-v1.svg', 'images/home-icon-person-dark-v1.svg',
  'images/auth-stone-frame-v1.png', 'images/dialog-frame-blank-v2.png', 'images/settings-forest-background-v1.png',
  'images/account-guild-background-v1.png', 'images/account-hamster-knight-v1.png',
  'images/dialog-button-primary-blank-v1.png', 'images/dialog-button-secondary-blank-v1.png', 'images/dialog-button-danger-blank-v1.png',
  'images/dialog-field-blank-v1.png',
  'images/settings-camp-blank-v1.png', 'images/settings-nav-selected-blank-v1.png', 'images/settings-nav-neutral-blank-v1.png',
  'images/settings-row-blank-v1.png', 'images/settings-control-thumb-v1.png',
  'images/project-grassland-scene-v1.png', 'images/project-creation-camp-scene-v1.png',
  'images/project-grassland-scene-v2.png', 'images/project-create-blackboard-scene-v1.png',
  'images/project-panel-blank-v1.png', 'images/hamster-traveler-v1.png',
  'images/agent-selection-camp-blank-v1.png', 'images/agent-codex.png', 'images/agent-claude-code.png', 'images/agent-qoder.png', 'images/agent-codebuddy.svg', 'images/agent-openclaw.svg', 'images/agent-hermes.png',
  'fonts/SourceHanSansCN-Bold.otf', 'licenses/SourceHanSans-LICENSE.txt',
];
for (const file of files) {
  const output = join(root, 'tmp/build/public/assets', file);
  await mkdir(dirname(output), {recursive: true});
  await copyFile(join(root, 'assets', file), output);
}
await readFile(join(root, 'cloud/public-license-key.json'));
console.log(`Prepared ${files.length} approved assets.`);
