import React, { useState, useEffect, useCallback } from 'react';
import {
  KeyRound,
  Plus,
  RefreshCw,
  Trash2,
  AlertTriangle,
  CheckCircle2,
  Lock,
  Loader2,
  AlertCircle,
  Globe,
  ShieldCheck,
  Pencil,
  Copy,
  Server,
} from 'lucide-react';
import { getApiKeys, createApiKey, updateApiKey, revokeApiKey, revealApiKey, getAllDomains, getUpstreams } from '../api/client';
import { ApiKeyInfo, CreatedApiKey, AdminDomainInfo, UpstreamSummary, ApiError } from '../types';
import { useToast } from '../components/Toast';
import { Badge } from '../components/Badge';
import { CopyButton } from '../components/CopyButton';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { Modal } from '../components/Modal';
import { DomainPicker } from '../components/DomainPicker';
import { KeyRateLimitField, keyRateLimitDraft, parseKeyRateLimit } from '../components/KeyRateLimitField';
import { TableSkeleton } from '../components/Loading';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { formatDateTime } from '../utils/format';

/** 渠道（上游实例）白名单选择器：不勾选任何渠道 = 不限渠道 */
const ChannelPicker: React.FC<{
  upstreams: UpstreamSummary[];
  selected: string[];
  onChange: (next: string[]) => void;
}> = ({ upstreams, selected, onChange }) => {
  const toggle = (id: string) => {
    onChange(selected.includes(id) ? selected.filter((c) => c !== id) : [...selected, id]);
  };
  return (
    <div className="space-y-1.5">
      <div className="max-h-32 overflow-y-auto border border-slate-200 rounded-lg divide-y divide-slate-100">
        {upstreams.length === 0 ? (
          <div className="p-3 text-xs text-slate-400 text-center">暂无上游实例</div>
        ) : (
          upstreams.map((u) => (
            <label key={u.id} className="flex items-center gap-2.5 px-3 py-2 hover:bg-slate-50 cursor-pointer">
              <input
                type="checkbox"
                checked={selected.includes(u.id)}
                onChange={() => toggle(u.id)}
                className="w-3.5 h-3.5 accent-indigo-600"
              />
              <span className={`text-xs font-medium flex-1 truncate ${u.enabled ? 'text-slate-700' : 'text-slate-400'}`}>
                {u.name}
              </span>
              <span className="text-[10px] text-slate-400 font-mono">{u.type}</span>
              <span className="text-[10px] text-slate-400">{u.domainCount} 域名</span>
              {!u.enabled && (
                <span className="text-[10px] text-slate-500 bg-slate-200 rounded px-1 py-0.5 flex-shrink-0">已停用</span>
              )}
            </label>
          ))
        )}
      </div>
      <p className="text-[11px] text-slate-400 leading-relaxed">
        已限 {selected.length} 个渠道；不勾选 = 不限渠道。渠道限制自动覆盖该渠道后续同步的新域名（域名白名单是静态的，做不到这一点）；两者同时配置时取交集。
      </p>
    </div>
  );
};

export const ApiKeys: React.FC = () => {
  const [keys, setKeys] = useState<ApiKeyInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 签发 Key 输入弹窗
  const [isCreateOpen, setIsCreateOpen] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [createError, setCreateError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // 域名/渠道白名单候选（创建/编辑共用）
  const [allDomains, setAllDomains] = useState<AdminDomainInfo[]>([]);
  const [upstreamOptions, setUpstreamOptions] = useState<UpstreamSummary[]>([]);
  const [createDomains, setCreateDomains] = useState<string[]>([]);
  const [createChannels, setCreateChannels] = useState<string[]>([]);
  const [createRateLimit, setCreateRateLimit] = useState(() => keyRateLimitDraft(null));
  const [createConcurrency, setCreateConcurrency] = useState(() => keyRateLimitDraft(null));

  // 调用限制编辑弹窗（域名 + 渠道 + 限流）
  const [editTarget, setEditTarget] = useState<ApiKeyInfo | null>(null);
  const [editDomains, setEditDomains] = useState<string[]>([]);
  const [editChannels, setEditChannels] = useState<string[]>([]);
  const [editRateLimit, setEditRateLimit] = useState(() => keyRateLimitDraft(null));
  const [editConcurrency, setEditConcurrency] = useState(() => keyRateLimitDraft(null));
  const [editError, setEditError] = useState<string | null>(null);
  const [isSavingRestrictions, setIsSavingRestrictions] = useState(false);

  // 一次性明文展示弹窗
  const [revealedKey, setRevealedKey] = useState<CreatedApiKey | null>(null);

  // 吊销确认弹窗（吊销即从列表删除）
  const [revokeTarget, setRevokeTarget] = useState<ApiKeyInfo | null>(null);
  const [isRevoking, setIsRevoking] = useState(false);

  // 取回完整密钥明文（复制用）
  const [revealingId, setRevealingId] = useState<string | null>(null);

  const toast = useToast();

  // 取回完整密钥并写入剪贴板
  const handleCopyFullKey = async (item: ApiKeyInfo) => {
    try {
      setRevealingId(item.id);
      let key: string;
      try {
        key = await revealApiKey(item.id);
      } catch (err) {
        if (err instanceof ApiError && err.code === 'KEY_PLAINTEXT_UNAVAILABLE') {
          toast.error('该密钥创建于旧版本（仅存哈希），明文无法取回，请重新签发');
          return;
        }
        throw err;
      }
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(key);
      } else {
        // 纯 HTTP 兜底：textarea 必须被移除并先清空，否则完整明文 key 会残留 DOM
        const textarea = document.createElement('textarea');
        textarea.value = key;
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        try {
          textarea.select();
          document.execCommand('copy');
        } finally {
          textarea.value = '';
          document.body.removeChild(textarea);
        }
      }
      toast.success(`已复制「${item.name}」的完整密钥`);
    } catch (err) {
      toast.error((err as Error).message || '取回密钥失败');
    } finally {
      setRevealingId(null);
    }
  };

  const loadKeys = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const list = await getApiKeys();
      setKeys(list);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('无法加载 API Key 列表，请检查网络或后端状态');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadKeys();
  }, [loadKeys]);

  // 拉取域名/渠道候选（失败不阻断主流程）
  const loadPickerData = useCallback(async () => {
    try {
      const [domains, upstreams] = await Promise.all([getAllDomains(), getUpstreams()]);
      setAllDomains(domains);
      setUpstreamOptions(upstreams);
    } catch {
      /* 候选加载失败不阻断 */
    }
  }, []);

  // 打开签发弹窗
  const handleOpenCreate = () => {
    setNewKeyName('');
    setCreateDomains([]);
    setCreateChannels([]);
    setCreateRateLimit(keyRateLimitDraft(null));
    setCreateConcurrency(keyRateLimitDraft(null));
    setCreateError(null);
    setIsCreateOpen(true);
    loadPickerData();
  };

  // 提交签发
  const handleCreateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    const name = newKeyName.trim();
    if (!name) {
      setCreateError('请输入密钥标识名称（例如：生产客户端、测试服务）');
      return;
    }
    if (name.length > 100) {
      setCreateError('密钥名称不能超过 100 个字符');
      return;
    }

    try {
      setIsSubmitting(true);
      setCreateError(null);
      const created = await createApiKey(name, createDomains, createChannels, parseKeyRateLimit(createRateLimit), parseKeyRateLimit(createConcurrency));
      toast.success(`已为「${created.name}」签发网关 API Key`);
      // 插入到列表首位
      setKeys((prev) => [created, ...prev]);
      // 关闭创建弹窗，打开明文展示模态框
      setIsCreateOpen(false);
      setRevealedKey(created);
    } catch (err) {
      if (err instanceof Error) {
        setCreateError(err.message);
      } else {
        setCreateError('签发失败，请重试');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  // 打开调用限制编辑弹窗
  const handleOpenEditRestrictions = (item: ApiKeyInfo) => {
    setEditTarget(item);
    setEditDomains(item.domains ?? []);
    setEditChannels(item.channels ?? []);
    setEditRateLimit(keyRateLimitDraft(item.mailboxesPerHour));
    setEditConcurrency(keyRateLimitDraft(item.maxConcurrentRequests));
    setEditError(null);
    loadPickerData();
  };

  // 保存白名单与限流配置
  const handleSaveRestrictions = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editTarget) return;
    try {
      setIsSavingRestrictions(true);
      setEditError(null);
      const updated = await updateApiKey(editTarget.id, {
        domains: editDomains.length > 0 ? editDomains : null,
        channels: editChannels.length > 0 ? editChannels : null,
        mailboxesPerHour: parseKeyRateLimit(editRateLimit),
        maxConcurrentRequests: parseKeyRateLimit(editConcurrency),
      });
      setKeys((prev) => prev.map((k) => (k.id === updated.id ? updated : k)));
      toast.success(`已更新密钥「${updated.name}」的调用限制`);
      setEditTarget(null);
    } catch (err) {
      setEditError((err as Error).message || '保存失败，请重试');
    } finally {
      setIsSavingRestrictions(false);
    }
  };

  // 确认吊销（吊销即删除，从列表移除）
  const handleConfirmRevoke = async () => {
    if (!revokeTarget) return;
    try {
      setIsRevoking(true);
      await revokeApiKey(revokeTarget.id);
      toast.success(`密钥「${revokeTarget.name}」已吊销并删除`);
      setKeys((prev) => prev.filter((k) => k.id !== revokeTarget.id));
      setRevokeTarget(null);
    } catch (err) {
      toast.error((err as Error).message || '吊销密钥失败');
    } finally {
      setIsRevoking(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* 头部标题与操作 */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight flex items-center gap-2.5">
            <KeyRound className="w-7 h-7 text-indigo-600" />
            <span>网关 API Key 管理</span>
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            对外签发统一网关 API Key，可分别配置域名、渠道、建箱次数与并发请求上限。
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={loadKeys}
            title="刷新列表"
            className="p-2.5 text-slate-600 hover:text-slate-900 bg-white hover:bg-slate-100 border border-slate-200 rounded-xl shadow-sm transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            type="button"
            onClick={handleOpenCreate}
            className="inline-flex items-center gap-2 px-4 py-2.5 bg-indigo-600 hover:bg-indigo-700 text-white font-medium text-sm rounded-xl shadow-lg shadow-indigo-100 hover:shadow-indigo-200 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-all"
          >
            <Plus className="w-4 h-4" />
            <span>签发新 Key</span>
          </button>
        </div>
      </div>

      {/* 列表主体 */}
      {loading ? (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <TableSkeleton rows={5} cols={8} />
        </div>
      ) : error ? (
        <ErrorState message={error} onRetry={loadKeys} />
      ) : keys.length === 0 ? (
        <EmptyState
          icon={<KeyRound className="w-10 h-10 text-slate-400" />}
          title="暂无签发的网关 API Key"
          description="签发 Key 后，调用方可通过 Authorization: Bearer <key> 调用 /v1/mailboxes 创建并使用临时邮箱。"
          action={
            <button
              type="button"
              onClick={handleOpenCreate}
              className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-medium text-sm rounded-lg transition-colors"
            >
              <Plus className="w-4 h-4" />
              <span>立即签发第一个 Key</span>
            </button>
          }
        />
      ) : (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm border-collapse">
              <thead>
                <tr className="bg-slate-50/80 border-b border-slate-200/80 text-xs font-semibold text-slate-500 uppercase tracking-wider">
                  <th className="py-3.5 px-6">名称与备注</th>
                  <th className="py-3.5 px-4">密钥前缀（Prefix）</th>
                  <th className="py-3.5 px-4">状态</th>
                  <th className="py-3.5 px-4">可用域名</th>
                  <th className="py-3.5 px-4 whitespace-nowrap">调用限额</th>
                  <th className="py-3.5 px-4">最近调用时间</th>
                  <th className="py-3.5 px-4">创建时间</th>
                  <th className="py-3.5 px-6 text-right">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-700">
                {keys.map((item) => (
                  <tr key={item.id} className="hover:bg-slate-50/70 transition-colors">
                    <td className="py-4 px-6 font-medium text-slate-900 whitespace-nowrap">
                      {item.name}
                    </td>

                    <td className="py-4 px-4 whitespace-nowrap">
                      <div className="flex items-center gap-2">
                        <code className="px-2 py-1 bg-slate-100 border border-slate-200 rounded text-xs font-mono text-slate-800">
                          {item.prefix}...
                        </code>
                        <button
                          type="button"
                          disabled={revealingId === item.id}
                          onClick={() => handleCopyFullKey(item)}
                          title="复制完整密钥（明文已加密保存，可随时取回）"
                          className="inline-flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-indigo-600 hover:text-indigo-700 hover:bg-indigo-50 border border-indigo-200 rounded transition-colors disabled:opacity-50"
                        >
                          {revealingId === item.id ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          ) : (
                            <Copy className="w-3.5 h-3.5" />
                          )}
                          <span>复制密钥</span>
                        </button>
                      </div>
                    </td>

                    <td className="py-4 px-4 whitespace-nowrap">
                      <Badge variant={item.enabled ? 'emerald' : 'slate'} dot>
                        {item.enabled ? '有效' : '已吊销'}
                      </Badge>
                    </td>

                    <td className="py-4 px-4 whitespace-nowrap">
                      <div className="flex items-center gap-2 flex-wrap">
                        {item.domains && item.domains.length > 0 ? (
                          <span
                            className="inline-flex items-center gap-1 text-xs text-slate-700 font-medium"
                            title={item.domains.join(', ')}
                          >
                            <Globe className="w-3.5 h-3.5 text-indigo-500" />
                            {item.domains.length} 个域名
                          </span>
                        ) : (
                          <span className="text-xs text-slate-400">全部域名</span>
                        )}
                        {item.channels && item.channels.length > 0 && (
                          <span
                            className="inline-flex items-center gap-1 text-xs text-indigo-700 bg-indigo-50 border border-indigo-200 rounded px-1.5 py-0.5"
                            title={`渠道白名单：${item.channels.join(', ')}`}
                          >
                            <Server className="w-3 h-3" />
                            {item.channels.length} 渠道
                          </span>
                        )}
                      </div>
                    </td>

                    <td className="py-4 px-4 whitespace-nowrap">
                      <div className="text-xs font-medium text-slate-700">
                        {item.effectiveMailboxesPerHour <= 0 ? '不限制' : `${item.effectiveMailboxesPerHour} 次/小时`}
                      </div>
                      <div className="text-[11px] text-slate-400 mt-1">
                        {item.mailboxesPerHour === null ? '系统默认' : '单独配置'}
                      </div>
                      <div className="text-xs font-medium text-slate-700 mt-2">并发：{item.effectiveMaxConcurrentRequests === 0 ? '不限制' : `${item.effectiveMaxConcurrentRequests} 个请求`}</div>
                      <div className="text-[11px] text-slate-400 mt-1">{item.maxConcurrentRequests === null ? '系统默认' : '单独配置'}</div>
                    </td>

                    <td className="py-4 px-4 whitespace-nowrap text-xs text-slate-500 font-mono">
                      {formatDateTime(item.lastUsedAt)}
                    </td>

                    <td className="py-4 px-4 whitespace-nowrap text-xs text-slate-500 font-mono">
                      {formatDateTime(item.createdAt)}
                    </td>

                    <td className="py-4 px-6 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => handleOpenEditRestrictions(item)}
                          className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium text-indigo-600 hover:text-indigo-700 hover:bg-indigo-50 rounded-lg border border-indigo-200 transition-colors"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                          <span>调用限制</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => setRevokeTarget(item)}
                          title="吊销并从列表删除该密钥"
                          className="inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium text-rose-600 hover:text-rose-700 hover:bg-rose-50 rounded-lg border border-rose-200 transition-colors"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span>删除</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 签发 Key 弹窗 */}
      <Modal
        isOpen={isCreateOpen}
        onClose={isSubmitting ? () => {} : () => setIsCreateOpen(false)}
        title="签发新网关 API Key"
        footer={
          <>
            <button
              type="button"
              disabled={isSubmitting}
              onClick={() => setIsCreateOpen(false)}
              className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 transition-colors"
            >
              取消
            </button>
            <button
              type="submit"
              form="create-api-key-form"
              disabled={isSubmitting}
              className="inline-flex items-center gap-2 px-5 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50 transition-colors"
            >
              {isSubmitting && <Loader2 className="w-4 h-4 animate-spin" />}
              <span>{isSubmitting ? '正在签发...' : '确认签发'}</span>
            </button>
          </>
        }
      >
        <form id="create-api-key-form" onSubmit={handleCreateSubmit} className="space-y-4">
          {createError && (
            <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg text-rose-700 text-sm flex items-start gap-2">
              <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span>{createError}</span>
            </div>
          )}
          <div>
            <label htmlFor="key-name" className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
              Key 标识名称 <span className="text-rose-500">*</span>
            </label>
            <input
              id="key-name"
              type="text"
              value={newKeyName}
              onChange={(e) => {
                setNewKeyName(e.target.value);
                if (createError) setCreateError(null);
              }}
              placeholder="例如：爬虫测试节点 / 自动化流水线"
              maxLength={100}
              autoFocus
              className="w-full px-3.5 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600 transition-all"
            />
            <p className="mt-1.5 text-xs text-slate-400 leading-relaxed">
              标识该密钥的用途或所有者，便于后期审计和权限管理。
            </p>
          </div>

          <KeyRateLimitField value={createRateLimit} onChange={setCreateRateLimit} disabled={isSubmitting} />
          <KeyRateLimitField kind="concurrent" value={createConcurrency} onChange={setCreateConcurrency} disabled={isSubmitting} />

          <div>
            <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1.5 flex items-center gap-1.5">
              <ShieldCheck className="w-3.5 h-3.5 text-indigo-600" />
              <span>域名白名单（可选）</span>
            </label>
            <DomainPicker allDomains={allDomains} selected={createDomains} onChange={setCreateDomains} />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1.5 flex items-center gap-1.5">
              <Server className="w-3.5 h-3.5 text-indigo-600" />
              <span>渠道限制（可选）</span>
            </label>
            <ChannelPicker upstreams={upstreamOptions} selected={createChannels} onChange={setCreateChannels} />
          </div>
        </form>
      </Modal>

      {/* 签发成功 · 一次性明文展示模态框 (硬性交互要求) */}
      <Modal
        isOpen={!!revealedKey}
        onClose={() => setRevealedKey(null)}
        title={
          <div className="flex items-center gap-2 text-emerald-700">
            <CheckCircle2 className="w-5 h-5 text-emerald-600" />
            <span>网关 API Key 签发成功</span>
          </div>
        }
        closeOnOverlayClick={false}
        footer={
          <button
            type="button"
            onClick={() => setRevealedKey(null)}
            className="w-full sm:w-auto px-6 py-2.5 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg shadow-sm transition-colors"
          >
            我已完整复制并安全保存，关闭窗口
          </button>
        }
      >
        {revealedKey && (
          <div className="space-y-4">
            {/* 提示横幅 */}
            <div className="p-3.5 bg-amber-50 border border-amber-200 rounded-xl text-amber-900 text-xs flex items-start gap-2.5 leading-relaxed">
              <AlertTriangle className="w-5 h-5 mt-0.5 text-amber-600 flex-shrink-0" />
              <div>
                <span className="font-bold text-amber-900 block mb-0.5">请妥善保管此密钥！</span>
                鉴权仅使用密钥的不可逆散列；明文已加密存储，关闭窗口后仍可随时在列表中点击「复制密钥」取回完整明文。若怀疑泄露请立即删除并重新签发。
              </div>
            </div>

            <div>
              <div className="text-xs font-semibold text-slate-700 mb-1.5 flex items-center justify-between">
                <span>完整 API Key（用于 HTTP 请求）：</span>
                <span className="text-slate-400 font-normal">名称: {revealedKey.name}</span>
              </div>
              <div className="p-3.5 bg-slate-900 rounded-xl border border-slate-800 flex items-center justify-between gap-3">
                <code className="text-xs font-mono text-emerald-400 break-all select-all flex-1 leading-relaxed">
                  {revealedKey.key}
                </code>
                <CopyButton
                  text={revealedKey.key}
                  label="复制明文"
                  className="bg-slate-800 text-white hover:bg-slate-700 border-slate-700 flex-shrink-0"
                />
              </div>
            </div>

            {/* 调用示例提示 */}
            <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs space-y-1 text-slate-600">
              <div className="font-semibold text-slate-700 flex items-center gap-1.5">
                <Lock className="w-3.5 h-3.5 text-indigo-600" />
                <span>调用方式说明</span>
              </div>
              <p className="font-mono text-[11px] text-slate-500 bg-white p-2 rounded border border-slate-200">
                curl -H "Authorization: Bearer {revealedKey.key}" {window.location.origin}/v1/mailboxes
              </p>
            </div>
          </div>
        )}
      </Modal>

      {/* 调用限制编辑弹窗 */}
      <Modal
        isOpen={!!editTarget}
        onClose={isSavingRestrictions ? () => {} : () => setEditTarget(null)}
        title={
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-5 h-5 text-indigo-600" />
            <span>调用限制 — {editTarget?.name}</span>
          </div>
        }
        footer={
          <>
            <button
              type="button"
              disabled={isSavingRestrictions}
              onClick={() => setEditTarget(null)}
              className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 transition-colors"
            >
              取消
            </button>
            <button
              type="submit"
              form="edit-api-key-form"
              disabled={isSavingRestrictions}
              className="inline-flex items-center gap-2 px-5 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-50 transition-colors"
            >
              {isSavingRestrictions && <Loader2 className="w-4 h-4 animate-spin" />}
              <span>{isSavingRestrictions ? '正在保存...' : '保存限制'}</span>
            </button>
          </>
        }
      >
        <form id="edit-api-key-form" onSubmit={handleSaveRestrictions} className="space-y-4">
          {editError && (
            <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg text-rose-700 text-sm flex items-start gap-2">
              <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
              <span>{editError}</span>
            </div>
          )}
          <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg text-xs text-slate-600 leading-relaxed">
            勾选域名或渠道可限定该 Key 的可用范围；都为空时允许全部域名和渠道。邮箱创建限流单独生效。
          </div>
          <KeyRateLimitField value={editRateLimit} onChange={setEditRateLimit} disabled={isSavingRestrictions} />
          <KeyRateLimitField kind="concurrent" value={editConcurrency} onChange={setEditConcurrency} disabled={isSavingRestrictions} />
          <DomainPicker allDomains={allDomains} selected={editDomains} onChange={setEditDomains} />
          <div>
            <label className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1.5 flex items-center gap-1.5">
              <Server className="w-3.5 h-3.5 text-indigo-600" />
              <span>渠道限制（可选）</span>
            </label>
            <ChannelPicker upstreams={upstreamOptions} selected={editChannels} onChange={setEditChannels} />
          </div>
        </form>
      </Modal>

      {/* 吊销二次确认对话框 (红色标注不可逆后果) */}
      <ConfirmDialog
        isOpen={!!revokeTarget}
        onClose={() => setRevokeTarget(null)}
        onConfirm={handleConfirmRevoke}
        isLoading={isRevoking}
        title="吊销 API Key 确认"
        description={
          <div>
            确定要吊销密钥 <span className="font-bold text-slate-900">「{revokeTarget?.name}」</span>（前缀{' '}
            <code className="font-mono text-xs bg-slate-100 px-1 py-0.5 rounded">{revokeTarget?.prefix}</code>）吗？
            <div className="mt-2 text-xs text-slate-500 leading-relaxed">
              吊销后密钥立即失效，并<strong className="text-slate-700">直接从列表中删除</strong>；
              所有依赖此 Key 的客户端将立即返回 401 Unauthorized，无法再创建或访问临时邮箱。
            </div>
          </div>
        }
        dangerNotice="密钥一旦吊销将立即删除且不可恢复！"
        confirmText="确认吊销并删除"
        isDanger={true}
      />
    </div>
  );
};
