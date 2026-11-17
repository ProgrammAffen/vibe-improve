import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {cp, mkdir, rename, rm, stat} from 'node:fs/promises';
import {join} from 'node:path';

const source = {
  file: 'whisper.cpp-v1.9.5.tar.gz',
  url: 'https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/d1be6fde11ac6e0407606b4e42fe72d34add8037',
  sha256: '645445da884df6dbd52b30f82d7be7c01d1767c938714e477e786b88d529e9f4'
};
const cmake = {
  file: 'cmake-4.2.3-macos-universal.tar.gz',
  url: 'https://github.com/Kitware/CMake/releases/download/v4.2.3/cmake-4.2.3-macos-universal.tar.gz',
  sha256: 'c2302d3e9c48daabee5ea7c4db4b2b93b989bcc89dae8b760880e00120641b5b'
};
const model = {
  file: 'ggml-small-q5_1.bin',
  url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/87cd18b47b941d2f65d09981dad23bb7d0481c77/ggml-small-q5_1.bin',
  sha256: 'ae85e4a935d7a567bd102fe55afc16bb595bdb618e11b2fc7591bc08120411bb'
};
const weightsLicense = {
  file: 'OpenAI-Whisper-LICENSE',
  url: 'https://raw.githubusercontent.com/openai/whisper/v20250625/LICENSE',
  sha256: 'b5d65a59060e68c4ff940e1eddfa6f94b2d68fdf58ed7f4dd57721c997e35e9d'
};

function run(executable, args) {
  const result = spawnSync(executable, args, {stdio: 'inherit'});
  if (result.status !== 0) throw new Error(result.error?.message || executable + ' failed');
}

async function matches(path, digest) {
  if (!(await stat(path).catch(() => null))?.isFile()) return false;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex') === digest;
}

async function pinnedFile(cache, dependency) {
  const path = join(cache, dependency.file);
  if (await matches(path, dependency.sha256)) return path;
  const temporary = path + '.' + process.pid + '.part';
  try {
    run('/usr/bin/curl', ['--disable', '--fail', '--silent', '--show-error', '--location', '--proto', '=https',
      '--proto-redir', '=https', '--connect-timeout', '15', '--max-time', '300', '--retry', '2',
      '--output', temporary, dependency.url]);
    if (!await matches(temporary, dependency.sha256)) throw new Error('Checksum mismatch for ' + dependency.file);
    await rename(temporary, path);
    return path;
  } finally { await rm(temporary, {force: true}); }
}

async function unpack(archive, destination, checkFile) {
  if ((await stat(join(destination, checkFile)).catch(() => null))?.isFile()) return;
  const staging = destination + '.' + process.pid;
  await mkdir(staging, {recursive: true});
  try {
    run('/usr/bin/tar', ['-xzf', archive, '-C', staging, '--strip-components', '1']);
    if (!(await stat(join(staging, checkFile))).isFile()) throw new Error('Incomplete Whisper build dependency');
    await rename(staging, destination);
  } finally { await rm(staging, {recursive: true, force: true}); }
}

export async function buildWhisper(root, architecture) {
  const cache = join(root, 'tmp/build/whisper-cache');
  await mkdir(cache, {recursive: true});
  const archives = await Promise.all([source, cmake, model, weightsLicense].map(dependency => pinnedFile(cache, dependency)));
  const [sourceArchive, cmakeArchive, weights, license] = archives;
  const sourceDirectory = join(cache, 'source-v1.9.5');
  const toolDirectory = join(cache, 'cmake-4.2.3');
  const cmakeEntry = 'CMake.app/Contents/bin/cmake';
  await Promise.all([unpack(sourceArchive, sourceDirectory, 'include/whisper.h'), unpack(cmakeArchive, toolDirectory, cmakeEntry)]);
  const executable = join(toolDirectory, cmakeEntry);
  const build = join(cache, architecture);
  run(executable, ['-S', join(root, 'apps/macos/resources/whisper'), '-B', build,
    '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_OSX_DEPLOYMENT_TARGET=13.0',
    '-DCMAKE_OSX_SYSROOT=macosx', '-DCMAKE_OSX_ARCHITECTURES=' + architecture,
    '-DWHISPER_SOURCE_DIR=' + sourceDirectory]);
  run(executable, ['--build', build, '--target', 'vibe-whisper', '--parallel', '4']);
  const engine = join(build, 'vibe-whisper');
  run('/usr/bin/lipo', [engine, '-verify_arch', architecture]);
  return {engine, weights, weightsLicense: license, engineLicense: join(sourceDirectory, 'LICENSE')};
}

export async function packageWhisper(dependency, app) {
  const helperDirectory = join(app, 'Contents/Helpers');
  const weightsDirectory = join(app, 'Contents/Resources/Whisper');
  const licenses = join(app, 'Contents/Resources/Licenses');
  await Promise.all([helperDirectory, weightsDirectory, licenses].map(path => mkdir(path, {recursive: true})));
  const engine = join(helperDirectory, 'vibe-whisper');
  await Promise.all([
    cp(dependency.engine, engine),
    cp(dependency.weights, join(weightsDirectory, model.file)),
    cp(dependency.weightsLicense, join(licenses, 'OpenAI-Whisper.txt')),
    cp(dependency.engineLicense, join(licenses, 'whisper.cpp.txt'))
  ]);
  run('/usr/bin/codesign', ['--force', '--sign', '-', engine]);
}
