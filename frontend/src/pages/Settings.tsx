import React, { useCallback, useEffect, useState } from 'react';
import { Activity, Eraser, KeyRound, Loader2, Save, Settings as SettingsIcon, ShieldCheck } from 'lucide-react';
import { Link, useNavigate } from 'react-router-dom';
import { getGlobalSettings, updateGlobalSettings } from '../api/client';
import type { GlobalSettings, UpdateGlobalSettingsPayload } from '../types';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../components/Toast';
import { ErrorState } from '../components/ErrorState';
import { LoadingSpinner } from '../components/Loading';

const inputClass = 'w-full px-3.5 py-2.5 text-sm bg-white border border-slate-300 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600 disabled:bg-slate-50 disabled:text-slate-400';
const cardClass = 'bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden';
const buttonClass = 'inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-xl transition-colors disabled:opacity-50 disabled:cursor-not-allowed';

function numberValue(value: string, label: string, min = 0, max = Number.MAX_SAFE_INTEGER) {
  const n = Number(value);
  if (!value.trim() || !Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${label}请输入 ${min} 至 ${max} 的整数`);
  return n;
}

export const Settings: React.FC = () => {
  const [saved, setSaved] = useState<GlobalSettings | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [healthEnabled, setHealthEnabled] = useState(true);
  const [intervalSeconds, setIntervalSeconds] = useState('300');
  const [cleanupEnabled, setCleanupEnabled] = useState(false);
  const [cleanupImmediate, setCleanupImmediate] = useState(false);
  const [cleanupIntervalSeconds, setCleanupIntervalSeconds] = useState('3600');
  const [hourlyLimit, setHourlyLimit] = useState('60');
  const [concurrency, setConcurrency] = useState('0');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState<'runtime' | 'password' | null>(null);
  const [runtimeError, setRuntimeError] = useState<string | null>(null);
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const toast = useToast();
  const { checkSession } = useAuth();
  const navigate = useNavigate();

  const fillRuntime = (s: GlobalSettings) => {
    setCleanupEnabled(s.mailboxCleanupEnabled);
    setCleanupImmediate(s.mailboxCleanupImmediate);
    setCleanupIntervalSeconds(String(s.mailboxCleanupIntervalMs / 1000));
    setHealthEnabled(s.healthCheckEnabled);
    setIntervalSeconds(String(s.healthCheckIntervalMs / 1000));
    setHourlyLimit(String(s.mailboxesPerKeyPerHour));
    setConcurrency(String(s.maxConcurrentRequestsPerKey));
  };
  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const s = await getGlobalSettings();
      setSaved(s); fillRuntime(s);
    } catch (err) { setLoadError((err as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const runtimeDirty = !!saved && (
    cleanupEnabled !== saved.mailboxCleanupEnabled
    || cleanupImmediate !== saved.mailboxCleanupImmediate
    || (cleanupEnabled && !cleanupImmediate && (!cleanupIntervalSeconds || Number(cleanupIntervalSeconds) * 1000 !== saved.mailboxCleanupIntervalMs))
    || healthEnabled !== saved.healthCheckEnabled
    || Number(intervalSeconds) * 1000 !== saved.healthCheckIntervalMs
    || Number(hourlyLimit) !== saved.mailboxesPerKeyPerHour
    || Number(concurrency) !== saved.maxConcurrentRequestsPerKey
    || !intervalSeconds || !hourlyLimit || !concurrency
  );
  const passwordDirty = !!newPassword || !!confirmPassword;
  useEffect(() => {
    if (!runtimeDirty && !passwordDirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [runtimeDirty, passwordDirty]);

  const saveRuntime = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!saved) return;
    setRuntimeError(null);
    try {
      const values = {
        mailboxCleanupEnabled: cleanupEnabled,
        mailboxCleanupImmediate: cleanupImmediate,
        mailboxCleanupIntervalMs: cleanupEnabled && !cleanupImmediate
          ? numberValue(cleanupIntervalSeconds ? String(Number(cleanupIntervalSeconds) * 1000) : '', '清理间隔（毫秒）', 60_000, 86_400_000)
          : saved.mailboxCleanupIntervalMs,
        healthCheckEnabled: healthEnabled,
        healthCheckIntervalMs: numberValue(intervalSeconds ? String(Number(intervalSeconds) * 1000) : '', '验活间隔（毫秒）', 60_000, 86_400_000),
        mailboxesPerKeyPerHour: numberValue(hourlyLimit, '每小时建箱上限'),
        maxConcurrentRequestsPerKey: numberValue(concurrency, '并发上限'),
      };
      // 仅提交用户实际修改的字段，减少覆盖其他管理员同时编辑的设置。
      const patch = Object.fromEntries(Object.entries(values).filter(([key, value]) => value !== saved[key as keyof GlobalSettings])) as UpdateGlobalSettingsPayload;
      if (!Object.keys(patch).length) return;
      setSaving('runtime');
      const res = await updateGlobalSettings(patch);
      setSaved(res.settings); fillRuntime(res.settings);
      toast.success('全局配置已保存，新的请求和后台任务将使用新设置');
    } catch (err) { setRuntimeError((err as Error).message); }
    finally { setSaving(null); }
  };

  const savePassword = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!saved) return;
    setPasswordError(null);
    if (newPassword !== confirmPassword) { setPasswordError('两次输入的新密码不一致'); return; }
    if (newPassword && (newPassword.length < 8 || !newPassword.trim())) { setPasswordError('新密码至少 8 个字符，且不能全为空格'); return; }
    if (!newPassword) { setPasswordError('请填写新密码'); return; }
    try {
      setSaving('password');
      const res = await updateGlobalSettings({
        currentPassword,
        newPassword,
      });
      setCurrentPassword(''); setNewPassword(''); setConfirmPassword('');
      setSaved(res.settings);
      if (res.reauthenticationRequired) {
        toast.success('登录密码已更新，请使用新密码重新登录');
        await checkSession();
        navigate('/login', { replace: true });
      }
    } catch (err) { setPasswordError((err as Error).message); }
    finally { setSaving(null); }
  };

  if (loadError && !saved) return <ErrorState message={loadError} onRetry={() => void load()} />;
  if (!saved) return <LoadingSpinner text="正在读取全局设置..." />;

  return (
    <div className="space-y-6 max-w-5xl">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-3 text-2xl font-bold text-slate-900"><SettingsIcon className="w-7 h-7 text-indigo-600" />全局设置</h1>
          <p className="mt-2 text-sm text-slate-500">管理登录密码、过期邮箱清理、渠道监控和默认调用限制。保存后自动生效，重启后保留。</p>
        </div>
        <span className={`text-xs px-3 py-1.5 rounded-full ${runtimeDirty || passwordDirty ? 'bg-amber-50 text-amber-700' : 'bg-emerald-50 text-emerald-700'}`}>
          {runtimeDirty || passwordDirty ? '有未保存的修改' : '配置已同步'}
        </span>
      </div>

      <form onSubmit={saveRuntime} className="space-y-5">
        <fieldset disabled={saving !== null} className="space-y-5">
          <section className={cardClass}>
            <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-2"><Activity className="w-5 h-5 text-indigo-600" /><h2 className="font-semibold text-slate-900">渠道验活</h2></div>
            <div className="p-6 grid gap-6 sm:grid-cols-2">
              <div>
                <label className="flex items-center gap-2.5 text-sm font-semibold text-slate-700"><input type="checkbox" checked={healthEnabled} onChange={(e) => setHealthEnabled(e.target.checked)} className="w-4 h-4 accent-indigo-600" />开启自动验活</label>
                <p className="mt-2 text-xs leading-6 text-slate-500">定期检查渠道存活和域名变动。关闭后暂停全部自动巡检，仍可在状态监控页手动检测。</p>
              </div>
              <div>
                <label htmlFor="health-interval" className="block text-sm font-medium text-slate-700 mb-2">默认验活间隔（秒）</label>
                <input id="health-interval" type="number" min={60} max={86400} step={0.001} required value={intervalSeconds} onChange={(e) => setIntervalSeconds(e.target.value)} className={inputClass} />
                <p className="mt-2 text-xs leading-6 text-slate-500">60–86400 秒；300 秒 = 5 分钟。单独配置的渠道沿用自己的间隔，具体检测时间取决于巡检调度。</p>
              </div>
            </div>
          </section>

          <section className={cardClass}>
            <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-2"><Eraser className="w-5 h-5 text-indigo-600" /><h2 className="font-semibold text-slate-900">过期邮箱自动清理</h2></div>
            <div className="p-6 space-y-5">
              <div>
                <label className="flex items-center gap-2.5 text-sm font-semibold text-slate-700"><input type="checkbox" checked={cleanupEnabled} onChange={(e) => setCleanupEnabled(e.target.checked)} className="w-4 h-4 accent-indigo-600" />开启自动清理过期邮箱</label>
                <p className="mt-2 text-xs leading-6 text-slate-500">自动清理<Link to="/mailboxes" className="text-indigo-600 hover:underline">邮箱概览</Link>中的过期记录。默认关闭；未过期和长期有效的邮箱会保留。</p>
              </div>
              <fieldset disabled={!cleanupEnabled} className="grid gap-5 sm:grid-cols-2 disabled:opacity-60">
                <div>
                  <p id="mailbox-cleanup-mode-label" className="text-sm font-medium text-slate-700 mb-3">清理方式</p>
                  <div role="radiogroup" aria-labelledby="mailbox-cleanup-mode-label" className="space-y-3">
                    <label className="flex items-center gap-2.5 text-sm text-slate-700"><input type="radio" name="mailbox-cleanup-mode" value="interval" checked={!cleanupImmediate} onChange={() => setCleanupImmediate(false)} className="w-4 h-4 accent-indigo-600" />按间隔清理</label>
                    <label className="flex items-center gap-2.5 text-sm text-slate-700"><input type="radio" name="mailbox-cleanup-mode" value="immediate" checked={cleanupImmediate} onChange={() => setCleanupImmediate(true)} className="w-4 h-4 accent-indigo-600" />过期立即清理</label>
                  </div>
                </div>
                <div>
                  <label htmlFor="mailbox-cleanup-interval" className="block text-sm font-medium text-slate-700 mb-2">清理间隔（秒）</label>
                  <input id="mailbox-cleanup-interval" type="number" min={60} max={86400} step={0.001} required={cleanupEnabled && !cleanupImmediate} disabled={cleanupImmediate} value={cleanupIntervalSeconds} onChange={(e) => setCleanupIntervalSeconds(e.target.value)} className={inputClass} />
                  <p className="mt-2 text-xs leading-6 text-slate-500">{cleanupImmediate ? '邮箱过期后尽快清理，无需等待批量清理间隔。' : '60–86400 秒，默认 3600 秒（1 小时）。启用或修改清理设置后，首次检查先清理一次，再按间隔执行。'}</p>
                </div>
              </fieldset>
            </div>
            <div className="px-6 py-3 bg-slate-50 border-t border-slate-100 text-xs text-slate-500 leading-6">仅删除网关记录，上游邮箱由上游管理。任务在后台运行，无需保持页面打开，也不受渠道验活开关影响。Docker 每秒检查；Cloudflare Workers 每分钟检查，访问邮箱概览时也会检查。</div>
          </section>

          <section className={cardClass}>
            <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-2"><KeyRound className="w-5 h-5 text-indigo-600" /><h2 className="font-semibold text-slate-900">Key 默认限制</h2></div>
            <div className="p-6 grid gap-6 sm:grid-cols-2">
              <div>
                <label htmlFor="key-concurrency" className="block text-sm font-medium text-slate-700 mb-2">每个 Key 的并发请求上限</label>
                <input id="key-concurrency" type="number" min={0} max={Number.MAX_SAFE_INTEGER} step={1} required value={concurrency} onChange={(e) => setConcurrency(e.target.value)} className={inputClass} />
                <p className="mt-2 text-xs leading-6 text-slate-500">同时处理的请求数，统一 API 与上游透传共用额度。0 表示不限，超限返回 429。</p>
              </div>
              <div>
                <label htmlFor="key-hourly" className="block text-sm font-medium text-slate-700 mb-2">每个 Key 每小时建箱上限</label>
                <input id="key-hourly" type="number" min={0} max={Number.MAX_SAFE_INTEGER} step={1} required value={hourlyLimit} onChange={(e) => setHourlyLimit(e.target.value)} className={inputClass} />
                <p className="mt-2 text-xs leading-6 text-slate-500">统一 API 的邮箱创建请求次数。0 表示不限；保存后保留本小时已用次数。</p>
              </div>
            </div>
            <div className="px-6 py-3 bg-slate-50 border-t border-slate-100 text-xs text-slate-500 leading-6">适用于新 Key 及选择“跟随系统默认”的已有 Key。可在 <Link to="/keys" className="text-indigo-600 hover:underline">API Keys</Link> 中单独覆盖；多进程或 Workers 部署时，额度按各运行实例分别计数。</div>
          </section>

          {runtimeError && <p role="alert" className="text-sm text-rose-700 bg-rose-50 border border-rose-200 p-3 rounded-xl">{runtimeError}</p>}
          <div className="flex flex-wrap justify-end gap-3">
            <button type="button" disabled={!runtimeDirty} onClick={() => { fillRuntime(saved); setRuntimeError(null); }} className="px-4 py-2.5 text-sm text-slate-600 border border-slate-200 bg-white rounded-xl disabled:opacity-50">撤销修改</button>
            <button type="submit" disabled={!runtimeDirty} className={buttonClass}>{saving === 'runtime' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}保存全局配置</button>
          </div>
        </fieldset>
      </form>

      <form onSubmit={savePassword} className={cardClass}>
        <div className="px-6 py-4 border-b border-slate-100 flex items-center gap-2"><ShieldCheck className="w-5 h-5 text-indigo-600" /><h2 className="font-semibold text-slate-900">登录密码</h2></div>
        <fieldset disabled={saving !== null} className="p-6 space-y-5">
          <p className="text-sm text-slate-500 leading-6">后台仅使用密码登录。修改密码需验证当前密码；保存后所有旧会话失效，需要重新登录。</p>
          <div className="grid gap-5 sm:grid-cols-3">
            <div><label htmlFor="current-password" className="block text-sm font-medium text-slate-700 mb-2">当前密码</label><input id="current-password" type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required maxLength={1024} autoComplete="current-password" className={inputClass} /></div>
            <div><label htmlFor="new-password" className="block text-sm font-medium text-slate-700 mb-2">新密码</label><input id="new-password" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required minLength={8} maxLength={128} autoComplete="new-password" placeholder="至少 8 个字符" className={inputClass} /></div>
            <div><label htmlFor="confirm-password" className="block text-sm font-medium text-slate-700 mb-2">确认新密码</label><input id="confirm-password" type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required={!!newPassword} maxLength={128} autoComplete="new-password" placeholder="再次输入新密码" className={inputClass} /></div>
          </div>
          {passwordError && <p role="alert" className="text-sm text-rose-700 bg-rose-50 border border-rose-200 p-3 rounded-xl">{passwordError}</p>}
          {runtimeDirty && <p className="text-xs text-amber-700">请先保存上方全局配置，避免重新登录时丢失未保存的修改。</p>}
          <div className="flex justify-end"><button type="submit" disabled={!passwordDirty || runtimeDirty} className={buttonClass}>{saving === 'password' ? <Loader2 className="w-4 h-4 animate-spin" /> : <ShieldCheck className="w-4 h-4" />}更新登录密码</button></div>
        </fieldset>
      </form>
    </div>
  );
};
