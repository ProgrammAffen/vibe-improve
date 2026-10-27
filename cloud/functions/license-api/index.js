'use strict';
const cloudbase = require('@cloudbase/node-sdk');

exports.main = async (event, context) => {
  const { createRequestDiagnostics, CLIENT_TRACE_PATTERN } = await import('./diagnostics.mjs');
  const diagnostics = createRequestDiagnostics(event, {platformRequestId: context?.request_id ?? context?.requestId});
  let stage = 'cloud.import';
  try {
    const [{ createLicenseService, createSigner }, { cloudRepository }, { trustedIdentity, requestFromEvent }] = await Promise.all([
      import('./service.mjs'), import('./cloud-repository.mjs'), import('./cloud-auth.mjs'),
    ]);
    stage = 'cloud.config';
    const env = process.env.CLOUDBASE_ENV_ID;
    if (!env) return diagnostics.finish(failure('SERVICE_UNCONFIGURED'), {stage});
    stage = 'cloud.request';
    const request = requestFromEvent(event);
    const app = cloudbase.init({ env });
    const allowed = (process.env.LICENSE_ALLOWED_LOGIN_TYPES || '').split(',').filter(Boolean);
    stage = 'cloud.identity';
    const identity = await trustedIdentity(app, cloudbase, context, allowed);
    stage = 'cloud.signer';
    let signer;
    try {
      signer = createSigner({
        privateKeyPem: process.env.LICENSE_SIGNING_PRIVATE_KEY_PEM,
        keyId: process.env.LICENSE_SIGNING_KEY_ID,
        issuer: process.env.LICENSE_ISSUER,
        audience: process.env.LICENSE_AUDIENCE,
        productId: process.env.LICENSE_PRODUCT_ID,
      });
    } catch (cause) { return diagnostics.finish(failure('SERVICE_UNCONFIGURED'), {stage, cause}); }
    stage = 'cloud.repository';
    const service = createLicenseService({
      repo: cloudRepository(app.database()), signer,
      leaseSeconds: integerEnv('LICENSE_LEASE_SECONDS'),
      maxDevices: integerEnv('LICENSE_MAX_DEVICES'),
      activationCodePublicKeyPem: process.env.LICENSE_ACTIVATION_PUBLIC_KEY_PEM,
      offlineGraceSeconds: integerEnv('LICENSE_OFFLINE_GRACE_SECONDS', 0),
      rateLimitPerMinute: integerEnv('LICENSE_RATE_LIMIT_PER_MINUTE', 60),
    });
    const data = await service.handle(request, identity);
    const timeProof = typeof event?.clientTraceId === 'string' && CLIENT_TRACE_PATTERN.test(event.clientTraceId)
      ? signer.issue({purpose:'server-time-v1',userId:identity.uid,nonce:event.clientTraceId,serverTime:new Date().toISOString()}) : undefined;
    return diagnostics.finish({ ok: true, data, ...(timeProof && {timeProof}) }, {stage});
  } catch (error) {
    const { LicenseError } = await import('./service.mjs');
    return diagnostics.finish(error instanceof LicenseError ? failure(error.code, error.retryable) : failure('SERVICE_UNAVAILABLE', true), {stage, cause: error});
  }
};
function integerEnv(name, fallback) {
  const value = process.env[name];
  if (value === undefined && fallback !== undefined) return fallback;
  return typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value) ? Number(value) : NaN;
}
function failure(code, retryable = false) { return { ok: false, error: { code, retryable } }; }
