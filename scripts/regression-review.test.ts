import { test } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { resolve } from "node:path";
import { createDrizzleStores } from "../src/adapters/stores/drizzle/index";
import { createWebCryptoCipher } from "../src/adapters/crypto/webcrypto";
import { buildDeps } from "../src/bootstrap";
import { createApp } from "../src/core/app";
import { runMigrations } from "../src/db/migrate-node";
import { createUpstreamFetch, readBoundedText } from "../src/core/upstream-fetch";
import { runHealthChecks } from "../src/core/monitor";
import { MoeMailAdapter } from "../src/adapters/upstreams/moemail/index";

const json = (value: unknown, status = 200) => Response.json(value, { status });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(fetchFn: typeof fetch) {
  const sqlite = new Database(":memory:");
  runMigrations(sqlite, resolve("migrations"));
  const stores = createDrizzleStores(drizzle(sqlite) as never);
  const cipher = createWebCryptoCipher("regression-only-master-key");
  const deps = buildDeps({ stores, crypto: cipher, fetchFn, config: { masterKey: "regression-only-master-key", adminPassword: "regression-password" } });
  const app = createApp(deps);
  const login = await app.request("/admin/session", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({password:"regression-password"})});
  const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  const admin = (path: string, method = "GET", body?: unknown) => app.request(path, {method,headers:{Cookie:cookie,"Content-Type":"application/json"},body:body === undefined ? undefined : JSON.stringify(body)});
  const { key } = await (await admin("/admin/keys","POST",{name:"regression"})).json() as any;
  const headers = { "X-Gateway-Key": key.key as string, "Content-Type":"application/json" };
  const upstream = async (type: string, baseUrl: string) => {
    const res = await admin("/admin/upstreams","POST",{name:baseUrl,type,baseUrl,apiKey:"channel-secret"});
    assert.equal(res.status,201);
    return (await res.json() as any).upstream.id as string;
  };
  return {sqlite,stores,cipher,deps,app,admin,headers,cookie,upstream};
}

function duckMock() {
  const paths: string[] = [];
  let account: {id:string;address:string;password:string;token:string} | undefined;
  const fetchFn:typeof fetch = async (input,init) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? "GET";
    paths.push(path);
    const requestBody = init?.body instanceof ArrayBuffer ? new TextDecoder().decode(init.body) : String(init?.body ?? "{}");
    if (path === "/domains") return json({"hydra:member":[{domain:"duck.test"}],"hydra:totalItems":1});
    if (path === "/accounts" && method === "POST") {
      const req = JSON.parse(requestBody);
      account = {id:"duck-account",address:req.address,password:req.password,token:"mailbox-token-1"};
      return json({id:account.id,address:account.address},201);
    }
    if (path === "/token") {
      const req = JSON.parse(requestBody);
      return account?.password === req.password && account.address === req.address
        ? json({id:account.id,token:account.token}) : json({error:"invalid password"},401);
    }
    const authorized = !!account && new Headers(init?.headers).get("Authorization") === `Bearer ${account.token}`;
    if (!authorized) return json({error:"invalid mailbox token"},401);
    if (path === "/accounts/duck-account" && method === "DELETE") {
      account = undefined;
      return new Response(null,{status:204});
    }
    if (path === "/messages") return json({"hydra:member":[],"hydra:totalItems":0});
    return json({error:"not found"},404);
  };
  return {fetchFn,paths,rotate:() => {account!.token = "mailbox-token-2";},exists:() => !!account};
}

test("DuckMail native credentials survive registration; gateway and mailbox auth coexist", async () => {
  const mock = duckMock(); const f = await fixture(mock.fetchFn);
  try {
    await f.upstream("duckmail","https://older-duck.test");
    const id = await f.upstream("duckmail","https://duck.test");
    const account = {address:"native@duck.test",password:"mailbox-password"};
    const created = await f.app.request(`/upstream/${id}/accounts`,{method:"POST",headers:f.headers,body:JSON.stringify(account)});
    assert.equal(created.status,201); await created.text();
    let stored = await f.stores.mailboxes.findByAddress(account.address);
    assert(stored?.passwordEnc); assert.equal(await f.cipher.decrypt(stored.passwordEnc),account.password);
    // Disabling domain creation must not prevent logging into an existing mailbox.
    await f.stores.upstreams.setAllDomainsEnabled(id,false);
    const tokenRes = await f.app.request("/upstream/duckmail/token",{method:"POST",headers:f.headers,body:JSON.stringify(account)});
    assert.equal(tokenRes.status,200);
    assert.equal(tokenRes.headers.get("X-Gateway-Upstream-Id"),id);
    const {token} = await tokenRes.json() as any;
    stored = await f.stores.mailboxes.get(stored.id);
    assert.equal(await f.cipher.decrypt(stored!.credentialsEnc!),token);
    for (const headers of [
      {...f.headers,Authorization:`Bearer ${token}`},
      {Cookie:f.cookie,Authorization:`Bearer ${token}`},
    ]) {
      const res = await f.app.request(`/upstream/${id}/messages`,{headers});
      assert.equal(res.status,200); await res.text();
    }
    const noGateway = await f.app.request(`/upstream/${id}/messages`,{headers:{Authorization:`Bearer ${token}`}});
    assert.equal(noGateway.status,401); await noGateway.text();
    const unified = await f.app.request(`/v1/mailboxes/${stored!.id}/messages`,{headers:f.headers});
    assert.equal(unified.status,200); await unified.text();
    const deleted = await f.app.request(`/v1/mailboxes/${stored!.id}`,{method:"DELETE",headers:f.headers});
    assert.equal(deleted.status,204); assert.equal(mock.exists(),false);
  } finally {f.sqlite.close();}
});

test("DuckMail missing credentials never turns a failed deletion into success", async () => {
  const mock = duckMock(); const f = await fixture(mock.fetchFn);
  try {
    const id = await f.upstream("duckmail","https://duck.test");
    const mailbox = await f.stores.mailboxes.create({id:"legacy",upstreamId:id,address:"legacy@duck.test",localPart:"legacy",domain:"duck.test",upstreamMailboxId:"legacy",credentialsEnc:null,passwordEnc:null,apiKeyId:null,expiresAt:null});
    for (const [suffix,status] of [["",501],["?force=1",409]] as const) {
      const res = await f.app.request(`/v1/mailboxes/${mailbox.id}${suffix}`,{method:"DELETE",headers:f.headers});
      assert.equal(res.status,status); await res.text();
      assert(await f.stores.mailboxes.get(mailbox.id));
    }
  } finally {f.sqlite.close();}
});

test("a refreshed DuckMail token is reused by subsequent API requests", async () => {
  const mock = duckMock(); const f = await fixture(mock.fetchFn);
  try {
    await f.upstream("duckmail","https://duck.test");
    const created = await f.app.request("/v1/mailboxes",{method:"POST",headers:f.headers,body:JSON.stringify({domain:"duck.test",localPart:"rotated"})});
    assert.equal(created.status,201);
    const {mailbox} = await created.json() as any;
    mock.rotate(); mock.paths.length=0;
    for (let i=0;i<2;i++) {
      const res = await f.app.request(`/v1/mailboxes/${mailbox.id}/messages`,{headers:f.headers});
      assert.equal(res.status,200); await res.text();
    }
    assert.deepEqual(mock.paths,["/messages","/token","/messages","/messages"]);
    const row = await f.stores.mailboxes.get(mailbox.id);
    assert.equal(await f.cipher.decrypt(row!.credentialsEnc!),"mailbox-token-2");
  } finally {f.sqlite.close();}
});

test("shared-domain reads use the mailbox owner, including when its domain is disabled", async () => {
  const calls:string[]=[];
  const fetchFn:typeof fetch = async input => {
    const u = new URL(String(input)); calls.push(u.hostname);
    return u.pathname === "/open_api/settings" ? json({domains:["shared.test"]}) : json({results:[u.hostname]});
  };
  const f=await fixture(fetchFn);
  try {
    const a=await f.upstream("cf-temp-email","https://a.test");
    const b=await f.upstream("cf-temp-email","https://b.test");
    await f.stores.mailboxes.create({id:"owned",upstreamId:b,address:"owner@shared.test",localPart:"owner",domain:"shared.test",upstreamMailboxId:"owner@shared.test",credentialsEnc:null,passwordEnc:null,apiKeyId:null,expiresAt:null});
    await f.stores.upstreams.setAllDomainsEnabled(b,false); calls.length=0;
    const res=await f.app.request("/upstream/cf-temp-email/admin/mails?address=owner@shared.test",{headers:f.headers});
    assert.equal(res.status,200); assert.equal(res.headers.get("X-Gateway-Upstream-Id"),b);
    assert.deepEqual(await res.json(),{results:["b.test"]}); assert.deepEqual(calls,["b.test"]);
    await f.stores.upstreams.update(b,{enabled:false}); calls.length=0;
    const disabled=await f.app.request("/upstream/cf-temp-email/admin/mails?address=owner@shared.test",{headers:f.headers});
    assert.equal(disabled.status,400); await disabled.text(); assert.deepEqual(calls,[]);
    assert.notEqual(a,b);
  } finally {f.sqlite.close();}
});

test("multi-instance cursor pagination returns every row once and preserves totals", async () => {
  const counts:Record<string,number>={"a.test":25,"b.test":45};
  let fail=false;
  const calls:string[]=[];
  const fetchFn:typeof fetch=async input => {
    const u=new URL(String(input));
    if(u.pathname==="/api/config") return json({emailDomains:`${u.hostname}.mail`});
    calls.push(u.toString());
    if(fail && u.hostname==="b.test") return json({error:"temporary failure"},503);
    const cursor=u.searchParams.get("cursor");
    const start=cursor?Number(cursor.split(":")[1]):0;
    if(cursor && !cursor.startsWith(`${u.hostname}:`)) return json({error:"wrong cursor"},400);
    const total=counts[u.hostname]!;
    const end=Math.min(start+20,total);
    return json({emails:Array.from({length:end-start},(_,i)=>({id:`${u.hostname}-${start+i}`,address:`u${start+i}@${u.hostname}.mail`})),total,nextCursor:end<total?`${u.hostname}:${end}`:null});
  };
  const f=await fixture(fetchFn);
  try {
    const a=await f.upstream("moemail","https://a.test");
    await f.upstream("moemail","https://b.test");
    const seen=new Set<string>(); let cursor:string|null=null; let page=0;
    do {
      const suffix=cursor?`?cursor=${encodeURIComponent(cursor)}`:"";
      if(page===1) {
        fail=true;
        const failed=await f.app.request(`/upstream/moemail/api/emails${suffix}`,{headers:f.headers});
        assert.equal(failed.status,502); await failed.text(); fail=false;
        const wrongScope=await f.app.request(`/upstream/moemail/api/emails${suffix}&limit=3`,{headers:f.headers});
        assert.equal(wrongScope.status,400); await wrongScope.text();
      }
      calls.length=0;
      const res=await f.app.request(`/upstream/moemail/api/emails${suffix}`,{headers:f.headers});
      assert.equal(res.status,200);
      const data=await res.json() as any;
      assert.equal(data.total,70);
      for(const email of data.emails) {assert(!seen.has(email.id));seen.add(email.id);}
      if(page===2) assert(calls.every(url=>url.startsWith("https://b.test")),"exhausted A must not restart");
      cursor=data.nextCursor; page++;
      assert(page<=3);
    } while(cursor);
    assert.equal(seen.size,70); assert.equal(page,3);
    const malformed=await f.app.request("/upstream/moemail/api/emails?cursor=invalid",{headers:f.headers});
    assert.equal(malformed.status,400); await malformed.text();
    const raw=await f.app.request(`/upstream/${a}/api/emails?cursor=a.test:20`,{headers:f.headers});
    assert.equal(raw.status,200); assert.equal((await raw.json() as any).emails.length,5);
  } finally {f.sqlite.close();}
});

test("unrelated JSON is streamed without querying the full domain registry", async () => {
  let finish!:()=>void;
  const stream=new ReadableStream<Uint8Array>({start(c){c.enqueue(new TextEncoder().encode('{"message":"'));finish=()=>{c.enqueue(new TextEncoder().encode('hello"}'));c.close();};}});
  const f=await fixture(async input=>new URL(String(input)).pathname==="/api/config"?json({emailDomains:"mail.test"}):new Response(stream,{headers:{"Content-Type":"application/json"}}));
  try {
    const id=await f.upstream("moemail","https://stream.test");
    let domainReads=0;
    f.stores.upstreams.listActiveDomains=async()=>{domainReads++;return [];};
    const request=f.app.request(`/upstream/${id}/api/emails/box/message`,{headers:f.headers});
    const early=await Promise.race([request,sleep(100).then(()=>null)]);
    finish();
    assert(early,"response headers should arrive before the body finishes");
    assert.deepEqual(await early.json(),{message:"hello"}); assert.equal(domainReads,0);
  } finally {f.sqlite.close();}
});

test("buffered endpoints enforce a byte limit and cancel oversized upstream bodies", async () => {
  let cancelled=false;
  const res=new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array(32));},cancel(){cancelled=true;}}));
  await assert.rejects(readBoundedText(res,16),/上限/); assert(cancelled);
  const f=await fixture(async input=>new URL(String(input)).pathname==="/api/config"
    ? json({emailDomains:"mail.test"}) : new Response("x".repeat(4*1024*1024+1),{headers:{"Content-Type":"application/json"}}));
  try {
    const id=await f.upstream("moemail","https://oversized.test");
    const response=await f.app.request(`/upstream/${id}/api/emails`,{headers:f.headers});
    assert.equal(response.status,502);
    assert.equal((await response.json() as any).error.code,"UPSTREAM_ERROR");
  } finally {f.sqlite.close();}
});

test("upstream deadlines cover headers, stalled bodies, and ignore-signal transports", async () => {
  let signal:AbortSignal|null|undefined;
  const hanging=createUpstreamFetch(async(_input,init)=>{signal=init?.signal;return new Promise(()=>{});},25);
  await assert.rejects(hanging("https://hang.test"),/时限/); assert(signal?.aborted);
  let cancelled=false;
  const body=createUpstreamFetch(async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array([65]));},cancel(){cancelled=true;}})),25);
  const res=await body("https://body.test");
  await assert.rejects(res.text(),/时限/); assert(cancelled);
  let resolveLate!:(value:Response)=>void;
  let lateCancelled=false;
  const late=createUpstreamFetch(async()=>new Promise<Response>(resolve=>{resolveLate=resolve;}),15)("https://late.test");
  await assert.rejects(late,/时限/);
  resolveLate(new Response(new ReadableStream({cancel(){lateCancelled=true;}})));
  await sleep(0); assert(lateCancelled,"a late response must be cancelled after timeout");
});

test("client cancellation propagates both before headers and while streaming", async () => {
  const parent=new AbortController(); let signal:AbortSignal|null|undefined;
  const pending=createUpstreamFetch(async(_i,init)=>{signal=init?.signal;return new Promise(()=>{});},1000)("https://cancel.test",{signal:parent.signal});
  parent.abort(new Error("client closed"));
  await assert.rejects(pending,/client closed/); assert(signal?.aborted);
  let cancelled=false;
  const response=await createUpstreamFetch(async()=>new Response(new ReadableStream({cancel(){cancelled=true;}})),1000)("https://stream.test");
  await response.body!.cancel(); assert(cancelled);
});

test("health probes make progress past a stalled channel and record its timeout", async () => {
  let stalled=false; let slowAborted=false; const called:string[]=[];
  const fetchFn:typeof fetch=async (input,init)=>{
    const host=new URL(String(input)).hostname;
    if(stalled) {
      called.push(host);
      if(host==="a.test") {init?.signal?.addEventListener("abort",()=>{slowAborted=true;});return new Promise(()=>{});}
      assert.equal(slowAborted,false,"healthy channel should run before the slow channel times out");
    }
    return json({emailDomains:`${host}.mail`});
  };
  const f=await fixture(fetchFn);
  try {
    await f.upstream("moemail","https://a.test"); await f.upstream("moemail","https://b.test");
    f.deps.registry.register(new MoeMailAdapter({fetchFn,timeoutMs:30}),{displayName:"MoeMail",description:"regression"});
    stalled=true;
    const results=await runHealthChecks({upstreams:f.stores.upstreams,health:f.stores.health,registry:f.deps.registry,crypto:f.cipher});
    assert.equal(results.find(r=>r.upstreamName.includes("a.test"))!.status,"down");
    assert.equal(results.find(r=>r.upstreamName.includes("b.test"))!.status,"up");
    assert.deepEqual(new Set(called),new Set(["a.test","b.test"]));
  } finally {f.sqlite.close();}
});

test("per-key list/count use the new index, including shared and expiry filters", async () => {
  const f=await fixture(async()=>json({}));
  try {
    for(const query of [
      "SELECT * FROM mailboxes WHERE api_key_id='key' ORDER BY created_at DESC LIMIT 20",
      "SELECT count(*) FROM mailboxes WHERE api_key_id='key'",
      "SELECT count(*) FROM mailboxes WHERE (api_key_id='key' OR api_key_id IS NULL) AND (expires_at IS NULL OR expires_at>100)",
    ]) {
      const plan=f.sqlite.prepare(`EXPLAIN QUERY PLAN ${query}`).all() as {detail:string}[];
      assert(plan.some(r=>r.detail.includes("mailboxes_key_created_idx")),JSON.stringify(plan));
    }
    runMigrations(f.sqlite,resolve("migrations")); // upgrade remains idempotent
  } finally {f.sqlite.close();}
});
