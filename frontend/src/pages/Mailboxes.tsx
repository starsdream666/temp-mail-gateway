import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { Link } from 'react-router-dom';
import {
  Mail,
  RefreshCw,
  Filter,
  ChevronLeft,
  ChevronRight,
  Clock,
  Infinity as InfinityIcon,
  Eraser,
  DownloadCloud,
  AlertTriangle,
  X,
} from 'lucide-react';
import { Modal } from '../components/Modal';
import {
  getMailboxes,
  getGlobalSettings,
  getUpstreams,
  pruneExpiredMailboxes,
  importMailboxes,
  getOrphanMailboxes,
  dismissOrphanMailbox,
  clearOrphanMailboxes,
  getApiKeys,
} from '../api/client';
import { Mailbox, UpstreamSummary, ApiError, OrphanEntry, ApiKeyInfo } from '../types';
import { CopyButton } from '../components/CopyButton';
import { TableSkeleton } from '../components/Loading';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { useToast } from '../components/Toast';
import { formatDateTime } from '../utils/format';

const PAGE_SIZE = 50;

export const Mailboxes: React.FC = () => {
  const [mailboxes, setMailboxes] = useState<Mailbox[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [autoCleanupEnabled, setAutoCleanupEnabled] = useState(false);
  const mailboxRequest = useRef(0);
  const mailboxRequestPending = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  // 清理已过期记录
  const [pruneOpen, setPruneOpen] = useState(false);
  const [pruning, setPruning] = useState(false);

  // 纳管上游已存在的地址
  const [importOpen, setImportOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [importText, setImportText] = useState('');
  const [importKeyId, setImportKeyId] = useState('');
  const [importErrors, setImportErrors] = useState('');
  const [apiKeys, setApiKeys] = useState<ApiKeyInfo[]>([]);

  // 尽力删除留下的残留
  const [orphans, setOrphans] = useState<OrphanEntry[]>([]);

  // 筛选与分页
  const [upstreams, setUpstreams] = useState<UpstreamSummary[]>([]);
  const [selectedUpstreamId, setSelectedUpstreamId] = useState<string>('');
  const [currentPage, setCurrentPage] = useState<number>(1);

  // 上游 ID 到名称的映射
  const upstreamMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const u of upstreams) {
      map.set(u.id, u.name);
    }
    return map;
  }, [upstreams]);

  // 加载上游列表作为筛选下拉选项
  useEffect(() => {
    let active = true;
    getUpstreams()
      .then((list) => {
        if (active) setUpstreams(list);
      })
      .catch(() => {
        // 筛选下拉加载失败不阻断主流程
      });
    return () => {
      active = false;
    };
  }, []);

  // 后台刷新不闪烁；请求序号防止筛选/分页变化后旧响应覆盖新列表。
  const loadMailboxes = useCallback(async (silent = false) => {
    if (silent && mailboxRequestPending.current) return;
    const request = ++mailboxRequest.current;
    mailboxRequestPending.current = true;
    if (!silent) { setLoading(true); setError(null); }
    try {
      const offset = (currentPage - 1) * PAGE_SIZE;
      const res = await getMailboxes({
        upstreamId: selectedUpstreamId || undefined,
        limit: PAGE_SIZE,
        offset,
      });
      if (request !== mailboxRequest.current) return;
      setTotal(res.total);
      setError(null);
      const lastPage = Math.max(1, Math.ceil(res.total / PAGE_SIZE));
      if (currentPage > lastPage) {
        setCurrentPage(lastPage);
        return;
      }
      setMailboxes(res.mailboxes);
    } catch (err) {
      if (request === mailboxRequest.current && !silent) {
        setError(err instanceof ApiError ? err.message : '无法加载邮箱概览列表，请检查网络或后端状态');
      }
    } finally {
      if (request === mailboxRequest.current) {
        mailboxRequestPending.current = false;
        setLoading(false);
      }
    }
  }, [currentPage, selectedUpstreamId]);

  useEffect(() => {
    void loadMailboxes();
    return () => { mailboxRequest.current += 1; mailboxRequestPending.current = false; };
  }, [loadMailboxes]);

  useEffect(() => {
    let active = true;
    const refreshSettings = () => {
      void getGlobalSettings().then((settings) => {
        if (active) setAutoCleanupEnabled(settings.mailboxCleanupEnabled);
      }).catch(() => { /* 设置读取失败不阻断邮箱列表和手动刷新。 */ });
    };
    const onFocus = () => { refreshSettings(); void loadMailboxes(true); };
    refreshSettings();
    window.addEventListener('focus', onFocus);
    return () => { active = false; window.removeEventListener('focus', onFocus); };
  }, [loadMailboxes]);

  useEffect(() => {
    if (!autoCleanupEnabled) return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void loadMailboxes(true);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [autoCleanupEnabled, loadMailboxes]);

  const totalPages = Math.ceil(total / PAGE_SIZE) || 1;

  const handleUpstreamChange = (val: string) => {
    setSelectedUpstreamId(val);
    setCurrentPage(1); // 切换筛选时重置到第一页
  };

  const handlePrune = async () => {
    try {
      setPruning(true);
      const { deleted } = await pruneExpiredMailboxes();
      setPruneOpen(false);
      if (deleted === 0) {
        toast.info('没有已过期的邮箱记录');
      } else {
        toast.success(`已清理 ${deleted} 条过期邮箱记录`);
      }
      setCurrentPage(1);
      await loadMailboxes();
    } catch (err) {
      toast.error((err as Error).message || '清理过期记录失败');
    } finally {
      setPruning(false);
    }
  };

  // 残留（孤儿）记录：force 删除时上游失败留下的线索
  const loadOrphans = useCallback(async () => {
    try {
      setOrphans(await getOrphanMailboxes());
    } catch {
      // 提示性信息，加载失败不打扰主流程
    }
  }, []);

  useEffect(() => {
    loadOrphans();
    // key 列表供纳管弹窗选择归属；失败不阻断（可留空按共享邮箱登记）
    getApiKeys()
      .then(setApiKeys)
      .catch(() => {});
  }, [loadOrphans]);

  const handleDismissOrphan = async (id: string) => {
    try {
      await dismissOrphanMailbox(id);
      await loadOrphans();
    } catch (err) {
      toast.error((err as Error).message || '消账失败');
    }
  };

  const handleClearOrphans = async () => {
    try {
      const { deleted } = await clearOrphanMailboxes();
      toast.success(`已消账 ${deleted} 条残留记录`);
      await loadOrphans();
    } catch (err) {
      toast.error((err as Error).message || '清空残留记录失败');
    }
  };

  // 纳管：把上游已存在、注册表没有的地址补登记进来
  const handleImport = async () => {
    const addresses = importText
      .split(/[\s,;]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (addresses.length === 0) {
      toast.error('请先填写要纳管的邮箱地址');
      return;
    }
    try {
      setImporting(true);
      const res = await importMailboxes(addresses, importKeyId || null);
      if (res.failed.length === 0) {
        toast.success(`已纳管 ${res.imported.length} 个邮箱`);
        setImportOpen(false);
        setImportText('');
      } else {
        // 部分失败时保留弹窗与输入，方便对照错误逐条修
        const detail = res.failed.map((f) => `${f.address}：${f.message}`).join('\n');
        if (res.imported.length > 0) {
          toast.warning(`成功 ${res.imported.length} 个，失败 ${res.failed.length} 个`);
        } else {
          toast.error(`全部失败（${res.failed.length} 个）`);
        }
        setImportErrors(detail);
      }
      setCurrentPage(1);
      await loadMailboxes();
    } catch (err) {
      toast.error((err as Error).message || '纳管失败');
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* 头部与操作区 */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight flex items-center gap-2.5">
            <Mail className="w-7 h-7 text-indigo-600" />
            <span>邮箱概览</span>
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            只读查看所有通过网关签发的临时邮箱。支持按上游服务筛选及分页检索。
          </p>
          {autoCleanupEnabled && <p className="mt-1 text-xs text-slate-500">自动清理已开启，列表每 5 秒更新。<Link to="/settings" className="ml-1 text-indigo-600 hover:underline">管理清理设置</Link></p>}
        </div>

        {/* 筛选与刷新 */}
        <div className="flex items-center flex-wrap gap-3">
          <div className="relative inline-flex items-center">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
              <Filter className="w-3.5 h-3.5" />
            </div>
            <select
              value={selectedUpstreamId}
              onChange={(e) => handleUpstreamChange(e.target.value)}
              className="pl-8 pr-8 py-2 text-xs bg-white border border-slate-200 rounded-xl shadow-sm text-slate-700 font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600 transition-all cursor-pointer"
            >
              <option value="">全部上游服务 ({upstreams.length})</option>
              {upstreams.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name} ({u.type})
                </option>
              ))}
            </select>
          </div>

          <button
            type="button"
            onClick={() => {
              setImportErrors('');
              setImportOpen(true);
            }}
            title="把上游已存在但网关没登记的邮箱补进注册表"
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 hover:text-slate-900 bg-white hover:bg-slate-100 border border-slate-200 rounded-xl shadow-sm transition-colors"
          >
            <DownloadCloud className="w-3.5 h-3.5" />
            <span>纳管已有地址</span>
          </button>

          <button
            type="button"
            onClick={() => setPruneOpen(true)}
            title="清理已过期的邮箱记录"
            className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-slate-700 hover:text-slate-900 bg-white hover:bg-slate-100 border border-slate-200 rounded-xl shadow-sm transition-colors"
          >
            <Eraser className="w-3.5 h-3.5" />
            <span>清理已过期</span>
          </button>

          <button
            type="button"
            onClick={() => void loadMailboxes()}
            title="刷新数据"
            className="p-2 text-slate-600 hover:text-slate-900 bg-white hover:bg-slate-100 border border-slate-200 rounded-xl shadow-sm transition-colors"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      <ConfirmDialog
        isOpen={pruneOpen}
        onClose={() => setPruneOpen(false)}
        onConfirm={handlePrune}
        isLoading={pruning}
        isDanger={false}
        title="清理已过期的邮箱记录"
        confirmText="开始清理"
        dangerNotice="只影响网关侧记录，不会向上游发送任何删除请求。"
        description={
          <div className="space-y-2 text-sm text-slate-600">
            <p>
              删除所有<strong className="text-slate-900">到期时间已过</strong>的邮箱记录。
              上游到期后会自行回收邮箱，但网关侧的记录不会自动消失，长期累积会让列表越来越慢。
            </p>
            <p>无到期时间（永久）与尚未到期的邮箱不受影响。</p>
          </div>
        }
      />

      {/* 纳管弹窗 */}
      <Modal
        isOpen={importOpen}
        onClose={() => setImportOpen(false)}
        title="纳管上游已有地址"
      >
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            把<strong className="text-slate-900">上游已存在、但网关注册表里没有</strong>的邮箱补登记进来。
            典型场景是客户端从「直连上游」切到「走网关」后，存量邮箱通过统一 API 读不到。
          </p>

          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1.5">
              邮箱地址（每行一个，也可用空格/逗号分隔，单次上限 200）
            </label>
            <textarea
              value={importText}
              onChange={(e) => setImportText(e.target.value)}
              rows={6}
              autoFocus
              placeholder={'user1@example.com\nuser2@example.com'}
              className="w-full px-3 py-2 font-mono text-xs bg-white border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600 transition-all"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-500 mb-1.5">归属 Key</label>
            <select
              value={importKeyId}
              onChange={(e) => setImportKeyId(e.target.value)}
              className="w-full px-3 py-2 text-xs bg-white border border-slate-200 rounded-xl text-slate-700 focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600 transition-all cursor-pointer"
            >
              <option value="">共享邮箱（任何 Key 可读，默认不进列表）</option>
              {apiKeys.map((k) => (
                <option key={k.id} value={k.id}>
                  {k.name}（{k.prefix}…）
                </option>
              ))}
            </select>
            <p className="mt-1.5 text-xs text-slate-400">
              选定某把 Key 后，这些邮箱只对该 Key 的 <code>GET /v1/mailboxes</code> 可见。
            </p>
          </div>

          {importErrors && (
            <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl">
              <div className="text-xs font-medium text-rose-800 mb-1">部分地址未能纳管</div>
              <pre className="text-xs text-rose-700 whitespace-pre-wrap break-all max-h-32 overflow-y-auto">
                {importErrors}
              </pre>
            </div>
          )}

          <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-xs text-amber-800">
            依赖每邮箱独立凭证的上游（DuckMail）无法纳管——密码是建箱时随机生成的，事后换不回 token。
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={() => setImportOpen(false)}
              disabled={importing}
              className="px-4 py-2 text-xs font-medium text-slate-600 hover:text-slate-900 bg-white hover:bg-slate-100 border border-slate-200 rounded-xl transition-colors disabled:opacity-50"
            >
              取消
            </button>
            <button
              type="button"
              onClick={() => void handleImport()}
              disabled={importing}
              className="px-4 py-2 text-xs font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-xl shadow-sm transition-colors disabled:opacity-50"
            >
              {importing ? '纳管中...' : '开始纳管'}
            </button>
          </div>
        </div>
      </Modal>

      {/* 残留（孤儿）提示：force 删除时上游失败留下的线索 */}
      {orphans.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-2xl p-4">
          <div className="flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 text-amber-600 mt-0.5 flex-shrink-0" />
            <div className="flex-1 min-w-0 space-y-2">
              <div className="text-sm text-amber-900">
                有 <strong>{orphans.length}</strong> 条邮箱记录已从网关移除，但
                <strong>上游删除失败</strong>，可能仍然存在于上游 —— 需要到对应上游后台手工清理。
              </div>
              <ul className="space-y-1">
                {orphans.slice(0, 5).map((o) => (
                  <li key={o.id} className="flex items-center gap-2 text-xs text-amber-800">
                    <code className="font-mono">{o.address}</code>
                    <span className="text-amber-600">@{o.upstreamName}</span>
                    <span className="text-amber-600/80 truncate" title={o.error ?? ''}>
                      {o.errorCode}
                    </span>
                    <button
                      type="button"
                      onClick={() => void handleDismissOrphan(o.id)}
                      title="已手工清理，消账这条"
                      className="ml-auto p-0.5 text-amber-600 hover:text-amber-900 transition-colors"
                    >
                      <X className="w-3 h-3" />
                    </button>
                  </li>
                ))}
              </ul>
              {orphans.length > 5 && (
                <div className="text-xs text-amber-700">…另有 {orphans.length - 5} 条</div>
              )}
              <button
                type="button"
                onClick={() => void handleClearOrphans()}
                className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-amber-800 bg-white hover:bg-amber-100 border border-amber-300 rounded-lg transition-colors"
              >
                <Eraser className="w-3 h-3" />
                全部已清理，消账
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 列表渲染 */}
      {loading ? (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <TableSkeleton rows={8} cols={6} />
        </div>
      ) : error ? (
        <ErrorState message={error} onRetry={loadMailboxes} />
      ) : mailboxes.length === 0 ? (
        <EmptyState
          icon={<Mail className="w-10 h-10 text-slate-400" />}
          title={selectedUpstreamId ? '该上游下暂无临时邮箱' : '暂无临时邮箱记录'}
          description={
            selectedUpstreamId
              ? '当前所选的上游服务名下尚未创建任何邮箱，您可以切换筛选条件查看。'
              : '调用方使用 API Key 请求 POST /v1/mailboxes 创建临时邮箱后，记录将在此展示。'
          }
        />
      ) : (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm border-collapse">
              <thead>
                <tr className="bg-slate-50/80 border-b border-slate-200/80 text-xs font-semibold text-slate-500 uppercase tracking-wider">
                  <th className="py-3.5 px-6">完整邮箱地址</th>
                  <th className="py-3.5 px-4">域名（Domain）</th>
                  <th className="py-3.5 px-4">归属上游</th>
                  <th className="py-3.5 px-4">创建时间</th>
                  <th className="py-3.5 px-4">有效期 / 到期时间</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-700">
                {mailboxes.map((item) => {
                  const upstreamName = upstreamMap.get(item.upstreamId) || item.upstreamId;

                  return (
                    <tr key={item.id} className="hover:bg-slate-50/70 transition-colors">
                      {/* 地址与复制 */}
                      <td className="py-4 px-6 whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          <span className="font-mono font-medium text-slate-900 bg-slate-100/70 px-2 py-1 rounded border border-slate-200/60">
                            {item.address}
                          </span>
                          <CopyButton text={item.address} iconOnly title="复制完整邮箱地址" />
                        </div>
                      </td>

                      {/* 域名 */}
                      <td className="py-4 px-4 whitespace-nowrap font-mono text-xs text-slate-600">
                        @{item.domain}
                      </td>

                      {/* 归属上游 */}
                      <td className="py-4 px-4 whitespace-nowrap">
                        <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-slate-100 text-slate-700 border border-slate-200">
                          {upstreamName}
                        </span>
                      </td>

                      {/* 创建时间 */}
                      <td className="py-4 px-4 whitespace-nowrap text-xs text-slate-500 font-mono">
                        {formatDateTime(item.createdAt)}
                      </td>

                      {/* 到期时间 */}
                      <td className="py-4 px-4 whitespace-nowrap text-xs">
                        {item.expiresAt ? (
                          <div className="flex items-center gap-1.5 text-amber-700 font-mono">
                            <Clock className="w-3.5 h-3.5 text-amber-500 flex-shrink-0" />
                            <span>{formatDateTime(item.expiresAt)}</span>
                          </div>
                        ) : (
                          <div className="flex items-center gap-1.5 text-slate-400">
                            <InfinityIcon className="w-3.5 h-3.5 text-slate-400" />
                            <span>长期有效</span>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* 分页栏 */}
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between px-6 py-4 bg-slate-50/50 border-t border-slate-100 gap-3">
            <div className="text-xs text-slate-500">
              共 <span className="font-semibold text-slate-900">{total}</span> 个临时邮箱 · 当前第{' '}
              <span className="font-semibold text-slate-900">{currentPage}</span> / {totalPages} 页（每页 {PAGE_SIZE} 条）
            </div>

            <div className="flex items-center gap-2 self-end sm:self-auto">
              <button
                type="button"
                disabled={currentPage <= 1 || loading}
                onClick={() => setCurrentPage((p) => Math.max(1, p - 1))}
                className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg shadow-sm hover:bg-slate-50 disabled:opacity-40 disabled:hover:bg-white transition-colors"
              >
                <ChevronLeft className="w-3.5 h-3.5" />
                <span>上一页</span>
              </button>

              <button
                type="button"
                disabled={currentPage >= totalPages || loading}
                onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))}
                className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium text-slate-700 bg-white border border-slate-200 rounded-lg shadow-sm hover:bg-slate-50 disabled:opacity-40 disabled:hover:bg-white transition-colors"
              >
                <span>下一页</span>
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
