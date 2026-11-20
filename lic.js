/* 제어판 배선 — 사용 코드 확인 (로더 화면과 앱 화면이 함께 씀)
 * 서버: 구글 시트 + Apps Script (PLC 래더 시뮬레이터와 같은 서버, app=cpw)
 * 인증되면 서버가 (1) RSA 서명된 사용권 (2) 앱 복호화 키를 준다.
 * 복호화 키는 기기에 저장하지 않는다. 풀어낸 앱 파일만 캐시에 두고, 만료·정지되면 지운다. */
(function () {
  'use strict';
  const SERVER = 'https://script.google.com/macros/s/AKfycby61l4mRVok8UhZRRKJkIaVfITCQY_ZPjkzczNWk5319In6gVh_bY7APNa0wHI7CO9YpA/exec';
  const PUB_N = '4/fCnicpxeJjyAFkTlcqfJr3jC6qTb8fTSQn1Hb9xlbJA72xK+w8LQpioQIum5J9KqsYqMGNxWOKKf37aDsALAVMeeMMflwX35z8s6Ct1wO8jCwny45UxRA17s/mcJaHv83BseGcpuCJXe2t7VV2tcNOeCnkEiGB7lF/2ApgpTZ+uWa7fngJY98MWJKb3b0oWJsSP6G2fsDwL2jSX/twTZhVHwq8Oxedo9rQoARhaZGkFERK+wRTOHs68tGfx32BWef8pSNmKHc9SvURhZtNZAK4UXPkqtACJCPp4MmQU8/8iQfn3tjXSjZf/raTRvfHLAp2w6+wXkpoTLABsZldPw==';
  const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const LIC = 'cpw-lic', APP = 'cpw-app';
  const CLOCK_SLACK = 10 * 60 * 1000; // 시계를 이만큼 넘게 되돌리면 서버 확인이 필요
  const BASE = new URL('./', (document.currentScript && document.currentScript.src) || location.href);
  const LIC_URL = new URL('lic.json', BASE).href;
  const APP_INDEX = new URL('app/index.html', BASE).href;

  const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const b64u = s => s.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const normCode = s => String(s).toUpperCase().split('').filter(c => ALPHA.indexOf(c) >= 0).join('');

  async function readLic() {
    try {
      const r = await (await caches.open(LIC)).match(LIC_URL);
      return r ? await r.json() : null;
    } catch (_) { return null; }
  }
  async function writeLic(o) {
    const c = await caches.open(LIC);
    await c.put(LIC_URL, new Response(JSON.stringify(o), { headers: { 'content-type': 'application/json' } }));
  }
  async function wipe() {
    try { await caches.delete(APP); } catch (_) {}
    try { await caches.delete(LIC); } catch (_) {}
  }
  async function hasApp() {
    try { return !!(await (await caches.open(APP)).match(APP_INDEX)); } catch (_) { return false; }
  }

  async function getDev() {
    let d = null;
    try { d = localStorage.getItem('cpw.dev'); } catch (_) {}
    if (!d || d.length !== 10) { const l = await readLic(); d = l && l.dev; }
    if (!d || d.length !== 10) {
      const r = crypto.getRandomValues(new Uint8Array(10));
      d = Array.from(r).map(x => ALPHA[x & 31]).join('');
    }
    try { localStorage.setItem('cpw.dev', d); } catch (_) {}
    return d;
  }

  let pub = null;
  function pubKey() {
    return pub || (pub = crypto.subtle.importKey('jwk', { kty: 'RSA', n: b64u(PUB_N), e: 'AQAB', alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
  }
  async function verify(payload, sig) {
    try { return await crypto.subtle.verify('RSASSA-PKCS1-v1_5', await pubKey(), b64(sig), new TextEncoder().encode(payload)); }
    catch (_) { return false; }
  }
  function parse(payload) {
    const p = String(payload).split('|');
    return { v: p[0], code: p[1], dev: p[2], exp: +p[3], chk: +p[4], iss: +p[5] };
  }

  // 지금 기기의 사용권 상태: none | expired | clock | recheck | ok
  async function status() {
    const dev = await getDev();
    const lic = await readLic();
    const now = Date.now();
    if (!lic || !lic.payload || !(await verify(lic.payload, lic.sig))) return { s: 'none', dev };
    const p = parse(lic.payload);
    if (p.v !== 'v1' || p.dev !== dev) return { s: 'none', dev };
    if (now >= p.exp) return { s: 'expired', p, dev, lic };
    if (now < (lic.seen || 0) - CLOCK_SLACK) return { s: 'clock', p, dev, lic };
    if (now >= p.chk) return { s: 'recheck', p, dev, lic };
    return { s: 'ok', p, dev, lic };
  }

  // 서버에 묻기. 실패 이유: code stopped otherpc expired busy server network
  async function ask(code, dev) {
    let j;
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 20000);
      const r = await fetch(SERVER + '?app=cpw&code=' + encodeURIComponent(code) + '&pc=' + encodeURIComponent(dev), { cache: 'no-store', signal: ctl.signal });
      clearTimeout(t);
      j = await r.json();
    } catch (_) { return { ok: false, err: 'network' }; }
    if (!j || !j.ok) return { ok: false, err: (j && j.err) || 'server' };
    if (!j.key || !(await verify(j.payload, j.sig))) return { ok: false, err: 'server' };
    const p = parse(j.payload);
    if (p.dev !== dev || p.code !== code) return { ok: false, err: 'server' };
    return j;
  }

  async function remoteVer() {
    const r = await fetch(new URL('enc/version.json', BASE), { cache: 'no-store' });
    return (await r.json()).v;
  }

  // 암호화된 앱 묶음을 받아 풀어서 캐시에 넣는다 (복호화는 메모리에서만, 키는 남기지 않음)
  async function installApp(key, ver) {
    const buf = await (await fetch(new URL('enc/app.bin', BASE) + '?v=' + encodeURIComponent(ver), { cache: 'no-store' })).arrayBuffer();
    const k = await crypto.subtle.importKey('raw', b64(key), 'AES-GCM', false, ['decrypt']);
    const plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: new Uint8Array(buf, 0, 12) }, k, new Uint8Array(buf, 12)));
    const hl = new DataView(plain.buffer, plain.byteOffset).getUint32(0, true);
    const head = JSON.parse(new TextDecoder().decode(plain.subarray(4, 4 + hl)));
    let off = 4 + hl;
    const parts = [];
    for (const f of head.files) { parts.push([f, plain.slice(off, off + f.s)]); off += f.s; }
    const c = await caches.open(APP);
    for (const [f, data] of parts) {
      await c.put(new URL('app/' + f.n, BASE).href, new Response(data, { headers: { 'content-type': f.t } }));
    }
  }

  // 서버가 허락한 뒤: 필요하면 앱을 내려받고 사용권을 저장
  async function accept(r, dev) {
    const old = await readLic();
    const ver = await remoteVer();
    if (!(old && old.ver === ver && (await hasApp()))) await installApp(r.key, ver);
    await writeLic({ payload: r.payload, sig: r.sig, dev: dev, seen: Date.now(), ver: ver });
  }

  async function refresh(st) {
    const r = await ask(st.p.code, st.dev);
    if (r.ok) {
      try { await accept(r, st.dev); } catch (_) { return { a: 'offline', err: 'network' }; }
      return { a: 'go' };
    }
    if (r.err === 'network' || r.err === 'busy' || r.err === 'server') return { a: 'offline', err: r.err };
    await wipe();
    return { a: 'form', err: r.err };
  }

  // 로더 화면이 켜질 때: 바로 들어갈지 / 코드 입력 / 인터넷 필요
  async function boot() {
    const st = await status();
    if (st.s === 'ok') {
      if (await hasApp()) {
        st.lic.seen = Math.max(st.lic.seen || 0, Date.now());
        try { await writeLic(st.lic); } catch (_) {}
        return { a: 'go' };
      }
      return refresh(st);
    }
    if (st.s === 'recheck' || st.s === 'clock') return refresh(st);
    if (st.s === 'expired') { await wipe(); return { a: 'form', err: 'expired' }; }
    return { a: 'form' };
  }

  // 코드 입력 [확인]
  async function activate(input) {
    const code = normCode(input);
    if (code.length !== 12) return { ok: false, err: 'code' };
    const dev = await getDev();
    const r = await ask(code, dev);
    if (!r.ok) return r;
    try { await accept(r, dev); } catch (_) { return { ok: false, err: 'install' }; }
    return { ok: true };
  }

  // 앱 화면에서: 켤 때마다 뒤에서 서버에 다시 확인 (연장·정지 반영, 새 버전 받기)
  async function guard() {
    try {
      const st = await status();
      if (st.s === 'none' || st.s === 'expired') {
        await wipe();
        if (st.s === 'expired') { try { localStorage.setItem('cpw.msg', 'expired'); } catch (_) {} }
        location.replace(BASE.href);
        return;
      }
      if (st.s === 'clock' || st.s === 'recheck') {
        const r = await refresh(st);
        if (r.a !== 'go') location.replace(BASE.href);
        return;
      }
      const r = await ask(st.p.code, st.dev);
      if (r.ok) {
        const ver = await remoteVer().catch(() => st.lic.ver);
        let now = st.lic.ver;
        if (ver !== st.lic.ver) { try { await installApp(r.key, ver); now = ver; } catch (_) {} }
        await writeLic({ payload: r.payload, sig: r.sig, dev: st.dev, seen: Date.now(), ver: now });
      } else if (r.err !== 'network' && r.err !== 'busy' && r.err !== 'server') {
        await wipe();
        try { localStorage.setItem('cpw.msg', r.err); } catch (_) {}
        location.replace(BASE.href);
      }
    } catch (_) { /* 확인을 못 해도 앱은 계속 쓴다 (기한은 다음 실행 때 다시 본다) */ }
  }

  // 앱 화면에서 쫓겨났을 때 남겨 둔 이유를 한 번만 꺼낸다
  function takeMsg() {
    try { const m = localStorage.getItem('cpw.msg'); localStorage.removeItem('cpw.msg'); return m || null; } catch (_) { return null; }
  }

  window.CPW = { boot, activate, guard, getDev, takeMsg, base: BASE.href };
})();
