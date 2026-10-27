import {useCallback, useEffect, useRef, useState, type FormEvent, type MouseEvent} from 'react';
import service from './api';
import Field from './components/Field';
import GameButton from './components/GameButton';
import BackHomeButton from './components/BackHomeButton';
import Modal from './components/Modal';
import {NewProjectPage, ProjectListPage} from './components/ProjectPages';
import {type ProjectRecord} from './projects/domain';
import SettingsPage, {type SoundPreferences} from './components/SettingsPage';
import AgentSelectionPage from './components/AgentSelectionPage';
import {Info, Mail, TriangleAlert} from 'lucide-react';
import {dateLabel, readLanguage, translate, type Language} from './i18n';
import {logEvent} from './logger';
import {passwordPair} from './password-validation';
import './styles.css';
import './dialogs.css';

type Snapshot = Awaited<ReturnType<typeof service.getSnapshot>>;
type Page = 'home' | 'settings' | 'account' | 'projects' | 'new-project' | 'agents';
type AuthMode = 'login' | 'register' | 'verify' | 'forgot' | 'reset' | 'change';
type NativeBridge = {preferences?: Record<string, unknown>; setPreferences?: (value: Record<string, unknown>) => void; quit?: () => void};
const ASSET = import.meta.env.BASE_URL + 'assets/';
const BASE = {width: 1672, height: 1672 * 9 / 16};
const nativeBridge = () => (window as unknown as {vibeNative?: NativeBridge}).vibeNative;

function readSound(): SoundPreferences {
  const defaults = {enabled: false, volume: 50, effects: true, motion: !window.matchMedia('(prefers-reduced-motion: reduce)').matches};
  try {
    const value = nativeBridge()?.preferences?.sound ?? JSON.parse(localStorage.getItem('vibe-improve.preferences') ?? 'null');
    if (!value || typeof value !== 'object') return defaults;
    const prefs = value as Partial<SoundPreferences>;
    return {
      enabled: typeof prefs.enabled === 'boolean' ? prefs.enabled : defaults.enabled,
      effects: typeof prefs.effects === 'boolean' ? prefs.effects : defaults.effects,
      motion: typeof prefs.motion === 'boolean' ? prefs.motion : defaults.motion,
      volume: typeof prefs.volume === 'number' && Number.isFinite(prefs.volume) ? Math.max(0, Math.min(100, prefs.volume)) : defaults.volume,
    };
  } catch { return defaults; }
}

function initialPage(): Page {
  const path = window.location.hash.replace(/^#\/?/, '');
  return ['settings', 'account', 'projects', 'new-project', 'agents'].includes(path) ? path as Page : 'home';
}

function licenseStatus(license: any): string {
  if (!license) return 'unlicensed';
  return license.status ?? (license.active ? 'valid' : 'unlicensed');
}

export default function App() {
  const [language, setLanguage] = useState<Language>(readLanguage);
  const [sound, setSound] = useState<SoundPreferences>(readSound);
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [page, setPage] = useState<Page>(initialPage);
  const [selectedProject, setSelectedProject] = useState<ProjectRecord | null>(null);
  const [agentOrigin,setAgentOrigin]=useState<'settings'|'project'>('settings');
  const [settingsTab, setSettingsTab] = useState('general');
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [localBusy, setLocalBusy] = useState(false);
  const [error, setError] = useState('');
  const [dismissedServiceError, setDismissedServiceError] = useState<string | null>(null);
  const [success, setSuccess] = useState('');
  const [auth, setAuth] = useState<AuthMode | null>(null);
  const [email, setEmail] = useState('');
  const [nickname, setNickname] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [oldPassword, setOldPassword] = useState('');
  const [code, setCode] = useState('');
  const [clock, setClock] = useState(Date.now);
  const [activationCode, setActivationCode] = useState('');
  const [redeemOpen, setRedeemOpen] = useState(false);
  const [removeDevice, setRemoveDevice] = useState<string | null>(null);
  const [featureNotice, setFeatureNotice] = useState<'new' | 'load' | 'exit' | null>(null);
  const [scale, setScale] = useState(() => Math.min(window.innerWidth / BASE.width, window.innerHeight / BASE.height));
  const video = useRef<HTMLVideoElement>(null);
  const clickAudio = useRef<AudioContext | null>(null);
  const t = useCallback((zh: string, en: string) => translate(language, zh, en), [language]);
  const busy = localBusy || Boolean(snapshot?.busy);
  const user = snapshot?.user;
  const status = licenseStatus(snapshot?.license);
  const valid = ['valid', 'active', 'offline_valid', 'renewal_retry'].includes(status);
  const needsDeviceBinding = ['device_unbound', 'device_limit', 'device_revoked'].includes(status);
  const deviceLimitReached = status === 'device_limit';
  const needsLicenseCheck = ['network_error', 'checking', 'invalid'].includes(status);
  const entitlementActive = needsDeviceBinding || Boolean(snapshot?.license?.entitlementActive ?? snapshot?.license?.entitlement_active ?? valid);
  const expired = ['expired', 'lease_expired'].includes(status);
  const warning = error || (snapshot?.error !== dismissedServiceError ? snapshot?.error : '') || '';
  const codePurpose = auth === 'register' || auth === 'verify' ? 'registration' : auth === 'forgot' || auth === 'reset' ? 'reset' : auth === 'change' ? 'change' : null;
  const codeRetryAt = codePurpose ? service.getCodeRetryAt(codePurpose, email) : 0;
  const resendSeconds = Math.max(0, Math.ceil((codeRetryAt - clock) / 1000));
  const passwords = passwordPair(password, confirmation);

  useEffect(() => {
    const tick = () => setClock(Date.now());
    tick();
    if (codeRetryAt <= Date.now()) return;
    const timer = window.setInterval(() => {tick(); if (Date.now() >= codeRetryAt) window.clearInterval(timer);}, 1000);
    document.addEventListener('visibilitychange', tick);
    return () => {window.clearInterval(timer); document.removeEventListener('visibilitychange', tick);};
  }, [codeRetryAt]);

  const refresh = useCallback(async () => {
    const value = await service.getSnapshot();
    setSnapshot(value);
  }, []);

  useEffect(() => {
    let active = true;
    service.getSnapshot().then(value => {if (active) setSnapshot(value);}).catch(cause => {if (active) setError(String(cause.message ?? cause));});
    const unsubscribe = service.subscribe((next?: Snapshot) => {
      if (next) {if (active) setSnapshot(next);}
      else service.getSnapshot().then(value => {if (active) setSnapshot(value);}).catch(cause => {if (active) setError(String(cause.message ?? cause));});
    });
    return () => {active = false; unsubscribe();};
  }, []);

  useEffect(() => {
    if (page === 'account' && user && !busy && !snapshot?.restoring) void service.loadDevices().catch(() => {});
  }, [page, user?.id, busy, snapshot?.restoring]);

  useEffect(() => {
    if (!snapshot?.reauthRequired) return;
    setAuth('login'); setRemoveDevice(null); setFeatureNotice(null); setRedeemOpen(false); setActivationCode('');
    setPassword(''); setConfirmation(''); setOldPassword(''); setCode('');
    setError(''); setSuccess(''); setDismissedServiceError(null);
  }, [snapshot?.reauthRequired]);

  useEffect(() => {setRedeemOpen(false); setActivationCode('');}, [user?.id]);

  useEffect(() => {
    const resize = () => setScale(Math.min(window.innerWidth / BASE.width, window.innerHeight / BASE.height));
    const route = () => setPage(initialPage());
    window.addEventListener('resize', resize);
    window.addEventListener('hashchange', route);
    return () => {window.removeEventListener('resize', resize); window.removeEventListener('hashchange', route);};
  }, []);

  useEffect(() => {
    document.documentElement.lang = language;
    try {localStorage.setItem('vibe-improve.language', language);} catch { /* Preference storage is optional. */ }
  }, [language]);

  useEffect(() => {
    const native = nativeBridge();
    native?.setPreferences?.({...native.preferences, language, sound});
  }, [language, sound]);

  useEffect(() => {
    const query = window.matchMedia('(prefers-reduced-motion: reduce)');
    const changed = () => setReducedMotion(query.matches);
    query.addEventListener('change', changed);
    return () => query.removeEventListener('change', changed);
  }, []);

  useEffect(() => {
    try {localStorage.setItem('vibe-improve.preferences', JSON.stringify(sound));} catch { /* Preference storage is optional. */ }
    const updatePlayback = () => {
      if (!video.current) return;
      video.current.muted = true;
      if (sound.motion && !reducedMotion && !document.hidden && page === 'home') video.current.play().catch(() => {});
      else video.current.pause();
    };
    updatePlayback();
    document.addEventListener('visibilitychange', updatePlayback);
    return () => document.removeEventListener('visibilitychange', updatePlayback);
  }, [sound, page, reducedMotion]);

  useEffect(() => () => {clickAudio.current?.close().catch(() => {});}, []);

  function playClick(event: MouseEvent<HTMLElement>) {
    if (!sound.enabled || !sound.effects || !sound.volume || !(event.target instanceof Element)) return;
    const target = event.target.closest('button');
    if (!target || target.disabled || !window.AudioContext) return;
    try {
      const context = clickAudio.current ?? (clickAudio.current = new AudioContext());
      if (context.state === 'suspended') void context.resume().catch(() => {});
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      const now = context.currentTime;
      oscillator.type = 'sine';
      oscillator.frequency.setValueAtTime(620, now);
      oscillator.frequency.exponentialRampToValueAtTime(430, now + .065);
      gain.gain.setValueAtTime(.001, now);
      gain.gain.exponentialRampToValueAtTime(.025 * sound.volume / 100, now + .006);
      gain.gain.exponentialRampToValueAtTime(.001, now + .075);
      oscillator.connect(gain); gain.connect(context.destination);
      oscillator.start(now); oscillator.stop(now + .08);
      oscillator.onended = () => {oscillator.disconnect(); gain.disconnect();};
    } catch { /* Audio support does not block controls. */ }
  }

  function navigate(next: Page) {
    setPage(next);
    setError('');
    setSuccess('');
    setDismissedServiceError(snapshot?.error ?? null);
    window.location.hash = next === 'home' ? '/' : `/${next}`;
  }

  async function run(action: () => Promise<unknown>, completed?: () => void) {
    if (busy) return;
    setLocalBusy(true);
    setError('');
    setSuccess('');
    setDismissedServiceError(null);
    try {await action(); await refresh(); completed?.();}
    catch (cause: any) {setError(cause?.message || t('服务请求失败，请重试。', 'The service request failed. Please try again.'));}
    finally {setLocalBusy(false);}
  }

  function openAuth(mode: AuthMode) {
    if (snapshot?.restoring) return;
    setError(''); setSuccess(''); setDismissedServiceError(snapshot?.error ?? null); setAuth(mode); setCode('');
    setPassword(''); setConfirmation(''); setOldPassword('');
    if (user) setEmail(user.email);
  }

  function closeAuth() {
    if (busy) return;
    setAuth(null); setPassword(''); setConfirmation(''); setOldPassword(''); setCode(''); setError(''); setSuccess(''); setDismissedServiceError(snapshot?.error ?? null);
  }

  function openRedeem() {
    if (busy || !user || snapshot?.restoring) return;
    setActivationCode(''); setError(''); setSuccess('');
    setDismissedServiceError(snapshot?.error ?? null); setRedeemOpen(true);
  }

  function closeRedeem() {
    if (busy) return;
    setRedeemOpen(false); setActivationCode(''); setError(''); setSuccess('');
    setDismissedServiceError(snapshot?.error ?? null);
  }

  function openAccount() {if (snapshot?.restoring) return; if (user) navigate('account'); else openAuth('login');}
  function newPasswordValid() {
    if (passwords.policyError || !password) {
      logEvent('operation.failed', {operation: auth === 'register' ? 'auth.registration.send' : auth === 'change' ? 'auth.password.change' : 'auth.password.reset', stage: 'client.validation', resultCode: 'PASSWORD_INVALID', reason: 'password_policy'});
      return false;
    }
    if (!passwords.valid) {logEvent('operation.failed', {operation: auth === 'register' ? 'auth.registration.send' : auth === 'change' ? 'auth.password.change' : 'auth.password.reset', stage: 'client.validation', resultCode: 'PASSWORD_MISMATCH', reason: 'password_mismatch'}); return false;}
    return true;
  }

  async function submitAuth(event: FormEvent) {
    event.preventDefault();
    if (auth === 'login') {
      await run(async () => {await service.login(email.trim(), password); if ((await service.getSnapshot()).license?.status === 'device_limit') navigate('account');}, () => {setAuth(null); setPassword('');});
    } else if (auth === 'register') {
      if (!newPasswordValid()) return;
      await run(() => service.sendRegistration(email.trim(), password, nickname.trim()), () => {setAuth('verify'); setCode(''); setSuccess(t('验证码已发送。', 'Verification code sent.'));});
    } else if (auth === 'verify') {
      await run(() => service.register(email.trim(), password, nickname.trim(), code), () => {setAuth(null); setPassword(''); setConfirmation(''); navigate('account');});
    } else if (auth === 'forgot') {
      await run(() => service.sendReset(email.trim()), () => {setAuth('reset'); setCode(''); setPassword(''); setConfirmation(''); setSuccess(t('验证码已发送。', 'Verification code sent.'));});
    } else if (auth === 'reset') {
      if (!newPasswordValid()) return;
      await run(() => service.resetPassword(code, password), () => {navigate('home'); setAuth('login'); setPassword(''); setConfirmation(''); setCode(''); setSuccess(t('密码已重置，请重新登录。', 'Password reset. Please sign in again.'));});
    } else if (auth === 'change') {
      if (!newPasswordValid()) return;
      await run(() => service.changePassword(oldPassword, password, code), () => {navigate('home'); setAuth('login'); setOldPassword(''); setPassword(''); setConfirmation(''); setCode(''); setSuccess(t('密码已修改，请重新登录。', 'Password changed. Please sign in again.'));});
    }
  }

  const accountLabel = snapshot?.restoring ? t('恢复登录中…', 'Signing in…') : user && needsLicenseCheck ? t('授权待检查', 'Check license') : !user ? t('未登录', 'Sign in') : expired ? t('授权已到期', 'License expired') : status === 'device_revoked' ? t('当前设备已解绑', 'Device removed') : deviceLimitReached ? t('设备已达上限', 'Device limit reached') : needsDeviceBinding ? t('设备未绑定', 'Device not linked') : valid ? user.nickname || user.email : t('未激活', 'Not activated');
  const authTitle = auth === 'register' ? t('注册账户', 'Create account') : auth === 'verify' ? t('验证邮箱', 'Verify email') : auth === 'forgot' ? t('忘记密码', 'Forgot password') : auth === 'reset' ? t('重置密码', 'Reset password') : auth === 'change' ? t('修改密码', 'Change password') : t('登录', 'Sign in');
  const cooldownLabel = t(`${resendSeconds} 秒后重发`, `Resend in ${resendSeconds}s`);
  const sendsOnSubmit = auth === 'register' || auth === 'forgot';
  const submitLabel = busy ? t('处理中…', 'Please wait…') : sendsOnSubmit && resendSeconds > 0 ? cooldownLabel : auth === 'register' ? t('发送验证码', 'Send verification code') : auth === 'verify' ? t('完成注册', 'Complete registration') : auth === 'forgot' ? t('发送验证码', 'Send reset code') : auth === 'reset' ? t('重置密码', 'Reset password') : auth === 'change' ? t('确认修改', 'Change password') : t('登录', 'Sign in');
  const hasCode = ['verify', 'reset', 'change'].includes(auth ?? '');
  const hasNewPassword = ['register', 'reset', 'change'].includes(auth ?? '');
  const authIncomplete = !email.trim() || (auth === 'register' && !nickname.trim()) || (auth === 'login' && !password) || (hasCode && !/^\d{6}$/.test(code)) || (hasNewPassword && !passwords.valid) || (auth === 'change' && !oldPassword) || (sendsOnSubmit && resendSeconds > 0);
  const showPassword = {showLabel: t('显示密码', 'Show password'), hideLabel: t('隐藏密码', 'Hide password')};

  function detailsHeader() {
    return <header className="detail-header"><BackHomeButton language={language} onClick={() => navigate('home')}/></header>;
  }

  function renderHome() {
    return <div className="home-world" style={{width: BASE.width, height: BASE.height, transform: `translate(-50%, -50%) scale(${scale})`}}>
      <div className="home-scene">
        <img src={`${ASSET}images/home-volcano-background-1920x1080.png`} alt="" />
        <video ref={video} src={`${ASSET}video/home-volcano-loop-1080p-v1.mp4`} poster={`${ASSET}images/home-volcano-background-1920x1080.png`} autoPlay={sound.motion && !reducedMotion && !document.hidden} muted loop playsInline preload="auto" aria-hidden="true" />
      </div>
      <img className="home-title" src={`${ASSET}images/home-title-vibe-improve-v1.png`} alt="Vibe Improve" />
      <button type="button" className="account-capsule" onClick={openAccount} disabled={snapshot?.restoring} title={accountLabel} aria-label={t('我的账户：', 'My account: ') + accountLabel}>
        <img src={`${ASSET}images/home-icon-person-dark-v1.svg`} alt="" /><span className={user && valid ? 'is-user-data' : ''} data-layout-text="account-capsule">{accountLabel}</span>
      </button>
      <nav className="home-menu" aria-label={t('主菜单', 'Main menu')}>
        <GameButton icon="play" onClick={() => {setSelectedProject(null); navigate('new-project');}}>{t('开始新项目', 'New Quest')}</GameButton>
        <GameButton icon="folder" variant="secondary" onClick={() => navigate('projects')}>{t('加载项目', 'Load Quest')}</GameButton>
        <GameButton icon="gear" variant="secondary" onClick={() => navigate('settings')}>{t('设置', 'Settings')}</GameButton>
        <GameButton icon="exit" variant="danger" onClick={() => setFeatureNotice('exit')}>{t('退出', 'Exit')}</GameButton>
      </nav>
    </div>;
  }

  function renderSettings() {
    return <SettingsPage language={language} onLanguage={setLanguage} sound={sound} onSound={setSound} reducedMotion={reducedMotion} activeId={settingsTab} onSelect={setSettingsTab} accountName={user?.nickname || user?.email} busy={busy} onAccount={openAccount} onBack={() => navigate('home')} onAgents={()=>{setAgentOrigin('settings');navigate('agents')}} />;
  }

  function renderAccount() {
    const license = snapshot?.license;
    const expiry = license?.expiresAt ?? license?.expires_at;
    const devices = snapshot?.devices ?? [];
    const devicesState = snapshot?.devicesState ?? 'idle';
    const statusText = status === 'network_error' || status === 'checking' ? t('授权待检查', 'Check license') : status === 'device_revoked' ? t('当前设备已解绑', 'Device removed') : deviceLimitReached ? t('设备已达上限', 'Device limit reached') : needsDeviceBinding ? t('当前设备未绑定', 'Device not linked') : valid ? status === 'offline_valid' ? t('离线有效', 'Valid offline') : t('已激活', 'Activated') : expired ? t('已到期', 'Expired') : status === 'revoked' ? t('已撤销', 'Revoked') : status === 'invalid' ? t('授权异常', 'License needs attention') : t('未激活', 'Not activated');
    return <div className="detail-page account-page" data-layout-region="account">{detailsHeader()}
      <div className="account-layout">
        <div className="account-character"><img src={`${ASSET}images/account-hamster-knight-v1.png`} alt={t('金丝熊骑士', 'Hamster knight')} /></div>
        <section className="account-panel" aria-labelledby="account-title" data-layout-region="account-scroll">
          <h1 id="account-title">{t('我的账户', 'My account')}</h1>
          {!user ? <div className="signed-out-account"><p>{t('未登录', 'Not signed in')}</p><GameButton onClick={() => openAuth('login')}>{t('登录', 'Sign in')}</GameButton></div> : <>
            <dl className="identity-list"><div><dt>{t('昵称', 'Nickname')}</dt><dd title={user.nickname}>{user.nickname}</dd></div><div><dt>{t('邮箱', 'Email')}</dt><dd title={user.email}>{user.email}</dd></div><div><dt>{t('授权状态', 'License')}</dt><dd><span className={`license-badge ${valid ? 'is-valid' : ''}`}>{statusText}</span></dd></div>{expiry && <div><dt>{t('有效期至', 'Valid until')}</dt><dd>{dateLabel(expiry, language)}</dd></div>}</dl>
            {!entitlementActive && <form className="activation-form" onSubmit={event => {event.preventDefault(); run(() => service.activate(activationCode.trim()), () => {setActivationCode(''); setSuccess(t('激活成功。', 'License activated.'));});}}><Field label={t('激活码', 'Activation code')} value={activationCode} onChange={event => setActivationCode(event.target.value)} autoComplete="off" disabled={busy} required /><GameButton type="submit" disabled={busy || !activationCode.trim()}>{busy ? t('处理中…', 'Please wait…') : t('激活', 'Activate')}</GameButton></form>}
            <div className="account-tools"><button type="button" className="text-button" onClick={() => openAuth('change')} disabled={busy}>{t('修改密码', 'Change password')}</button><button type="button" className="text-button" onClick={() => run(() => service.refreshLicense())} disabled={busy}>{t('检查授权', 'Check license')}</button><button type="button" className="text-button" onClick={openRedeem} disabled={busy || snapshot?.restoring}>{t('续期 / 兑换激活码', 'Renew / redeem code')}</button></div>
            <section className="devices-section" aria-labelledby="devices-title" aria-busy={devicesState === 'loading'}><div className="device-heading"><h2 id="devices-title">{t('已绑定设备', 'Linked devices')}{snapshot?.devicesMaxDevices != null && <span className="device-capacity">{devices.length} / {snapshot.devicesMaxDevices}</span>}</h2><div className="device-actions">{needsDeviceBinding && <button type="button" className="text-button" onClick={() => run(() => service.requestDeviceBinding())} disabled={busy}>{t('绑定当前设备', 'Link this device')}</button>}<button type="button" className="text-button" onClick={() => void service.loadDevices(true).catch(() => {})} disabled={busy || devicesState === 'loading'}>{t('刷新设备', 'Refresh devices')}</button></div></div>
              {devicesState === 'loading' && <p className="empty-devices" role="status">{t('正在加载设备…', 'Loading devices…')}</p>}
              {devicesState === 'idle' && <p className="empty-devices" role="status">{t('设备列表尚未加载', 'Devices not loaded')}</p>}
              {devicesState === 'error' && <p className="form-message is-error" role="alert">{t('设备列表加载失败。', 'Could not load devices.')} {snapshot?.devicesError}</p>}
              {devices.length === 0 ? devicesState === 'ready' && <p className="empty-devices">{t('暂无已绑定设备', 'No linked devices')}</p> : <ul className="device-list">{devices.map((device: any) => {
                const deviceId = device.device_id ?? device.deviceId ?? device.id;
                const current = device.is_current ?? device.isCurrent ?? deviceId === snapshot?.deviceId;
                const deviceName = device.device_name ?? device.deviceName ?? device.name ?? t('设备', 'Device');
                return <li key={deviceId} data-layout-region="device-card"><div className="device-details"><strong title={deviceName}>{deviceName}</strong>{current && <span className="device-current">{t('当前', 'This device')}</span>}<small>{dateLabel(device.last_seen_at ?? device.lastSeenAt, language)}</small></div><button type="button" className="text-button device-remove" onClick={() => setRemoveDevice(deviceId)} disabled={busy}>{t('移除', 'Remove')}</button></li>;
              })}</ul>}
            </section>
            {warning && !auth && !redeemOpen && <p className="form-message is-error" role="alert">{warning}</p>}{success && !auth && !redeemOpen && <p className="form-message is-success" role="status">{success}</p>}
            <div className="account-actions"><GameButton variant="secondary" onClick={() => run(() => service.logout(), () => {navigate('home');})} disabled={busy}>{t('退出登录', 'Sign out')}</GameButton></div>
          </>}
        </section>
      </div>
    </div>;
  }

  return <main className={`app lang-${language}`} aria-busy={busy} onInvalidCapture={event => {if (event.target instanceof HTMLInputElement && event.target.type === 'email') logEvent('operation.failed', {operation: auth === 'register' ? 'auth.registration.send' : auth === 'forgot' ? 'auth.password.reset.send' : 'auth.login', stage: 'client.validation', resultCode: 'AUTH_EMAIL_INVALID', reason: 'email_invalid'});}} onClickCapture={playClick}>
    {page === 'home' ? renderHome() : page === 'settings' ? renderSettings() : page === 'projects' ? <ProjectListPage language={language} onBack={() => navigate('home')} onNew={() => {setSelectedProject(null); navigate('new-project');}} onOpen={record => {setSelectedProject(record); navigate('new-project');}} /> : page === 'new-project' ? <NewProjectPage key={selectedProject?.id ?? 'new'} language={language} record={selectedProject} onBack={() => navigate('home')} onSaved={record => {setSelectedProject(record);setAgentOrigin('project');navigate('agents');}} /> : page === 'agents' ? <AgentSelectionPage language={language} project={agentOrigin==='project'?selectedProject:null} settings={agentOrigin==='settings'} onPrevious={()=>navigate(agentOrigin==='settings'?'settings':'new-project')} onHome={()=>navigate('home')} onDone={()=>{navigate(agentOrigin==='settings'?'settings':'projects');}} /> : renderAccount()}
    {auth && <Modal title={authTitle} onClose={closeAuth} closeLabel={t('关闭', 'Close')} busy={busy} className={`auth-dialog auth-${auth}`}>
      <form className="auth-form" onSubmit={submitAuth}>
        {auth === 'register' && <Field label={t('昵称', 'Nickname')} value={nickname} onChange={event => setNickname(event.target.value)} autoComplete="nickname" maxLength={64} disabled={busy} required />}
        {['login', 'register', 'forgot'].includes(auth) && <Field label={t('邮箱', 'Email')} type="email" value={email} onChange={event => setEmail(event.target.value)} autoComplete="email" autoFocus disabled={busy} required />}
        {auth === 'change' && <Field label={t('当前密码', 'Current password')} type="password" value={oldPassword} onChange={event => setOldPassword(event.target.value)} autoComplete="current-password" autoFocus disabled={busy} required {...showPassword} />}
        {(auth === 'login' || hasNewPassword) && <div className={hasNewPassword ? 'password-fields' : ''}><Field label={auth === 'login' || auth === 'register' ? t('密码', 'Password') : t('新密码', 'New password')} type="password" value={password} onChange={event => setPassword(event.target.value)} autoComplete={auth === 'login' ? 'current-password' : 'new-password'} minLength={auth === 'login' ? undefined : 8} maxLength={auth === 'login' ? undefined : 128} error={hasNewPassword && passwords.policyError ? t('密码需为 8–128 位，包含英文字母和数字。', 'Use 8–128 characters, including a letter and a number.') : undefined} disabled={busy} required {...showPassword} />{hasNewPassword && <Field label={t('确认密码', 'Confirm password')} type="password" value={confirmation} onChange={event => setConfirmation(event.target.value)} autoComplete="new-password" minLength={8} maxLength={128} error={passwords.mismatch ? t('两次密码不一致。', 'The passwords do not match.') : undefined} disabled={busy} required {...showPassword} />}</div>}
        {hasNewPassword && <p className="password-rule">{t('8–128 位，包含英文字母和数字', '8–128 characters, including a letter and a number')}</p>}
        {hasCode && <><div className="verification-email"><Mail aria-hidden="true" focusable="false" /><span>{email}</span></div><div className="verification-row"><Field label={t('邮箱验证码', 'Email code')} value={code} onChange={event => setCode(event.target.value.replace(/\D/g, '').slice(0, 6))} inputMode="numeric" pattern="[0-9]{6}" maxLength={6} autoComplete="one-time-code" autoFocus={auth !== 'change'} disabled={busy} required /><GameButton variant="secondary" className="resend-code" onClick={() => run(() => auth === 'change' ? service.sendChangePassword() : auth === 'verify' ? service.sendRegistration(email.trim(), password, nickname.trim()) : service.sendReset(email.trim()), () => {setCode(''); setSuccess(t('验证码已发送。', 'Verification code sent.'));})} disabled={busy || resendSeconds > 0}>{resendSeconds > 0 ? cooldownLabel : t('重新发送验证码', 'Resend code')}</GameButton></div></>}
        {warning && <p className="form-message is-error" role="alert">{warning}</p>}{success && <p className="form-message is-success" role="status">{success}</p>}
        <div className="auth-submit"><GameButton type="submit" disabled={busy || authIncomplete}>{submitLabel}</GameButton></div>
        <div className="auth-links">
          {auth === 'login' ? <><button type="button" onClick={() => openAuth('register')} disabled={busy}>{t('注册账户', 'Create account')}</button><button type="button" onClick={() => openAuth('forgot')} disabled={busy}>{t('忘记密码', 'Forgot password')}</button></> : auth === 'verify' ? <button type="button" onClick={() => {setAuth('register'); setError('');}} disabled={busy}>{t('返回修改', 'Edit details')}</button> : auth !== 'change' ? <button type="button" onClick={() => openAuth('login')} disabled={busy}>{t('返回登录', 'Back to sign in')}</button> : null}
        </div>
      </form>
    </Modal>}
    {redeemOpen && user && !auth && <Modal title={t('兑换激活码', 'Redeem activation code')} closeLabel={t('关闭', 'Close')} onClose={closeRedeem} busy={busy} className="license-redeem-dialog">
      <form className="license-redeem-form" onSubmit={event => {event.preventDefault(); if (!activationCode.trim()) return; void run(() => service.activate(activationCode.trim()), () => {setActivationCode(''); setRedeemOpen(false); setSuccess(t('激活码已兑换。', 'Activation code redeemed.'));});}}>
        {(snapshot.license?.expiresAt ?? snapshot.license?.expires_at) && <dl className="redeem-current-expiry"><dt>{t('当前有效期至', 'Currently valid until')}</dt><dd>{dateLabel(snapshot.license?.expiresAt ?? snapshot.license?.expires_at, language)}</dd></dl>}
        <Field label={t('激活码', 'Activation code')} value={activationCode} onChange={event => setActivationCode(event.target.value)} autoComplete="off" autoCapitalize="characters" spellCheck={false} autoFocus disabled={busy} required />
        {warning && <p className="form-message is-error" role="alert">{warning}</p>}
        <div className="confirmation-actions"><GameButton variant="secondary" onClick={closeRedeem} disabled={busy}>{t('取消', 'Cancel')}</GameButton><GameButton type="submit" disabled={busy || !activationCode.trim()}>{busy ? t('处理中…', 'Please wait…') : t('兑换', 'Redeem')}</GameButton></div>
      </form>
    </Modal>}
    {snapshot?.bindingPrompt && user && !auth && !removeDevice && !redeemOpen && <Modal title={t('绑定当前设备', 'Link this device')} closeLabel={t('关闭', 'Close')} onClose={() => service.dismissDeviceBinding()} busy={busy} className="device-binding-dialog"><div className="confirmation-message"><Info className="notice-icon info-icon" aria-hidden="true" focusable="false" /><p className="confirmation-copy">{t('是否将当前设备绑定到此账户？', 'Link this device to your account?')}</p></div><p className="binding-capacity">{t('已绑定设备', 'Linked devices')} {snapshot.bindingPrompt.used} / {snapshot.bindingPrompt.maximum}</p>{warning && <p className="form-message is-error" role="alert">{warning}</p>}<div className="confirmation-actions"><GameButton variant="secondary" onClick={() => service.dismissDeviceBinding()} disabled={busy}>{t('暂不绑定', 'Not now')}</GameButton><GameButton onClick={() => run(() => service.bindDevice())} disabled={busy}>{t('确认绑定', 'Link device')}</GameButton></div></Modal>}
    {removeDevice && <Modal title={t('移除设备', 'Remove device')} closeLabel={t('关闭', 'Close')} onClose={() => setRemoveDevice(null)} busy={busy}><div className="confirmation-message"><TriangleAlert className="notice-icon warning-icon" aria-hidden="true" focusable="false" /><p className="confirmation-copy">{t('移除后，该设备将失去授权。学习数据仍保留。', 'This device will lose access to the license. Learning data stays intact.')}</p></div>{warning && <p className="form-message is-error" role="alert">{warning}</p>}<div className="confirmation-actions"><GameButton variant="secondary" onClick={() => setRemoveDevice(null)} disabled={busy}>{t('取消', 'Cancel')}</GameButton><GameButton variant="danger" onClick={() => run(() => service.revokeDevice(removeDevice!), () => setRemoveDevice(null))} disabled={busy}>{t('确认移除', 'Remove device')}</GameButton></div></Modal>}
    {featureNotice && <Modal title={featureNotice === 'new' ? t('开始新项目', 'New Quest') : featureNotice === 'load' ? t('加载项目', 'Load Quest') : t('退出', 'Exit')} closeLabel={t('关闭', 'Close')} onClose={() => setFeatureNotice(null)}><div className="confirmation-message">{featureNotice !== 'exit' && <Info className="notice-icon info-icon" aria-hidden="true" focusable="false" />}<p className="confirmation-copy">{featureNotice === 'exit' ? t('退出 Vibe Improve？', 'Exit Vibe Improve?') : t('此功能尚未接入。', 'This feature is not connected yet.')}</p></div><div className="confirmation-actions">{featureNotice === 'exit' ? <><GameButton variant="secondary" onClick={() => setFeatureNotice(null)}>{t('取消', 'Cancel')}</GameButton><GameButton variant="danger" onClick={() => {const native = nativeBridge(); if (native?.quit) native.quit(); else window.close(); setFeatureNotice(null);}}>{t('退出', 'Exit')}</GameButton></> : <GameButton variant="secondary" onClick={() => setFeatureNotice(null)}>{t('返回', 'Back')}</GameButton>}</div></Modal>}
  </main>;
}

