// Executed only inside the actual Codex turn, with owned endpoints supplied by the host fixture.
const net = require('node:net'), dgram = require('node:dgram'), http = require('node:http');
const fs = require('node:fs'), cp = require('node:child_process');
const proxy = new URL(process.env.HTTP_PROXY);
const endpoint = Number(process.argv[2]);
const mode = process.argv[3];
const marker = process.argv[4];
const connect = (authority) => new Promise((ok, fail) => {
  const s = net.connect(Number(proxy.port), proxy.hostname); let data = '';
  s.setTimeout(5000, () => s.destroy(new Error('proxy timed out')));
  s.on('error', fail);
  s.once('connect', () => s.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`));
  const read = b => { data += b; if (!data.includes('\r\n\r\n')) return; s.off('data', read); s.setTimeout(0); ok({ s, status: Number(data.split(' ')[1]) }); };
  s.on('data', read);
});
async function main() {
  if (mode === 'standing') {
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
      if (process.env[key] !== proxy.href.replace(/\/$/, '')) throw new Error('missing or inconsistent proxy variable: ' + key);
    }
    if (process.env.NO_PROXY !== '' || process.env.no_proxy !== '') throw new Error('proxy bypass variables must be empty');
    for (const host of ['forbidden.test', 'forbidden-alias.test', '9.9.9.9']) {
      const denied = await connect(host + ':80'); denied.s.destroy();
      if (denied.status !== 403) throw new Error('never host allowed: ' + host);
    }
  }
  if (mode === 'hold') {
    const { s, status } = await connect('owned-upstream.test:80');
    if (status !== 200) throw new Error('hold CONNECT refused');
    s.write('GET /mediated-hold HTTP/1.1\r\nHost: owned-upstream.test\r\n\r\n');
    fs.writeFileSync(marker, String(proxy.port));
    return; // Deliberately live until production executor/provider teardown.
  }
  if (mode === 'public') {
    const { s, status } = await connect('example.com:443');
    if (status !== 200) throw new Error('public CONNECT refused');
    const tls = require('node:tls').connect({ socket: s, servername: 'example.com' });
    tls.setTimeout(15000, () => tls.destroy(new Error('public TLS timed out')));
    await new Promise((ok, fail) => { tls.once('secureConnect', ok); tls.once('error', fail); });
    const response = await new Promise((ok, fail) => {
      let data = ''; tls.on('data', b => data += b); tls.once('error', fail); tls.once('end', () => ok(data));
      tls.write('GET / HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n');
    });
    if (!/^HTTP\/1\.[01] 200/.test(response)) throw new Error('public HTTP failed');
    console.log('MEDIATED_PUBLIC_OK:' + proxy.port); return;
  }
  const direct = await new Promise(ok => {
    const s = net.connect(endpoint, '127.0.0.1');
    s.once('connect', () => { s.destroy(); ok('UNEXPECTED_CONNECT'); });
    s.once('error', e => ok(e.code)); s.setTimeout(2000, () => { s.destroy(); ok('TIMEOUT'); });
  });
  const udp = await new Promise(ok => {
    const s = dgram.createSocket('udp4');
    let finished = false; const finish = code => { if (!finished) { finished = true; try { s.close(); } catch {} ok(code); } };
    s.once('error', e => finish(e.code));
    // A real DNS question to an owned UDP sink, never to a host resolver.
    s.send(Buffer.from('123401000001000000000000076578616d706c6503636f6d0000010001', 'hex'), endpoint, '127.0.0.1', e => finish(e?.code ?? 'UNEXPECTED_SEND'));
  });
  const forbidden = await connect('owned-upstream.test:49444'); forbidden.s.destroy();
  const local = await connect('127.0.0.1:' + endpoint); local.s.destroy();
  const body = await new Promise((ok, fail) => {
    const req = http.get({ host: proxy.hostname, port: proxy.port, path: 'http://owned-upstream.test/mediated-upstream', headers: { Host: 'owned-upstream.test' } }, res => {
      let data = ''; res.on('data', b => data += b); res.on('end', () => ok(data));
    }); req.on('error', fail);
  });
  if (direct !== 'EPERM' || udp !== 'EPERM' || forbidden.status !== 403 || local.status !== 403 || body !== 'MEDIATED_UPSTREAM_OK') throw new Error(JSON.stringify({ direct, udp, forbidden: forbidden.status, local: local.status, body }));
  const child = cp.spawn(process.execPath, [__filename, String(endpoint), 'hold', marker], { stdio: 'ignore' }); child.unref();
  for (let n = 0; !fs.existsSync(marker) && n < 100; n++) await new Promise(r => setTimeout(r, 50));
  if (!fs.existsSync(marker)) throw new Error('live tunnel did not start');
  console.log('MEDIATED_RESULT:' + JSON.stringify({ direct, udp, forbidden: forbidden.status, local: local.status, body, port: Number(proxy.port), held: true }));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
