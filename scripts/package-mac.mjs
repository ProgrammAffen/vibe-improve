import {spawnSync, execFileSync} from 'node:child_process';
import {mkdir, writeFile, cp, rm, stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {publishMacApp} from './publish-mac-app.mjs';
import {build} from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const target = join(root, 'tmp/build/macos/Vibe Improve.app');
let appleSilicon = process.arch === 'arm64';
try {appleSilicon = execFileSync('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64'], {encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim() === '1';} catch {}
const arch = process.argv.includes('--arm64') ? 'arm64' : process.argv.includes('--intel') ? 'x86_64' : appleSilicon ? 'arm64' : 'x86_64';
function run(command, args) {
  const result = spawnSync(command, args, {cwd: root, stdio: 'inherit', env: {...process.env, CLANG_MODULE_CACHE_PATH: join(root, 'tmp/cache/clang'), SWIFT_MODULECACHE_PATH: join(root, 'tmp/cache/swift')}});
  if (result.status !== 0) throw new Error(`${command} failed`);
}
run(process.execPath, ['scripts/build-planning-prompts.mjs', '--check']);
await stat(join(root, 'tmp/build/web/index.html'));
await rm(target, {recursive: true, force: true});
await mkdir(join(target, 'Contents/MacOS'), {recursive: true});
await mkdir(join(target, 'Contents/Resources'), {recursive: true});
await mkdir(join(root, 'tmp/cache/swift'), {recursive: true});
run('/usr/bin/swiftc', ['-O', '-module-cache-path', join(root,'tmp/cache/swift'), '-target', `${arch}-apple-macosx13.0`, '-framework', 'Cocoa', '-framework', 'WebKit', '-framework', 'Network', '-framework', 'JavaScriptCore', 'apps/macos/DiagnosticLog.swift', 'apps/macos/LocalClientOrigin.swift', 'apps/macos/RuntimeDirectory.swift', 'apps/macos/RuntimeLocation.swift', 'apps/macos/SessionCredentialStore.swift', 'apps/macos/WindowLayout.swift', 'apps/macos/DeviceIdentity.swift', 'apps/macos/LicenseClock.swift', 'apps/macos/ProjectStore.swift', 'apps/macos/RoutePreparationStore.swift', 'apps/macos/AgentManager.swift', 'apps/macos/CodeBuddyAdapter.swift', 'apps/macos/PlanningStore.swift', 'apps/macos/PlanningAgent.swift', 'apps/macos/PlanningPromptPack.swift', 'apps/macos/PlanningPromptPackResources.swift', 'apps/macos/PlanningGeneration.swift', 'apps/macos/PlanningCoordinator.swift', 'apps/macos/main.swift', '-o', join(target,'Contents/MacOS/VibeImprove')]);
await build({entryPoints:[join(root,'packages/domain/route-validation.mjs')],bundle:true,format:'iife',globalName:'VibeRoute',platform:'neutral',target:'es2022',outfile:join(target,'Contents/Resources/RouteValidation/route-validation.js')});
await build({entryPoints:[join(root,'packages/domain/planning.mjs')],bundle:true,format:'iife',globalName:'VibePlanning',platform:'neutral',target:'es2022',outfile:join(target,'Contents/Resources/PlanningValidation/planning.js')});
await cp(join(root,'contracts/route.schema.json'),join(target,'Contents/Resources/PlanningValidation/route.schema.json'));
await cp(join(root,'apps/macos/resources/codebuddy-cli'), join(target,'Contents/Resources/CodeBuddyCLI'), {recursive:true});
await cp(join(root,'tmp/build/web'), join(target,'Contents/Resources/web'), {recursive:true});
await mkdir(join(target,'Contents/Resources/Licenses'), {recursive: true});
await cp(join(root,'node_modules/lucide-react/LICENSE'), join(target,'Contents/Resources/Licenses/Lucide.txt'));
await writeFile(join(target, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleExecutable</key><string>VibeImprove</string><key>CFBundleIdentifier</key><string>app.vibeimprove.desktop</string><key>CFBundleName</key><string>Vibe Improve</string><key>CFBundleDisplayName</key><string>Vibe Improve</string><key>CFBundleShortVersionString</key><string>0.1.0</string><key>CFBundleVersion</key><string>1</string><key>CFBundlePackageType</key><string>APPL</string><key>LSMinimumSystemVersion</key><string>13.0</string><key>NSHighResolutionCapable</key><true/><key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict></dict></plist>`);
run('/usr/bin/codesign', ['--force', '--sign', '-', '--deep', target]);
run('/usr/bin/codesign', ['--verify', '--deep', '--strict', target]);
const published = await publishMacApp(root, target);
console.log(`macOS app: ${published}\nArchitecture: ${arch}\nSignature: ad hoc; not notarized.`);
