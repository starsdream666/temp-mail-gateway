import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Globe,
  RefreshCw,
  Search,
  ChevronDown,
  ChevronRight,
  Copy as CopyIcon,
  Filter,
} from 'lucide-react';
import { getAllDomains, setDomainEnabled, setChannelDomainsEnabled } from '../api/client';
import { AdminDomainInfo, ApiError } from '../types';
import { useToast } from '../components/Toast';
import { Badge } from '../components/Badge';
import { CopyButton } from '../components/CopyButton';
import { Toggle } from '../components/Toggle';
import { TableSkeleton } from '../components/Loading';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { tldOf, baseDomainOf, domainLevelOf, levelNameForLabelCount, collectOptions } from '../utils/domain';

interface ChannelGroup {
  upstreamId: string;
  upstreamName: string;
  upstreamType: string;
  upstreamEnabled: boolean;
  domains: AdminDomainInfo[];
}

type StatusFilter = '' | 'enabled' | 'disabled';

/** 每个渠道分组默认渲染的域名行数上限（超过部分点"显示全部"展开） */
const RENDER_CAP = 50;

/**
 * 域名总览：全渠道域名的只读预览 + 调用开关。
 * 支持关键字 / 顶级域 / 主域 / 渠道 / 状态筛选，按渠道（上游实例）分组展示。
 */
export const Domains: React.FC = () => {
  const [domains, setDomains] = useState<AdminDomainInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [togglingDomain, setTogglingDomain] = useState<string | null>(null);
  const [batchChannelId, setBatchChannelId] = useState<string | null>(null);

  // 复合 key = `${upstreamId}:${domain}`：同一域名可登记在多个渠道（复合主键），
  // 单用 domain 会把其他渠道的同名行一起改掉/一起打上 loading
  const domainKey = (d: { upstreamId: string; domain: string }) => `${d.upstreamId}:${d.domain}`;

  // 筛选条件
  const [keyword, setKeyword] = useState('');
  const [tld, setTld] = useState('');
  const [baseDomain, setBaseDomain] = useState('');
  const [level, setLevel] = useState('');
  const [channel, setChannel] = useState('');
  const [status, setStatus] = useState<StatusFilter>('');

  // 渠道分组折叠状态 + 大分组"显示全部"状态（默认每组只渲染前 RENDER_CAP 行，避免卡顿）
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});

  const toast = useToast();

  const loadDomains = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      setDomains(await getAllDomains());
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('无法获取域名列表，请检查网络或后端状态');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadDomains();
  }, [loadDomains]);

  const tldOptions = useMemo(() => collectOptions(domains.map((d) => d.domain), tldOf), [domains]);
  const baseOptions = useMemo(() => collectOptions(domains.map((d) => d.domain), baseDomainOf), [domains]);
  const levelOptions = useMemo(
    () =>
      collectOptions(domains.map((d) => d.domain), (d) => String(domainLevelOf(d)))
        .map((o) => ({ value: o.value, count: o.count, name: levelNameForLabelCount(Number(o.value)) }))
        .sort((a, b) => Number(a.value) - Number(b.value)),
    [domains],
  );
  const channelOptions = useMemo(() => {
    const map = new Map<string, string>();
    for (const d of domains) map.set(d.upstreamId, d.upstreamName);
    return [...map.entries()].sort((a, b) => a[1].localeCompare(b[1]));
  }, [domains]);

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return domains.filter((d) => {
      if (kw && !d.domain.includes(kw)) return false;
      if (tld && tldOf(d.domain) !== tld) return false;
      if (baseDomain && baseDomainOf(d.domain) !== baseDomain) return false;
      if (level && domainLevelOf(d.domain) !== Number(level)) return false;
      if (channel && d.upstreamId !== channel) return false;
      if (status === 'enabled' && !d.enabled) return false;
      if (status === 'disabled' && d.enabled) return false;
      return true;
    });
  }, [domains, keyword, tld, baseDomain, level, channel, status]);

  const groups = useMemo(() => {
    const map = new Map<string, ChannelGroup>();
    for (const d of filtered) {
      let g = map.get(d.upstreamId);
      if (!g) {
        g = {
          upstreamId: d.upstreamId,
          upstreamName: d.upstreamName,
          upstreamType: d.upstreamType,
          upstreamEnabled: d.upstreamEnabled,
          domains: [],
        };
        map.set(d.upstreamId, g);
      }
      g.domains.push(d);
    }
    return [...map.values()].sort((a, b) => a.upstreamName.localeCompare(b.upstreamName));
  }, [filtered]);

  const stats = useMemo(
    () => ({
      total: domains.length,
      enabled: domains.filter((d) => d.enabled).length,
      disabled: domains.filter((d) => !d.enabled).length,
      channels: new Set(domains.map((d) => d.upstreamId)).size,
      shown: filtered.length,
    }),
    [domains, filtered],
  );

  const hasFilter =
    keyword.trim() !== '' || tld !== '' || baseDomain !== '' || level !== '' || channel !== '' || status !== '';

  const clearFilters = () => {
    setKeyword('');
    setTld('');
    setBaseDomain('');
    setLevel('');
    setChannel('');
    setStatus('');
  };

  // 开关域名调用（乐观更新，失败回滚；按复合 key 精确定位某渠道的域名行）
  const handleToggle = async (item: AdminDomainInfo, next: boolean) => {
    setTogglingDomain(domainKey(item));
    const apply = (enabled: boolean) =>
      setDomains((prev) => prev.map((d) => (domainKey(d) === domainKey(item) ? { ...d, enabled } : d)));
    apply(next);
    try {
      const updated = await setDomainEnabled(item.upstreamId, item.domain, next);
      setDomains((prev) =>
        prev.map((d) =>
          d.upstreamId === item.upstreamId && d.domain === updated.domain
            ? { ...d, enabled: updated.enabled }
            : d,
        ),
      );
      toast.success(`域名 ${item.domain} 已${next ? '开启' : '停止'}调用`);
    } catch (err) {
      apply(!next); // 回滚
      toast.error((err as Error).message || '更新域名状态失败');
    } finally {
      setTogglingDomain(null);
    }
  };

  // 批量开关某渠道（上游实例）的全部域名
  const handleToggleChannel = async (group: ChannelGroup, next: boolean) => {
    setBatchChannelId(group.upstreamId);
    const prev = domains; // 快照：失败时重新拉取（本地反推会抹平渠道原本的混合状态）
    const apply = (enabled: boolean) =>
      setDomains((prevList) =>
        prevList.map((d) => (d.upstreamId === group.upstreamId ? { ...d, enabled } : d)),
      );
    apply(next);
    try {
      const affected = await setChannelDomainsEnabled(group.upstreamId, next);
      toast.success(`渠道「${group.upstreamName}」已${next ? '启用' : '停用'} ${affected} 个域名的调用`);
    } catch (err) {
      // 失败后重新拉取服务端真值，避免本地反推抹平渠道原本的混合启用状态
      setDomains(prev);
      toast.error((err as Error).message || '批量更新渠道域名失败');
    } finally {
      setBatchChannelId(null);
    }
  };

  const selectClass =
    'pl-3 pr-7 py-2 text-xs bg-white border border-slate-200 rounded-xl shadow-sm text-slate-700 font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600 transition-all cursor-pointer max-w-[190px]';

  return (
    <div className="space-y-6">
      {/* 头部 */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight flex items-center gap-2.5">
            <Globe className="w-7 h-7 text-indigo-600" />
            <span>域名总览</span>
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            全渠道域名预览：支持关键字 / 顶级域 / 主域筛选，按渠道（上游实例）分组，可在这里直接开关域名的调用。
          </p>
        </div>
        <button
          type="button"
          onClick={loadDomains}
          title="刷新数据"
          className="p-2 text-slate-600 hover:text-slate-900 bg-white hover:bg-slate-100 border border-slate-200 rounded-xl shadow-sm transition-colors self-start sm:self-auto"
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* 统计条 */}
      {!loading && !error && domains.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[
            { label: '域名总数', value: stats.total, tone: 'text-slate-900' },
            { label: '调用中', value: stats.enabled, tone: 'text-emerald-600' },
            { label: '已停用', value: stats.disabled, tone: 'text-amber-600' },
            { label: '渠道数', value: stats.channels, tone: 'text-indigo-600' },
          ].map((s) => (
            <div key={s.label} className="bg-white rounded-2xl border border-slate-200 shadow-sm px-4 py-3">
              <div className={`text-xl font-bold font-mono ${s.tone}`}>{s.value}</div>
              <div className="text-[11px] text-slate-400 font-medium mt-0.5">{s.label}</div>
            </div>
          ))}
        </div>
      )}

      {/* 筛选栏 */}
      {!loading && !error && domains.length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative flex-1 min-w-[200px]">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                <Search className="w-4 h-4" />
              </div>
              <input
                type="text"
                value={keyword}
                onChange={(e) => setKeyword(e.target.value)}
                placeholder="关键字筛选，如 com / hzeg / 007 ..."
                className="w-full pl-9 pr-3 py-2 text-xs bg-white border border-slate-200 rounded-xl shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600 transition-all"
              />
            </div>
            <select value={tld} onChange={(e) => setTld(e.target.value)} className={selectClass} title="按顶级域筛选">
              <option value="">全部顶级域</option>
              {tldOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  .{o.value} ({o.count})
                </option>
              ))}
            </select>
            <select
              value={baseDomain}
              onChange={(e) => setBaseDomain(e.target.value)}
              className={selectClass}
              title="按主域（基础域名）筛选"
            >
              <option value="">全部主域</option>
              {baseOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.value} ({o.count})
                </option>
              ))}
            </select>
            <select value={level} onChange={(e) => setLevel(e.target.value)} className={selectClass} title="按域名层级筛选">
              <option value="">全部层级</option>
              {levelOptions.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.name} ({o.count})
                </option>
              ))}
            </select>
            <select value={channel} onChange={(e) => setChannel(e.target.value)} className={selectClass} title="按渠道筛选">
              <option value="">全部渠道</option>
              {channelOptions.map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value as StatusFilter)}
              className={selectClass}
              title="按状态筛选"
            >
              <option value="">全部状态</option>
              <option value="enabled">仅调用中</option>
              <option value="disabled">仅已停用</option>
            </select>
          </div>
          <div className="flex items-center gap-3 text-xs text-slate-500">
            <Filter className="w-3.5 h-3.5 text-slate-400" />
            <span>
              筛选结果 <span className="font-semibold text-slate-800">{stats.shown}</span> / {stats.total} 个域名
              ，按渠道分为 {groups.length} 组
            </span>
            {hasFilter && (
              <button type="button" onClick={clearFilters} className="text-indigo-600 hover:text-indigo-700 underline underline-offset-2">
                清除筛选
              </button>
            )}
          </div>
        </div>
      )}

      {/* 主体 */}
      {loading ? (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <TableSkeleton rows={8} cols={7} />
        </div>
      ) : error ? (
        <ErrorState message={error} onRetry={loadDomains} />
      ) : domains.length === 0 ? (
        <EmptyState
          icon={<Globe className="w-10 h-10 text-slate-400" />}
          title="暂无域名"
          description="在「上游管理」接入上游并同步域名后，这里会按渠道展示全部域名。"
        />
      ) : filtered.length === 0 ? (
        <EmptyState
          icon={<Globe className="w-10 h-10 text-slate-400" />}
          title="没有匹配筛选条件的域名"
          description="试试调整或清除筛选条件。"
          action={
            <button
              type="button"
              onClick={clearFilters}
              className="px-4 py-2 text-sm font-medium text-indigo-600 bg-indigo-50 hover:bg-indigo-100 rounded-lg transition-colors"
            >
              清除筛选
            </button>
          }
        />
      ) : (
        <div className="space-y-4">
          {groups.map((g) => {
            const isCollapsed = collapsed[g.upstreamId];
            const isExpanded = !!expandedGroups[g.upstreamId];
            const shown = isExpanded ? g.domains : g.domains.slice(0, RENDER_CAP);
            const hiddenCount = g.domains.length - shown.length;
            const enabledCount = g.domains.filter((d) => d.enabled).length;
            return (
              <div key={g.upstreamId} className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
                {/* 渠道组头 */}
                <button
                  type="button"
                  onClick={() =>
                    setCollapsed((prev) => {
                      const next = { ...prev, [g.upstreamId]: !prev[g.upstreamId] };
                      if (next[g.upstreamId]) {
                        // 折叠时复位"显示全部"，下次展开重新按上限渲染
                        setExpandedGroups((e) => ({ ...e, [g.upstreamId]: false }));
                      }
                      return next;
                    })
                  }
                  className="w-full flex items-center gap-2.5 px-5 py-3.5 bg-slate-50/70 hover:bg-slate-100 text-left border-b border-slate-100"
                >
                  {isCollapsed ? (
                    <ChevronRight className="w-4 h-4 text-slate-400" />
                  ) : (
                    <ChevronDown className="w-4 h-4 text-slate-400" />
                  )}
                  <Globe className="w-4 h-4 text-indigo-500" />
                  <span className="text-sm font-bold text-slate-800">{g.upstreamName}</span>
                  <span className="text-[11px] font-mono text-slate-400 bg-slate-100 border border-slate-200 rounded px-1.5 py-0.5">
                    {g.upstreamType}
                  </span>
                  {!g.upstreamEnabled && <Badge variant="slate">上游已停用</Badge>}
                  <span className="ml-auto text-xs text-slate-500 font-mono">
                    <span className="text-emerald-600 font-semibold">{enabledCount}</span> 启用 /{' '}
                    <span className="text-amber-600 font-semibold">{g.domains.length - enabledCount}</span> 停用 · 共{' '}
                    {g.domains.length} 个
                  </span>
                </button>

                {/* 渠道级批量操作（与停用上游实例不同：只挡建箱，读信/透传 GET 不受影响） */}
                {/* 批量作用于整个渠道（不随筛选收窄）；有筛选生效时提示用户 */}
                <div className="flex items-center gap-2 px-5 py-2 bg-white border-b border-slate-100 text-[11px]">
                  <span className="text-slate-400">渠道批量操作：</span>
                  <button
                    type="button"
                    disabled={batchChannelId === g.upstreamId || enabledCount === 0}
                    onClick={() => handleToggleChannel(g, false)}
                    title="停用该渠道全部域名（含未在筛选结果中的域名）"
                    className="px-2 py-1 font-medium text-amber-700 bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded-lg transition-colors disabled:opacity-40"
                  >
                    全部停用建箱
                  </button>
                  <button
                    type="button"
                    disabled={batchChannelId === g.upstreamId || enabledCount === g.domains.length}
                    onClick={() => handleToggleChannel(g, true)}
                    title="启用该渠道全部域名（含未在筛选结果中的域名）"
                    className="px-2 py-1 font-medium text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-lg transition-colors disabled:opacity-40"
                  >
                    全部启用
                  </button>
                  <span className="text-slate-300">|</span>
                  <span className="text-slate-400">
                    仅挡该渠道建箱，不停用上游实例（读信、透传 GET 仍可用）
                  </span>
                  {hasFilter && (
                    <span className="text-amber-600 font-medium">
                      当前有筛选：批量操作覆盖该渠道全部 {g.domains.length} 个域名
                    </span>
                  )}
                </div>

                {/* 域名表 */}
                {!isCollapsed && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs text-left">
                      <thead>
                        <tr className="bg-white border-b border-slate-100 text-slate-400 font-semibold">
                          <th className="py-2.5 px-5">域名</th>
                          <th className="py-2.5 px-3">层级</th>
                          <th className="py-2.5 px-3">顶级域</th>
                          <th className="py-2.5 px-3">主域</th>
                          <th className="py-2.5 px-3">权限</th>
                          <th className="py-2.5 px-3">调用开关</th>
                          <th className="py-2.5 px-5 text-right">操作</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-50 text-slate-700">
                        {shown.map((d) => (
                          <tr
                            key={domainKey(d)}
                            className={`hover:bg-slate-50/60 ${d.enabled ? '' : 'bg-slate-50/50'}`}
                          >
                            <td
                              className={`py-2.5 px-5 font-mono font-medium text-xs ${d.enabled ? 'text-slate-900' : 'text-slate-400 line-through'}`}
                            >
                              @{d.domain}
                            </td>
                            <td className="py-2.5 px-3">
                              <span className="text-[11px] text-slate-500 bg-slate-100 border border-slate-200 rounded px-1.5 py-0.5 whitespace-nowrap">
                                {levelNameForLabelCount(domainLevelOf(d.domain))}
                              </span>
                            </td>
                            <td className="py-2.5 px-3 font-mono text-slate-500">.{tldOf(d.domain)}</td>
                            <td className="py-2.5 px-3 font-mono text-slate-500">{baseDomainOf(d.domain)}</td>
                            <td className="py-2.5 px-3">
                              <Badge variant={d.isPrivate ? 'amber' : 'emerald'}>{d.isPrivate ? '私有' : '公开'}</Badge>
                            </td>
                            <td className="py-2.5 px-3">
                              <div className="flex items-center gap-2">
                                <Toggle
                                  checked={d.enabled}
                                  disabled={togglingDomain === domainKey(d)}
                                  onChange={(next) => handleToggle(d, next)}
                                  title={d.enabled ? '点击停用该域名的调用' : '点击开启该域名的调用'}
                                />
                                <span className={`text-[11px] font-medium ${d.enabled ? 'text-emerald-600' : 'text-slate-400'}`}>
                                  {d.enabled ? '调用中' : '已停用'}
                                </span>
                              </div>
                            </td>
                            <td className="py-2.5 px-5 text-right">
                              <CopyButton text={d.domain} iconOnly title="复制域名" />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {hiddenCount > 0 && (
                      <div className="px-5 py-2.5 border-t border-slate-100 bg-slate-50/60">
                        <button
                          type="button"
                          onClick={() => setExpandedGroups((prev) => ({ ...prev, [g.upstreamId]: true }))}
                          className="text-xs text-indigo-600 hover:text-indigo-700 font-medium"
                        >
                          已显示前 {RENDER_CAP} 个，点击显示全部 {g.domains.length} 个（筛选/批量操作不受影响）
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          <p className="text-[11px] text-slate-400 flex items-center gap-1.5 px-1">
            <CopyIcon className="w-3 h-3" />
            停用后，统一 API 与原生格式透传的建箱请求都会被拒绝（存量邮箱收发不受影响）；重新同步域名会保留停用状态。
          </p>
        </div>
      )}
    </div>
  );
};
