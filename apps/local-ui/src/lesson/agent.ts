import type {Language} from '../i18n';
import type {LessonAgentInput,LessonAgentJob} from './types';

const states=new Set(['pending','completed','failed','cancelled']);
const identifier=(value:unknown):value is string=>typeof value==='string'&&/^[a-f0-9-]{36}$/.test(value);
const errors:Record<string,[string,string]>={
  LESSON_AGENT_INVALID:['本次对话已变化，请重新发送。','The conversation changed. Send the question again.'],
  LESSON_AGENT_CONFLICT:['小节或智能体已变化，请重新发送。','The lesson or agent changed. Send the question again.'],
  LESSON_CONFLICT:['笔记已更新，请重新打开当前小节。','The notebook changed. Open the lesson again.'],
  LESSON_AGENT_UNAVAILABLE:['暂时无法读取小节或资料，请重试。','The lesson or material is unavailable. Try again.'],
  LESSON_AGENT_UNSUPPORTED:['此智能体暂不支持学习对话，请选择其他智能体。','This agent does not support learning conversations. Choose another agent.'],
  LESSON_AGENT_BUSY:['已有回答正在生成，请先停止或等待完成。','An answer is being generated. Wait or stop it first.'],
  LESSON_AGENT_REWRITE_INVALID:['未收到完整的修改提案，已有回答已保留。','A complete revision was not received. The answer was kept.'],
  LESSON_AGENT_DESKTOP_REQUIRED:['请在桌面 App 中连接智能体后提问。','Connect an agent in the desktop app to ask a question.'],
  LESSON_AGENT_RESPONSE_INVALID:['无法读取智能体的返回，已有内容已保留。','Could not read the agent response. Existing text was kept.'],
  PLANNING_AGENT_TIMEOUT:['智能体连续 3 分钟没有输出，已停止并保留已有内容。','Stopped after 3 minutes without agent output. Existing text was kept.'],
  PLANNING_AGENT_OPTIONS:['模型或推理强度不可用，请重新选择。','The model or reasoning effort is unavailable. Choose again.'],
  PLANNING_AGENT_PERMISSION_REQUIRED:['智能体需要额外权限，本次回答已停止。','The agent needs additional permission. This answer was stopped.'],
  PLANNING_AGENT_INPUT_LIMIT:['当前模型无法接收这么多内容，请减少引用后重试。','The model cannot accept this much content. Try fewer references.'],
  PLANNING_AGENT_IMAGE_UNSUPPORTED:['当前模型不支持图片，请更换模型后重试。','This model does not support images. Choose another model.'],
  PLANNING_AGENT_NETWORK:['连接中断，请重试，已有内容已保留。','The connection was interrupted. Existing text was kept. Try again.'],
  PLANNING_AGENT_PROTOCOL:['智能体回复未完成，已有内容已保留。','The agent response was incomplete. Existing text was kept.'],
  PLANNING_AGENT_OUTPUT_TOO_LARGE:['回答内容过长，请缩小问题范围。','The answer is too long. Narrow the question.'],
  PLANNING_AGENT_QUOTA:['智能体额度不足，请检查对应账户。','Check the agent account quota.'],
  PLANNING_AGENT_AUTH_REQUIRED:['请重新登录当前智能体。','Sign in to the current agent again.'],
  AGENT_AUTH_REQUIRED:['请重新登录当前智能体。','Sign in to the current agent again.'],
  AGENT_PROJECT_UNAVAILABLE:['项目目录不可用，请重新定位。','The project folder is unavailable. Locate it again.'],
};
export function lessonAgentMessage(cause:unknown,language:Language){
  const code=cause instanceof Error?cause.message:String(cause);
  const entry=Object.entries(errors).find(([key])=>code.includes(key))?.[1];
  return entry?.[language==='en'?1:0]??(language==='en'?'The agent could not finish. Existing text was kept. Try again.':'智能体未能完成回答，已有内容已保留，请重试。');
}
function parseJob(value:unknown,expectedId:string):LessonAgentJob{
  if(!value||typeof value!=='object')throw new Error('LESSON_AGENT_RESPONSE_INVALID');
  const job=value as Record<string,unknown>;
  if(job.id!==expectedId||!states.has(String(job.state))||typeof job.text!=='string'||job.text.length>1024*1024||
    (job.editText!==undefined&&(job.state!=='completed'||typeof job.editText!=='string'||job.editText.length>1024*1024))||
    (job.stage!==undefined&&typeof job.stage!=='string')||(job.errorCode!==undefined&&typeof job.errorCode!=='string'))throw new Error('LESSON_AGENT_RESPONSE_INVALID');
  return job as LessonAgentJob;
}
async function request(action:string,value:Record<string,unknown>){
  const bridge=window.vibeNative?.projects;
  if(!bridge)throw new Error('LESSON_AGENT_DESKTOP_REQUIRED');
  return bridge.request(action,value);
}
export const lessonAgent={
  async start(input:LessonAgentInput):Promise<{id:string}>{
    const value=await request('lesson.agent.start',input);
    if(!value||typeof value!=='object'||!identifier((value as {id?:unknown}).id))throw new Error('LESSON_AGENT_RESPONSE_INVALID');
    return {id:(value as {id:string}).id};
  },
  async poll(projectId:string,jobId:string):Promise<LessonAgentJob>{
    return parseJob(await request('lesson.agent.poll',{projectId,jobId}),jobId);
  },
  async cancel(projectId:string,jobId:string):Promise<LessonAgentJob>{
    return parseJob(await request('lesson.agent.cancel',{projectId,jobId}),jobId);
  },
};

/** The caller owns identity and persistence; abort stops polling, not a new lesson's job. */
export async function watchLessonAgent(projectId:string,jobId:string,onUpdate:(job:LessonAgentJob)=>void,signal?:AbortSignal):Promise<LessonAgentJob|undefined>{
  while(!signal?.aborted){
    const job=await lessonAgent.poll(projectId,jobId);
    if(signal?.aborted)return;
    onUpdate(job);
    if(job.state!=='pending')return job;
    await new Promise<void>(resolve=>{
      const finish=()=>{clearTimeout(timer);signal?.removeEventListener('abort',finish);resolve();};
      const timer=setTimeout(finish,300);signal?.addEventListener('abort',finish,{once:true});
      if(signal?.aborted)finish();
    });
  }
}
