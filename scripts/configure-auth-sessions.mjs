import {readFile} from 'node:fs/promises';
import {privateCloudApi} from './cloudbase-api-private.mjs';

const mode=process.argv[2];
if(!['--check','--apply'].includes(mode)||process.argv.length!==3)throw Error('USE_CHECK_OR_APPLY');
const config=JSON.parse(await readFile(new URL('../cloud/cloudbase.json',import.meta.url),'utf8'));
const maximum=config.authentication?.maxSessions;
if(!(maximum===-1||(Number.isInteger(maximum)&&maximum>=2&&maximum<=50)))throw Error('AUTH_SESSION_POLICY_INVALID');
const body={EnvId:config.envId,Id:config.envId};
const before=await privateCloudApi({action:'DescribeClient',body,region:config.region});
if(mode==='--apply'&&before.MaxDevice!==maximum)await privateCloudApi({action:'ModifyClient',body:{...body,MaxDevice:maximum},region:config.region});
const after=mode==='--apply'?await privateCloudApi({action:'DescribeClient',body,region:config.region}):before;
const report={maxSessions:after.MaxDevice,accessTokenSeconds:after.AccessTokenExpiresIn,refreshTokenSeconds:after.RefreshTokenExpiresIn,
 passed:after.MaxDevice===maximum&&before.AccessTokenExpiresIn===after.AccessTokenExpiresIn&&before.RefreshTokenExpiresIn===after.RefreshTokenExpiresIn};
console.log(JSON.stringify(report));if(!report.passed)process.exitCode=1;
