import React, { useMemo, useState } from 'react';
import { Search, CheckSquare, Square, XCircle, ChevronDown, ChevronRight, Globe } from 'lucide-react';
import { AdminDomainInfo } from '../types';
import { tldOf, baseDomainOf, domainLevelOf, levelNameForLabelCount, collectOptions } from '../utils/domain';

interface DomainPickerProps {
  allDomains: AdminDomainInfo[];
  selected: string[];
  onChange: (next: string[]) => void;
}

/** 每个渠道分组默认渲染的域名行数上限（超过部分点"显示全部"展开） */
const RENDER_CAP = 50;

interface ChannelGroup {
  upstreamId: string;
  upstreamName: string;
  upstreamType: string;
  upstreamEnabled: boolean;
  domains: AdminDomainInfo[];
}

/**
 * 域名白名单选择器（key 签发/编辑共用）：
 * - 按渠道（上游实例）分组展示；
 * - 筛选条件：关键字包含 / 顶级域 / 主域（基础域名）；
 * - 「全选筛选结果」一键勾选当前筛选下的所有域名。
 * 不勾选任何域名 = 不限制。
 */
export const DomainPicker: React.FC<DomainPickerProps> = ({ allDomains, selected, onChange }) => {
  const [keyword, setKeyword] = useState('');
  const [tld, setTld] = useState('');
  const [baseDomain, setBaseDomain] = useState('');
  const [level, setLevel] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  // 大渠道默认只渲染前 RENDER_CAP 行，点"显示全部"后整组展开（重新折叠时复位）
  const [expandedGroups, setExpandedGroups] = useState<Record<string, boolean>>({});

  const selectedSet = useMemo(() => new Set(selected), [selected]);

  const tldOptions = useMemo(() => collectOptions(allDomains.map((d) => d.domain), tldOf), [allDomains]);
  const baseOptions = useMemo(
    () => collectOptions(allDomains.map((d) => d.domain), baseDomainOf),
    [allDomains],
  );
  const levelOptions = useMemo(
    () =>
      collectOptions(allDomains.map((d) => d.domain), (d) => String(domainLevelOf(d)))
        .map((o) => ({ value: o.value, count: o.count, name: levelNameForLabelCount(Number(o.value)) }))
        .sort((a, b) => Number(a.value) - Number(b.value)),
    [allDomains],
  );

  const filtered = useMemo(() => {
    const kw = keyword.trim().toLowerCase();
    return allDomains.filter((d) => {
      if (kw && !d.domain.includes(kw)) return false;
      if (tld && tldOf(d.domain) !== tld) return false;
      if (baseDomain && baseDomainOf(d.domain) !== baseDomain) return false;
      if (level && domainLevelOf(d.domain) !== Number(level)) return false;
      return true;
    });
  }, [allDomains, keyword, tld, baseDomain, level]);

  // 按渠道（上游实例）分组
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

  const hasFilter = keyword.trim() !== '' || tld !== '' || baseDomain !== '' || level !== '';

  const selectFiltered = () => {
    const next = new Set(selectedSet);
    for (const d of filtered) next.add(d.domain);
    onChange([...next]);
  };
  const deselectFiltered = () => {
    const drop = new Set(filtered.map((d) => d.domain));
    onChange(selected.filter((d) => !drop.has(d)));
  };
  const clearAll = () => onChange([]);

  const clearFilters = () => {
    setKeyword('');
    setTld('');
    setBaseDomain('');
    setLevel('');
  };

  const toggleGroup = (upstreamId: string) => {
    setCollapsed((prev) => {
      const next = { ...prev, [upstreamId]: !prev[upstreamId] };
      if (next[upstreamId]) {
        // 折叠时复位"显示全部"，下次展开重新按上限渲染
        setExpandedGroups((e) => ({ ...e, [upstreamId]: false }));
      }
      return next;
    });
  };

  const selectClass =
    'px-2.5 py-1.5 text-xs bg-white border border-slate-300 rounded-lg text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600 transition-all max-w-[180px]';

  return (
    <div className="space-y-2.5">
      {/* 筛选工具栏 */}
      <div className="p-2.5 bg-slate-50 border border-slate-200 rounded-xl space-y-2.5">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative flex-1 min-w-[160px]">
            <div className="absolute inset-y-0 left-0 pl-2.5 flex items-center pointer-events-none text-slate-400">
              <Search className="w-3.5 h-3.5" />
            </div>
            <input
              type="text"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
              placeholder="关键字，如 com / hzeg / 007 ..."
              className="w-full pl-8 pr-2.5 py-1.5 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600 transition-all"
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
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={selectFiltered}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-indigo-700 bg-indigo-50 hover:bg-indigo-100 border border-indigo-200 rounded-lg transition-colors"
          >
            <CheckSquare className="w-3.5 h-3.5" />
            <span>全选筛选结果 ({filtered.length})</span>
          </button>
          <button
            type="button"
            onClick={deselectFiltered}
            disabled={filtered.length === 0}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-slate-600 bg-white hover:bg-slate-100 border border-slate-300 rounded-lg transition-colors disabled:opacity-40"
          >
            <Square className="w-3.5 h-3.5" />
            <span>取消选中筛选结果</span>
          </button>
          {selected.length > 0 && (
            <button
              type="button"
              onClick={clearAll}
              className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium text-rose-600 hover:bg-rose-50 border border-rose-200 rounded-lg transition-colors"
            >
              <XCircle className="w-3.5 h-3.5" />
              <span>清空全部已选 (不限制)</span>
            </button>
          )}
          {hasFilter && (
            <button
              type="button"
              onClick={clearFilters}
              className="text-xs text-slate-500 hover:text-slate-700 underline underline-offset-2"
            >
              清除筛选
            </button>
          )}
        </div>
      </div>

      {/* 按渠道分组的域名列表（每组默认只渲染前 50 行，避免大渠道卡顿） */}
      <div className="max-h-72 overflow-y-auto border border-slate-200 rounded-xl divide-y divide-slate-100">
        {groups.length === 0 ? (
          <div className="p-4 text-xs text-slate-400 text-center">
            {allDomains.length === 0 ? '暂无已同步的域名，请先在上游管理中同步' : '没有匹配筛选条件的域名'}
          </div>
        ) : (
          groups.map((g) => {
            const isCollapsed = collapsed[g.upstreamId];
            const isExpanded = !!expandedGroups[g.upstreamId];
            const shown = isExpanded ? g.domains : g.domains.slice(0, RENDER_CAP);
            const hiddenCount = g.domains.length - shown.length;
            const selectedInGroup = g.domains.filter((d) => selectedSet.has(d.domain)).length;
            return (
              <div key={g.upstreamId}>
                <button
                  type="button"
                  onClick={() => toggleGroup(g.upstreamId)}
                  className="w-full flex items-center gap-2 px-3 py-2 bg-slate-50/80 hover:bg-slate-100 text-left"
                >
                  {isCollapsed ? (
                    <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
                  ) : (
                    <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
                  )}
                  <Globe className="w-3.5 h-3.5 text-indigo-500 flex-shrink-0" />
                  <span className="text-xs font-semibold text-slate-800">{g.upstreamName}</span>
                  <span className="text-[10px] text-slate-400 font-mono">{g.upstreamType}</span>
                  {!g.upstreamEnabled && (
                    <span className="text-[10px] text-slate-500 bg-slate-200 rounded px-1 py-0.5">上游已停用</span>
                  )}
                  <span className="ml-auto text-[11px] text-slate-500 font-mono">
                    {selectedInGroup > 0 && (
                      <span className="text-indigo-600 font-semibold mr-2">已选 {selectedInGroup}</span>
                    )}
                    {g.domains.length} 个
                  </span>
                </button>
                {!isCollapsed && (
                  <div className="divide-y divide-slate-50">
                    {shown.map((d) => (
                      <label
                        key={`${g.upstreamId}:${d.domain}`}
                        className="flex items-center gap-2.5 px-3 py-1.5 hover:bg-slate-50 cursor-pointer pl-8"
                      >
                        <input
                          type="checkbox"
                          checked={selectedSet.has(d.domain)}
                          onChange={() =>
                            onChange(
                              selectedSet.has(d.domain)
                                ? selected.filter((x) => x !== d.domain)
                                : [...selected, d.domain],
                            )
                          }
                          className="w-3.5 h-3.5 accent-indigo-600"
                        />
                        <span
                          className={`font-mono text-xs flex-1 truncate ${d.enabled ? 'text-slate-700' : 'text-slate-400'}`}
                        >
                          @{d.domain}
                        </span>
                        <span className="text-[10px] text-slate-400 flex-shrink-0">.{tldOf(d.domain)}</span>
                        {!d.enabled && (
                          <span className="text-[10px] text-amber-600 bg-amber-50 border border-amber-200 rounded px-1 py-0.5 flex-shrink-0">
                            已停用
                          </span>
                        )}
                      </label>
                    ))}
                    {hiddenCount > 0 && (
                      <button
                        type="button"
                        onClick={() => setExpandedGroups((prev) => ({ ...prev, [g.upstreamId]: true }))}
                        className="w-full px-3 py-2 text-[11px] text-indigo-600 hover:text-indigo-700 hover:bg-indigo-50/60 text-left pl-8"
                      >
                        已显示前 {RENDER_CAP} 个，点击显示全部 {g.domains.length} 个（勾选/全选操作不受影响）
                      </button>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      <p className="text-[11px] text-slate-400 leading-relaxed">
        已选 {selected.length} 个域名；不勾选任何域名 = 不限制（可调用全部启用域名）。停用的域名即使勾选也无法创建邮箱。
      </p>
    </div>
  );
};
