'use strict';

const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const express = require('express');
const cookieParser = require('cookie-parser');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const { q, authenticate, createSession, inventory, pruneItem } = require('./db');

const app = express();
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

app.set('trust proxy', Number(process.env.TRUST_PROXY || 0));
app.use(express.json({ limit: '256kb' }));
app.use(cookieParser());

// Web Bluetooth only exists in a secure context, and this deployment is public,
// so the browser is told to stay on HTTPS.
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        objectSrc: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
    hsts: process.env.NODE_ENV === 'production' ? undefined : false,
  })
);

// The rack secret is the only credential, so brute force has to be expensive.
app.use(
  '/api/session',
  rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: true, legacyHeaders: false })
);
app.use('/api', rateLimit({ windowMs: 60_000, limit: 600, standardHeaders: true, legacyHeaders: false }));

const COOKIE = 'rack_session';
const cookieOpts = {
  httpOnly: true,
  sameSite: 'lax',
  secure: process.env.NODE_ENV === 'production',
  maxAge: 30 * 24 * 3600 * 1000,
};

// Presenting the rack's own secret, read over BLE, both claims a new rack and
// authenticates an existing one.
app.post('/api/session', (req, res) => {
  const rackId = String(req.body?.rackId || '').trim();
  const auth = String(req.get('authorization') || '');
  const secret = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';

  if (!/^[0-9a-f]{6,32}$/.test(rackId) || !/^[0-9a-f]{32}$/.test(secret)) {
    return res.status(400).json({ error: 'rackId and secret required' });
  }
  const result = authenticate(rackId, secret);
  if (!result.ok) return res.status(401).json({ error: 'bad key for this rack' });

  res.cookie(COOKIE, createSession(rackId), cookieOpts);
  res.json({ ok: true, rackId, name: result.rack.name, created: result.created });
});

function requireRack(req, res, next) {
  const token = req.cookies?.[COOKIE];
  const row = token ? q.session.get(token) : null;
  if (!row) return res.status(401).json({ error: 'connect to your rack over Bluetooth first' });
  req.rackId = row.rack_id;
  next();
}

app.post('/api/logout', (req, res) => {
  res.clearCookie(COOKIE, cookieOpts);
  res.json({ ok: true });
});

app.get('/api/bootstrap', requireRack, (req, res) => {
  const rack = q.rackById.get(req.rackId);
  const cfgRow = q.getConfig.get(req.rackId);
  res.json({
    rackId: req.rackId,
    name: rack.name,
    config: cfgRow ? JSON.parse(cfgRow.json) : null,
    inventory: inventory(req.rackId),
  });
});

app.put('/api/config', requireRack, (req, res) => {
  const cfg = req.body && typeof req.body === 'object' ? req.body : {};
  q.putConfig.run(req.rackId, JSON.stringify(cfg));
  if (typeof cfg.rackName === 'string' && cfg.rackName.trim()) {
    q.renameRack.run(cfg.rackName.trim(), req.rackId);
  }
  res.json(cfg);
});

app.get('/api/inventory', requireRack, (req, res) => {
  res.json({ items: inventory(req.rackId) });
});

app.get('/api/bin', requireRack, (req, res) => {
  const row = Number(req.query.row);
  const col = Number(req.query.col);
  if (!Number.isInteger(row) || !Number.isInteger(col)) {
    return res.status(400).json({ error: 'row and col required' });
  }
  const here = q.itemsInCell.all(req.rackId, row, col);
  res.json({
    row,
    col,
    shared: here.length > 1,
    count: here.length,
    total: here.reduce((a, i) => a + i.qty, 0),
    items: here.map((i) => ({
      id: i.id, name: i.name, category: i.category,
      package: i.package, mpn: i.mpn, cellQty: i.qty,
    })),
  });
});

function newId() {
  return require('crypto').randomBytes(3).toString('hex');
}

// A compartment holds one part unless the caller opts into sharing. Replacing
// what is already there has to be explicit, so a mis-sent cell cannot silently
// destroy someone's stock.
app.post('/api/stock/place', requireRack, (req, res) => {
  const { row, col, name, share, replace } = req.body || {};
  if (!Number.isInteger(row) || !Number.isInteger(col)) {
    return res.status(400).json({ error: 'row and col required' });
  }
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name required' });

  const qty = Number.isFinite(Number(req.body.qty)) ? Math.max(0, Number(req.body.qty)) : 1;
  const here = q.itemsInCell.all(req.rackId, row, col);
  const same = here.find(
    (i) =>
      (req.body.id && i.id === req.body.id) ||
      (i.name === String(name).trim() && (i.package || '') === (req.body.package || ''))
  );

  if (!share && !replace && here.length && !same) {
    return res.status(409).json({
      error: 'cell occupied',
      occupant: here[0].name,
      row,
      col,
    });
  }
  if (!share && !same && here.length) {
    for (const occ of here) {
      q.deleteLoc.run(req.rackId, occ.id, row, col);
      pruneItem(req.rackId, occ.id);
    }
  }

  const id = same ? same.id : req.body.id || newId();
  q.upsertItem.run({
    rack_id: req.rackId,
    id,
    name: String(name).trim(),
    category: req.body.category || 'other',
    package: req.body.package || '',
    mpn: req.body.mpn || '',
  });
  q.setLoc.run(req.rackId, id, row, col, qty);
  if (qty <= 0) {
    q.deleteLoc.run(req.rackId, id, row, col);
    pruneItem(req.rackId, id);
  }
  res.json({ ok: true, id, row, col, qty });
});

// id picks one part out of a shared compartment; without it the cell must hold
// exactly one part for the operation to be unambiguous.
function resolveTarget(rackId, row, col, id, res) {
  if (id) {
    const loc = q.getLoc.get(rackId, id, row, col);
    if (!loc) {
      res.status(404).json({ error: 'that part is not in this bin' });
      return null;
    }
    return id;
  }
  const here = q.itemsInCell.all(rackId, row, col);
  if (here.length === 0) {
    res.status(404).json({ error: 'empty cell' });
    return null;
  }
  if (here.length > 1) {
    res.status(409).json({ error: 'shared bin — say which part', count: here.length });
    return null;
  }
  return here[0].id;
}

app.post('/api/stock/adjust', requireRack, (req, res) => {
  const { row, col, delta } = req.body || {};
  const id = resolveTarget(req.rackId, row, col, req.body?.id, res);
  if (!id) return;
  const cur = q.getLoc.get(req.rackId, id, row, col);
  const qty = Math.max(0, (cur?.qty || 0) + (Number(delta) || 0));
  q.setLoc.run(req.rackId, id, row, col, qty);
  if (qty === 0) {
    q.deleteLoc.run(req.rackId, id, row, col);
    pruneItem(req.rackId, id);
  }
  res.json({ ok: true, id, qty });
});

app.post('/api/stock/set', requireRack, (req, res) => {
  const { row, col } = req.body || {};
  const id = resolveTarget(req.rackId, row, col, req.body?.id, res);
  if (!id) return;
  const qty = Math.max(0, Number(req.body.qty) || 0);
  q.setLoc.run(req.rackId, id, row, col, qty);
  if (qty === 0) {
    q.deleteLoc.run(req.rackId, id, row, col);
    pruneItem(req.rackId, id);
  }
  res.json({ ok: true, id, qty });
});

app.post('/api/stock/clear', requireRack, (req, res) => {
  const { row, col, id } = req.body || {};
  if (!Number.isInteger(row) || !Number.isInteger(col)) {
    return res.status(400).json({ error: 'row and col required' });
  }
  if (id) {
    q.deleteLoc.run(req.rackId, id, row, col);
    pruneItem(req.rackId, id);
  } else {
    const here = q.itemsInCell.all(req.rackId, row, col);
    q.clearCell.run(req.rackId, row, col);
    for (const occ of here) pruneItem(req.rackId, occ.id);
  }
  res.json({ ok: true });
});

app.get('/api/backup', requireRack, (req, res) => {
  const cfgRow = q.getConfig.get(req.rackId);
  res.setHeader('Content-Disposition', 'attachment; filename="rack-backup.json"');
  res.json({
    rackId: req.rackId,
    config: cfgRow ? JSON.parse(cfgRow.json) : null,
    inventory: inventory(req.rackId),
  });
});

app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
app.get('*', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));

const PORT = Number(process.env.PORT || 8080);
const TLS_PORT = Number(process.env.TLS_PORT || 8443);
const CERT_DIR = process.env.CERT_DIR || path.join(__dirname, '..', 'certs');

http.createServer(app).listen(PORT, () => {
  console.log(`[rack] http  :${PORT}`);
});

// Web Bluetooth needs a secure context. localhost counts, anything else does not,
// so a TLS listener is started whenever a certificate is present.
const keyPath = path.join(CERT_DIR, 'key.pem');
const certPath = path.join(CERT_DIR, 'cert.pem');
if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
  https
    .createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, app)
    .listen(TLS_PORT, () => console.log(`[rack] https :${TLS_PORT}`));
} else {
  console.log('[rack] no certs — https disabled. Bluetooth needs https or localhost.');
}

module.exports = app;
