import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_QUESTION_IDS, QUESTION_IDS, createPlanning, validatePlanning, appendUser,
  applyInterview, acceptAnswer, canGenerate, canRequestGeneration, restartIntake,
  intakeQuestions, intakeCurrentQuestion, planningFacts, beginConsistencyCheck,
  applyConsistencyCheck, focusQuestion,
} from '../packages/domain/planning.mjs';

const project = 'proj_12345678-1234-4234-8234-123456789abc';
const coreIds = ['goal', 'purpose', 'baseline', 'time'];
const legacyIds = [...coreIds, 'constraints'];
const sevenIds = [...coreIds, 'deadline', 'scope', 'constraints'];
const compatible = {status: 'consistent', issues: []};
const fields = {
  goal: {topic: 'Spreadsheets', outcome: 'Create a monthly report'},
  purpose: {criteria: 'Explain the main changes without help'},
  baseline: {experience: 'Complete beginner'},
  time: {weekly: 'About two hours'},
};

function proposeAnswer(state, id) {
  const request = `request_${id}`;
  const message = `user_${id}`;
  const answer = Object.values(fields[id]).join(', ');
  const pending = appendUser(state, answer, message, request, state.revision);
  assert.equal(pending.pending.questionId, id);
  return applyInterview(pending, {
    reply: 'Confirm this summary?',
    summary: answer,
    updates: [{
      id,
      fields: fields[id],
      evidence: Object.keys(fields[id]).map(field => ({field, messageId: message, quote: answer})),
      missing: [],
      complete: true,
    }],
    consistency: compatible,
  }, request, pending.revision);
}

function collect(state, id) {
  const next = proposeAnswer(state, id);
  const {messageId} = next.questions.find(question => question.id === id).answerProposal;
  return acceptAnswer(next, id, messageId, next.revision);
}

function legacyPlan(ids, {withAcceptedScope = false} = {}) {
  const state = createPlanning(project, 'codex', 'en');
  for (const id of ids.slice(coreIds.length)) {
    state.questions.push({id, status: 'pending', summary: '', fields: {}, evidence: [], missing: []});
  }
  if (withAcceptedScope) {
    const question = state.questions.find(question => question.id === 'scope');
    const summary = 'Only everyday reports and charts';
    const message = {id: 'legacy_scope', role: 'user', questionId: 'scope', text: summary, createdAt: '2026-11-06T10:00:00.000Z'};
    const snapshot = {
      revision: 1,
      summary,
      fields: {scope: summary},
      evidence: [{field: 'scope', messageId: message.id, quote: summary}],
    };
    Object.assign(question, {
      status: 'complete', summary, fields: snapshot.fields,
      evidence: snapshot.evidence, acceptedSnapshot: snapshot,
    });
    state.messages.push(message);
    delete state.consistency;
  }
  return validatePlanning(state);
}

test('four core answers must be confirmed before generation is available', () => {
  let state = createPlanning(project, 'codebuddy', 'zh-CN');
  assert.deepEqual(DEFAULT_QUESTION_IDS, coreIds);
  assert.deepEqual(QUESTION_IDS, sevenIds);
  assert.deepEqual(intakeQuestions(state).map(question => question.id), coreIds);
  for (const id of coreIds.slice(0, -1)) state = collect(state, id);
  state = proposeAnswer(state, 'time');
  assert.equal(canRequestGeneration(state), false);
  const time = state.questions.find(question => question.id === 'time');
  state = acceptAnswer(state, 'time', time.answerProposal.messageId, state.revision);
  assert.equal(intakeCurrentQuestion(state), null);
  assert.equal(canGenerate(state), true);
});

for (const ids of [legacyIds, sevenIds]) {
  test(`idle retired questions do not block ${ids.length}-topic saved projects`, () => {
    let state = legacyPlan(ids, {withAcceptedScope: ids.length === 7});
    const acceptedExtras = planningFacts(state).answers;
    const earlierMessages = structuredClone(state.messages);
    for (const id of coreIds.slice(0, -1)) state = collect(state, id);

    state.questions.find(question => question.id === 'time').status = 'pending';
    state.questions.find(question => question.id === 'constraints').status = 'current';
    state.currentQuestion = 'constraints';
    const saved = JSON.stringify(state);
    state = validatePlanning(JSON.parse(saved));
    assert.equal(intakeCurrentQuestion(state), 'time');
    assert.deepEqual(intakeQuestions(state).map(question => question.id), ids.length === 7 ? [...coreIds, 'scope'] : coreIds);
    assert.equal(JSON.stringify(state), saved);

    state = collect(state, 'time');
    assert.equal(intakeCurrentQuestion(state), null);
    assert.equal(canGenerate(state), true);
    const waitingOnRetiredQuestion = structuredClone(state);
    waitingOnRetiredQuestion.currentQuestion = 'constraints';
    waitingOnRetiredQuestion.questions.find(question => question.id === 'constraints').status = 'current';
    assert.equal(intakeCurrentQuestion(validatePlanning(waitingOnRetiredQuestion)), null);
    assert.equal(canRequestGeneration(waitingOnRetiredQuestion), true);
    assert.equal(state.questions.length, ids.length);
    assert.deepEqual(state.messages.slice(0, earlierMessages.length), earlierMessages);
    for (const [id, answer] of Object.entries(acceptedExtras)) {
      assert.deepEqual(planningFacts(state).answers[id], answer);
    }

    const restarted = restartIntake(state, state.revision);
    assert.deepEqual(restarted.questions.map(question => question.id), coreIds);
    assert.deepEqual(restarted.messages, []);
  });
}

test('a consistency review for a confirmed historical answer remains reachable', () => {
  let state = legacyPlan(sevenIds, {withAcceptedScope: true});
  for (const id of coreIds) state = collect(state, id);
  state = beginConsistencyCheck(state, 'review_scope', state.revision);
  state = applyConsistencyCheck(state, {
    reply: 'Confirm which reports to include.',
    consistency: {status: 'requires_review', issues: [{
      questionId: 'scope', fields: ['scope'], kind: 'uncertain',
      reason: 'Confirm which reports to include.', suggestion: null,
    }]},
  }, 'review_scope', state.revision);
  assert.equal(intakeQuestions(state).find(question => question.id === 'scope').status, 'needs-review');
  assert.equal(canRequestGeneration(state), false);
  assert.equal(intakeCurrentQuestion(focusQuestion(state, 'scope', state.revision)), 'scope');
});

test('a historical follow-up already in progress can continue without becoming mandatory', () => {
  let state = legacyPlan(legacyIds);
  for (const id of coreIds) state = collect(state, id);
  const question = state.questions.find(question => question.id === 'constraints');
  question.status = 'needs-detail';
  question.missing = ['Which exercises should stay offline?'];
  state.currentQuestion = question.id;
  state.messages.push({
    id: 'legacy_detail', role: 'user', questionId: question.id,
    text: 'The practice environment must be offline.', createdAt: '2026-11-06T10:00:00.000Z',
  });
  state = validatePlanning(JSON.parse(JSON.stringify(state)));
  assert.equal(intakeCurrentQuestion(state), question.id);
  assert.deepEqual(intakeQuestions(state).map(question => question.id), legacyIds);
  assert.equal(canRequestGeneration(state), true);
  const next = appendUser(state, 'All hands-on exercises.', 'legacy_reply', 'legacy_request', state.revision);
  assert.equal(next.pending.questionId, question.id);
});
