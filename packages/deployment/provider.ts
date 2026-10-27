export interface DeploymentArtifact {
  directory: string;
  version: string;
  apiEnvironment: string;
}
export interface DeploymentRelease {
  provider: 'cloudbase' | 'cloudflare';
  url: string;
  version: string;
  verified: boolean;
}
export interface DeploymentProvider {
  plan(artifact: DeploymentArtifact): Promise<{provider: string; destination: string; files: string[]}>;
  deploy(plan: {provider: string; destination: string; files: string[]}): Promise<DeploymentRelease>;
  verify(release: DeploymentRelease): Promise<DeploymentRelease>;
}
export const cloudflareStatus = {implemented: false, consumes: 'tmp/build/web', apiProvider: 'cloudbase'} as const;
