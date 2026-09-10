import React, { useId } from 'react';
import { Gauge } from 'lucide-react';

export interface KeyRateLimitDraft {
  mode: 'default' | 'custom' | 'unlimited';
  amount: string;
}

export function keyRateLimitDraft(limit: number | null): KeyRateLimitDraft {
  return {
    mode: limit === null ? 'default' : limit === 0 ? 'unlimited' : 'custom',
    amount: limit !== null && limit > 0 ? String(limit) : '',
  };
}

export function parseKeyRateLimit(draft: KeyRateLimitDraft): number | null {
  if (draft.mode === 'default') return null;
  if (draft.mode === 'unlimited') return 0;
  const limit = Number(draft.amount);
  if (!Number.isSafeInteger(limit) || limit <= 0) {
    throw new Error('自定义上限请输入大于 0 的整数；如需取消限流，请选择“不限制”。');
  }
  return limit;
}

export const KeyRateLimitField: React.FC<{
  value: KeyRateLimitDraft;
  onChange: (value: KeyRateLimitDraft) => void;
  disabled?: boolean;
  kind?: 'hourly' | 'concurrent';
}> = ({ value, onChange, disabled, kind = 'hourly' }) => {
  const id = useId();
  const concurrent = kind === 'concurrent';
  return (
    <fieldset disabled={disabled} className="space-y-2">
      <label htmlFor={`${id}-mode`} className="flex items-center gap-1.5 text-xs font-semibold text-slate-700">
        <Gauge className="w-3.5 h-3.5 text-indigo-600" />
        {concurrent ? '并发请求限制' : '邮箱创建限流'}
      </label>
      <select
        id={`${id}-mode`}
        value={value.mode}
        onChange={(e) => onChange({ ...value, mode: e.target.value as KeyRateLimitDraft['mode'] })}
        aria-describedby={`${id}-help`}
        className="w-full px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600 disabled:opacity-50"
      >
        <option value="default">跟随系统默认</option>
        <option value="custom">自定义上限</option>
        <option value="unlimited">不限制</option>
      </select>
      {value.mode === 'custom' && (
        <div className="flex items-center gap-2">
          <label htmlFor={`${id}-amount`} className="text-xs text-slate-600 whitespace-nowrap">{concurrent ? '同时最多' : '每小时最多'}</label>
          <input
            id={`${id}-amount`}
            type="number"
            min={1}
            max={Number.MAX_SAFE_INTEGER}
            step={1}
            required
            value={value.amount}
            onChange={(e) => onChange({ ...value, amount: e.target.value })}
            placeholder={concurrent ? '例如 10' : '例如 120'}
            aria-describedby={`${id}-help`}
            className="min-w-0 flex-1 px-3 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600 disabled:opacity-50"
          />
          <span className="text-xs text-slate-500 whitespace-nowrap">{concurrent ? '个请求' : '次创建请求'}</span>
        </div>
      )}
      <p id={`${id}-help`} className="text-xs text-slate-400 leading-relaxed">
        {concurrent ? '统一 API 与上游透传共用并发额度，超限返回 429。选择系统默认后跟随全局设置。' : '统一 API 按 Key 独立计数，超限返回 429。修改立即生效，当前小时窗口内的已用次数会保留。'}
      </p>
    </fieldset>
  );
};
