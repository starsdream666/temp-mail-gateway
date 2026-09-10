import React, { useMemo, useState } from 'react';
import {
  AlertTriangle,
  BookOpen,
  Braces,
  ChevronDown,
  ExternalLink,
  KeyRound,
  ListFilter,
  Server,
  TerminalSquare,
} from 'lucide-react';
import { CopyButton } from '../components/CopyButton';

type Method = 'GET' | 'POST' | 'DELETE';
type Endpoint = {
  method: Method;
  path: string;
  title: string;
  description: string;
  params?: string[];
  body?: string;
  response: string;
  notes?: string;
};

const endpoints: Endpoint[] = [
  {
    method: 'GET',
    path: '/v1/domains',
    title: '列出可用域名',
    description: '返回当前 API Key 有权使用的启用域名，并按域名去重。',
    response: `{
  "domains": [{
    "domain": "duckmail.sbs",
    "upstreamId": "upstream_id",
    "upstreamType": "duckmail",
    "isPrivate": false
  }]
}`,
  },
  {
    method: 'POST',
    path: '/v1/mailboxes',
    title: '创建邮箱',
    description: '按指定域名路由到对应上游；不传 domain 时自动选择可用域名。',
    notes: '每个 Key 可在「API Keys → 调用限制」单独设置每小时创建上限；未配置时跟随系统默认（默认 60 次/小时）。超限返回 429，查询与读信不消耗此额度。',
    body: `{
  "domain": "duckmail.sbs",
  "localPart": "demo",
  "expiresInSeconds": 3600
}`,
    response: `{
  "mailbox": {
    "id": "mailbox_id",
    "address": "demo@duckmail.sbs",
    "localPart": "demo",
    "domain": "duckmail.sbs",
    "upstreamId": "upstream_id",
    "expiresAt": "2026-09-09T12:00:00.000Z",
    "createdAt": "2026-09-09T11:00:00.000Z"
  }
}`,
  },
  {
    method: 'GET',
    path: '/v1/mailboxes',
    title: '列出邮箱',
    description: '分页列出当前 Key 创建的邮箱，按创建时间从新到旧。',
    params: [
      'limit：每页数量，默认 20，最大 100',
      'offset：分页偏移量，默认 0',
      'includeExpired：true/1 时包含已过期邮箱',
      'includeShared：true/1 时包含透传登记的共享邮箱',
    ],
    response: `{
  "total": 1,
  "mailboxes": [{ "id": "mailbox_id", "address": "demo@duckmail.sbs" }]
}`,
  },
  {
    method: 'GET',
    path: '/v1/mailboxes/{id}',
    title: '获取邮箱详情',
    description: '查询单个邮箱记录；已过期的邮箱仍可查询详情。',
    response: `{ "mailbox": { "id": "mailbox_id", "address": "demo@duckmail.sbs" } }`,
  },
  {
    method: 'DELETE',
    path: '/v1/mailboxes/{id}',
    title: '删除邮箱',
    description: '默认同时删除上游邮箱；成功返回 204。',
    params: ['force：true/1 开启尽力删除；无论上游结果如何都移除网关记录'],
    response: `{ "deleted": true, "upstreamDeleted": true }`,
    notes: 'force 模式才返回 JSON；普通严格删除成功返回 204。依赖每邮箱独立凭证的上游可能拒绝 force。',
  },
  {
    method: 'GET',
    path: '/v1/mailboxes/{id}/messages',
    title: '列出邮件',
    description: '获取邮箱内的邮件摘要列表。',
    params: ['since：上一页最后一条邮件 ID，用于增量拉取'],
    response: `{
  "messages": [{
    "id": "message_id",
    "from": "sender@example.com",
    "to": ["demo@duckmail.sbs"],
    "subject": "Your code",
    "intro": "Verification code: 123456",
    "seen": false,
    "hasAttachments": false,
    "createdAt": "2026-09-09T11:05:00.000Z"
  }]
}`,
  },
  {
    method: 'GET',
    path: '/v1/mailboxes/{id}/messages/{mid}',
    title: '获取邮件详情',
    description: '返回邮件文本、HTML 与附件元数据。',
    response: `{
  "message": {
    "id": "message_id",
    "subject": "Your code",
    "text": "Verification code: 123456",
    "html": ["<p>Verification code: <b>123456</b></p>"],
    "attachments": []
  }
}`,
  },
  {
    method: 'DELETE',
    path: '/v1/mailboxes/{id}/messages/{mid}',
    title: '删除邮件',
    description: '删除指定邮件；上游不支持时返回 501。',
    response: '204 No Content',
  },
  {
    method: 'GET',
    path: '/v1/mailboxes/{id}/messages/{mid}/source',
    title: '获取原始报文',
    description: '获取 RFC 822 原始邮件；上游不支持时返回 501。',
    response: 'Content-Type: message/rfc822\n\nFrom: sender@example.com\nTo: demo@duckmail.sbs\n...',
  },
];

const methodStyle: Record<Method, string> = {
  GET: 'bg-sky-50 text-sky-700 border-sky-200',
  POST: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  DELETE: 'bg-rose-50 text-rose-700 border-rose-200',
};

function CodeBlock({ value, label }: { value: string; label: string }) {
  return (
    <div className="overflow-hidden rounded-xl border border-slate-800 bg-slate-950 shadow-sm">
      <div className="flex items-center justify-between border-b border-slate-800 px-3 py-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">{label}</span>
        <CopyButton
          text={value}
          label="复制"
          className="!border-slate-700 !bg-slate-900 !text-slate-300 hover:!bg-slate-800"
        />
      </div>
      <pre className="overflow-x-auto p-4 text-xs leading-6 text-slate-200"><code>{value}</code></pre>
    </div>
  );
}

function EndpointCard({ endpoint, baseUrl, apiKey }: { endpoint: Endpoint; baseUrl: string; apiKey: string }) {
  const [open, setOpen] = useState(false);
  const path = endpoint.path
    .replace('{id}', 'mailbox_id')
    .replace('{mid}', 'message_id');
  const curl = [
    `curl -X ${endpoint.method} "${baseUrl}${path}"`,
    `  -H "Authorization: Bearer ${apiKey || '<YOUR_API_KEY>'}"`,
    ...(endpoint.body ? [`  -H "Content-Type: application/json"`, `  -d '${endpoint.body.replace(/\s+/g, ' ')}'`] : []),
  ].join(' \\\n');

  return (
    <article className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm transition-shadow hover:shadow-md">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-start gap-3 p-4 text-left sm:p-5"
        aria-expanded={open}
      >
        <span className={`mt-0.5 min-w-[4.25rem] rounded-lg border px-2 py-1 text-center font-mono text-xs font-bold ${methodStyle[endpoint.method]}`}>
          {endpoint.method}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
            <code className="break-all text-sm font-bold text-slate-900">{endpoint.path}</code>
            <span className="text-sm font-medium text-slate-600">{endpoint.title}</span>
          </span>
          <span className="mt-1 block text-sm leading-6 text-slate-500">{endpoint.description}</span>
        </span>
        <ChevronDown className={`mt-1 h-5 w-5 flex-none text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="space-y-4 border-t border-slate-100 bg-slate-50/60 p-4 sm:p-5">
          {endpoint.params && (
            <div>
              <h3 className="mb-2 text-xs font-bold uppercase tracking-wider text-slate-500">查询参数</h3>
              <ul className="space-y-1.5 text-sm text-slate-600">
                {endpoint.params.map((param) => <li key={param}>• {param}</li>)}
              </ul>
            </div>
          )}
          {endpoint.notes && (
            <div className="flex gap-2 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-none" />
              <span>{endpoint.notes}</span>
            </div>
          )}
          {endpoint.body && <CodeBlock value={endpoint.body} label="请求体 JSON" />}
          <CodeBlock value={curl} label="cURL" />
          <CodeBlock value={endpoint.response} label="响应示例" />
        </div>
      )}
    </article>
  );
}

export const ApiDocs: React.FC = () => {
  const defaultBaseUrl = typeof window === 'undefined' ? 'http://localhost:8787' : window.location.origin;
  const [baseUrl, setBaseUrl] = useState(defaultBaseUrl);
  const [apiKey, setApiKey] = useState('');
  const [filter, setFilter] = useState<'ALL' | Method>('ALL');
  const normalizedBase = useMemo(() => baseUrl.trim().replace(/\/+$/, '') || defaultBaseUrl, [baseUrl, defaultBaseUrl]);
  const visible = filter === 'ALL' ? endpoints : endpoints.filter((endpoint) => endpoint.method === filter);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="flex items-center gap-2.5 text-2xl font-bold tracking-tight text-slate-900">
            <BookOpen className="h-7 w-7 text-indigo-600" />
            API 调用说明
          </h1>
          <p className="mt-1 max-w-3xl text-sm leading-6 text-slate-500">
            统一 API 的鉴权、端点和可复制示例。页面中的 Key 只在当前页面内存中使用，不会保存或发送。
          </p>
        </div>
        <div className="flex gap-2">
          <a href="/api/ui" target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-xl border border-slate-200 bg-white px-3.5 py-2.5 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50">
            Swagger UI <ExternalLink className="h-4 w-4" />
          </a>
          <a href="/api/doc" target="_blank" rel="noreferrer" className="inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-3.5 py-2.5 text-sm font-medium text-white shadow-sm hover:bg-indigo-700">
            OpenAPI JSON <Braces className="h-4 w-4" />
          </a>
        </div>
      </div>

      <section className="grid gap-4 lg:grid-cols-[1.15fr_0.85fr]">
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="mb-4 flex items-center gap-2 text-sm font-bold text-slate-900"><TerminalSquare className="h-5 w-5 text-indigo-600" />调用配置</div>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="space-y-1.5 text-xs font-semibold text-slate-600">
              服务地址
              <span className="relative block">
                <Server className="absolute left-3 top-3 h-4 w-4 text-slate-400" />
                <input value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} className="w-full rounded-xl border border-slate-200 py-2.5 pl-9 pr-3 font-mono text-sm text-slate-800 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100" />
              </span>
            </label>
            <label className="space-y-1.5 text-xs font-semibold text-slate-600">
              API Key（可选，仅生成示例）
              <span className="relative block">
                <KeyRound className="absolute left-3 top-3 h-4 w-4 text-slate-400" />
                <input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder="tmg_xxx..." autoComplete="off" className="w-full rounded-xl border border-slate-200 py-2.5 pl-9 pr-3 font-mono text-sm text-slate-800 outline-none focus:border-indigo-400 focus:ring-2 focus:ring-indigo-100" />
              </span>
            </label>
          </div>
        </div>
        <div className="rounded-2xl border border-indigo-100 bg-indigo-50/70 p-5">
          <div className="mb-3 flex items-center gap-2 text-sm font-bold text-indigo-950"><KeyRound className="h-5 w-5 text-indigo-600" />鉴权方式</div>
          <p className="text-sm leading-6 text-indigo-900/75">推荐使用 Bearer Token。也兼容裸 Authorization、X-API-Key、X-Admin-Auth 与 X-Gateway-Key。</p>
          <div className="mt-3 flex items-center justify-between rounded-xl border border-indigo-200 bg-white/80 px-3 py-2">
            <code className="min-w-0 truncate text-xs text-indigo-900">Authorization: Bearer {'<YOUR_API_KEY>'}</code>
            <CopyButton text="Authorization: Bearer <YOUR_API_KEY>" iconOnly />
          </div>
        </div>
      </section>

      <section className="space-y-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="flex items-center gap-2 text-lg font-bold text-slate-900"><ListFilter className="h-5 w-5 text-indigo-600" />统一 API 端点</h2>
            <p className="mt-0.5 text-xs text-slate-500">点击端点展开请求与响应示例；路径参数需替换为真实 ID。</p>
          </div>
          <div className="flex rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
            {(['ALL', 'GET', 'POST', 'DELETE'] as const).map((value) => (
              <button key={value} type="button" onClick={() => setFilter(value)} className={`rounded-lg px-3 py-1.5 text-xs font-bold transition-colors ${filter === value ? 'bg-slate-900 text-white' : 'text-slate-500 hover:bg-slate-50'}`}>
                {value === 'ALL' ? '全部' : value}
              </button>
            ))}
          </div>
        </div>
        <div className="space-y-3">
          {visible.map((endpoint) => <EndpointCard key={`${endpoint.method}-${endpoint.path}`} endpoint={endpoint} baseUrl={normalizedBase} apiKey={apiKey} />)}
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-sm font-bold text-slate-900">通用响应与状态码</h2>
        <div className="mt-3 grid gap-4 md:grid-cols-2">
          <CodeBlock value={`{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "无效的 API key",
    "details": {}
  }
}`} label="错误信封" />
          <div className="grid grid-cols-2 gap-2 text-sm">
            {[
              ['400', '参数或路由错误'], ['401', '凭证缺失或无效'], ['403', 'Key 白名单限制'],
              ['404', '资源不存在'], ['409', '地址冲突/操作受限'], ['410', '邮箱已过期'],
              ['429', '创建速率超限'], ['501', '上游能力不支持'], ['502', '上游服务错误'],
            ].map(([code, text]) => <div key={code} className="rounded-xl border border-slate-100 bg-slate-50 p-3"><span className="font-mono font-bold text-slate-900">{code}</span><div className="mt-1 text-xs text-slate-500">{text}</div></div>)}
          </div>
        </div>
      </section>
    </div>
  );
};
