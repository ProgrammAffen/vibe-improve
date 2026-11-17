import test from 'node:test';
import assert from 'node:assert/strict';
import {
  acceptAnswer, agentInterviewDiagnostics, appendUser, applyInterview, beginInterviewPrefill,
  canGenerate, canPrefillInterview, cancelPlanningRequest, createPlanning, focusQuestion,
  planningFacts, questionMessages, reanswerQuestion, recoverPlanning, restartIntakeFrom, validatePlanning,
} from '../packages/domain/planning.mjs';

const projectId = 'proj_12345678-1234-4234-8234-123456789abc';
const timestamp = '2026-11-12T09:00:00.000Z';
const consistent = {status: 'consistent', issues: []};
const firstAnswer = 'I want to learn SQL to build and reconcile my business report. I can study three hours each week.';
const baselineOptions = ['I have never written a query', 'I have followed a query tutorial', 'I can query one table on my own'];

function initial() {
  return createPlanning(projectId, 'codex', 'en');
}

function result(id, fields, evidence, missing = []) {
  return {
    reply: missing[0] ?? 'Please confirm the summary.',
    summary: Object.values(fields).join(' · '),
    updates: [{id, fields, evidence, missing, complete: !missing.length}],
    consistency: consistent,
  };
}

function submit(state, id, userText, fields, missing = []) {
  const messageId = `${id}-user-${state.revision}`;
  const requestId = `${id}-request-${state.revision}`;
  const pending = appendUser(state, userText, messageId, requestId, state.revision, timestamp);
  const evidence = Object.keys(fields).map(field => ({field, messageId, quote: userText}));
  return applyInterview(pending, result(id, fields, evidence, missing), requestId, pending.revision, timestamp);
}

function accept(state, id) {
  return acceptAnswer(state, id, question(state, id).answerProposal.messageId, state.revision, timestamp);
}

function question(state, id) {
  return state.questions.find(item => item.id === id);
}

function withGoal() {
  return accept(submit(initial(), 'goal', firstAnswer, {topic: 'SQL'}), 'goal');
}

function reuse(field, messageId = 'goal-user-0', reusedFrom = 'goal') {
  return {field, messageId, quote: 'The user gave this detail earlier.', reusedFrom};
}

function prefillPurpose(state) {
  const pending = beginInterviewPrefill(state, 'prefill-purpose', state.revision);
  const fields = {context: 'Business reporting', criteria: 'Independently build and reconcile the report'};
  return applyInterview(pending, result('purpose', fields, [reuse('context'), reuse('criteria')]),
    'prefill-purpose', pending.revision, timestamp);
}

test('one answer supplies later candidates while each item still requires explicit confirmation', () => {
  const goalDraft = submit(initial(), 'goal', firstAnswer, {topic: 'SQL'});
  assert.equal(canPrefillInterview(goalDraft), false);
  const goal = accept(goalDraft, 'goal');
  assert.equal(canPrefillInterview(goal), true);

  const purpose = prefillPurpose(goal);
  assert.equal(question(purpose, 'purpose').status, 'awaiting-confirmation');
  assert.deepEqual(Object.keys(planningFacts(purpose).answers), ['goal']);
  assert.deepEqual(questionMessages(purpose, 'purpose').map(message => message.role), ['assistant']);
  assert.deepEqual(questionMessages(purpose, 'goal'), questionMessages(goal, 'goal'));

  const adoptedPurpose = accept(purpose, 'purpose');
  assert.equal(question(adoptedPurpose, 'purpose').acceptedSnapshot.evidence[0].reusedFrom, 'goal');
  const adoptedBaseline = accept(submit(adoptedPurpose, 'baseline', 'I have never written SQL.',
    {experience: 'No SQL practice'}), 'baseline');
  const pending = beginInterviewPrefill(adoptedBaseline, 'prefill-time', adoptedBaseline.revision);
  assert.deepEqual(pending.messages, adoptedBaseline.messages);
  const time = applyInterview(pending, result('time', {weekly: 'Three hours'}, [reuse('weekly')]),
    'prefill-time', pending.revision, timestamp);
  assert.equal(canGenerate(time), false);
  const complete = accept(time, 'time');
  assert.equal(canGenerate(complete), true);
  assert.equal(planningFacts(complete).answers.time.fields.weekly, 'Three hours');
  assert.deepEqual(validatePlanning(JSON.parse(JSON.stringify(complete))), complete);
});

test('partial reuse carries the known use case through an ordinary follow-up', () => {
  const goal = withGoal();
  const pending = beginInterviewPrefill(goal, 'prefill-purpose', goal.revision);
  const draft = applyInterview(pending, result('purpose', {context: 'Business reporting'}, [reuse('context')],
    ['Which report should you be able to make on your own?']), 'prefill-purpose', pending.revision, timestamp);
  assert.equal(question(draft, 'purpose').status, 'needs-detail');
  assert.equal(canPrefillInterview(draft), false);
  const complete = submit(draft, 'purpose', 'A checked order totals report.', {criteria: 'Check order totals'});
  assert.deepEqual(question(accept(complete, 'purpose'), 'purpose').acceptedSnapshot.fields,
    {context: 'Business reporting', criteria: 'Check order totals'});
});

test('only eligible earlier user references support prefill and the active question alone can change', () => {
  const source = withGoal();
  const pending = beginInterviewPrefill(source, 'prefill-purpose', source.revision);
  const snapshot = structuredClone(pending);
  for (const evidence of [
    reuse('criteria', 'missing-message'),
    reuse('criteria', 'assistant_goal-request-0'),
    reuse('criteria', 'goal-user-0', 'baseline'),
    {field: 'criteria', messageId: 'goal-user-0', quote: 'Missing reuse marker.'},
  ]) {
    const output = result('purpose', {criteria: 'Make the report'}, [evidence]);
    assert.ok(agentInterviewDiagnostics(pending, output).issues.length);
    assert.throws(() => applyInterview(pending, output, 'prefill-purpose', pending.revision, timestamp),
      /PLANNING_EVIDENCE_INVALID/);
  }
  const otherQuestion = result('time', {weekly: 'Three hours'}, [reuse('weekly')]);
  assert.throws(() => applyInterview(pending, otherQuestion, 'prefill-purpose', pending.revision, timestamp),
    /PLANNING_RESPONSE_INVALID/);
  const cancelled = cancelPlanningRequest(pending, 'prefill-purpose', pending.revision);
  assert.deepEqual(cancelled.messages, source.messages);
  assert.deepEqual(cancelled.questions, source.questions);
  assert.throws(() => applyInterview(cancelled, result('purpose', {criteria: 'Make the report'}, [reuse('criteria')]),
    'prefill-purpose', pending.revision, timestamp), /PLANNING_CONFLICT/);

  const recovered = recoverPlanning(pending, timestamp);
  assert.equal(recovered.pending, undefined);
  assert.deepEqual(recovered.questions, source.questions);
  const recoveryTurns = questionMessages(recovered, 'purpose');
  assert.deepEqual(recoveryTurns.map(turn => turn.role), ['assistant']);
  assert.match(recoveryTurns[0].text, /answer this question directly/);
  assert.doesNotMatch(recoveryTurns[0].text, /send your message again/i);
  assert.equal(canPrefillInterview(recovered), false);
  assert.deepEqual(pending, snapshot);
});

test('prefill keeps the first active turn and fills its remaining slots with recent turns', () => {
  let state = initial();
  for (let turn = 1; turn <= 8; turn++) {
    state = submit(state, 'goal', `Synthetic goal detail ${turn}`, {}, ['What do you want to learn?']);
  }
  state = accept(submit(state, 'goal', firstAnswer, {topic: 'SQL'}), 'goal');
  const turns = questionMessages(state, 'goal').filter(message => message.role === 'user');
  const pending = beginInterviewPrefill(state, 'prefill-purpose', state.revision);
  const evicted = result('purpose', {criteria: 'Make the report'}, [reuse('criteria', turns[1].id)]);
  assert.throws(() => applyInterview(pending, evicted, 'prefill-purpose', pending.revision, timestamp),
    /PLANNING_EVIDENCE_INVALID/);
  const kept = [turns[0], turns.at(-1)].map(turn => result('purpose', {criteria: 'Make the report'},
    [reuse('criteria', turn.id)]));
  for (const output of kept) {
    assert.equal(question(applyInterview(pending, output, 'prefill-purpose', pending.revision, timestamp),
      'purpose').status, 'awaiting-confirmation');
  }

  state = reanswerQuestion(state, 'goal', state.revision);
  state = accept(submit(state, 'goal', 'I want to learn spreadsheets.', {topic: 'Spreadsheets'}), 'goal');
  const newRound = beginInterviewPrefill(state, 'prefill-new-round', state.revision);
  assert.throws(() => applyInterview(newRound, kept[1], 'prefill-new-round', newRound.revision, timestamp),
    /PLANNING_EVIDENCE_INVALID/);
});

test('only an unanswered baseline prefill can store three distinct short choices', () => {
  const purpose = accept(prefillPurpose(withGoal()), 'purpose');
  const pending = beginInterviewPrefill(purpose, 'prefill-baseline', purpose.revision);
  const baseline = result('baseline', {}, [], ['What can you already do in SQL?']);
  for (const choices of [baselineOptions.slice(0, 2), ['A', 'A', 'B'], ['A', 'B', 'C'.repeat(81)], ['A', 'B', 'C\nD']]) {
    assert.throws(() => applyInterview(pending, {...baseline, baselineOptions: choices}, 'prefill-baseline',
      pending.revision, timestamp), /PLANNING_RESPONSE_INVALID/);
  }
  const ownTurn = appendUser(purpose, 'I know a little.', 'baseline-user', 'direct-baseline', purpose.revision, timestamp);
  assert.throws(() => applyInterview(ownTurn, {...baseline, baselineOptions}, 'direct-baseline', ownTurn.revision,
    timestamp), /PLANNING_RESPONSE_INVALID/);

  const saved = applyInterview(pending, {...baseline, baselineOptions}, 'prefill-baseline', pending.revision, timestamp);
  assert.deepEqual(question(saved, 'baseline').baselineOptions, baselineOptions);
  assert.deepEqual(question(saved, 'baseline').fields, {});
  assert.equal(question(saved, 'baseline').answerProposal, undefined);
  assert.deepEqual(validatePlanning(JSON.parse(JSON.stringify(saved))), saved);
  const picked = submit(saved, 'baseline', baselineOptions[0], {experience: 'No SQL practice'});
  assert.equal(question(picked, 'baseline').baselineOptions, undefined);
  assert.equal(question(picked, 'baseline').status, 'awaiting-confirmation');

  const reset = restartIntakeFrom(saved, 'baseline', saved.revision);
  assert.equal(question(reset, 'baseline').baselineOptions, undefined);
  assert.deepEqual(questionMessages(reset, 'baseline'), []);
  assert.deepEqual(question(reset, 'purpose').acceptedSnapshot, question(saved, 'purpose').acceptedSnapshot);
  const earlierReset = restartIntakeFrom(saved, 'purpose', saved.revision);
  assert.equal(question(earlierReset, 'purpose').acceptedSnapshot, undefined);
  assert.deepEqual(questionMessages(earlierReset, 'goal'), questionMessages(saved, 'goal'));
});

test('an unconfirmed earlier question cannot trigger prefill when the user changes focus', () => {
  const goal = submit(initial(), 'goal', firstAnswer, {topic: 'SQL'});
  const focused = focusQuestion(goal, 'purpose', goal.revision);
  assert.equal(canPrefillInterview(focused), false);
  assert.throws(() => beginInterviewPrefill(focused, 'prefill-purpose', focused.revision), /PLANNING_INCOMPLETE/);
  const pending = appendUser(focused, 'A report.', 'purpose-user', 'purpose-request', focused.revision, timestamp);
  const unrelated = result('purpose', {criteria: 'Make a report'}, [reuse('criteria')]);
  assert.throws(() => applyInterview(pending, unrelated, 'purpose-request', pending.revision, timestamp),
    /PLANNING_EVIDENCE_INVALID/);
});
