#!/usr/bin/env node
/* =============================================================================
   gsc-token.js — lets a CLIENT grant you read-only Google access, without you
   ever seeing their password, and without a paid anything.

   Why this exists: Search Console data is only released to a verified owner.
   There is no workaround and we do not pretend there is one. What we can do is
   make the owner's side a 2-minute job:

     1. you (the agency) create one OAuth client in YOUR Google Cloud project   ₹0
        APIs enabled: Search Console API (+ Analytics API if you want GA4)
        Redirect URI: http://localhost:8420
        Client type:  Web application
     2. you run:   node tools/gsc-token.js --client-id <id> --client-secret <secret>
     3. the owner (or you, sitting with them) signs in and clicks Allow
     4. a short-lived access token + refresh token land in ./tokens/<property>.json
     5. node tools/ingest.js --token-file tokens/sc-domain-example.com.json

   Refresh tokens expire if unused for 6 months, or when the owner revokes access
   in myaccount.google.com → Security → Third-party access. Nothing here stores a
   password, and nothing is sent anywhere except googleapis.com.
   ============================================================================= */
'use strict';
const fs = require('fs'), path = require('path'), http = require('http'), crypto = require('crypto');

const A = process.argv.slice(2);
const opt = (k, d) => { const i = A.indexOf('--' + k); return i > -1 ? A[i + 1] : d };
const CFG = {
  clientId: opt('client-id', process.env.GOOGLE_CLIENT_ID || ''),
  secret: opt('client-secret', process.env.GOOGLE_CLIENT_SECRET || ''),
  port: +opt('port', 8420),
  property: opt('property', ''),              // sc-domain:example.com — optional, for the filename
  out: opt('out', 'tokens'),
  ga4: A.includes('--ga4'),
  headless: A.includes('--no-browser'),
};
if (!CFG.clientId || !CFG.secret) {
  console.error(`
usage:
  node tools/gsc-token.js --client-id <ID>.apps.googleusercontent.com --client-secret <SECRET> [--ga4] [--property sc-domain:example.com] [--no-browser]

Get those two values from console.cloud.google.com → APIs & Services → Credentials
→ OAuth client ID (Web application), with http://localhost:${CFG.port} added as an
authorised redirect URI. Free. One client works for every client you onboard —
each owner grants their own property access.
`); process.exit(2);
}
const SCOPES = ['https://www.googleapis.com/auth/webmasters.readonly',
  CFG.ga4 ? 'https://www.googleapis.com/auth/analytics.readonly' : null].filter(Boolean).join(' ');

const verifier = crypto.randomBytes(32).toString('base64url');
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
const state = crypto.randomBytes(12).toString('base64url');
const REDIRECT = `http://localhost:${CFG.port}`;

const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id: CFG.clientId, redirect_uri: REDIRECT, response_type: 'code', scope: SCOPES,
  state, code_challenge: challenge, code_challenge_method: 'S256', access_type: 'offline', prompt: 'consent',
});

console.log('\n1) is URL client ko bhejo (ya khud unke saamne kholo):\n');
console.log('   ' + authUrl + '\n');
console.log('2) unke Allow ke baad ye window wait karega, token file mein likh dega.\n');

const srv = http.createServer(async (req, res) => {
  const u = new URL(req.url, REDIRECT);
  if (u.pathname !== '/') return;
  const code = u.searchParams.get('code'), st = u.searchParams.get('state'), err = u.searchParams.get('error');
  if (err) return done(res, 400, 'Owner cancelled or Google refused: ' + err), srv.close();
  if (st !== state) return done(res, 400, 'state mismatch — possible CSRF, aborting.'), srv.close();
  try {
    const r = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code, client_id: CFG.clientId, client_secret: CFG.secret,
        redirect_uri: REDIRECT, grant_type: 'authorization_code', code_verifier: verifier }),
    });
    const j = await r.json();
    if (!r.ok) { done(res, 500, 'token exchange failed: ' + (j.error_description || j.error)); srv.close(); return }
    fs.mkdirSync(CFG.out, { recursive: true });
    const name = (CFG.property || 'gsc').replace(/[^a-z0-9._-]/gi, '_');
    const file = path.join(CFG.out, name + '.json');
    fs.writeFileSync(file, JSON.stringify({ ...j, obtainedAt: new Date().toISOString(), scopes: SCOPES }, null, 1), { mode: 0o600 });
    done(res, 200, '✓ Done. Aapki window band ho sakti hai — access save ho gaya.');
    console.log('   wrote ' + file + '  (chmod 600)');
    console.log('   next: node tools/ingest.js --token-file ' + file + (CFG.property ? ' --site ' + CFG.property : '') + '\n');
    srv.close();
  } catch (e) { done(res, 500, e.message); srv.close() }
});
function done(res, code, msg) {
  res.writeHead(code, { 'content-type': 'text/html; charset=utf-8' });
  res.end(`<!doctype html><meta charset=utf-8><title>Viralytics — access</title>
<body style="font:15px/1.6 system-ui;background:#0a0b0d;color:#e6e8ea;display:grid;place-items:center;height:100vh;margin:0">
<div style="max-width:520px;padding:28px;border:1px solid #21262d;border-radius:14px;background:#111317">
<h2 style="margin:0 0 8px;font-size:18px">${code === 200 ? '✓ Ho gaya' : '✗ Ruk gaya'}</h2>
<p style="margin:0;color:#9aa4b0">${msg}</p>
<p style="margin:14px 0 0;font-size:12.5px;color:#6a7480">Ye read-only access hai: aapki Search Console setting, users, ya
koi bhi data modify nahi ho sakta. Revoked: myaccount.google.com → Security → Third-party apps.</p></div></body>`);
}
srv.listen(CFG.port, () => {
  if (!CFG.headless && process.platform === 'darwin') require('child_process').exec('open ' + JSON.stringify(authUrl));
  console.log('   listening on ' + REDIRECT + '  (Ctrl-C to abort)');
  setTimeout(() => { console.log('\n   still waiting after 5 min — the owner has not clicked Allow yet.\n'); }, 300000);
});
