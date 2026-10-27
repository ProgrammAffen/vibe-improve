import { LicenseError } from './service.mjs';
import { CLIENT_TRACE_PATTERN } from './diagnostics.mjs';

export function requestFromEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return event;
  const { tcbContext, clientTraceId, ...request } = event;
  if (clientTraceId !== undefined && (typeof clientTraceId !== 'string' || !CLIENT_TRACE_PATTERN.test(clientTraceId))) throw new LicenseError('INVALID_REQUEST');
  return request;
}

export async function trustedIdentity(app, sdk, platformContext, allowedLoginTypes = []) {
  if (!platformContext || typeof platformContext !== 'object') throw new LicenseError('AUTH_REQUIRED');
  let authContext;
  let injected;
  try {
    authContext = await app.auth().getAuthContext(platformContext);
    injected = sdk.getCloudbaseContext(platformContext);
  } catch { throw new LicenseError('AUTH_CONTEXT_UNAVAILABLE'); }
  const uid = authContext?.uid;
  const loginType = authContext?.loginType;
  const anonymous = injected?.TCB_ISANONYMOUS_USER;
  if (typeof uid !== 'string' || !uid || uid.length > 256) throw new LicenseError('AUTH_REQUIRED');
  if (anonymous === true || anonymous === 'true' || (typeof loginType === 'string' && /anonym/i.test(loginType))) throw new LicenseError('AUTH_REQUIRED');
  const explicitlyRegistered = anonymous === false || anonymous === 'false';
  const verifiedLoginType = typeof loginType === 'string' && allowedLoginTypes.includes(loginType);
  if (!explicitlyRegistered && !verifiedLoginType) throw new LicenseError('AUTH_CONTEXT_UNSUPPORTED');
  return { uid, anonymous: false };
}
