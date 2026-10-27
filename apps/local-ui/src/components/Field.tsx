import {useId, useState, type InputHTMLAttributes} from 'react';
import {Eye, EyeClosed, LockKeyhole, Mail, ShieldCheck, UserRound} from 'lucide-react';

type Props = InputHTMLAttributes<HTMLInputElement> & {label: string; hint?: string; error?: string; showLabel?: string; hideLabel?: string};

export default function Field({label, hint, error, type = 'text', id, showLabel = '显示密码', hideLabel = '隐藏密码', ...props}: Props) {
  const generated = useId();
  const fieldId = id ?? generated;
  const hintId = `${fieldId}-hint`;
  const errorId = `${fieldId}-error`;
  const [visible, setVisible] = useState(false);
  const password = type === 'password';
  const Icon = password ? LockKeyhole : type === 'email' ? Mail : props.autoComplete === 'one-time-code' ? ShieldCheck : props.autoComplete === 'nickname' ? UserRound : null;
  return <div className="field">
    <label htmlFor={fieldId} data-layout-text="field-label">{label}</label>
    <div className={`field-control ${Icon ? 'has-field-icon' : ''} ${password ? 'has-password-toggle' : ''} ${error ? 'has-error' : ''}`}>
      <span className="field-art" aria-hidden="true"><img src={`${import.meta.env.BASE_URL}assets/images/dialog-field-blank-v1.png`} alt="" style={{width:`${100*2172/2120}%`,height:`${100*724/356}%`,left:`${-100*26/2120}%`,top:`${-100*179/356}%`}} /></span>
      {Icon && <Icon className="field-icon" aria-hidden="true" focusable="false" />}
      <input {...props} placeholder={props.placeholder ?? label} id={fieldId} type={password && visible ? 'text' : type} aria-invalid={error ? true : props['aria-invalid']} aria-describedby={[props['aria-describedby'], hint && hintId, error && errorId].filter(Boolean).join(' ') || undefined} />
      {password && <button type="button" className="password-toggle" onClick={() => setVisible(!visible)} aria-label={visible ? hideLabel : showLabel} title={visible ? hideLabel : showLabel} aria-pressed={visible} disabled={props.disabled}>{visible ? <Eye aria-hidden="true" focusable="false" /> : <EyeClosed aria-hidden="true" focusable="false" />}</button>}
    </div>
    {hint && <p className="field-hint" id={hintId}>{hint}</p>}
    {error && <p className="field-error" id={errorId} role="alert">{error}</p>}
  </div>;
}
