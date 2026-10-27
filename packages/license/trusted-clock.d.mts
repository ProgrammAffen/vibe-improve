export type ClockSample = {schemaVersion:1; bootId:string; continuousMs:number};
export type ClockAnchor = ClockSample & {serverTimeMs:number};
export function validClockAnchor(value:unknown):value is ClockAnchor;
export class TrustedLicenseClock {
  constructor(options:{sample:()=>Promise<ClockSample>; performanceNow?:()=>number});
  readonly trusted:boolean;
  sample():Promise<ClockSample>;
  restore(value:unknown):Promise<boolean>;
  now():number;
  observe(serverTimeMs:number,before:ClockSample):Promise<number>;
  record():ClockAnchor|null;
}
