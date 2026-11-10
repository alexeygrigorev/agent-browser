import { randomBytes, createHash, X509Certificate } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createRemoteJWKSet, jwtVerify } from 'jose';

export const secret = () => randomBytes(32).toString('base64url');
export const hash = value => createHash('sha256').update(value).digest('hex');
export const escape = value => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
export const deviceName = value => typeof value === 'string' && /^[a-z][a-z0-9_-]{0,31}$/.test(value);
const cookie = (name, value, age) => `${name}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;
const cookieValue = (req, name) => (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith(`${name}=`))?.slice(name.length + 1);
export const fail = (status, message) => Object.assign(new Error(message), { status });
export async function jsonBody(req, limit = 16384) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw fail(413, 'Request too large'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { throw fail(400, 'Invalid JSON'); }
}
export function json(res, status, body) { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); }
export function page(res, title, body) {
  // Basic form POSTs under no-referrer may send Origin:null. Keep the real
  // origin for same-origin CSRF checks without sending referrers off-site.
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'referrer-policy': 'same-origin',
    'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'", 'x-content-type-options': 'nosniff' });
  res.end(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${escape(title)} · DTC Tools</title><style>body{font:17px/1.55 system-ui;color:#18332e;background:#f3f4ef;max-width:720px;margin:8vh auto;padding:24px}main{background:white;border:1px solid #ccd5ce;padding:36px;border-radius:12px}h1{font-size:30px;line-height:1.2}a{color:#126347}button{font:inherit;padding:10px 20px;background:#126347;color:white;border:0;border-radius:5px;cursor:pointer}button[name=deny]{background:#6b3838}input{font:inherit;padding:9px;max-width:90%}code{font-size:22px}small{color:#52645b}</style><main><small>DataTalks.Club · Tools</small><h1>${escape(title)}</h1>${body}</main></html>`);
}

export async function createAuth({ file, origin, clientId, gate, issuer = 'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_H7nJu52Bs', authBase = 'https://auth.dtcdev.click', verifyIdentity, now = Date.now, audit = () => {} }) {
  if (!clientId || !file || new URL(origin).protocol !== 'https:') throw new Error('Tools server requires HTTPS origin, client ID and private state file');
  const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  const verify = verifyIdentity || (async (token, nonce) => {
    const { payload } = await jwtVerify(token, jwks, { issuer, audience: clientId, algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'sub', 'nonce', 'email', 'email_verified'] });
    if (payload.token_use !== 'id' || payload.nonce !== nonce) throw fail(401, 'Invalid identity');
    return payload;
  });
  let state;
  try { state = JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; state = { sessions: {}, credentials: {}, devices: {}, transactions: {} }; }
  state.grants ||= {}; state.proofs ||= {}; state.phoneRequests ||= {};
  for (const [id, item] of Object.entries(state.credentials)) if (item.role === 'controller' && !item.grantId) delete state.credentials[id];
  let queue = Promise.resolve();
  function save() {
    queue = queue.catch(() => {}).then(async () => {
      await mkdir(dirname(file), { recursive: true, mode: 0o700 });
      const temp = `${file}.${process.pid}.tmp`;
      await writeFile(temp, JSON.stringify(state), { mode: 0o600 }); await rename(temp, file);
    });
    return queue;
  }
  function prune() {
    for (const bucket of Object.values(state)) for (const [key, item] of Object.entries(bucket)) if (item.expires <= now()) delete bucket[key];
  }
  function credential(req) {
    const raw = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.authorization || '')?.[1];
    const item = raw && state.credentials[hash(raw)];
    return item && item.expires > now() && (item.role !== 'controller' || item.grantId && state.grants[item.grantId]?.expires > now()) ? { ...item, key: hash(raw) } : null;
  }
  function session(req) {
    const raw = cookieValue(req, '__Host-tools-session');
    const item = raw && state.sessions[hash(raw)];
    return item && item.expires > now() ? item : null;
  }
  function principal(req, role = 'controller') {
    const item = credential(req);
    if (!item || item.role !== role || !item.tools.includes('browser')) throw fail(401, 'Run auth login for this role');
    return item;
  }
  function csrf(req, s, value) { if (req.headers.origin !== origin || value !== s.csrf) throw fail(403, 'Invalid approval request'); }
  function revoke(key, onRevoke) {
    const parent = state.credentials[key]?.grantId || key;
    delete state.grants[parent]; delete state.credentials[key]; onRevoke(key);
    for (const [id, c] of Object.entries(state.credentials)) if (c.grantId === parent) { delete state.credentials[id]; onRevoke(id); }
  }
  const rates = new Map();
  function rate(req, limit = 30, kind = 'start') {
    const ip = `${kind}:${req.headers['x-forwarded-for'] || req.socket.remoteAddress}`;
    const time = now();
    for (const [key, value] of rates) if (value.until < time) rates.delete(key);
    const item = rates.get(ip) || { count: 0, until: time + 900000 };
    if (rates.size > 5000 || ++item.count > limit) throw fail(429, 'Too many login requests');
    rates.set(ip, item);
  }
  async function handle(req, res, url, onRevoke = () => {}) {
    const path = url.pathname;
    if (!path.startsWith('/auth/') && !path.startsWith('/api/auth/') && path !== '/device' && path !== '/approve') return false;
    if (req.method === 'GET' && path === '/auth/login') {
      prune(); rate(req);
      const tx = secret(), binding = secret(), verifier = secret(), nonce = secret();
      const code = url.searchParams.get('code') || '';
      const approve = url.searchParams.get('approve') || '';
      state.transactions[hash(tx)] = { binding: hash(binding), verifier, nonce, code: /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code) ? code : '', approve: /^[a-f0-9-]{6,36}$/i.test(approve) ? approve : '', expires: now() + 600000 };
      await save();
      const target = new URL(`${authBase}/oauth2/authorize`);
      target.search = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: `${origin}/auth/callback`, scope: 'openid email profile', identity_provider: 'Google', state: tx, nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') }).toString();
      res.writeHead(303, { location: target.href, 'set-cookie': cookie('__Host-tools-tx', binding, 600), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); res.end(); return true;
    }
    if (req.method === 'GET' && path === '/auth/callback') {
      rate(req, 120, 'callback');
      const txKey = hash(url.searchParams.get('state') || ''); const tx = state.transactions[txKey];
      try {
        if (!tx || tx.expires <= now() || tx.binding !== hash(cookieValue(req, '__Host-tools-tx') || '') || !url.searchParams.get('code')) throw fail(401, 'Invalid login transaction');
        // Reject unsolicited callbacks without disk writes or consuming another
        // browser's transaction. Consume a valid, bound code exchange only once.
        delete state.transactions[txKey]; await save();
        const response = await fetch(`${authBase}/oauth2/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', client_id: clientId, code: url.searchParams.get('code'), redirect_uri: `${origin}/auth/callback`, code_verifier: tx.verifier }), signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw fail(401, 'Identity exchange failed');
        const result = await response.json(); const identity = await verify(result.id_token, tx.nonce);
        const email = String(identity.email || '').toLowerCase();
        if (!identity.sub || !email.endsWith('@datatalks.club') || ![true, 'true'].includes(identity.email_verified)) throw fail(403, 'Verified DataTalks.Club account required');
        const raw = secret(); state.sessions[hash(raw)] = { owner: identity.sub, email, csrf: secret(), expires: now() + 86400000 }; await save();
        const nextUrl = tx.approve ? `/approve?id=${encodeURIComponent(tx.approve)}` : tx.code ? `/device?code=${tx.code}` : '/browser';
        res.writeHead(303, { location: nextUrl, 'set-cookie': [cookie('__Host-tools-session', raw, 86400), cookie('__Host-tools-tx', '', 0)], 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); res.end();
      } catch { res.writeHead(303, { location: '/auth/error', 'set-cookie': cookie('__Host-tools-tx', '', 0), 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }); res.end(); }
      return true;
    }
    if (req.method === 'GET' && path === '/auth/error') { page(res, 'Sign-in could not be completed', '<p>Use a verified DataTalks.Club Google account.</p><a href="/auth/login">Try again</a>'); return true; }
    if (req.method === 'POST' && path === '/api/auth/device') {
      rate(req); prune(); if (Object.keys(state.devices).length > 1000) throw fail(429, 'Too many pending logins');
      const body = await jsonBody(req); const role = body.role || 'controller';
      if (!['controller', 'daemon'].includes(role) || role === 'daemon' && !deviceName(body.device)) throw fail(400, 'Expected controller or daemon with a device name');
      if (role === 'controller') {
        try { if (typeof body.certificate !== 'string' || body.certificate.length > 8192 || new X509Certificate(body.certificate).publicKey.asymmetricKeyType !== 'ec') throw new Error(); }
        catch { throw fail(400, 'Controller TLS identity certificate required'); }
      }
      const raw = secret(), userCode = randomBytes(4).toString('hex').toUpperCase().replace(/(.{4})/, '$1-');
      state.devices[hash(raw)] = { userCode, label: String(body.label || 'Browser CLI').slice(0, 100), role, certificate: role === 'controller' ? body.certificate : undefined, device: role === 'daemon' ? body.device : null, interval: 5, nextPoll: 0, expires: now() + 600000 };
      await save(); json(res, 200, { device_code: raw, user_code: userCode, verification_uri: `${origin}/device`, verification_uri_complete: `${origin}/device?code=${userCode}`, expires_in: 600, interval: 5 }); return true;
    }
    if (req.method === 'POST' && path === '/api/auth/device/token') {
      rate(req, 1200, 'poll');
      const body = await jsonBody(req); const key = typeof body.device_code === 'string' ? hash(body.device_code) : ''; const d = state.devices[key];
      if (body.grant_type !== 'urn:ietf:params:oauth:grant-type:device_code') { json(res, 400, { error: 'unsupported_grant_type' }); return true; }
      if (!d || d.expires <= now()) { json(res, 400, { error: 'expired_token' }); return true; }
      if (d.denied) { delete state.devices[key]; await save(); json(res, 400, { error: 'access_denied' }); return true; }
      if (d.nextPoll > now()) { d.interval = Math.min(30, d.interval + 5); d.nextPoll = now() + d.interval * 1000; json(res, 400, { error: 'slow_down' }); return true; }
      d.nextPoll = now() + d.interval * 1000;
      if (!d.owner) { json(res, 400, { error: 'authorization_pending' }); return true; }
      const token = secret(); const item = { owner: d.owner, email: d.email, role: d.role, device: d.device, label: d.label, tools: ['browser'], certificate: d.certificate, expires: now() + (d.role === 'controller' ? 900000 : 30 * 86400000) };
      let refresh;
      if (d.role === 'controller') { refresh = secret(); item.grantId = hash(refresh); state.grants[item.grantId] = { ...item, expires: now() + 30 * 86400000 }; }
      delete state.devices[key]; state.credentials[hash(token)] = item; await save();
      audit('credential_issued', { owner: item.owner, role: item.role, device: item.device });
      json(res, 200, { access_token: token, refresh_token: refresh, token_type: 'Bearer', expires_in: d.role === 'controller' ? 900 : 30 * 86400, ...item }); return true;
    }
    if (req.method === 'POST' && path === '/api/auth/refresh') {
      rate(req, 120, 'refresh'); prune(); const body = await jsonBody(req); const grantId = hash(String(body.refresh_token || '')); const grant = state.grants[grantId];
      if (!grant || grant.expires <= now()) throw fail(401, 'Device grant expired or revoked');
      let proof;
      try {
        ({ payload: proof } = await jwtVerify(String(req.headers.dpop || ''), new X509Certificate(grant.certificate).publicKey, { algorithms: ['ES256'], typ: 'dpop+jwt', maxTokenAge: '60s', currentDate: new Date(now()), requiredClaims: ['iat', 'jti'] }));
        if (proof.htm !== 'POST' || proof.htu !== `${origin}/api/auth/refresh` || proof.grant_hash !== grantId || typeof proof.jti !== 'string' || proof.jti.length > 100 || state.proofs[hash(proof.jti)] || Math.abs(now() / 1000 - proof.iat) > 60) throw new Error();
      } catch { throw fail(401, 'Invalid or replayed device proof'); }
      state.proofs[hash(proof.jti)] = { expires: now() + 120000 };
      const token = secret(); const item = { ...grant, grantId, expires: now() + 900000 }; state.credentials[hash(token)] = item; await save();
      audit('credential_renewed', { owner: item.owner, role: item.role });
      json(res, 200, { access_token: token, token_type: 'Bearer', expires_in: 900, ...item }); return true;
    }
    if (req.method === 'GET' && path === '/device') {
      const code = (url.searchParams.get('code') || '').toUpperCase(); const s = session(req);
      if (!s) { res.writeHead(303, { location: `/auth/login?code=${encodeURIComponent(code)}` }); res.end(); return true; }
      const d = Object.values(state.devices).find(d => d.userCode === code && d.expires > now() && !d.denied && !d.owner);
      if (!d) { page(res, 'Connect a CLI', '<form method="get" action="/device"><label>Device code <input name="code" required placeholder="ABCD-1234"></label> <button>Continue</button></form><p>Only enter a code from a login you started.</p>'); return true; }
      const pin = d.certificate ? new X509Certificate(d.certificate).fingerprint256.replaceAll(':', '').toLowerCase() : null;
      page(res, 'Approve browser access', `<p>Signed in as <strong>${escape(s.email)}</strong>.</p><p>Code: <code>${escape(code)}</code></p><p>${escape(d.label)} requests <strong>${d.role === 'daemon' ? `permission to publish browser device ${escape(d.device)}` : 'control of your connected browser devices'}</strong>.</p>${pin ? `<p>Controller identity: <small style="overflow-wrap:anywhere">${pin}</small></p>` : ''}<p>Approve only if you started this login. Controller access tokens last 15 minutes and renew with the device key for up to 30 days. Desktop pairing independently limits browser permissions.</p><form method="post" action="/api/auth/device/approve"><input type="hidden" name="code" value="${escape(code)}"><input type="hidden" name="csrf" value="${escape(s.csrf)}"><button name="approve" value="yes">Approve</button> <button name="deny" value="yes">Deny</button></form>`); return true;
    }
    if (req.method === 'POST' && path === '/api/auth/device/approve') {
      const s = session(req); if (!s) throw fail(401, 'Browser sign-in required');
      const chunks = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > 4096) throw fail(413, 'Request too large'); chunks.push(chunk); }
      const body = new URLSearchParams(Buffer.concat(chunks).toString()); csrf(req, s, body.get('csrf'));
      const d = Object.values(state.devices).find(d => d.userCode === body.get('code') && d.expires > now() && !d.owner && !d.denied);
      if (!d) throw fail(400, 'Code expired or already approved');
      if (body.get('approve') !== 'yes') d.denied = true; else { d.owner = s.owner; d.email = s.email; }
      await save(); page(res, d.denied ? 'Access denied' : 'Device approved', '<p>You can return to the CLI.</p><a href="/browser">Connected browsers</a>'); return true;
    }
    if (req.method === 'GET' && path === '/api/auth/me') { const p = credential(req) || session(req); if (!p) throw fail(401, 'Not signed in'); json(res, 200, { email: p.email, role: p.role || 'browser', device: p.device, expires: p.expires }); return true; }
    if (req.method === 'POST' && path === '/api/auth/logout') {
      const p = credential(req); if (!p) throw fail(401, 'Not signed in'); revoke(p.key, onRevoke); await save(); json(res, 200, { revoked: true }); return true;
    }
    if (req.method === 'GET' && path === '/api/auth/credentials') {
      const s = session(req); if (!s) throw fail(401, 'Browser sign-in required'); json(res, 200, [...Object.entries(state.credentials).filter(([, c]) => !c.grantId), ...Object.entries(state.grants)].filter(([, c]) => c.owner === s.owner).map(([id, c]) => ({ id, label: c.label, role: c.role, device: c.device, expires: c.expires }))); return true;
    }
    if (req.method === 'POST' && ['/api/auth/revoke', '/auth/revoke'].includes(path)) {
      const s = session(req); if (!s) throw fail(401, 'Browser sign-in required');
      let b;
      if (path === '/auth/revoke') {
        const chunks = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > 4096) throw fail(413, 'Request too large'); chunks.push(chunk); }
        b = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()));
      } else b = await jsonBody(req);
      csrf(req, s, b.csrf);
      const c = state.grants[b.id] || state.credentials[b.id]; if (!c || c.owner !== s.owner) throw fail(404, 'Credential not found'); revoke(b.id, onRevoke); await save();
      if (path === '/auth/revoke') { res.writeHead(303, { location: '/browser' }); res.end(); } else json(res, 200, { revoked: true }); return true;
    }
    if (req.method === 'GET' && path === '/approve') {
      prune();
      const id = url.searchParams.get('id') || '';
      const s = session(req);
      if (!s) { res.writeHead(303, { location: `/auth/login?approve=${encodeURIComponent(id)}` }); res.end(); return true; }
      if (s.email !== 'alexey@datatalks.club') throw fail(403, 'Only Alexey (alexey@datatalks.club) can approve or deny requests; agents cannot self-approve');
      const gateUrl = (process.env.PHONE_GATE_URL || '').replace(/\/$/, ''), gateToken = process.env.PHONE_GATE_TOKEN || '';
      if (gateUrl && gateToken) {
        try {
          const up = await fetch(`${gateUrl}${id ? `/requests/${encodeURIComponent(id)}` : '/requests'}`, { headers: { Authorization: gateToken }, signal: AbortSignal.timeout(4000) });
          if (up.ok) {
            const payload = await up.json();
            for (const u of (id ? [payload] : (payload.items || []))) {
              if (!u || !u.id) continue;
              const cur = state.phoneRequests[u.id];
              if (!cur || cur.state === 'pending') {
                state.phoneRequests[u.id] = { id: String(u.id), requester: String(u.requester || 'agent'), resource: String(u.resource || 'browser'), scope: String(u.scope || 'desktop'), reason: String(u.reason || ''), ttl_s: Number(u.ttl_s) || 1800, state: cur?.state && cur.state !== 'pending' ? cur.state : String(u.state || 'pending'), requestedAt: (Number(u.requested_at) || Math.floor(now() / 1000)) * 1000, expires: (Number(u.expires_at) || Math.floor(now() / 1000) + 900) * 1000 };
              }
            }
            await save();
          }
        } catch {}
      }
      const r = state.phoneRequests[id];
      if (!r || r.expires <= now() || r.state !== 'pending') {
        const pending = Object.values(state.phoneRequests).filter(x => x.state === 'pending' && x.expires > now());
        if (!pending.length) { page(res, 'Phone approvals', '<p>No pending approval requests.</p><a href="/browser">Connected browsers</a>'); return true; }
        page(res, 'Pending phone approvals', pending.map(x => `<p><strong>${escape(x.requester)}</strong> asks for <code>${escape(x.resource)}:${escape(x.scope)}</code> (${Math.round(x.ttl_s / 60)}m): ${escape(x.reason)} · <a href="/approve?id=${encodeURIComponent(x.id)}">Review</a></p>`).join('')); return true;
      }
      const mins = Math.max(1, Math.round(r.ttl_s / 60));
      const dur = mins % 60 === 0 ? `${mins / 60}h (${mins} minutes)` : `${mins} minutes`;
      page(res, 'Approve resource request', `<p>Signed in as <strong>${escape(s.email)}</strong>.</p><ul><li><strong>Who asks:</strong> ${escape(r.requester)}</li><li><strong>For what resource:</strong> <code>${escape(r.resource)}:${escape(r.scope)}</code></li><li><strong>Why:</strong> ${escape(r.reason)}</li><li><strong>For how long:</strong> ${escape(dur)}</li></ul><form method="post" action="/api/auth/approve"><input type="hidden" name="id" value="${escape(r.id)}"><input type="hidden" name="csrf" value="${escape(s.csrf)}"><button name="approve" value="yes">Approve</button> <button name="deny" value="yes">Deny</button></form>`); return true;
    }
    if (req.method === 'POST' && path === '/api/auth/approve') {
      const s = session(req); if (!s) throw fail(401, 'Browser sign-in required');
      if (s.email !== 'alexey@datatalks.club') throw fail(403, 'Only Alexey (alexey@datatalks.club) can approve or deny requests; agents cannot self-approve');
      const chunks = []; let size = 0; for await (const chunk of req) { size += chunk.length; if (size > 4096) throw fail(413, 'Request too large'); chunks.push(chunk); }
      const body = new URLSearchParams(Buffer.concat(chunks).toString()); csrf(req, s, body.get('csrf'));
      const r = state.phoneRequests[body.get('id') || ''];
      if (!r || r.expires <= now() || r.state !== 'pending') throw fail(400, 'Request expired or already decided');
      if (body.get('approve') === 'yes') {
        r.state = 'approved'; r.decidedAt = now(); r.grantExpires = now() + r.ttl_s * 1000;
        if (r.resource === 'browser' && gate?.grant) await gate.grant(r.scope || 'desktop', Math.min(r.ttl_s * 1000, 8 * 3600 * 1000), `${r.requester}: ${r.reason}`);
        audit('phone_request_approved', { id: r.id, requester: r.requester, resource: r.resource, scope: r.scope });
      } else {
        r.state = 'denied'; r.decidedAt = now();
        if (r.resource === 'browser' && gate?.revoke) await gate.revoke(r.scope || 'desktop');
        audit('phone_request_denied', { id: r.id, requester: r.requester, resource: r.resource, scope: r.scope });
      }
      await save();
      page(res, r.state === 'approved' ? 'Request approved' : 'Request denied', `<p><strong>${escape(r.requester)}</strong> (${escape(r.resource)}:${escape(r.scope)}) is now <strong>${escape(r.state)}</strong>.</p><a href="/approve">Pending requests</a> · <a href="/browser">Connected browsers</a>`); return true;
    }
    throw fail(404, 'Not found');
  }
  return { handle, principal, credential, session, save, state, now, origin };
}
