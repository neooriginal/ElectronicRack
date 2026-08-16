'use strict';

// Generates a self-signed certificate so the server can offer https, which is
// what Web Bluetooth requires outside of localhost. A browser will warn once;
// after you accept the exception the origin counts as secure and Bluetooth works.
// For a public deployment use a real certificate instead.

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const dir = process.env.CERT_DIR || path.join(__dirname, '..', 'certs');
const host = process.argv[2] || 'rack.local';
fs.mkdirSync(dir, { recursive: true });

const key = path.join(dir, 'key.pem');
const cert = path.join(dir, 'cert.pem');
if (fs.existsSync(key) && fs.existsSync(cert)) {
  console.log(`certs already present in ${dir} — delete them to regenerate`);
  process.exit(0);
}

execFileSync(
  'openssl',
  [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes',
    '-keyout', key, '-out', cert,
    '-days', '825',
    '-subj', `/CN=${host}`,
    '-addext', `subjectAltName=DNS:${host},DNS:localhost,IP:127.0.0.1`,
  ],
  { stdio: 'inherit' }
);

console.log(`\nwrote ${key}\nwrote ${cert}\nCN=${host}`);
