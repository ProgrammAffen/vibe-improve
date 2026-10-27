const invalid = () => {throw Object.assign(new Error('LICENSE_CLOCK_UNTRUSTED'), {code:'LICENSE_CLOCK_UNTRUSTED'});};
const integer = value => Number.isSafeInteger(value) && value >= 0;
const boot = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{16,128}$/.test(value);
export function validClockAnchor(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === 'bootId,continuousMs,schemaVersion,serverTimeMs' &&
    value.schemaVersion === 1 && boot(value.bootId) && integer(value.continuousMs) && integer(value.serverTimeMs) && value.serverTimeMs > 0;
}
export class TrustedLicenseClock {
  constructor({sample, performanceNow = () => performance.now()}) {this.sampleSource = sample; this.performanceNow = performanceNow; this.anchor = null; this.last = null;}
  get trusted() {return Boolean(this.anchor && this.last && this.anchor.bootId === this.last.sample.bootId && this.last.sample.continuousMs >= this.anchor.continuousMs);}
  async sample() {
    let sample;
    try {sample = await this.sampleSource();} catch {this.anchor = null; invalid();}
    if (!sample || sample.schemaVersion !== 1 || !boot(sample.bootId) || !integer(sample.continuousMs)) {this.anchor = null; invalid();}
    if (this.last && (sample.bootId !== this.last.sample.bootId || sample.continuousMs < this.last.sample.continuousMs)) this.anchor = null;
    this.last = {sample, performance: this.performanceNow()};
    return {...sample};
  }
  async restore(value) {
    this.anchor = null;
    const sample = await this.sample();
    if (!validClockAnchor(value) || value.bootId !== sample.bootId || value.continuousMs > sample.continuousMs) return false;
    this.anchor = {...value}; return true;
  }
  now() {
    if (!this.trusted) invalid();
    const elapsed = this.performanceNow() - this.last.performance;
    if (!Number.isFinite(elapsed) || elapsed < 0) {this.anchor = null; invalid();}
    const value = Math.floor(this.anchor.serverTimeMs + this.last.sample.continuousMs - this.anchor.continuousMs + elapsed);
    if (!Number.isSafeInteger(value)) invalid();
    return value;
  }
  async observe(serverTimeMs, before) {
    if (!integer(serverTimeMs) || serverTimeMs <= 0 || !before || !integer(before.continuousMs) || !boot(before.bootId)) invalid();
    const previous = this.anchor;
    const sample = await this.sample();
    if (sample.bootId !== before.bootId || sample.continuousMs < before.continuousMs) {this.anchor = null; invalid();}
    const floor = previous?.bootId === sample.bootId && sample.continuousMs >= previous.continuousMs
      ? previous.serverTimeMs + sample.continuousMs - previous.continuousMs : 0;
    this.anchor = {schemaVersion:1,bootId:sample.bootId,continuousMs:sample.continuousMs,serverTimeMs:Math.max(serverTimeMs + sample.continuousMs - before.continuousMs,floor)};
    return this.now();
  }
  record() {return this.trusted ? {...this.anchor} : null;}
}
