import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {validateRoute,parseRoute,routeIssues} from '../packages/domain/route-validation.mjs';
import {assessmentAnswer,withAssessmentAnswer,MAX_ASSESSMENT_ANSWER_LENGTH} from '../packages/domain/assessment.mjs';
import {createPlanning,saveEditor,confirmRoute,validatePlanning,undoEditor,redoEditor,appendUser,applyEdit,applyProposal,assertStudiedRouteUnchanged,agentRouteDiagnostics} from '../packages/domain/planning.mjs';
import {loadPromptPack,assembleTask,matchesSchema} from '../scripts/build-planning-prompts.mjs';

const project='proj_12345678-1234-4234-8234-123456789abc';
const forms=[
  ['1. 选择题：只读查询应该使用哪个工具？A. 查询；B. 删除。','1. A。接受“选 A，使用查询工具”等等价表述。'],
  ['1. 填空题：工具返回失败时，应说明结果暂时____。','1. 无法确认。接受“不能确定”等等价说法。'],
  ['1. 计算题：以 100 为基准，110 的变化率是多少？','1. 增加 10%。接受 0.1 或百分数，写明换算；允许格式、空白和等价表达。'],
  ['1. 简答题：为什么回答应依据工具本次返回的结果？','需说明实时状态和可核对的证据。接受合理的替代措辞。'],
  ['1. 代码题：写一个函数处理工具返回失败的情况。','检查失败分支是否返回明确说明，成功分支是否保留真实结果；接受行为等价的不同实现。'],
  ['1. 实操任务：运行一次只读查询，提交输入、返回结果和说明。','输入与返回记录对应；说明依据实际返回结果；缺少记录时要求补充。'],
];
const assessment=(task=forms[0][0],answer=forms[0][1])=>({task,answer,objectiveIds:['goal']});
const route=a=>({format:'vibe-improve.route',schemaVersion:2,id:'synthetic',revision:1,title:'Synthetic quiz',locale:'zh-CN',sourceLanguage:'zh-CN',chapters:[{id:'chapter',title:'Tools',stageGoal:'Choose appropriate tools.',nodes:[{id:'lesson',title:'Tool use',objectives:[{id:'goal',description:'Choose an appropriate tool and explain the result.'}],prerequisites:[],estimatedMinutes:30,assessment:a}]}]});

test('all quiz formats and mixed questions preserve free-form questions and answer rubrics',()=>{
  for(const [task,answer] of [...forms,[forms.map(x=>x[0]).join('\n\n'),forms.map(x=>x[1]).join('\n\n')]]){
    let state=createPlanning(project,'codex','zh-CN',route(assessment(task,answer)));
    assert.deepEqual(parseRoute(JSON.stringify(state.routeDraft)).chapters[0].nodes[0].assessment,assessment(task,answer));
    const draft=structuredClone(state.routeDraft);draft.chapters[0].nodes[0].assessment.answer+='\n允许合理的等价回答。';
    state=saveEditor(state,draft,state.revision);state=validatePlanning(JSON.parse(JSON.stringify(state)));
    state=undoEditor(state,state.revision);assert.equal(state.routeDraft.chapters[0].nodes[0].assessment.answer,answer);
    state=redoEditor(state,state.revision);assert.match(state.routeDraft.chapters[0].nodes[0].assessment.answer,/等价回答/);
    assert.doesNotThrow(()=>confirmRoute(state,state.revision));
  }
});

test('legacy assessments retain both grading guidance and public criteria when edited',async()=>{
  const legacy={task:'Explain the result.',objectiveIds:['goal'],passCriteria:['Key concepts are explained.','Relevant evidence is supplied.'],mode:'qualitative',evaluatorPrompt:'Accept equivalent explanations and ask for missing evidence.'};
  for(const locale of ['zh-CN','en']){
    const text=assessmentAnswer(legacy,locale);
    for(const expected of [...legacy.passCriteria,legacy.evaluatorPrompt])assert.ok(text.includes(expected));
    const next=withAssessmentAnswer(legacy,text);
    assert.deepEqual(Object.keys(next).sort(),['answer','objectiveIds','task']);
    assert.equal(assessmentAnswer(next,locale),text);
    assert.doesNotThrow(()=>validateRoute(route(next)));
  }
  const largest={...legacy,passCriteria:Array.from({length:24},(_,i)=>String(i)+'x'.repeat(1997)),evaluatorPrompt:'y'.repeat(4000)};
  assert.ok(assessmentAnswer(largest).length<MAX_ASSESSMENT_ANSWER_LENGTH);
  const imported=parseRoute(await readFile('contracts/examples/route.valid.json','utf8'));
  assert.equal(imported.schemaVersion,1);
});

test('incomplete quizzes save without silently creating answers, but confirmation identifies missing answers',()=>{
  let state=createPlanning(project,null,'zh-CN',route(assessment()));
  const draft=structuredClone(state.routeDraft);draft.chapters[0].nodes[0].assessment.answer='';
  state=saveEditor(state,draft,state.revision);
  assert.equal(state.routeDraft.chapters[0].nodes[0].assessment.answer,'');
  assert.throws(()=>confirmRoute(state,state.revision),/PLANNING_ROUTE_INVALID/);
  assert.deepEqual(routeIssues(draft),[{path:'chapters.0.nodes.0.assessment.answer',code:'required'}]);
  assert.deepEqual(agentRouteDiagnostics(state,draft).issues,routeIssues(draft));
  const missing=route(assessment());delete missing.chapters[0].nodes[0].assessment.answer;
  assert.ok(routeIssues(missing).some(x=>x.path.endsWith('.answer')));
  const mixed=route({...assessment(),mode:'qualitative',evaluatorPrompt:'Legacy field'});
  assert.throws(()=>validateRoute(mixed));
});

test('AI quiz proposals need adoption and preserve other lesson settings and studied locks',()=>{
  let state=createPlanning(project,'codex','zh-CN',route(assessment()));
  state.routeDraft.chapters[0].nodes[0].requirement='optional';
  state.routeDraft.chapters[0].nodes[0].review={content:'Recall the concept.',passCriteria:['Explain it accurately.']};
  const original=structuredClone(state.routeDraft),proposal=structuredClone(original);
  proposal.chapters[0].nodes[0].assessment=assessment(...forms[3]);
  state=appendUser(state,'@1.1节 Generate a quiz for this lesson.','user','request',state.revision,undefined,undefined,[{token:'@1.1节',target:{chapterId:'chapter',nodeId:'lesson'}}]);
  assert.equal(state.messages.at(-1).mentions[0].target.nodeId,'lesson');
  state=applyEdit(state,{reply:'Quiz prepared.',route:proposal},'request',state.revision);
  assert.deepEqual(state.routeDraft,original);
  assert.throws(()=>assertStudiedRouteUnchanged(original,proposal,new Set(['lesson'])),/PLANNING_STUDIED_LESSON_LOCKED/);
  state=applyProposal(state,state.revision);
  assert.deepEqual(state.routeDraft.chapters[0].nodes[0].review,original.chapters[0].nodes[0].review);
  assert.equal(state.routeDraft.chapters[0].nodes[0].requirement,'optional');
  assert.deepEqual(state.routeDraft.chapters[0].nodes[0].assessment,assessment(...forms[3]));
});

test('route planning defers quizzes while retaining legacy route compatibility',async()=>{
  const pack=await loadPromptPack(),schema=assembleTask(pack,'lessons').schema;
  const output=a=>({status:'ok',reply:'Prepared.',result:{nodes:[{ref:'L1',objectives:['Explain the concept.'],prerequisites:[],estimatedMinutes:30,activities:['Practise using a guided example.'],...(a===undefined?{}:{assessment:a})}]},missing:[]});
  assert.equal(matchesSchema(output(undefined),schema),true);
  assert.equal(matchesSchema(output(null),schema),true);
  for(const [task,answer] of forms)assert.equal(matchesSchema(output({task,answer}),schema),false);
  const legacy={task:'Explain the result.',passCriteria:['Explain the concepts.'],mode:'qualitative',evaluatorPrompt:'Check evidence and equivalent explanations.'};
  assert.equal(matchesSchema(output(legacy),schema),false);
  const edit=assembleTask(pack,'edit');
  assert.equal(matchesSchema({reply:'Preserved legacy content.',route:route(assessment())},edit.schema),true);
  for(const example of pack.examples.filter(item=>item.task==='lessons')){
    assert.equal(matchesSchema(example.response,schema),true,example.name);
    for(const node of example.response.result?.nodes??[]){
      assert.ok(node.assessment==null,example.name);
      assert.equal(node.review,undefined,example.name);
    }
  }
});
