import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';

test('native diagnostics enforce allowlists, permissions, bounded rotation, clear and path safety', {skip: process.platform !== 'darwin', timeout: 120_000}, async () => {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const base = join(root, 'tmp/checks/native-diagnostics');
  await mkdir(base, {recursive: true});
  const run = await mkdtemp(join(base, 'run-'));
  const source = join(run, 'main.swift');
  await writeFile(source, `import Foundation
import Darwin
func check(_ value: Bool) { precondition(value) }
let files = FileManager.default
let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let runtime = root.appendingPathComponent("runtime", isDirectory: true)
try files.createDirectory(at: runtime, withIntermediateDirectories: true)
let logs = runtime.appendingPathComponent("logs", isDirectory: true)
let log = DiagnosticLog(runtimeRoot: runtime)
let entry: [String: Any] = ["schemaVersion": 1, "timestamp": "2026-10-18T02:03:04.005Z", "level": "info", "event": "cloud.completed", "sessionId": "dd6f4556-e988-48c6-9876-61491553d615", "traceId": "9749be68-9784-482f-8d6d-7efbc72af76a", "operation": "license.status", "durationMs": 4.2, "resultCode": "OK", "email": "SENSITIVE_EMAIL", "token": "SENSITIVE_TOKEN", "message": "SENSITIVE_MESSAGE", "stack": "SENSITIVE_STACK", "deviceId": "SENSITIVE_DEVICE"]
log.receive(entry)
let first = logs.appendingPathComponent("native.ndjson")
let text = try String(contentsOf: first, encoding: .utf8)
check(!text.contains("SENSITIVE"))
check(text.contains("license.status"))
let record = try JSONSerialization.jsonObject(with: Data(text.utf8)) as! [String: Any]
check(record.count == 9)
log.record("native.local.failed", level: "warn", resultCode: "SERVICE_UNAVAILABLE")
let incoming = try JSONSerialization.data(withJSONObject: ["schemaVersion": 1, "entries": [entry], "token": "SENSITIVE_EXPORT"])
let exported = log.exportData(String(decoding: incoming, as: UTF8.self))!
let exportedText = String(decoding: exported, as: UTF8.self)
check(!exportedText.contains("SENSITIVE"))
let combined = try JSONSerialization.jsonObject(with: exported) as! [String: Any]
check((combined["entries"] as! [[String: Any]]).count == 1)
check((combined["nativeEntries"] as! [[String: Any]]).count == 2)
var detailed = entry
detailed["stage"] = "auth.password.signin"
detailed["reason"] = "credentials_rejected"
detailed["providerCode"] = "invalid_credentials"
detailed["providerCategory"] = "INVALID_CREDENTIALS"
detailed["httpStatus"] = 400
detailed["providerErrorNumber"] = 4010
detailed["serverTraceId"] = "9749be68-9784-482f-8d6d-7efbc72af76a"
detailed["providerRequestId"] = "587a86d9-cb69-11f1-ba0a-5254008bd148"
detailed["retryable"] = false
log.receive(detailed)
let detailedText = try String(contentsOf: first, encoding: .utf8)
check(detailedText.contains("credentials_rejected"))
check(detailedText.contains("providerRequestId"))
check(!detailedText.contains("SENSITIVE"))

check(log.exportData(String(repeating: "X", count: 262_145)) == nil)
check(log.exportData("{}") == nil)
let afterNative = try String(contentsOf: first, encoding: .utf8)
check((try files.attributesOfItem(atPath: first.path)[.posixPermissions] as! NSNumber).intValue == 0o600)
check((try files.attributesOfItem(atPath: logs.path)[.posixPermissions] as! NSNumber).intValue == 0o700)
var invalid = entry
invalid["event"] = "SENSITIVE_EVENT"
log.receive(invalid)
check(try String(contentsOf: first, encoding: .utf8) == afterNative)
invalid = entry
invalid["sessionId"] = "SENSITIVE_SESSION"
check(DiagnosticLog.sanitize(invalid) == nil)
invalid = entry
invalid["schemaVersion"] = true
check(DiagnosticLog.sanitize(invalid) == nil)
invalid = entry
invalid["traceId"] = "SENSITIVE_TRACE"
invalid["operation"] = "SENSITIVE_OPERATION"
invalid["resultCode"] = "SENSITIVE_RESULT"
invalid["durationMs"] = Double.infinity
let safe = DiagnosticLog.sanitize(invalid)!
check(safe["traceId"] == nil && safe["operation"] == nil && safe["resultCode"] == nil && safe["durationMs"] == nil)
let seed = Data("{\\"seed\\":\\"CURRENT\\"}\\n".utf8)
var full = Data()
while full.count + seed.count <= DiagnosticLog.maximumBytes { full.append(seed) }
try full.write(to: first)
try files.setAttributes([.posixPermissions: 0o600], ofItemAtPath: first.path)
try Data("{\\"seed\\":\\"PREVIOUS\\"}\\n".utf8).write(to: logs.appendingPathComponent("native.1.ndjson"))
try Data("{\\"seed\\":\\"DISCARD\\"}\\n".utf8).write(to: logs.appendingPathComponent("native.2.ndjson"))
log.record("native.started")
check(try String(contentsOf: logs.appendingPathComponent("native.2.ndjson"), encoding: .utf8).contains("PREVIOUS"))
check(try String(contentsOf: logs.appendingPathComponent("native.1.ndjson"), encoding: .utf8).contains("CURRENT"))
let names = try files.contentsOfDirectory(atPath: logs.path)
check(names.count == 3)
for name in names {
    let attributes = try files.attributesOfItem(atPath: logs.appendingPathComponent(name).path)
    check((attributes[.size] as! NSNumber).intValue <= DiagnosticLog.maximumBytes)
    check((attributes[.posixPermissions] as! NSNumber).intValue == 0o600)
}
log.clear()
check(try files.contentsOfDirectory(atPath: logs.path).isEmpty)
let protected = root.appendingPathComponent("protected.txt")
try Data("UNCHANGED".utf8).write(to: protected)
try files.createSymbolicLink(at: first, withDestinationURL: protected)
log.record("native.started")
log.clear()
check(try String(contentsOf: protected, encoding: .utf8) == "UNCHANGED")
check((try files.attributesOfItem(atPath: first.path)[.type] as! FileAttributeType) == .typeSymbolicLink)
try files.removeItem(at: first)
try files.removeItem(at: logs)
let protectedDirectory = root.appendingPathComponent("protected-directory", isDirectory: true)
try files.createDirectory(at: protectedDirectory, withIntermediateDirectories: false)
try files.createSymbolicLink(at: logs, withDestinationURL: protectedDirectory)
log.record("native.started")
log.clear()
check(try files.contentsOfDirectory(atPath: protectedDirectory.path).isEmpty)
print("native diagnostics assertions passed")
`);
  const output = join(run, 'native-diagnostics-test');
  const env = {...process.env, CLANG_MODULE_CACHE_PATH: join(root, 'tmp/cache/clang'), SWIFT_MODULECACHE_PATH: join(root, 'tmp/cache/swift')};
  const compile = spawnSync('/usr/bin/swiftc', ['-module-cache-path', join(root, 'tmp/cache/swift'), join(root, 'apps/macos/DiagnosticLog.swift'), source, '-o', output], {cwd: root, env, encoding: 'utf8'});
  assert.equal(compile.status, 0, compile.stderr);
  const result = spawnSync(output, [run], {cwd: root, env, encoding: 'utf8'});
  await writeFile(join(run, 'result.txt'), result.stdout + result.stderr);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /assertions passed/);
  const sourceText = await readFile(join(root, 'apps/macos/main.swift'), 'utf8');
  assert.match(sourceText, /message\.frameInfo\.isMainFrame/);
  assert.match(sourceText, /isAllowed\(origin\)/);
});
