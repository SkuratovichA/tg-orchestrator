// Minimal CDP driver over Node 22's built-in WebSocket. No deps.
const PORT = process.env.CDP_PORT || 9222;
const base = `http://127.0.0.1:${PORT}`;

async function browserWs() {
  const v = await (await fetch(`${base}/json/version`)).json();
  return v.webSocketDebuggerUrl;
}

function conn(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  const ready = new Promise((res, rej) => { ws.onopen = () => res(); ws.onerror = (e) => rej(new Error('ws error')); });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
  };
  const send = async (method, params = {}, sessionId) => {
    await ready;
    const mid = ++id;
    return new Promise((res, rej) => { pending.set(mid, { res, rej }); ws.send(JSON.stringify({ id: mid, method, params, sessionId })); });
  };
  return { send, close: () => ws.close(), ready };
}

const [cmd, ...rest] = process.argv.slice(2);
const c = conn(await browserWs());

async function attach(targetId) {
  const { sessionId } = await c.send('Target.attachToTarget', { targetId, flatten: true });
  return sessionId;
}

try {
  if (cmd === 'targets') {
    const { targetInfos } = await c.send('Target.getTargets');
    for (const t of targetInfos) if (t.type === 'page') console.log([t.targetId, t.browserContextId, t.url.slice(0, 90)].join(' | '));
  } else if (cmd === 'contexts') {
    const { targetInfos } = await c.send('Target.getTargets');
    const byCtx = new Map();
    for (const t of targetInfos) { if (t.type !== 'page') continue; if (!byCtx.has(t.browserContextId)) byCtx.set(t.browserContextId, []); byCtx.get(t.browserContextId).push(t.url.slice(0, 60)); }
    for (const [k, v] of byCtx) console.log(k, '->', v.length, 'pages |', v.slice(0, 3).join(' , '));
  } else if (cmd === 'newtab') {
    const [browserContextId, url] = rest;
    const { targetId } = await c.send('Target.createTarget', { url: url || 'about:blank', browserContextId, background: true });
    console.log(targetId);
  } else if (cmd === 'nav') {
    const [targetId, url] = rest;
    const s = await attach(targetId);
    await c.send('Page.enable', {}, s);
    await c.send('Page.navigate', { url }, s);
    await new Promise((r) => setTimeout(r, 3500));
    const { result } = await c.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }, s);
    console.log(result.value);
  } else if (cmd === 'eval') {
    const [targetId] = rest;
    const expr = rest.slice(1).join(' ');
    const s = await attach(targetId);
    const { result, exceptionDetails } = await c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, s);
    if (exceptionDetails) console.log('EXC:', JSON.stringify(exceptionDetails.exception?.description || exceptionDetails.text).slice(0, 400));
    else console.log(typeof result.value === 'string' ? result.value : JSON.stringify(result.value));
  } else if (cmd === 'close') {
    await c.send('Target.closeTarget', { targetId: rest[0] });
    console.log('closed');
  } else console.log('usage: targets|contexts|newtab <ctx> <url>|nav <tid> <url>|eval <tid> <js>|close <tid>');
} finally { c.close(); }
