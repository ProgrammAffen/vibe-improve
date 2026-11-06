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
let planningTrace="9749be68-9784-482f-8d6d-7efbc72af76a"
log.record("native.planning.failed",level:"warn",resultCode:"PLANNING_AGENT_TIMEOUT",diagnostic:["traceId":planningTrace,"provider":"codebuddy","intent":"edit","stage":"total_timeout","durationMs":1800123,"receivedCharacters":125,"reply":"SENSITIVE_REPLY","token":"SENSITIVE_TOKEN"])
let planningExport=try JSONSerialization.jsonObject(with:log.exportData("{\\"entries\\":[]}")!) as! [String:Any]
let planning=(planningExport["nativeEntries"] as! [[String:Any]]).last!
check(planning["resultCode"] as? String=="PLANNING_AGENT_TIMEOUT" && planning["traceId"] as? String==planningTrace)
check(planning["stage"] as? String=="total_timeout")
check(planning["stage"] as? String=="total_timeout" && planning["provider"] as? String=="codebuddy" && planning["intent"] as? String=="edit")
check(planning["durationMs"] as? Int==1800123 && planning["receivedCharacters"] as? Int==125)
check(planning["reply"]==nil && planning["token"]==nil)
var unsafePlanning=planning
unsafePlanning["provider"]="SENSITIVE_PROVIDER";unsafePlanning["stage"]="SENSITIVE_STAGE";unsafePlanning["intent"]="SENSITIVE_INTENT";unsafePlanning["receivedCharacters"] = -1
let cleanedPlanning=DiagnosticLog.sanitize(unsafePlanning,allowNative:true)!
check(cleanedPlanning["provider"]==nil && cleanedPlanning["stage"]==nil && cleanedPlanning["intent"]==nil && cleanedPlanning["receivedCharacters"]==nil)
check(DiagnosticLog.sanitize(planning)==nil)
var businessOutcome=planning
businessOutcome["resultCode"]="PLANNING_NEEDS_INPUT";businessOutcome["promptVersion"]="planning.1";businessOutcome["userReply"]="SENSITIVE_QUESTION"
let businessSafe=DiagnosticLog.sanitize(businessOutcome,allowNative:true)!
check(businessSafe["resultCode"] as? String=="PLANNING_NEEDS_INPUT" && businessSafe["promptVersion"] as? String=="planning.1")
check(businessSafe["userReply"]==nil)
businessOutcome["promptVersion"]="SENSITIVE_VERSION"
check(DiagnosticLog.sanitize(businessOutcome,allowNative:true)?["promptVersion"]==nil)
var rejectedPlanning=planning
rejectedPlanning["validationIssues"]=[["path":"chapters.0.nodes.1.prerequisites","code":"dependencies","value":"SENSITIVE_DATA"],["path":"SENSITIVE_PATH","code":"invalid"],["path":"chapters..title","code":"invalid"],["path":"chapters.0.title","code":"SENSITIVE_CODE"]]
rejectedPlanning["partialReply"]="SENSITIVE_PARTIAL"
let rejectedSafe=DiagnosticLog.sanitize(rejectedPlanning,allowNative:true)!
let issueList=rejectedSafe["validationIssues"] as! [[String:String]]
check(issueList.count==1 && issueList[0]==["path":"chapters.0.nodes.1.prerequisites","code":"dependencies"])
check(rejectedSafe["partialReply"]==nil)
var badReference=planning
badReference["resultCode"]="PLANNING_EVIDENCE_INVALID"
badReference["validationIssues"]=[["path":"updates.0.evidence.0.proposalMessageId","code":"reference","value":"SENSITIVE_REFERENCE"],["path":"updates.SENSITIVE_ID.evidence","code":"reference"],["path":"updates.0.evidence.0.messageId","code":"SENSITIVE_REASON"]]
let referenceSafe=DiagnosticLog.sanitize(badReference,allowNative:true)!
check(referenceSafe["resultCode"] as? String=="PLANNING_EVIDENCE_INVALID")
check(referenceSafe["validationIssues"] as? [[String:String]]==[["path":"updates.0.evidence.0.proposalMessageId","code":"reference"]])
check(!String(describing:referenceSafe).contains("SENSITIVE"))
var missingRoute=planning
missingRoute["resultCode"]="PLANNING_AGENT_ROUTE_MISSING";missingRoute["validationIssues"]=[["path":"route","code":"required","value":"SENSITIVE_ROUTE"]]
let missingSafe=DiagnosticLog.sanitize(missingRoute,allowNative:true)!
check(missingSafe["resultCode"] as? String=="PLANNING_AGENT_ROUTE_MISSING")
check(missingSafe["validationIssues"] as? [[String:String]]==[["path":"route","code":"required"]])
missingRoute["resultCode"]="PLANNING_AGENT_ROUTE_ENCODING";missingRoute["validationIssues"]=[["path":"route","code":"invalid","value":"SENSITIVE_ROUTE"]]
let encodingSafe=DiagnosticLog.sanitize(missingRoute,allowNative:true)!
check(encodingSafe["resultCode"] as? String=="PLANNING_AGENT_ROUTE_ENCODING")
check(encodingSafe["validationIssues"] as? [[String:String]]==[["path":"route","code":"invalid"]])
missingRoute["completedChapters"]=3;missingRoute["chapterCount"]=8
check(DiagnosticLog.sanitize(missingRoute,allowNative:true)?["completedChapters"] as? Int==3)
missingRoute["completedChapters"]=9
check(DiagnosticLog.sanitize(missingRoute,allowNative:true)?["completedChapters"]==nil)

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
