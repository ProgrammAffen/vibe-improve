export interface LicenseTrust {
  keyId: string;
  publicKeySpki: string;
  issuer: string;
  audience: string;
  productId: string;
}
export interface ExpectedLicenseIdentity {
  userId: string;
  deviceId: string;
  bindingId: string;
  licenseId: string;
  now?: number;
}
export interface VerifiedLicenseClaims {
  readonly schemaVersion: 1;
  readonly keyId: string;
  readonly issuer: string;
  readonly audience: string;
  readonly productId: string;
  readonly userId: string;
  readonly deviceId: string;
  readonly bindingId: string;
  readonly licenseId: string;
  readonly features: readonly string[];
  readonly issuedAt: string;
  readonly notBefore: string;
  readonly expiresAt: string;
  readonly leaseExpiresAt: string;
  readonly offlineUntil: string;
}
export function verifyLicenseCertificate(certificate: unknown, trust: LicenseTrust, expected: ExpectedLicenseIdentity): Promise<VerifiedLicenseClaims>;
export function verifyServerTimeProof(certificate: unknown, trust: LicenseTrust, expected: {userId:string;nonce:string}): Promise<number>;
