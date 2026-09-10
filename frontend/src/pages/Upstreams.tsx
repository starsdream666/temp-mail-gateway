import React, { useState, useEffect, useCallback } from 'react';
import {
  Plus,
  RefreshCw,
  Edit2,
  Trash2,
  Globe,
  ChevronDown,
  ChevronRight,
  Server,
  AlertTriangle,
  CheckCircle,
  Code2,
  Link2,
} from 'lucide-react';
import {
  getUpstreams,
  getUpstream,
  createUpstream,
  updateUpstream,
  deleteUpstream,
  syncUpstreamDomains,
  setDomainEnabled,
  getAdapterTypes,
} from '../api/client';
import {
  UpstreamSummary,
  UpstreamDetail,
  AdapterTypeInfo,
  SyncDomainsResult,
  CreateUpstreamPayload,
  UpdateUpstreamPayload,
  ApiError,
} from '../types';
import { useToast } from '../components/Toast';
import { Badge } from '../components/Badge';
import { CopyButton } from '../components/CopyButton';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { TableSkeleton } from '../components/Loading';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { Modal } from '../components/Modal';
import { Toggle } from '../components/Toggle';
import { UpstreamFormModal } from '../components/UpstreamFormModal';
import { formatDateTime } from '../utils/format';

export const Upstreams: React.FC = () => {
  const [upstreams, setUpstreams] = useState<UpstreamSummary[]>([]);
  const [adapterTypes, setAdapterTypes] = useState<AdapterTypeInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 展开的详情缓存
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detailCache, setDetailCache] = useState<Record<string, UpstreamDetail>>({});
  const [loadingDetailId, setLoadingDetailId] = useState<string | null>(null);

  // 详情域名表渲染上限（大渠道如 YYDS 379 个域名全量渲染会造成展开卡顿）
  const [showAllDomains, setShowAllDomains] = useState(false);

  // 同步操作状态
  const [syncingId, setSyncingId] = useState<string | null>(null);
  const [syncResult, setSyncResult] = useState<{ name: string; result: SyncDomainsResult } | null>(null);

  // 新建/编辑 Modal
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingDetail, setEditingDetail] = useState<UpstreamDetail | null>(null);

  // 删除确认对话框
  const [deleteTarget, setDeleteTarget] = useState<UpstreamSummary | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [toggleLoadingId, setToggleLoadingId] = useState<string | null>(null);

  const toast = useToast();

  const loadData = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const [upstreamList, types] = await Promise.all([getUpstreams(), getAdapterTypes()]);
      setUpstreams(upstreamList);
      setAdapterTypes(types);
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError('无法获取上游服务列表，请检查网络或后端状态');
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // 获取并展开详情
  const toggleExpand = async (id: string) => {
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }

    setExpandedId(id);
    setShowAllDomains(false); // 切换详情时复位"显示全部"，避免大渠道展开即全量渲染
    if (!detailCache[id]) {
      try {
        setLoadingDetailId(id);
        const detail = await getUpstream(id);
        setDetailCache((prev) => ({ ...prev, [id]: detail }));
      } catch (err) {
        toast.error((err as Error).message || '获取上游详情失败');
      } finally {
        setLoadingDetailId(null);
      }
    }
  };

  // 切换启用状态开关
  const handleToggleEnabled = async (item: UpstreamSummary, e: React.MouseEvent) => {
    e.stopPropagation();
    const nextEnabled = !item.enabled;
    setToggleLoadingId(item.id);

    // 乐观更新
    setUpstreams((prev) => prev.map((u) => (u.id === item.id ? { ...u, enabled: nextEnabled } : u)));

    try {
      const updated = await updateUpstream(item.id, { enabled: nextEnabled });
      toast.success(`上游「${item.name}」已${nextEnabled ? '启用' : '停用'}`);
      setUpstreams((prev) => prev.map((u) => (u.id === item.id ? { ...u, enabled: updated.enabled } : u)));
      if (detailCache[item.id]) {
        setDetailCache((prev) => ({ ...prev, [item.id]: updated }));
      }
    } catch (err) {
      // 回滚
      setUpstreams((prev) => prev.map((u) => (u.id === item.id ? { ...u, enabled: item.enabled } : u)));
      toast.error((err as Error).message || '更新状态失败');
    } finally {
      setToggleLoadingId(null);
    }
  };

  // 开关某域名的调用（乐观更新，失败回滚）。
  // 匹配键 = (upstreamId, domain)：复合主键下同名域名可出现在多个渠道，只改本渠道的行
  const handleToggleDomain = async (upstreamId: string, domain: string, nextEnabled: boolean) => {
    const applyTo = (cache: Record<string, UpstreamDetail>): Record<string, UpstreamDetail> => {
      const current = cache[upstreamId];
      if (!current) return cache;
      return {
        ...cache,
        [upstreamId]: {
          ...current,
          domains: current.domains.map((d) =>
            d.domain === domain ? { ...d, enabled: nextEnabled } : d,
          ),
        },
      };
    };
    // 进函数先快照旧值；catch 里整块还原（旧写法闭包写死了新值，回滚是空操作）
    const prev = detailCache[upstreamId];
    setDetailCache(applyTo);
    try {
      const updated = await setDomainEnabled(upstreamId, domain, nextEnabled);
      setDetailCache((prevCache) =>
        prevCache[upstreamId]
          ? {
              ...prevCache,
              [upstreamId]: {
                ...prevCache[upstreamId]!,
                domains: prevCache[upstreamId]!.domains.map((d) => (d.domain === domain ? updated : d)),
              },
            }
          : prevCache,
      );
      toast.success(`域名 ${domain} 已${nextEnabled ? '开启' : '停止'}调用`);
    } catch (err) {
      if (prev) setDetailCache((prevCache) => ({ ...prevCache, [upstreamId]: prev }));
      toast.error((err as Error).message || '更新域名状态失败');
    }
  };

  // 手动同步域名
  const handleSyncDomains = async (item: UpstreamSummary, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      setSyncingId(item.id);
      const res = await syncUpstreamDomains(item.id);
      setSyncResult({ name: item.name, result: res });

      // 刷新列表与缓存详情中的域名数
      setUpstreams((prev) => prev.map((u) => (u.id === item.id ? { ...u, domainCount: res.total } : u)));
      // 如果当前展开，重新拉取最新详情
      if (expandedId === item.id) {
        const freshDetail = await getUpstream(item.id);
        setDetailCache((prev) => ({ ...prev, [item.id]: freshDetail }));
      } else {
        // 清理缓存，下次展开时拉取最新
        setDetailCache((prev) => {
          const next = { ...prev };
          delete next[item.id];
          return next;
        });
      }

      if (res.warning) {
        toast.warning(`域名同步完成，但有告警: ${res.warning}`);
      } else {
        toast.success(`域名同步成功：新增 ${res.added.length} 个，移除 ${res.removed.length} 个，现有 ${res.total} 个`);
      }
    } catch (err) {
      toast.error((err as Error).message || '同步域名失败');
    } finally {
      setSyncingId(null);
    }
  };

  // 打开编辑
  const handleOpenEdit = async (item: UpstreamSummary, e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      // 保证拿到最新 detail (含 settings)
      let detail = detailCache[item.id];
      if (!detail) {
        const fresh = await getUpstream(item.id);
        detail = fresh;
        setDetailCache((prev) => ({ ...prev, [item.id]: fresh }));
      }
      setEditingDetail(detail);
      setIsFormOpen(true);
    } catch (err) {
      toast.error((err as Error).message || '加载详情失败');
    }
  };

  // 打开新建
  const handleOpenCreate = () => {
    setEditingDetail(null);
    setIsFormOpen(true);
  };

  // 提交新建 / 编辑
  const handleFormSubmit = async (payload: CreateUpstreamPayload | UpdateUpstreamPayload) => {
    if (editingDetail) {
      // 编辑
      const updated = await updateUpstream(editingDetail.id, payload as UpdateUpstreamPayload);
      toast.success(`上游「${updated.name}」已更新`);
      setUpstreams((prev) => prev.map((u) => (u.id === updated.id ? { ...u, ...updated } : u)));
      setDetailCache((prev) => ({ ...prev, [updated.id]: updated }));
    } else {
      // 新建
      const { upstream, sync } = await createUpstream(payload as CreateUpstreamPayload);
      toast.success(`上游「${upstream.name}」创建成功`);
      if (sync) {
        setSyncResult({ name: upstream.name, result: sync });
      }
      setUpstreams((prev) => [upstream, ...prev]);
      setDetailCache((prev) => ({ ...prev, [upstream.id]: upstream }));
    }
  };

  // 删除上游
  const handleConfirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      setIsDeleting(true);
      await deleteUpstream(deleteTarget.id);
      toast.success(`上游「${deleteTarget.name}」已成功删除`);
      setUpstreams((prev) => prev.filter((u) => u.id !== deleteTarget.id));
      setDetailCache((prev) => {
        const next = { ...prev };
        delete next[deleteTarget.id];
        return next;
      });
      if (expandedId === deleteTarget.id) setExpandedId(null);
      setDeleteTarget(null);
    } catch (err) {
      // 后端名下有邮箱时返回 409
      toast.error((err as Error).message || '删除失败');
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* 头部标题与新建按钮 */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-slate-900 tracking-tight flex items-center gap-2.5">
            <Server className="w-7 h-7 text-indigo-600" />
            <span>上游管理</span>
          </h1>
          <p className="text-sm text-slate-500 mt-1">
            配置与维护临时邮箱上游服务，支持自动及手动同步域名列表，按域名智能分发邮箱请求。
          </p>
        </div>
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={loadData}
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
            <span>新建上游</span>
          </button>
        </div>
      </div>

      {/* 列表主体三态展示 */}
      {loading ? (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <TableSkeleton rows={5} cols={7} />
        </div>
      ) : error ? (
        <ErrorState message={error} onRetry={loadData} />
      ) : upstreams.length === 0 ? (
        <EmptyState
          icon={<Server className="w-10 h-10 text-slate-400" />}
          title="还没有任何上游服务"
          description="添加第一个上游（例如内置 Dummy 或 Mail.tm），网关将自动同步可用域名以供接收邮件。"
          action={
            <button
              type="button"
              onClick={handleOpenCreate}
              className="inline-flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-700 text-white font-medium text-sm rounded-lg transition-colors"
            >
              <Plus className="w-4 h-4" />
              <span>立即新建上游</span>
            </button>
          }
        />
      ) : (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden divide-y divide-slate-100">
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm border-collapse">
              <thead>
                <tr className="bg-slate-50/80 border-b border-slate-200/80 text-xs font-semibold text-slate-500 uppercase tracking-wider">
                  <th className="w-10 py-3.5 pl-4 pr-1"></th>
                  <th className="py-3.5 px-3">名称</th>
                  <th className="py-3.5 px-3">适配器类型</th>
                  <th className="py-3.5 px-3">Base URL</th>
                  <th className="py-3.5 px-3">启用状态</th>
                  <th className="py-3.5 px-3">API Key</th>
                  <th className="py-3.5 px-3">域名数</th>
                  <th className="py-3.5 px-3">创建时间</th>
                  <th className="py-3.5 px-4 text-right">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-slate-700">
                {upstreams.map((item) => {
                  const isExpanded = expandedId === item.id;
                  const isSyncing = syncingId === item.id;
                  const isToggling = toggleLoadingId === item.id;
                  const detail = detailCache[item.id];

                  return (
                    <React.Fragment key={item.id}>
                      <tr
                        onClick={() => toggleExpand(item.id)}
                        className={`cursor-pointer transition-colors group ${
                          isExpanded ? 'bg-indigo-50/30' : 'hover:bg-slate-50/80'
                        }`}
                      >
                        {/* 展开指示箭头 */}
                        <td className="py-4 pl-4 pr-1 text-slate-400">
                          {isExpanded ? (
                            <ChevronDown className="w-4 h-4 text-indigo-600" />
                          ) : (
                            <ChevronRight className="w-4 h-4 group-hover:text-slate-600" />
                          )}
                        </td>

                        {/* 上游名称 + ID */}
                        <td className="py-4 px-3 whitespace-nowrap">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-slate-900">{item.name}</span>
                          </div>
                          <div className="mt-1 flex items-center gap-1.5">
                            <span
                              className="font-mono text-[11px] text-slate-400 max-w-[200px] truncate"
                              title={`上游 ID: ${item.id}`}
                            >
                              {item.id}
                            </span>
                            <CopyButton text={item.id} iconOnly title="复制上游 ID" />
                          </div>
                        </td>

                        {/* 适配器类型 badge */}
                        <td className="py-4 px-3 whitespace-nowrap">
                          <Badge variant={item.type === 'dummy' ? 'purple' : 'indigo'}>
                            {item.type}
                          </Badge>
                        </td>

                        {/* Base URL */}
                        <td className="py-4 px-3 font-mono text-xs text-slate-600 max-w-[200px] truncate" title={item.baseUrl}>
                          {item.baseUrl}
                        </td>

                        {/* 启用状态 Switch */}
                        <td className="py-4 px-3 whitespace-nowrap">
                          <button
                            type="button"
                            role="switch"
                            aria-checked={item.enabled}
                            disabled={isToggling}
                            onClick={(e) => handleToggleEnabled(item, e)}
                            className={`relative inline-flex h-5 w-9 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-1 ${
                              item.enabled ? 'bg-emerald-500' : 'bg-slate-300'
                            } ${isToggling ? 'opacity-50' : ''}`}
                            title={item.enabled ? '点击停用' : '点击启用'}
                          >
                            <span
                              className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                                item.enabled ? 'translate-x-4' : 'translate-x-0'
                              }`}
                            />
                          </button>
                        </td>

                        {/* API Key 状态 */}
                        <td className="py-4 px-3 whitespace-nowrap">
                          <Badge variant={item.hasApiKey ? 'emerald' : 'slate'} dot>
                            {item.hasApiKey ? '已配置' : '未配置'}
                          </Badge>
                        </td>

                        {/* 域名数 */}
                        <td className="py-4 px-3 whitespace-nowrap font-medium text-slate-800">
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-100 text-slate-700">
                            <Globe className="w-3 h-3 text-slate-400" />
                            <span>{item.domainCount}</span>
                          </span>
                        </td>

                        {/* 创建时间 */}
                        <td className="py-4 px-3 whitespace-nowrap text-xs text-slate-500 font-mono">
                          {formatDateTime(item.createdAt)}
                        </td>

                        {/* 操作栏 */}
                        <td className="py-4 px-4 text-right whitespace-nowrap">
                          <div className="flex items-center justify-end gap-1.5" onClick={(e) => e.stopPropagation()}>
                            {/* 同步域名 */}
                            <button
                              type="button"
                              disabled={isSyncing}
                              onClick={(e) => handleSyncDomains(item, e)}
                              title="手动同步上游域名"
                              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-slate-600 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg border border-slate-200 transition-colors disabled:opacity-50"
                            >
                              <RefreshCw className={`w-3.5 h-3.5 ${isSyncing ? 'animate-spin text-indigo-600' : ''}`} />
                              <span>{isSyncing ? '同步中' : '同步域名'}</span>
                            </button>

                            {/* 编辑 */}
                            <button
                              type="button"
                              onClick={(e) => handleOpenEdit(item, e)}
                              title="编辑配置"
                              className="p-1.5 text-slate-600 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg border border-slate-200 transition-colors"
                            >
                              <Edit2 className="w-3.5 h-3.5" />
                            </button>

                            {/* 删除 */}
                            <button
                              type="button"
                              onClick={(e) => {
                                e.stopPropagation();
                                setDeleteTarget(item);
                              }}
                              title="删除上游"
                              className="p-1.5 text-slate-600 hover:text-rose-600 hover:bg-rose-50 rounded-lg border border-slate-200 transition-colors"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>

                      {/* 展开详情行 */}
                      {isExpanded && (
                        <tr className="bg-slate-50/70 border-b border-slate-100">
                          <td colSpan={9} className="p-6">
                            {loadingDetailId === item.id ? (
                              <div className="py-6 flex items-center justify-center text-slate-400 text-xs gap-2">
                                <RefreshCw className="w-4 h-4 animate-spin text-indigo-600" />
                                <span>加载详情中...</span>
                              </div>
                            ) : detail ? (
                              <div className="space-y-6">
                                {/* 调用信息（透传前缀） */}
                                <div>
                                  <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider mb-2 flex items-center gap-2">
                                    <Link2 className="w-4 h-4 text-indigo-600" />
                                    <span>调用信息 · 原生格式透传前缀</span>
                                  </h4>
                                  <div className="bg-white rounded-xl border border-slate-200 shadow-sm divide-y divide-slate-100 text-xs">
                                    <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 px-4 py-3">
                                      <span className="sm:w-24 flex-shrink-0 text-slate-500 font-medium">上游 ID</span>
                                      <code className="font-mono text-slate-900 break-all">{detail.id}</code>
                                      <div className="sm:ml-auto flex-shrink-0">
                                        <CopyButton text={detail.id} label="复制 ID" />
                                      </div>
                                    </div>
                                    <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 px-4 py-3">
                                      <span className="sm:w-24 flex-shrink-0 text-slate-500 font-medium">实例透传</span>
                                      <code className="font-mono text-slate-900 break-all">/upstream/{detail.id}/&#123;上游原生路径&#125;</code>
                                      <div className="sm:ml-auto flex-shrink-0">
                                        <CopyButton text={`/upstream/${detail.id}`} label="复制前缀" />
                                      </div>
                                    </div>
                                    <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 px-4 py-3">
                                      <span className="sm:w-24 flex-shrink-0 text-slate-500 font-medium">类型透传</span>
                                      <code className="font-mono text-slate-900 break-all">/upstream/{detail.type}/&#123;上游原生路径&#125;</code>
                                      <div className="sm:ml-auto flex-shrink-0">
                                        <CopyButton text={`/upstream/${detail.type}`} label="复制前缀" />
                                      </div>
                                    </div>
                                  </div>
                                  <p className="mt-2 text-[11px] text-slate-400 leading-relaxed">
                                    请求头携带 Authorization: Bearer 网关Key 即可按上游原生格式调用；类型前缀在多实例时按域名路由，GET 会合并各实例结果。
                                  </p>
                                </div>

                                {/* 域名列表展示 */}
                                <div>
                                  <div className="flex items-center justify-between mb-3">
                                    <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider flex items-center gap-2">
                                      <Globe className="w-4 h-4 text-indigo-600" />
                                      <span>已同步的有效域名列表 ({detail.domains.length})</span>
                                    </h4>
                                    <button
                                      type="button"
                                      disabled={isSyncing}
                                      onClick={(e) => handleSyncDomains(item, e)}
                                      className="text-xs text-indigo-600 hover:text-indigo-700 font-medium inline-flex items-center gap-1"
                                    >
                                      <RefreshCw className={`w-3 h-3 ${isSyncing ? 'animate-spin' : ''}`} />
                                      <span>立即重新同步</span>
                                    </button>
                                  </div>

                                  {detail.domains.length === 0 ? (
                                    <div className="p-4 bg-white rounded-xl border border-dashed border-slate-200 text-center text-xs text-slate-500">
                                      当前上游暂无同步到的域名，请检查上游状态或点击上方「同步域名」
                                    </div>
                                  ) : (
                                    <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                                      <table className="w-full text-xs text-left">
                                        <thead>
                                          <tr className="bg-slate-50 border-b border-slate-100 text-slate-500 font-semibold">
                                            <th className="py-2.5 px-4">域名</th>
                                            <th className="py-2.5 px-4">访问权限</th>
                                            <th className="py-2.5 px-4">调用开关</th>
                                            <th className="py-2.5 px-4">同步时间</th>
                                            <th className="py-2.5 px-4 text-right">操作</th>
                                          </tr>
                                        </thead>
                                        <tbody className="divide-y divide-slate-100 text-slate-700">
                                          {(() => {
                                            const cap = 50;
                                            const shown = showAllDomains ? detail.domains : detail.domains.slice(0, cap);
                                            const hidden = detail.domains.length - shown.length;
                                            return (
                                              <>
                                                {shown.map((dom) => (
                                                  <tr
                                                    key={`${item.id}:${dom.domain}`}
                                                    className={`hover:bg-slate-50/50 transition-colors ${dom.enabled ? '' : 'bg-slate-50/60'}`}
                                                  >
                                                    <td
                                                      className={`py-2.5 px-4 font-mono font-medium ${dom.enabled ? 'text-slate-900' : 'text-slate-400 line-through'}`}
                                                    >
                                                      @{dom.domain}
                                                    </td>
                                                    <td className="py-2.5 px-4">
                                                      <Badge variant={dom.isPrivate ? 'amber' : 'emerald'}>
                                                        {dom.isPrivate ? '私有' : '公开'}
                                                      </Badge>
                                                    </td>
                                                    <td className="py-2.5 px-4">
                                                      <div className="flex items-center gap-2">
                                                        <Toggle
                                                          checked={dom.enabled}
                                                          onChange={(next) => handleToggleDomain(item.id, dom.domain, next)}
                                                          title={dom.enabled ? '点击停用该域名的调用' : '点击开启该域名的调用'}
                                                        />
                                                        <span
                                                          className={`text-[11px] font-medium ${dom.enabled ? 'text-emerald-600' : 'text-slate-400'}`}
                                                        >
                                                          {dom.enabled ? '可调用' : '已停用'}
                                                        </span>
                                                      </div>
                                                    </td>
                                                    <td className="py-2.5 px-4 font-mono text-slate-500">
                                                      {formatDateTime(dom.syncedAt)}
                                                    </td>
                                                    <td className="py-2.5 px-4 text-right">
                                                      <CopyButton text={dom.domain} label="复制域名" />
                                                    </td>
                                                  </tr>
                                                ))}
                                                {hidden > 0 && (
                                                  <tr>
                                                    <td colSpan={5} className="px-4 py-2.5 bg-slate-50/60 text-[11px]">
                                                      <button
                                                        type="button"
                                                        onClick={() => setShowAllDomains(true)}
                                                        className="text-indigo-600 hover:text-indigo-700 font-medium"
                                                      >
                                                        已显示前 {cap} 个，点击显示全部 {detail.domains.length} 个
                                                      </button>
                                                    </td>
                                                  </tr>
                                                )}
                                              </>
                                            );
                                          })()}
                                        </tbody>
                                      </table>
                                      <div className="px-4 py-2 bg-slate-50/60 border-t border-slate-100 text-[11px] text-slate-400">
                                        停用后，统一 API 与原生格式透传的建箱请求都会被拒绝（存量邮箱收发不受影响）。
                                      </div>
                                    </div>
                                  )}
                                </div>

                                {/* Settings JSON 展示 */}
                                <div>
                                  <h4 className="text-xs font-bold text-slate-700 uppercase tracking-wider mb-2 flex items-center gap-2">
                                    <Code2 className="w-4 h-4 text-indigo-600" />
                                    <span>适配器私有配置 (Settings)</span>
                                  </h4>
                                  <pre className="p-3.5 bg-slate-900 text-slate-100 rounded-xl text-xs font-mono overflow-x-auto border border-slate-800 leading-relaxed">
                                    {JSON.stringify(detail.settings, null, 2)}
                                  </pre>
                                </div>
                              </div>
                            ) : null}
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 新建 / 编辑表单模态框 */}
      <UpstreamFormModal
        isOpen={isFormOpen}
        onClose={() => setIsFormOpen(false)}
        adapterTypes={adapterTypes}
        initialData={editingDetail}
        onSubmit={handleFormSubmit}
      />

      {/* 同步域名结果展示弹窗 */}
      <Modal
        isOpen={!!syncResult}
        onClose={() => setSyncResult(null)}
        title={
          <div className="flex items-center gap-2">
            <CheckCircle className="w-5 h-5 text-emerald-600" />
            <span>域名同步结果 · {syncResult?.name}</span>
          </div>
        }
        maxWidth="md"
        footer={
          <button
            type="button"
            onClick={() => setSyncResult(null)}
            className="px-4 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg shadow-sm"
          >
            知道了
          </button>
        }
      >
        {syncResult && (
          <div className="space-y-4">
            {syncResult.result.warning && (
              <div className="p-3 bg-amber-50 border border-amber-200 rounded-xl text-amber-800 text-xs flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 mt-0.5 text-amber-600 flex-shrink-0" />
                <div className="leading-relaxed">
                  <div className="font-semibold mb-0.5">同步过程中产生告警:</div>
                  <div>{syncResult.result.warning}</div>
                </div>
              </div>
            )}

            <div className="grid grid-cols-3 gap-3">
              <div className="p-3 bg-emerald-50 border border-emerald-100 rounded-xl text-center">
                <div className="text-xl font-bold text-emerald-600">+{syncResult.result.added.length}</div>
                <div className="text-xs text-emerald-700 font-medium mt-0.5">新增可用域名</div>
              </div>
              <div className="p-3 bg-rose-50 border border-rose-100 rounded-xl text-center">
                <div className="text-xl font-bold text-rose-600">-{syncResult.result.removed.length}</div>
                <div className="text-xs text-rose-700 font-medium mt-0.5">失效移除域名</div>
              </div>
              <div className="p-3 bg-indigo-50 border border-indigo-100 rounded-xl text-center">
                <div className="text-xl font-bold text-indigo-600">{syncResult.result.total}</div>
                <div className="text-xs text-indigo-700 font-medium mt-0.5">当前有效域名</div>
              </div>
            </div>

            {syncResult.result.added.length > 0 && (
              <div>
                <div className="text-xs font-semibold text-slate-700 mb-1.5">新增域名:</div>
                <div className="flex flex-wrap gap-1.5">
                  {syncResult.result.added.map((dom) => (
                    <Badge key={dom} variant="emerald">
                      +{dom}
                    </Badge>
                  ))}
                </div>
              </div>
            )}

            {syncResult.result.removed.length > 0 && (
              <div>
                <div className="text-xs font-semibold text-slate-700 mb-1.5">移除域名:</div>
                <div className="flex flex-wrap gap-1.5">
                  {syncResult.result.removed.map((dom) => (
                    <Badge key={dom} variant="rose">
                      -{dom}
                    </Badge>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* 删除危险确认对话框 */}
      <ConfirmDialog
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleConfirmDelete}
        isLoading={isDeleting}
        title="删除上游服务确认"
        description={
          <div>
            确定要删除上游服务 <span className="font-bold text-slate-900">「{deleteTarget?.name}」</span> 吗？
            <div className="mt-2 text-xs text-slate-500 leading-relaxed">
              删除后该上游登记的域名将全部失效，网关将不再处理其下域名的邮件。
              若名下仍有未清理的临时邮箱，后端将拒绝删除（409 冲突）。
            </div>
          </div>
        }
        dangerNotice="删除后不可恢复，请确保名下已无邮箱依赖！"
        confirmText="确认彻底删除"
        isDanger={true}
      />
    </div>
  );
};
