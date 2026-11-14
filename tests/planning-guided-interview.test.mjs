import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {
  createPlanning, validatePlanning, focusQuestion, appendUser, applyInterview,
  acceptAnswer, canGenerate, canRequestGeneration, planningFacts, restartIntakeFrom,
} from '../packages/domain/planning.mjs';

const projectId = 'proj_12345678-1234-4234-8234-123456789abc';
const now = '2026-11-07T09:00:00.000Z';
const consistent = {status: 'consistent', issues: []};
const fixture = async name => JSON.parse(await readFile(
  new URL(`../packages/planning-prompts/examples/${name}.json`, import.meta.url), 'utf8',
));

function confirmFacts(state, questionId, fields) {
  state = focusQuestion(state, questionId, state.revision);
  const requestId = `setup_${questionId}_${state.revision}`;
  const messageId = `user_${requestId}`;
  const summary = Object.values(fields).join(' · ');
  state = appendUser(state, summary, messageId, requestId, state.revision, now);
  state = applyInterview(state, {
    reply: 'Please confirm this answer.', summary,
    updates: [{id: questionId, fields, evidence: Object.keys(fields).map(field => ({
      field, messageId, quote: fields[field],
    })), missing: [], complete: true}],
    consistency: consistent,
  }, requestId, state.revision, now);
  return acceptAnswer(state, questionId, state.questions.find(q => q.id === questionId).answerProposal.messageId, state.revision);
}

function applyFixture(example, initial) {
  assert.equal(example.response.status, 'ok');
  const {input, response} = example;
  let state = initial ?? createPlanning(projectId, 'codebuddy', input.locale);
  if (!initial) {
    for (const [id, answer] of Object.entries(input.acceptedAnswers ?? {})) {
      state = confirmFacts(state, id, answer.fields);
    }
  }
  state = focusQuestion(state, input.currentQuestion, state.revision);
  const refs = new Map(input.messages.map(message => [message.ref, `${example.name}_${message.ref}`]));
  for (const message of input.messages.slice(0, -1)) {
    state.messages.push({id: refs.get(message.ref), role: message.role, text: message.text,
      questionId: input.currentQuestion, createdAt: now});
  }
  validatePlanning(state);
  const last = input.messages.at(-1);
  assert.equal(last.role, 'user');
  const requestId = `request_${example.name}`;
  state = appendUser(state, last.text, refs.get(last.ref), requestId, state.revision, now);
  const result = response.result;
  const evidence = result.evidence.map(item => {
    assert.ok(refs.has(item.messageRef));
    const linked = {field: item.field, messageId: refs.get(item.messageRef), quote: item.quote};
    if (item.proposalRef !== null) {
      assert.ok(refs.has(item.proposalRef));
      linked.proposalMessageId = refs.get(item.proposalRef);
    }
    return linked;
  });
  const domainResult = {
    reply: response.reply, summary: result.summary,
    updates: [{id: result.questionId, fields: result.fields, evidence,
      missing: result.unresolved, complete: result.complete}],
    ...(result.consistency ? {consistency: result.consistency} : {}),
  };
  const next = applyInterview(state, domainResult, requestId, state.revision, now);
  return {state: next, question: next.questions.find(q => q.id === input.currentQuestion), refs, requestId};
}

for (const name of ['interview-ambiguous-choice', 'interview-criteria-guidance', 'interview-clarification']) {
  test(`synthetic ${name} remains a normal follow-up without adopting suggested outcomes`, async () => {
    const example = await fixture(name);
    const {state, question} = applyFixture(example);
    assert.equal(state.pending, undefined);
    assert.equal(question.status, 'needs-detail');
    assert.equal(question.answerProposal, undefined);
    assert.equal(question.acceptedSnapshot, undefined);
    assert.deepEqual(question.fields, example.response.result.fields);
    assert.equal(question.fields.outcome, undefined);
    assert.equal(question.fields.criteria, undefined);
    assert.deepEqual(question.missing, example.response.result.unresolved);
    assert.equal(question.missing.length, 1);
    assert.equal(state.messages.at(-1).text, example.response.reply);
    assert.equal(state.messages.at(-1).questionId, example.input.currentQuestion);
    assert.equal(planningFacts(state).answers[example.input.currentQuestion], undefined);
    assert.equal(canRequestGeneration(state), false);
  });
}

test('a concrete topic is ready for confirmation without requiring the second question’s outcome', async () => {
  const {state, question} = applyFixture(await fixture('interview-beginner-goal'));
  assert.equal(question.status, 'awaiting-confirmation');
  assert.deepEqual(question.fields, {topic: '股票市场'});
  assert.equal(planningFacts(state).answers.goal, undefined);
  const accepted = acceptAnswer(state, 'goal', question.answerProposal.messageId, state.revision);
  assert.equal(accepted.currentQuestion, 'purpose');
  assert.equal(planningFacts(accepted).answers.purpose, undefined);
});

test('synthetic assent to one explicit suggestion links the proposal and still awaits the confirmation button', async () => {
  const example = await fixture('interview-adoption');
  const {state, question, refs} = applyFixture(example);
  assert.equal(question.status, 'awaiting-confirmation');
  assert.equal(question.acceptedSnapshot, undefined);
  assert.equal(planningFacts(state).answers.goal, undefined);
  const outcome = question.evidence.find(item => item.field === 'outcome');
  assert.equal(outcome.messageId, refs.get('U2'));
  assert.equal(outcome.proposalMessageId, refs.get('A1'));
  assert.equal(canRequestGeneration(state), false);
  const accepted = acceptAnswer(state, 'goal', question.answerProposal.messageId, state.revision);
  assert.equal(accepted.questions[0].status, 'complete');
  assert.deepEqual(accepted.questions[0].acceptedSnapshot.fields, example.response.result.fields);
  assert.equal(accepted.currentQuestion, 'purpose');
});

test('a suggested criterion is recorded only after the synthetic user accepts it and confirms its summary', async () => {
  const example = await fixture('interview-criteria-guidance');
  const guided = applyFixture(example);
  const criterion = '在模拟问路中说清目的地，听懂简短指路，没听清时请对方重复';
  let state = appendUser(guided.state, '可以，就按这个标准。', 'criteria_assent_user', 'criteria_assent', guided.state.revision, now);
  state = applyInterview(state, {
    reply: '请确认这个标准。', summary: criterion,
    updates: [{id: 'purpose', fields: {criteria: criterion}, evidence: [{
      field: 'criteria', messageId: 'criteria_assent_user',
      proposalMessageId: `assistant_${guided.requestId}`, quote: '用户认可刚才的具体标准。',
    }], missing: [], complete: true}], consistency: consistent,
  }, 'criteria_assent', state.revision, now);
  const question = state.questions.find(q => q.id === 'purpose');
  assert.equal(question.status, 'awaiting-confirmation');
  assert.equal(planningFacts(state).answers.purpose, undefined);
  state = acceptAnswer(state, 'purpose', question.answerProposal.messageId, state.revision);
  assert.equal(planningFacts(state).answers.purpose.fields.criteria, criterion);
});

test('synthetic beginner and unknown baseline answers remain confirmable without invented abilities', async () => {
  const beginner = await fixture('interview-beginner-baseline');
  const unknown = structuredClone(beginner);
  unknown.name = 'synthetic-unknown-baseline';
  unknown.input.messages[0].text = '接触过一些介绍，但还不知道自己能做到哪一步。';
  unknown.response.reply = '目前还不确定能独立做到哪一步，可以先用一次入门练习校准。是否确认该回答？';
  unknown.response.result.summary = '接触过介绍，独立完成任务的基础尚不确定。';
  unknown.response.result.fields = {experience: '接触过介绍，独立完成任务的基础尚不确定'};
  unknown.response.result.evidence[0].quote = unknown.input.messages[0].text;
  for (const example of [beginner, unknown]) {
    const {state, question} = applyFixture(example);
    assert.equal(question.status, 'awaiting-confirmation');
    assert.deepEqual(Object.keys(question.fields), ['experience']);
    assert.equal(question.acceptedSnapshot, undefined);
    const accepted = acceptAnswer(state, 'baseline', question.answerProposal.messageId, state.revision);
    assert.deepEqual(planningFacts(accepted).answers.baseline.fields, example.response.result.fields);
  }
});

test('synthetic unknown time can be confirmed without manufacturing weekly hours or a deadline', async () => {
  const example = await fixture('interview-unknown-time');
  const {state, question} = applyFixture(example);
  assert.equal(question.status, 'awaiting-confirmation');
  assert.deepEqual(Object.keys(question.fields), ['schedule']);
  assert.equal(question.acceptedSnapshot, undefined);
  const accepted = acceptAnswer(state, 'time', question.answerProposal.messageId, state.revision);
  assert.deepEqual(planningFacts(accepted).answers.time.fields, example.response.result.fields);
  assert.equal(canGenerate(accepted), false);
});

test('reanswering a guided plan still clears that answer and every later answer', async () => {
  const {state: proposed, question} = applyFixture(await fixture('interview-adoption'));
  let state = acceptAnswer(proposed, 'goal', question.answerProposal.messageId, proposed.revision);
  state = confirmFacts(state, 'purpose', {criteria: '独立清洗一份销售表，并向同事解释趋势与异常'});
  state = confirmFacts(state, 'baseline', {experience: '尚未独立清洗销售数据'});
  const guidedTime = applyFixture(await fixture('interview-unknown-time'), state);
  state = acceptAnswer(guidedTime.state, 'time', guidedTime.question.answerProposal.messageId, guidedTime.state.revision);
  assert.equal(canGenerate(state), true);
  const original = structuredClone(state);
  const reset = restartIntakeFrom(state, 'purpose', state.revision);
  assert.deepEqual(state, original);
  assert.deepEqual(reset.questions[0], state.questions[0]);
  assert.deepEqual(Object.keys(planningFacts(reset).answers), ['goal']);
  assert.equal(reset.currentQuestion, 'purpose');
  for (const [index, cleared] of reset.questions.slice(1).entries()) {
    assert.equal(cleared.status, index === 0 ? 'current' : 'pending');
    assert.deepEqual(cleared.fields, {});
    assert.deepEqual(cleared.evidence, []);
    assert.equal(cleared.answerProposal, undefined);
    assert.equal(cleared.acceptedSnapshot, undefined);
  }
  assert.ok(reset.messages.every(message => message.questionId === 'goal'));
  assert.equal(canRequestGeneration(reset), false);
  validatePlanning(reset);
});

test('a more specific current answer confirms without turning an earlier broad goal into a conflict', async () => {
  const example = await fixture('interview-consistency-refinement');
  const {state, question} = applyFixture(example);
  const originalGoal = structuredClone(planningFacts(state).answers.goal);
  assert.equal(state.currentQuestion, 'purpose');
  assert.equal(question.status, 'awaiting-confirmation');
  assert.equal(planningFacts(state).answers.purpose, undefined);
  const accepted = acceptAnswer(state, 'purpose', question.answerProposal.messageId, state.revision);
  assert.equal(accepted.currentQuestion, 'baseline');
  assert.deepEqual(planningFacts(accepted).answers.goal, originalGoal);
  assert.deepEqual(planningFacts(accepted).answers.purpose.fields, example.response.result.fields);
  assert.ok(accepted.questions.every(item => item.status !== 'needs-review'));
});

test('ambiguous cross-answer intent stays in the current conversation without adopting or changing either answer', async () => {
  const example = await fixture('interview-consistency-clarification');
  const {state, question} = applyFixture(example);
  assert.equal(state.currentQuestion, 'purpose');
  assert.equal(question.status, 'needs-detail');
  assert.equal(question.answerProposal, undefined);
  assert.equal(planningFacts(state).answers.purpose, undefined);
  assert.deepEqual(planningFacts(state).answers.goal.fields, example.input.acceptedAnswers.goal.fields);
  assert.deepEqual(question.missing, example.response.result.unresolved);
  assert.equal(question.missing.length, 1);
  assert.equal(state.messages.at(-1).questionId, 'purpose');
  assert.equal(state.messages.at(-1).text, example.response.reply);
  assert.equal(canRequestGeneration(state), false);
  validatePlanning(state);
});

test('explicit expansion of an earlier goal stays a proposal until one confirmation adopts both answers and advances', async () => {
  const example = await fixture('interview-consistency-goal-change');
  const {state, question, refs} = applyFixture(example);
  const before = structuredClone(state);
  assert.equal(state.currentQuestion, 'purpose');
  assert.equal(question.status, 'awaiting-confirmation');
  assert.deepEqual(planningFacts(state).answers.goal.fields, example.input.acceptedAnswers.goal.fields);
  assert.equal(planningFacts(state).answers.purpose, undefined);
  assert.equal(question.evidence[0].messageId, refs.get('U2'));
  assert.equal(question.evidence[0].proposalMessageId, refs.get('A1'));
  const accepted = acceptAnswer(state, 'purpose', question.answerProposal.messageId, state.revision);
  assert.deepEqual(state, before);
  assert.equal(accepted.currentQuestion, 'baseline');
  assert.equal(planningFacts(accepted).answers.goal.fields.topic, example.input.acceptedAnswers.goal.fields.topic);
  assert.equal(planningFacts(accepted).answers.goal.fields.outcome, example.response.result.consistency.issues[0].suggestion.fields.outcome);
  assert.deepEqual(planningFacts(accepted).answers.purpose.fields, example.response.result.fields);
  assert.ok(accepted.questions.every(item => item.status !== 'needs-review'));
  assert.deepEqual(planningFacts(validatePlanning(JSON.parse(JSON.stringify(accepted)))), planningFacts(accepted));
});
