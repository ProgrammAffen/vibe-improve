import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdir, mkdtemp, open, readFile, writeFile} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import test from 'node:test';

async function sampleWav(path) {
  const rate = 44_100;
  const channels = 2;
  const frameBytes = channels * 2;
  const bytes = 964 * rate * frameBytes;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(bytes + 36, 4);
  header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * frameBytes, 28);
  header.writeUInt16LE(frameBytes, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(bytes, 40);
  const pulse = Buffer.alloc(rate * frameBytes / 4, 48);
  const file = await open(path, 'w');
  try {
    await file.write(header);
    await file.truncate(header.length + bytes);
    for (const second of [1, 961]) await file.write(pulse, 0, pulse.length, header.length + second * rate * frameBytes);
  } finally {await file.close();}
}

test('Whisper ingestion checkpoints the whole track and resumes across app processes', {skip: process.platform !== 'darwin', timeout: 120_000}, async () => {
  const directory = resolve('tmp/checks/resource-transcription');
  await mkdir(directory, {recursive: true});
  const run = await mkdtemp(join(directory, 'native-'));
  const main = join(run, 'main.swift');
  const binary = join(run, 'test-transcription');
  await sampleWav(join(run, 'lesson.wav'));
  await writeFile(join(run, 'model.bin'), 'test weights');
  await writeFile(join(run, 'test-whisper'), String.raw`#!/usr/bin/python3
from pathlib import Path
import sys
import time

root = Path(sys.argv[1]).parent
audio = Path(sys.argv[2]).read_bytes()
assert sys.argv[3] == 'auto'
history = root / 'worker-history'
with history.open('a') as file:
    file.write(str(len(audio)) + '\n')
assert any(audio[32000:33000])
calls = len(history.read_text().splitlines())
if calls == 2:
    (root / 'worker-running').touch()
    time.sleep(25)
    sys.exit(1)
print('1000\t1250\t' + ('Opening explanation' if calls == 1 else 'Final checkpoint'))
`, {mode: 0o700});
  await writeFile(main, String.raw`import Foundation

let root = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
let project = "proj_2cb20aa8-3075-4830-becf-42eddce62533"
let audio = root.appendingPathComponent("lesson.wav")
let runtime = try RuntimeDirectory(url: root.appendingPathComponent("Runtime"))
let whisper = ResourceWhisper(engine: root.appendingPathComponent("test-whisper"), weights: root.appendingPathComponent("model.bin"))
let library = try ResourceLibrary(runtime: runtime, project: { if $0 != project { throw ResourceError.invalid } }, whisper: whisper)

func wait(_ description: String, until predicate: () throws -> Bool) throws {
    let deadline = Date().addingTimeInterval(15)
    while try !predicate() {
        precondition(Date() < deadline, description)
        Thread.sleep(forTimeInterval: 0.03)
    }
}
func firstItem() throws -> LearningResource {
    let row = try library.list(project, scope: nil).first!
    return try library.item(project, ref: ResourceSelection(id: row["id"] as! String, version: row["version"] as! String))
}

if CommandLine.arguments[2] == "pause" {
    let draftID = try library.beginDraft(project)["id"] as! String
    _ = try library.addFiles(project, urls: [audio], folder: false, scope: nil, draftID: draftID)
    let draft = try library.readDraft(project, id: draftID)
    let row = (draft["items"] as! [[String: Any]])[0]
    precondition(row["status"] as? String == "processing")
    let ref = ResourceSelection(id: row["id"] as! String, version: row["version"] as! String)
    let beforeSave = try library.list(project, scope: nil)
    precondition(beforeSave.isEmpty)
    _ = try library.finishDraft(project, id: draftID, saveRefs: [ref])
    let signal = root.appendingPathComponent("worker-running").path
    try wait("second clip should start") { FileManager.default.fileExists(atPath: signal) }
    try library.change(project, ref: ref, action: "pauseTranscription")
    let paused = try firstItem()
    precondition(paused.reason == "speechPaused" && paused.read == 960 && paused.total == 964)
    precondition(paused.segments.isEmpty && !paused.hasReadableContent)
    let partial = try library.transcript(project, ref: ref)
    precondition(partial.text.contains("00:00:01  Opening explanation") && !partial.text.contains("Final checkpoint"))
    let store = runtime.url.appendingPathComponent("projects/resources/\(project)/transcripts/\(ref.id)-\(ref.version)")
    try wait("pausing should stop the worker") { !FileManager.default.fileExists(atPath: store.appendingPathComponent("audio.pcm").path) }
} else {
    let paused = try firstItem()
    precondition(paused.reason == "speechPaused" && paused.read == 960)
    try library.change(project, ref: paused.ref, action: "transcribe", speechLocale: "zh-CN")
    try wait("resumption should complete") { try firstItem().status != .processing }
    let complete = try firstItem()
    precondition(complete.status == .ready && complete.read == 964 && complete.hasReadableContent, complete.reason ?? "missing transcript")
    precondition(complete.segments.map(\.location.start) == [1_000, 961_000])
    let transcript = try library.transcript(project, ref: complete.ref)
    precondition(transcript.text.contains("00:16:01  Final checkpoint"))
    let sources = try library.generationReferences(project, selections: [complete.ref])
    let excerpts = sources[0]["segments"] as! [[String: Any]]
    precondition(excerpts.last?["text"] as? String == "Final checkpoint")

    let draftID = try library.beginDraft(project)["id"] as! String
    try library.removeFromDraft(project, id: draftID, refs: [complete.ref])
    _ = try library.finishDraft(project, id: draftID, saveRefs: [])
    let afterRemoval = try library.list(project, scope: nil)
    precondition(afterRemoval.isEmpty && FileManager.default.fileExists(atPath: audio.path))
    precondition((try? library.transcript(project, ref: complete.ref)) == nil)
    let store = runtime.url.appendingPathComponent("projects/resources/\(project)/transcripts/\(complete.id)-\(complete.version)")
    precondition(!FileManager.default.fileExists(atPath: store.path))
}
print("PASS", CommandLine.arguments[2])
`);
  const sources = ['RuntimeDirectory', 'ResourceLibrary', 'ResourceExtractors', 'PublicResourceWeb', 'ResourceMedia', 'ResourceWhisper'];
  const compile = spawnSync('/usr/bin/swiftc', ['-O', '-module-cache-path', 'tmp/cache/swift',
    ...sources.map(file => 'apps/macos/' + file + '.swift'), main, '-o', binary], {encoding: 'utf8', timeout: 90_000});
  assert.equal(compile.status, 0, compile.error?.message ?? compile.stderr);
  for (const phase of ['pause', 'resume']) {
    const result = spawnSync(binary, [run, phase], {encoding: 'utf8', timeout: 20_000});
    assert.equal(result.status, 0, result.error?.message ?? result.stderr + result.stdout);
    assert.equal(result.stdout.trim(), 'PASS ' + phase);
  }
  assert.deepEqual((await readFile(join(run, 'worker-history'), 'utf8')).trim().split('\n'), ['3840000', '128000', '128000']);
});
