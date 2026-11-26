import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir, mkdtemp, writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

test('the desktop browser preserves web addresses and rejects local destinations and other schemes', {
  skip: process.platform !== 'darwin', timeout: 60_000,
}, async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const base = join(root, 'tmp/checks/in-app-browser-policy');
  await mkdir(base, {recursive: true});
  const run = await mkdtemp(join(base, 'run-'));
  const main = join(run, 'main.swift');
  const binary = join(run, 'browser-address-test');
  await writeFile(main, String.raw`import Foundation

for input in [
    "https://developer.apple.com/documentation/webkit?lang=en#overview",
    "http://example.org/tutorial",
    "https://learn.example.org:8443/reference?a=%2F#details",
    "https://example.org./",
    "https://8.8.8.8/",
    "https://[2606:4700:4700::1111]:8443/reference",
] {
    precondition(BrowserAddress.url(input)?.absoluteString == input, "Rejected or changed allowed URL: \(input)")
}

precondition(BrowserAddress.url("learn.example.org/path") == nil)
precondition(BrowserAddress.url("  learn.example.org:8443/path?q=https://other.example.org#part  ", assumeHTTPS: true)?.absoluteString
             == "https://learn.example.org:8443/path?q=https://other.example.org#part")
precondition(BrowserAddress.url("//developer.apple.com/documentation", assumeHTTPS: true)?.scheme == "https")
precondition(BrowserAddress.url("https://例子.中国/路由")?.host == "xn--fsqu00a.xn--fiqs8s")

for input in [
    "file:///tmp/document.html", "ftp://example.org/a", "data:text/html,test", "javascript:alert(1)", "mailto:example@example.org",
    "https://user:password@example.org/", "https://example.org:/", "https://example.org:65536/",
    "https://example.org:999999999999999999999999/", "https:///", "https://example.org/embedded\ncontrol",
    "https://example.org\\other.example.org/", "https://devbox/", "https://router.local/", "https://a.home.arpa/",
    "http://LOCALHOST.:1234/", "http://127.0.0.1:43129/vibe-improve/", "http://127.1/", "http://2130706433/",
    "http://0x7f000001/", "http://127.0.0.0x1/", "http://0177.0.0.1/", "http://%31%32%37.0.0.1/",
    "http://10.0.0.1/", "http://100.64.0.1/", "http://169.254.169.254/", "http://172.31.0.1/",
    "http://192.168.0.1/", "http://192.0.2.1/", "http://198.51.100.1/", "http://203.0.113.1/", "http://224.0.0.1/",
    "http://[::1]/", "http://[fe80::1%25en0]/", "http://[fc00::1]/", "http://[::ffff:127.0.0.1]/",
    "http://[2001:db8::1]/", "http://[2002:7f00:1::1]/", "http://[3fff::1]/",
] {
    precondition(BrowserAddress.url(input) == nil, "Accepted disallowed input: \(input)")
    precondition(BrowserAddress.url(input, assumeHTTPS: true) == nil, "Address field accepted disallowed input: \(input)")
    if !input.contains("\n"), !input.contains("\\"), let url = URL(string: input) {
        precondition(!BrowserAddress.permits(url), "Navigation allowed disallowed URL: \(input)")
    }
}
precondition(BrowserAddress.url("https://example.org/" + String(repeating: "x", count: 8192)) == nil)
precondition(BrowserAddress.url("localhost:8000", assumeHTTPS: true) == nil)
print("browser address assertions passed")
`);
  const cache = join(root, 'tmp/cache/swift');
  const env = {...process.env, CLANG_MODULE_CACHE_PATH: join(root, 'tmp/cache/clang'), SWIFT_MODULECACHE_PATH: cache};
  const compile = spawnSync('/usr/bin/swiftc', [
    '-module-cache-path', cache, join(root, 'apps/macos/BrowserAddress.swift'), main, '-o', binary,
  ], {cwd: root, env, encoding: 'utf8'});
  assert.equal(compile.status, 0, compile.stderr);
  const result = spawnSync(binary, [], {cwd: root, env, encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /browser address assertions passed/);
});
