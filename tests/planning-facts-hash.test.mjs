import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {sha256} from '../packages/domain/sha256.mjs';

const native=text=>createHash('sha256').update(text,'utf8').digest('hex');

test('portable SHA-256 matches standard vectors and UTF-8 across padding boundaries',()=>{
  assert.equal(sha256(''),'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256('abc'),'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  assert.equal(sha256('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq'),'248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1');
  for(const text of ['字符级语言模型：目标与标准。','A😀𐐷中\0Z','é','e\u0301','\u007f\u0080\u07ff\u0800\uffff','x'.repeat(55),'x'.repeat(56),'x'.repeat(63),'x'.repeat(64),'x'.repeat(65),'学习😀'.repeat(2000)]){
    assert.match(sha256(text),/^[a-f0-9]{64}$/);
    assert.equal(sha256(text),native(text));
  }
  assert.notEqual(sha256('é'),sha256('e\u0301'),'hashing must not silently normalize accepted facts');
});

test('canonical facts text is hashed exactly without host-specific APIs or object reserialization',()=>{
  const text='{"answers":{"goal":{"fields":{"outcome":"训练字符级语言模型","topic":"深度学习"},"revision":2,"summary":"训练并展示文本生成"},"time":{"fields":{"session":"半小时","weekly":"五小时"},"revision":1,"summary":"每周五小时"}},"resources":"合成笔记"}';
  assert.equal(sha256(text),native(text));
  assert.equal(sha256(text),sha256(String(text)));
  assert.notEqual(sha256(text),sha256(text.replace('"revision":2','"revision":3')));
  assert.notEqual(sha256(text),sha256(text+' '),'canonicalization is the caller responsibility');
});

test('lone surrogates and non-string inputs fail rather than hashing replacement characters',()=>{
  for(const text of ['\ud800','\udc00','a\ud800z','a\udc00z','\ud800\ud800','\udc00\udfff'])assert.throws(()=>sha256(text),/^Error: PLANNING_INVALID$/);
  for(const value of [undefined,null,{},[],1,true,new String('abc')])assert.throws(()=>sha256(value),/^Error: PLANNING_INVALID$/);
  assert.equal(sha256('\ud800\udc00'),native('\ud800\udc00'));
});
