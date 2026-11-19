import React from 'react';
import type { UpstreamSummary } from '../types';

/** 保留未在候选列表中找到的已选渠道，必须由管理员显式移除。 */
export const ChannelPicker: React.FC<{
  upstreams: UpstreamSummary[];
  selected: string[];
  onChange: (next: string[]) => void;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
}> = ({ upstreams, selected, onChange, loading, error, onRetry }) => {
  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((c) => c !== id) : [...selected, id]);
  const known = new Set(upstreams.map((u) => u.id));
  const missing = selected.filter((id) => !known.has(id));
  return (
    <div className="space-y-1.5">
      {loading && <p className="text-xs text-slate-500">正在读取渠道列表...</p>}
      {error && <div role="alert" className="text-xs text-rose-600">渠道列表加载失败：{error}<button type="button" onClick={onRetry} className="ml-2 underline">重试</button></div>}
      <div className="max-h-32 overflow-y-auto border border-slate-200 rounded-lg divide-y divide-slate-100">
        {upstreams.length === 0 && !loading && !error && (
          <div className="p-3 text-xs text-slate-400 text-center">暂无上游实例</div>
        )}
        {upstreams.map((u) => (
          <label key={u.id} className="flex items-center gap-2.5 px-3 py-2 hover:bg-slate-50 cursor-pointer">
            <input type="checkbox" checked={selected.includes(u.id)} onChange={() => toggle(u.id)} className="w-3.5 h-3.5 accent-indigo-600" />
            <span className={`text-xs font-medium flex-1 truncate ${u.enabled ? 'text-slate-700' : 'text-slate-400'}`}>{u.name}</span>
            <span className="text-[10px] text-slate-400 font-mono">{u.type}</span>
            <span className="text-[10px] text-slate-400">{u.domainCount} 域名</span>
            {!u.enabled && <span className="text-[10px] text-slate-500 bg-slate-200 rounded px-1 py-0.5 flex-shrink-0">已停用</span>}
          </label>
        ))}
        {!loading && !error && missing.map((id) => (
          <div key={id} className="flex items-center gap-2 px-3 py-2 bg-amber-50 text-xs text-amber-800">
            <span className="min-w-0 flex-1">未找到的渠道（可能已删除）<code className="block break-all mt-1">{id}</code></span>
            <button type="button" onClick={() => toggle(id)} aria-label={`移除失效渠道 ${id}`} className="shrink-0 px-2 py-1 border border-amber-300 rounded hover:bg-amber-100">移除</button>
          </div>
        ))}
      </div>
      <p className="text-[11px] text-slate-400 leading-relaxed">
        已限 {selected.length} 个渠道；不勾选 = 不限渠道。移除全部渠道限制后，可使用全部启用渠道。渠道限制覆盖后续同步的新域名；与域名白名单同时配置时取交集。
      </p>
    </div>
  );
};
