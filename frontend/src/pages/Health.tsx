import React, { useState, useEffect, useCallback } from 'react';
import {
  Activity,
  RefreshCw,
  Zap,
  AlertCircle,
  AlertTriangle,
  Globe,
  Plus,
  Minus,
  RefreshCcwDot,
} from 'lucide-react';
import {
  getHealthStatus,
  triggerHealthCheck,
  updateMonitorConfig,
  syncUpstreamDomains,
} from '../api/client';
import { HealthChannel, ApiError } from '../types';
import { useToast } from '../components/Toast';
import { Badge } from '../components/Badge';
import { TableSkeleton } from '../components/Loading';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { formatDateTime } from '../utils/format';

/** 时间线展示的条数（不足补空槽，保持视觉宽度稳定） */
const TIMELINE_SLOTS = 50;

/** 相对时间文案（时间线左端标注） */
function relativeTime(iso: string): string {
  const diffMin = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin} 分钟前`;
  const hours = Math.round(diffMin / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.round(hours / 24)} 天前`;
}

function shortTime(iso: string): string {
  const d = new Date(iso);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export const Health: React.FC = () => {
  const [channels, setChannels] = useState<HealthChannel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);
  const toast = useToast();
  // 请求序号守卫：手动刷新/立即检测与 30s 轮询并发时，慢的旧响应不得覆盖新数据
  const requestSeq = React.useRef(0);

  const load = useCallback(
    async (opts?: { silent?: boolean }) => {
      const seq = ++requestSeq.current;
      try {
        const next = await getHealthStatus();
        if (seq !== requestSeq.current) return; // 已有更新的请求发出，丢弃本次结果
        setError(null);
        setChannels(next);
        setLoading(false);
      } catch (err) {
        if (seq !== requestSeq.current) return;
        const message = err instanceof ApiError ? err.message : '无法获取健康状态，请检查网络或后端服务';
        if (opts?.silent) {
          // 后台轮询失败不毁掉整页：手里有数据就降级为 toast，首屏失败仍走 ErrorState
          toast.error(message);
        } else {
          setError(message);
          setLoading(false);
        }
      }
    },
    [toast],
  );

  useEffect(() => {
    load();
    // 30 秒自动刷新（仅拉取记录，不主动触发探测）
    const timer = setInterval(() => void load({ silent: true }), 30_000);
    return () => clearInterval(timer);
  }, [load]);

  const handleCheckNow = async () => {
    try {
      setChecking(true);
      await triggerHealthCheck();
      await load();
      toast.success('已完成一轮上游健康检查');
    } catch (err) {
      toast.error((err as Error).message || '健康检查失败');
    } finally {
      setChecking(false);
    }
  };

  const upCount = channels.filter((c) => c.status === 'up').length;
  const downCount = channels.filter((c) => c.status === 'down').length;

  return (
    <div className="space-y-6">
      {/* 头部 */}
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight flex items-center gap-2.5">
            <Activity className="w-7 h-7 text-indigo-600" />
            <span>状态监控</span>
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            定时探测各渠道上游存活状态与域名变化（每 5 分钟一轮，新渠道自动纳入），只监控存活，不统计请求。每 30 秒自动刷新。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void load()}
            title="刷新数据"
            className="p-2.5 text-slate-600 hover:text-slate-900 bg-white hover:bg-slate-100 border border-slate-200 rounded-xl shadow-sm transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            type="button"
            onClick={handleCheckNow}
            disabled={checking}
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white font-medium text-sm rounded-xl shadow-lg shadow-indigo-100 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50 transition-all"
          >
            <Zap className={`w-4 h-4 ${checking ? 'animate-pulse' : ''}`} />
            <span>{checking ? '检测中...' : '立即检测'}</span>
          </button>
        </div>
      </div>

      {/* 概览条 */}
      {!loading && !error && channels.length > 0 && (
        <div className="flex items-center gap-3 text-sm">
          <Badge variant={downCount === 0 ? 'emerald' : 'rose'} dot>
            {downCount === 0 ? '全部正常' : `${downCount} 个渠道异常`}
          </Badge>
          <span className="text-slate-500 text-xs">
            {upCount}/{channels.length} 个渠道存活 · 共监控 {channels.reduce((n, c) => n + c.domainCount, 0)} 个域名
          </span>
        </div>
      )}

      {/* 主体 */}
      {loading ? (
        <div className="space-y-4">
          <TableSkeleton rows={3} cols={4} />
          <TableSkeleton rows={3} cols={4} />
        </div>
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : channels.length === 0 ? (
        <EmptyState
          icon={<Activity className="w-10 h-10 text-slate-400" />}
          title="暂无被监控的渠道"
          description="在「上游管理」接入上游后，渠道会自动加入状态监控。"
        />
      ) : (
        <div className="space-y-4">
          {channels.map((ch) => (
            <HealthCard key={ch.id} channel={ch} onConfigChange={load} />
          ))}

          <div className="flex items-center gap-4 px-1 text-[11px] text-slate-400">
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block w-3 h-3 rounded-[3px] bg-emerald-500" />
              存活
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block w-3 h-3 rounded-[3px] bg-rose-500" />
              异常
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block w-3 h-3 rounded-[3px] bg-slate-200" />
              未检测 / 空槽
            </span>
            <span className="ml-auto">每一格 = 一轮健康检查（含存活探测与域名变化对比）</span>
          </div>
        </div>
      )}
    </div>
  );
};

/** 测活频率选项（value 为毫秒；-1 = 关闭该渠道监控；null = 跟随全局默认） */
const INTERVAL_OPTIONS: { value: number | null; label: string }[] = [
  { value: null, label: '跟随全局默认' },
  { value: 60_000, label: '每 1 分钟' },
  { value: 120_000, label: '每 2 分钟' },
  { value: 300_000, label: '每 5 分钟' },
  { value: 600_000, label: '每 10 分钟' },
  { value: 1_800_000, label: '每 30 分钟' },
  { value: 3_600_000, label: '每 1 小时' },
  { value: -1, label: '关闭监控' },
];

const HealthCard: React.FC<{ channel: HealthChannel; onConfigChange: () => void }> = ({ channel: ch, onConfigChange }) => {
  const toast = useToast();
  const [savingConfig, setSavingConfig] = useState(false);

  // 频率下拉的当前值：关闭 → -1；独立间隔 → 毫秒；否则 null
  const currentFreq = ch.monitorDisabled ? -1 : ch.monitorIntervalMs;

  const handleFreqChange = async (value: string) => {
    try {
      setSavingConfig(true);
      // 显式判 "null"（跟随全局）；数值项才走 Number 转换
      if (value === 'null') {
        await updateMonitorConfig(ch.id, { disabled: false, intervalMs: null });
      } else {
        const parsed = Number(value);
        if (parsed === -1) {
          await updateMonitorConfig(ch.id, { disabled: true });
        } else if (Number.isFinite(parsed) && parsed > 0) {
          await updateMonitorConfig(ch.id, { disabled: false, intervalMs: parsed });
        }
      }
      toast.success(`渠道「${ch.name}」测活频率已更新`);
      onConfigChange();
    } catch (err) {
      toast.error((err as Error).message || '更新测活频率失败');
    } finally {
      setSavingConfig(false);
    }
  };

  const handleAutoSyncToggle = async (next: boolean) => {
    try {
      setSavingConfig(true);
      await updateMonitorConfig(ch.id, { autoSyncDomains: next });
      toast.success(next ? `渠道「${ch.name}」域名变动将自动同步` : `渠道「${ch.name}」域名变动改为只检测不同步`);
      onConfigChange();
    } catch (err) {
      toast.error((err as Error).message || '更新自动同步设置失败');
    } finally {
      setSavingConfig(false);
    }
  };

  /** 待人工确认的同步（安全闸拦下）：点一次手动同步即可应用 */
  const handleConfirmSync = async () => {
    try {
      setSavingConfig(true);
      const res = await syncUpstreamDomains(ch.id);
      toast.success(`已同步：新增 ${res.added.length}、移除 ${res.removed.length}，当前 ${res.total} 个域名`);
      onConfigChange();
    } catch (err) {
      toast.error((err as Error).message || '同步域名失败');
    } finally {
      setSavingConfig(false);
    }
  };

  const asc = ch.timeline; // 后端已按时间升序返回（旧 → 新）；不再 reverse
  const pad = Math.max(0, TIMELINE_SLOTS - asc.length);
  const oldest = asc[0]?.checkedAt ?? null;
  const isDown = ch.status === 'down';
  const isUnknown = ch.status === 'unknown';

  return (
    <div className={`bg-white rounded-2xl border shadow-sm p-5 ${isDown ? 'border-rose-200' : 'border-slate-200'}`}>
      {/* 头部：名称 + 状态徽标 + 存活率/时延/域名数 */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 mb-4">
        <Globe className="w-5 h-5 text-indigo-500 flex-shrink-0" />
        <span className="text-base font-bold text-slate-900">{ch.name}</span>
        <span className="text-[11px] font-mono text-slate-400 bg-slate-100 border border-slate-200 rounded px-1.5 py-0.5">
          {ch.type}
        </span>
        {isUnknown ? (
          <Badge variant="slate">未检测</Badge>
        ) : isDown ? (
          <Badge variant="rose" dot>
            异常
          </Badge>
        ) : (
          <Badge variant="emerald" dot>
            正常
          </Badge>
        )}
        {!ch.enabled && <Badge variant="slate">已停用</Badge>}

        <span className="ml-auto flex items-center gap-3 text-xs text-slate-600 font-medium">
          {ch.uptimePct !== null && (
            <span>
              <span className={`font-bold font-mono ${ch.uptimePct >= 100 ? 'text-emerald-600' : ch.uptimePct >= 80 ? 'text-amber-600' : 'text-rose-600'}`}>
                {ch.uptimePct}%
              </span>{' '}
              <span className="text-slate-400">存活率</span>
            </span>
          )}
          <span className="text-slate-300">·</span>
          <span>
            <span className="font-bold font-mono text-slate-700">{ch.domainCount}</span>{' '}
            <span className="text-slate-400">域名</span>
          </span>
          {ch.latencyMs !== null && (
            <>
              <span className="text-slate-300">·</span>
              <span className="font-mono text-slate-500">{ch.latencyMs}ms</span>
            </>
          )}
        </span>
      </div>

      {/* 测活频率配置（自托管渠道可调低频率以节省上游请求配额，如 CF 免费版每日 10 万请求） */}
      <div className="flex flex-wrap items-center gap-2 mb-4 text-xs">
        <span className="text-slate-400">测活频率：</span>
        <select
          value={currentFreq === null ? 'null' : String(currentFreq)}
          disabled={savingConfig}
          onChange={(e) => void handleFreqChange(e.target.value)}
          title="每个渠道可独立设置探测频率；调低可减少对上游的请求消耗"
          className="px-2 py-1 bg-white border border-slate-200 rounded-lg text-xs text-slate-700 font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600 transition-all cursor-pointer disabled:opacity-50"
        >
          {INTERVAL_OPTIONS.map((o) => (
            <option key={String(o.value)} value={String(o.value)}>
              {o.label}
            </option>
          ))}
          {/* 后端接受任意 ≥60s 的毫秒值：非预设间隔要可见可改，避免下拉空白后静默覆盖 */}
          {ch.monitorIntervalMs !== null &&
            !INTERVAL_OPTIONS.some((o) => o.value === ch.monitorIntervalMs) && (
              <option value={String(ch.monitorIntervalMs)}>
                自定义 {Math.round(ch.monitorIntervalMs / 60_000)} 分钟
              </option>
            )}
        </select>
        <label
          className="inline-flex items-center gap-1.5 text-slate-500 cursor-pointer select-none"
          title="开启后，测活发现上游新增/下架域名会直接写入域名列表。上游已下架的域名留在表里也建不出邮箱，只会污染域名下拉与 Key 白名单选择器。"
        >
          <input
            type="checkbox"
            checked={ch.autoSyncDomains}
            disabled={savingConfig}
            onChange={(e) => void handleAutoSyncToggle(e.target.checked)}
            className="w-3.5 h-3.5 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500/30 cursor-pointer disabled:opacity-50"
          />
          <span>自动同步域名变动</span>
        </label>
        {ch.monitorDisabled ? (
          <span className="text-slate-400">该渠道已关闭自动监控，可用「立即检测」手动探测</span>
        ) : ch.effectiveIntervalMs === null ? (
          <span className="text-amber-600">全局自动验活已暂停，可在全局设置中开启</span>
        ) : (
          (
            <span className="text-slate-400">
              实际每 <span className="font-mono font-semibold text-slate-600">{Math.round(ch.effectiveIntervalMs / 60_000)}</span> 分钟探测一次
              {ch.type === 'yydsmail' ? (
                <span className="ml-1">（官方托管，不消耗你的 CF 请求配额）</span>
              ) : (
                <span className="ml-1">
                  ≈ <span className="font-mono">{Math.round(86_400_000 / Math.max(1, ch.effectiveIntervalMs)).toLocaleString()}</span> 次/天 上游请求
                </span>
              )}
            </span>
          )
        )}
      </div>

      {/* 时间线条形图 */}
      <div className="flex items-end gap-[3px] h-9">
        {Array.from({ length: pad }).map((_, i) => (
          <div key={`pad-${i}`} className="flex-1 h-full rounded-[3px] bg-slate-100" />
        ))}
        {asc.map((point) => (
          <div
            key={point.checkedAt}
            title={`${formatDateTime(point.checkedAt)} · ${point.status === 'up' ? '存活' : '异常'}${
              point.latencyMs !== null ? ` · ${point.latencyMs}ms` : ''
            }`}
            className={`flex-1 h-full rounded-[3px] cursor-default transition-transform hover:scale-y-110 ${
              point.status === 'up' ? 'bg-emerald-500' : 'bg-rose-500'
            }`}
          />
        ))}
      </div>

      {/* 时间标注 */}
      <div className="flex items-center justify-between mt-2 text-[11px] text-slate-400">
        <span>{oldest ? relativeTime(oldest) : '暂无检查记录'}</span>
        <span>{oldest ? `最早 ${shortTime(oldest)}` : ''}</span>
        <span>现在</span>
      </div>

      {/* 附加信息行 */}
      {(ch.domainChange || ch.pendingSync || (isDown && ch.lastError) || ch.lastCheckedAt) && (
        <div className="mt-3 pt-3 border-t border-slate-100 space-y-1.5 text-xs">
          {ch.lastCheckedAt && (
            <div className="text-slate-400">
              上次检查：<span className="font-mono">{formatDateTime(ch.lastCheckedAt)}</span>
            </div>
          )}
          {/* 安全闸拦下的同步：需要人工确认，否则会一直重复出现在每轮检查里 */}
          {ch.pendingSync && (
            <div className="flex items-start gap-1.5 text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5">
              <AlertTriangle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              <div className="space-y-1">
                <div>
                  检测到 {ch.pendingSync.removed.length} 个域名下架，但<strong>未自动应用</strong>：{ch.pendingSync.reason}
                </div>
                <div
                  className="text-amber-600/80 underline underline-offset-2 decoration-dotted cursor-help break-all"
                  title={ch.pendingSync.removed.join('、')}
                >
                  待移除：{ch.pendingSync.removed.slice(0, 3).join('、')}
                  {ch.pendingSync.removed.length > 3 ? ` 等 ${ch.pendingSync.removed.length} 个` : ''}
                </div>
                <button
                  type="button"
                  disabled={savingConfig}
                  onClick={() => void handleConfirmSync()}
                  className="inline-flex items-center gap-1 px-2 py-1 bg-white hover:bg-amber-100 border border-amber-300 rounded-md font-medium text-amber-800 transition-colors disabled:opacity-50"
                >
                  <RefreshCcwDot className="w-3 h-3" />
                  确认并同步
                </button>
              </div>
            </div>
          )}
          {ch.domainChange && (
            <div className="flex items-center gap-1.5 text-slate-600 flex-wrap">
              <span className="text-slate-400">域名变化（{formatDateTime(ch.domainChange.checkedAt)}）：</span>
              {(ch.domainChange.added.length > 0 || ch.domainChange.removed.length > 0) ? (
                <>
                  {ch.domainChange.added.length > 0 && (
                    <span className="inline-flex items-center gap-0.5 text-emerald-700 bg-emerald-50 border border-emerald-200 rounded px-1.5 py-0.5 font-mono">
                      <Plus className="w-3 h-3" />
                      {ch.domainChange.added.length}
                    </span>
                  )}
                  {ch.domainChange.removed.length > 0 && (
                    <span className="inline-flex items-center gap-0.5 text-rose-700 bg-rose-50 border border-rose-200 rounded px-1.5 py-0.5 font-mono">
                      <Minus className="w-3 h-3" />
                      {ch.domainChange.removed.length}
                    </span>
                  )}
                  <span
                    className="text-slate-400 underline underline-offset-2 decoration-dotted cursor-help"
                    title={[...ch.domainChange.added.map((d) => `+${d}`), ...ch.domainChange.removed.map((d) => `-${d}`)].join('、')}
                  >
                    查看明细
                  </span>
                  {/* 差异是否已落到域名列表：不写清楚的话，"检测到"与"已处理"看起来一样 */}
                  {ch.domainChange.syncAction === 'applied' && (
                    <span className="text-emerald-600">已同步到域名列表</span>
                  )}
                  {ch.domainChange.syncAction === 'detected' && (
                    <span className="text-slate-400">仅检测（该渠道未开启自动同步）</span>
                  )}
                </>
              ) : (
                <span className="text-slate-400">无</span>
              )}
            </div>
          )}
          {isDown && ch.lastError && (
            <div className="flex items-start gap-1.5 text-rose-600">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              <span className="break-all">{ch.lastError}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
