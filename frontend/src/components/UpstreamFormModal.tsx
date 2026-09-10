import React, { useState, useEffect } from 'react';
import { Loader2, AlertCircle } from 'lucide-react';
import { Modal } from './Modal';
import { Badge } from './Badge';
import {
  AdapterTypeInfo,
  UpstreamDetail,
  CreateUpstreamPayload,
  UpdateUpstreamPayload,
  ApiError,
} from '../types';

interface UpstreamFormModalProps {
  isOpen: boolean;
  onClose: () => void;
  adapterTypes: AdapterTypeInfo[];
  initialData?: UpstreamDetail | null;
  onSubmit: (payload: CreateUpstreamPayload | UpdateUpstreamPayload) => Promise<void>;
}

export const UpstreamFormModal: React.FC<UpstreamFormModalProps> = ({
  isOpen,
  onClose,
  adapterTypes,
  initialData,
  onSubmit,
}) => {
  const isEditing = !!initialData;

  const [name, setName] = useState('');
  const [type, setType] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [clearApiKey, setClearApiKey] = useState(false);
  const [enabled, setEnabled] = useState(true);
  const [settingsText, setSettingsText] = useState('{}');

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [generalError, setGeneralError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // 初始化或回填表单数据
  useEffect(() => {
    if (!isOpen) return;

    setErrors({});
    setGeneralError(null);

    if (initialData) {
      setName(initialData.name);
      setType(initialData.type);
      setBaseUrl(initialData.baseUrl);
      setApiKey('');
      setClearApiKey(false);
      setEnabled(initialData.enabled);
      setSettingsText(
        initialData.settings && Object.keys(initialData.settings).length > 0
          ? JSON.stringify(initialData.settings, null, 2)
          : '{}',
      );
    } else {
      const defaultType = adapterTypes[0]?.type || 'dummy';
      setName('');
      setType(defaultType);
      // 为常用上游提供默认建议设置
      if (defaultType === 'dummy') {
        setBaseUrl('https://api.mail.tm');
        setSettingsText('{\n  "domains": ["mail.test"]\n}');
      } else {
        setBaseUrl('');
        setSettingsText('{}');
      }
      setApiKey('');
      setClearApiKey(false);
      setEnabled(true);
    }
  }, [isOpen, initialData, adapterTypes]);

  // 当选择不同类型时，若为新建且 settings 仍是空对象，给予友好预设
  const handleTypeChange = (newType: string) => {
    setType(newType);
    if (!isEditing && (settingsText === '{}' || settingsText === '{\n  "domains": ["mail.test"]\n}')) {
      if (newType === 'dummy') {
        setSettingsText('{\n  "domains": ["mail.test"]\n}');
        if (!baseUrl) setBaseUrl('https://api.mail.tm');
      }
    }
  };

  const selectedAdapter = adapterTypes.find((a) => a.type === type);

  // 校验 JSON 格式
  const validateSettingsJson = (): boolean => {
    const trimmed = settingsText.trim();
    if (!trimmed) {
      setSettingsText('{}');
      const nextErrors = { ...errors };
      delete nextErrors.settings;
      setErrors(nextErrors);
      return true;
    }
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        setErrors((prev) => ({ ...prev, settings: 'Settings 必须是一个 JSON 对象 (如 {})' }));
        return false;
      }
      // 校验通过，清理错误
      setErrors((prev) => {
        const next = { ...prev };
        delete next.settings;
        return next;
      });
      return true;
    } catch (e) {
      setErrors((prev) => ({
        ...prev,
        settings: `JSON 格式错误: ${(e as Error).message}`,
      }));
      return false;
    }
  };

  // 表单整体验证
  const validateForm = (): boolean => {
    const newErrors: Record<string, string> = {};

    if (!name.trim()) {
      newErrors.name = '名称不能为空（1-100 字符）';
    } else if (name.trim().length > 100) {
      newErrors.name = '名称不能超过 100 字符';
    }

    if (!type) {
      newErrors.type = '请选择适配器类型';
    }

    if (!baseUrl.trim()) {
      newErrors.baseUrl = 'Base URL 不能为空';
    } else {
      try {
        const u = new URL(baseUrl.trim());
        if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'memory:') {
          newErrors.baseUrl = 'Base URL 必须是有效的 HTTP / HTTPS URL';
        }
      } catch {
        newErrors.baseUrl = '请输入合法的 URL 格式（例如 https://api.mail.tm）';
      }
    }

    // 校验 settings JSON
    try {
      const parsed = JSON.parse(settingsText.trim() || '{}');
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        newErrors.settings = 'Settings 必须是一个 JSON 键值对象';
      }
    } catch (e) {
      newErrors.settings = `JSON 解析失败: ${(e as Error).message}`;
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!validateForm()) return;

    setIsSubmitting(true);
    setGeneralError(null);

    try {
      const parsedSettings = JSON.parse(settingsText.trim() || '{}');

      if (isEditing) {
        const payload: UpdateUpstreamPayload = {
          name: name.trim(),
          baseUrl: baseUrl.trim(),
          enabled,
          settings: parsedSettings,
        };

        if (clearApiKey) {
          payload.apiKey = null;
        } else if (apiKey.trim()) {
          payload.apiKey = apiKey.trim();
        }

        await onSubmit(payload);
      } else {
        const payload: CreateUpstreamPayload = {
          name: name.trim(),
          type,
          baseUrl: baseUrl.trim(),
          enabled,
          settings: parsedSettings,
        };

        if (apiKey.trim()) {
          payload.apiKey = apiKey.trim();
        }

        await onSubmit(payload);
      }
      onClose();
    } catch (err) {
      if (err instanceof ApiError) {
        setGeneralError(err.message);
        if (err.details && typeof err.details === 'object') {
          // 尝试映射字段详情错误
          const detailObj = err.details as Record<string, unknown>;
          const fieldErrors: Record<string, string> = {};
          for (const [k, v] of Object.entries(detailObj)) {
            fieldErrors[k] = String(v);
          }
          if (Object.keys(fieldErrors).length > 0) {
            setErrors((prev) => ({ ...prev, ...fieldErrors }));
          }
        }
      } else {
        setGeneralError('保存失败，请检查网络或稍后重试');
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={isSubmitting ? () => {} : onClose}
      title={isEditing ? '编辑上游服务' : '新建上游服务'}
      maxWidth="lg"
      footer={
        <>
          <button
            type="button"
            disabled={isSubmitting}
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-slate-700 bg-white border border-slate-300 rounded-lg hover:bg-slate-50 disabled:opacity-50 transition-colors"
          >
            取消
          </button>
          <button
            type="button"
            disabled={isSubmitting}
            onClick={handleSubmit}
            className="inline-flex items-center gap-2 px-5 py-2 text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 rounded-lg shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:opacity-60 transition-colors"
          >
            {isSubmitting && <Loader2 className="w-4 h-4 animate-spin" />}
            <span>{isSubmitting ? '保存中...' : isEditing ? '保存修改' : '确认创建'}</span>
          </button>
        </>
      }
    >
      <form onSubmit={handleSubmit} className="space-y-4">
        {/* 全局错误提示 */}
        {generalError && (
          <div className="p-3 bg-rose-50 border border-rose-200 rounded-lg text-rose-700 text-sm flex items-start gap-2">
            <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
            <div className="flex-1 font-medium">{generalError}</div>
          </div>
        )}

        {/* 上游名称 */}
        <div>
          <label htmlFor="upstream-name" className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
            上游名称 <span className="text-rose-500">*</span>
          </label>
          <input
            id="upstream-name"
            type="text"
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (errors.name) setErrors((prev) => ({ ...prev, name: '' }));
            }}
            placeholder="例如：mail.tm 主力"
            maxLength={100}
            className={`w-full px-3.5 py-2 text-sm bg-white border rounded-lg focus:outline-none focus:ring-2 transition-all ${
              errors.name
                ? 'border-rose-300 focus:ring-rose-500/20 focus:border-rose-500'
                : 'border-slate-300 focus:ring-indigo-500/20 focus:border-indigo-600'
            }`}
          />
          {errors.name && <p className="mt-1 text-xs text-rose-600">{errors.name}</p>}
        </div>

        {/* 适配器类型 */}
        <div>
          <label htmlFor="upstream-type" className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
            适配器类型 <span className="text-rose-500">*</span>
          </label>
          {isEditing ? (
            <div className="px-3 py-2 text-sm bg-slate-100 border border-slate-200 rounded-lg text-slate-600 flex items-center justify-between">
              <span className="font-medium">{selectedAdapter?.displayName || type}</span>
              <span className="text-xs text-slate-400">（类型创建后不可修改）</span>
            </div>
          ) : (
            <select
              id="upstream-type"
              value={type}
              onChange={(e) => handleTypeChange(e.target.value)}
              className="w-full px-3.5 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600 transition-all"
            >
              {adapterTypes.map((item) => (
                <option key={item.type} value={item.type}>
                  {item.displayName} ({item.type})
                </option>
              ))}
            </select>
          )}

          {/* 适配器描述与能力信息展示 */}
          {selectedAdapter && (
            <div className="mt-2 p-3 bg-slate-50 border border-slate-200/80 rounded-lg space-y-2 text-xs">
              <p className="text-slate-600 leading-relaxed">{selectedAdapter.description}</p>
              <div className="flex flex-wrap items-center gap-2 pt-1 border-t border-slate-200/60">
                <span className="text-slate-500 font-medium">支持能力:</span>
                <Badge variant={selectedAdapter.capabilities.deleteMessage ? 'emerald' : 'slate'}>
                  {selectedAdapter.capabilities.deleteMessage ? '✓ 删除邮件' : '✗ 删除邮件'}
                </Badge>
                <Badge variant={selectedAdapter.capabilities.getSource ? 'emerald' : 'slate'}>
                  {selectedAdapter.capabilities.getSource ? '✓ 邮件原文' : '✗ 邮件原文'}
                </Badge>
              </div>
            </div>
          )}
        </div>

        {/* Base URL */}
        <div>
          <label htmlFor="upstream-url" className="block text-xs font-semibold text-slate-700 uppercase tracking-wider mb-1">
            Base URL <span className="text-rose-500">*</span>
          </label>
          <input
            id="upstream-url"
            type="text"
            value={baseUrl}
            onChange={(e) => {
              setBaseUrl(e.target.value);
              if (errors.baseUrl) setErrors((prev) => ({ ...prev, baseUrl: '' }));
            }}
            placeholder="https://api.mail.tm"
            className={`w-full px-3.5 py-2 text-sm font-mono bg-white border rounded-lg focus:outline-none focus:ring-2 transition-all ${
              errors.baseUrl
                ? 'border-rose-300 focus:ring-rose-500/20 focus:border-rose-500'
                : 'border-slate-300 focus:ring-indigo-500/20 focus:border-indigo-600'
            }`}
          />
          {errors.baseUrl && <p className="mt-1 text-xs text-rose-600">{errors.baseUrl}</p>}
        </div>

        {/* API Key */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label htmlFor="upstream-key" className="block text-xs font-semibold text-slate-700 uppercase tracking-wider">
              上游 API Key <span className="text-slate-400 font-normal">（可选，AES-256 加密存储）</span>
            </label>
            {isEditing && initialData.hasApiKey && (
              <label className="inline-flex items-center gap-1.5 text-xs text-rose-600 font-medium cursor-pointer">
                <input
                  type="checkbox"
                  checked={clearApiKey}
                  onChange={(e) => {
                    setClearApiKey(e.target.checked);
                    if (e.target.checked) setApiKey('');
                  }}
                  className="rounded border-slate-300 text-rose-600 focus:ring-rose-500"
                />
                <span>清除已配置的 Key</span>
              </label>
            )}
          </div>
          <input
            id="upstream-key"
            type="password"
            value={apiKey}
            disabled={clearApiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={
              isEditing && initialData?.hasApiKey
                ? clearApiKey
                  ? '保存后将清除上游 Key'
                  : '已配置，留空则保持不变'
                : '如上游需要鉴权，请输入'
            }
            className={`w-full px-3.5 py-2 text-sm bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/20 focus:border-indigo-600 transition-all font-mono disabled:bg-slate-100 disabled:text-slate-400`}
          />
        </div>

        {/* 启用状态 */}
        <div className="flex items-center justify-between p-3 bg-slate-50 border border-slate-200/80 rounded-lg">
          <div>
            <span className="text-sm font-semibold text-slate-800">启用该上游</span>
            <p className="text-xs text-slate-500">停用后网关将不再把临时邮箱请求路由至该上游</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={enabled}
            onClick={() => setEnabled(!enabled)}
            className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 ${
              enabled ? 'bg-indigo-600' : 'bg-slate-300'
            }`}
          >
            <span
              className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                enabled ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>

        {/* Settings JSON */}
        <div>
          <div className="flex items-center justify-between mb-1">
            <label htmlFor="upstream-settings" className="block text-xs font-semibold text-slate-700 uppercase tracking-wider">
              适配器配置（Settings JSON）
            </label>
            <span className="text-xs text-slate-400 font-mono">键值对对象</span>
          </div>
          <textarea
            id="upstream-settings"
            rows={4}
            value={settingsText}
            onChange={(e) => setSettingsText(e.target.value)}
            onBlur={validateSettingsJson}
            placeholder="例如：{&quot;domains&quot;: [&quot;mail.test&quot;]}"
            className={`w-full px-3 py-2 text-xs font-mono bg-slate-900 text-slate-100 rounded-lg focus:outline-none focus:ring-2 transition-all ${
              errors.settings
                ? 'border-2 border-rose-500 focus:ring-rose-500/30'
                : 'border border-slate-700 focus:ring-indigo-500/30'
            }`}
          />
          {errors.settings && <p className="mt-1 text-xs text-rose-600 font-medium">{errors.settings}</p>}
        </div>
      </form>
    </Modal>
  );
};
