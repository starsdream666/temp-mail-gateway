import assert from "node:assert/strict";
import { after, before, test, type TestContext } from "node:test";
import { resolve } from "node:path";
import { createElement } from "../frontend/node_modules/react/index.js";
import { act, create } from "../frontend/node_modules/react-test-renderer/index.js";
import { createServer } from "../frontend/node_modules/vite/dist/node/index.js";

// Load the real pages and API client through Vite, including import.meta.env.
// Only the HTTP transport and timers are replaced; hooks and events run normally.
let vite: Awaited<ReturnType<typeof createServer>>;
let Domains: any;
let Health: any;
let ToastProvider: any;
before(async () => {
  vite = await createServer({
    root: resolve("frontend"), configFile: false, envFile: false, logLevel: "silent",
    server: { middlewareMode: true, watch: null, hmr: false },
    esbuild: { jsx: "automatic" },
  });
  ({ Domains } = await vite.ssrLoadModule("/src/pages/Domains.tsx"));
  ({ Health } = await vite.ssrLoadModule("/src/pages/Health.tsx"));
  ({ ToastProvider } = await vite.ssrLoadModule("/src/components/Toast.tsx"));
});
after(async () => { await vite?.close(); });

async function mount(t: TestContext, Page: any, fetchFn: typeof fetch) {
  const oldWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  const timeouts = new Map<number, () => void>();
  const intervals = new Map<number, () => void>();
  let nextTimer = 0;
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    location: { origin: "http://gateway.test" },
    setTimeout: (callback: () => void) => { const id = ++nextTimer; timeouts.set(id, callback); return id; },
    clearTimeout: (id: number) => timeouts.delete(id),
  } });
  t.mock.method(globalThis, "fetch", fetchFn);
  t.mock.method(globalThis, "setInterval", (callback: () => void) => { const id = ++nextTimer; intervals.set(id, callback); return id; });
  t.mock.method(globalThis, "clearInterval", (id: number) => intervals.delete(id));
  let view: any;
  t.after(async () => {
    await act(async () => { view?.unmount(); });
    if (oldWindow) Object.defineProperty(globalThis, "window", oldWindow);
    else delete (globalThis as any).window;
  });
  await act(async () => { view = create(createElement(ToastProvider, null, createElement(Page))); });
  return { view, timeouts, intervals };
}

function text(node: any): string {
  if (typeof node === "string") return node;
  return (node.children ?? []).map(text).join("");
}

function seedDomains() {
  return [
    { upstreamId: "a", domain: "shared.test", enabled: true },
    { upstreamId: "a", domain: "paused.test", enabled: false },
    { upstreamId: "b", domain: "shared.test", enabled: true },
  ].map(row => ({ ...row, upstreamName: row.upstreamId, upstreamType: "dummy", upstreamEnabled: true, isPrivate: false }));
}

const buttons = (view: any, label: string) => view.root.findAll((node: any) => node.type === "button" && text(node) === label);
const domainSwitches = (view: any) => view.root.findAll((node: any) => node.type === "button" && node.props.role === "switch");

test("a failed channel batch preserves another channel's successful domain update", async (t) => {
  const domains = seedDomains();
  let failBatch!: (response: Response) => void;
  const delayed = new Promise<Response>(resolve => { failBatch = resolve; });
  const fetchFn: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path === "/admin/domains") return Response.json({ domains });
    if (path === "/admin/upstreams/a/domains") return delayed;
    assert.equal(path, "/admin/upstreams/b/domains/shared.test");
    domains[2]!.enabled = JSON.parse(String(init?.body)).enabled;
    return Response.json({ domain: domains[2] });
  };
  const { view } = await mount(t, Domains, fetchFn);
  let batch: Promise<void>;
  await act(async () => { batch = buttons(view, "全部停用建箱")[0].props.onClick(); });
  await act(async () => { await domainSwitches(view)[2].props.onClick(); });
  assert.equal(domains[2]!.enabled, false);
  await act(async () => {
    failBatch(Response.json({ error: { code: "INTERNAL", message: "batch failed" } }, { status: 500 }));
    await batch;
  });
  assert.deepEqual(domainSwitches(view).map((node: any) => node.props["aria-checked"]), [true, false, false]);
});

test("pending channel mutations lock overlapping actions until their own request finishes", async (t) => {
  const domains = seedDomains();
  let finishBatch!: (response: Response) => void;
  const delayed = new Promise<Response>(resolve => { finishBatch = resolve; });
  const fetchFn: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === "/admin/domains") return Response.json({ domains });
    if (path === "/admin/upstreams/a/domains") return delayed;
    assert.equal(path, "/admin/upstreams/b/domains/shared.test");
    return Response.json({ domain: { ...domains[2], enabled: false } });
  };
  const { view } = await mount(t, Domains, fetchFn);
  let batch: Promise<void>;
  await act(async () => { batch = buttons(view, "全部停用建箱")[0].props.onClick(); });
  try {
    assert(domainSwitches(view)[0].props.disabled);
    assert(domainSwitches(view)[1].props.disabled);
    assert(!domainSwitches(view)[2].props.disabled);
    assert(view.root.findByProps({ title: "刷新数据" }).props.disabled);
    await act(async () => { await domainSwitches(view)[2].props.onClick(); });
    assert(domainSwitches(view)[0].props.disabled, "finishing B must not unlock A");
  } finally {
    await act(async () => { finishBatch(Response.json({ affected: 2 })); await batch; });
  }
  assert(!domainSwitches(view)[0].props.disabled);
});

test("channel batch availability and affected counts use all domains under status filters", async (t) => {
  const { view } = await mount(t, Domains, async () => Response.json({ domains: seedDomains() }));
  const status = view.root.findByProps({ title: "按状态筛选" });
  await act(async () => { status.props.onChange({ target: { value: "enabled" } }); });
  assert.equal(domainSwitches(view).length, 2);
  assert.equal(buttons(view, "全部启用")[0].props.disabled, false);
  assert(text(view.root).includes("批量操作覆盖该渠道全部 2 个域名"));
  await act(async () => { status.props.onChange({ target: { value: "disabled" } }); });
  assert.equal(domainSwitches(view).length, 1);
  assert.equal(buttons(view, "全部停用建箱")[0].props.disabled, false);
});

test("health polling failures keep existing cards without toast-triggered requests", async (t) => {
  let calls = 0;
  const channel = {
    id: "a", name: "healthy-channel", type: "dummy", enabled: true, status: "up", domainCount: 2,
    lastCheckedAt: null, latencyMs: 1, uptimePct: 100, monitorIntervalMs: null, monitorDisabled: false,
    effectiveIntervalMs: 300000, autoSyncDomains: true, domainChange: null, pendingSync: null, lastError: null, timeline: [],
  };
  const { view, intervals, timeouts } = await mount(t, Health, async () => {
    calls++;
    return calls === 1 ? Response.json({ channels: [channel] })
      : Response.json({ error: { code: "INTERNAL", message: "temporary outage" } }, { status: 500 });
  });
  assert.equal(calls, 1);
  await act(async () => { for (const tick of [...intervals.values()]) tick(); });
  assert.equal(calls, 2, "toast insertion must not trigger another health fetch");
  assert(text(view.root).includes("healthy-channel"));
  assert(!text(view.root).includes("加载失败"));
  await act(async () => { for (const dismiss of [...timeouts.values()]) dismiss(); });
  assert.equal(calls, 2, "toast expiry must not trigger another health fetch");
  assert(text(view.root).includes("healthy-channel"));
});
