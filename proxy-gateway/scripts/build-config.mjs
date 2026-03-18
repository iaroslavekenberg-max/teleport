import fs from 'node:fs'

function fail(message) {
  console.error(message)
  process.exit(1)
}

const vlessUrl = process.env.VLESS_URL
const proxyUser = process.env.PROXY_USER
const proxyPass = process.env.PROXY_PASS
const proxyPort = Number(process.env.PROXY_PORT || '3128')

if (!vlessUrl) fail('VLESS_URL is required')
if (!proxyUser) fail('PROXY_USER is required')
if (!proxyPass) fail('PROXY_PASS is required')
if (!Number.isFinite(proxyPort) || proxyPort < 1 || proxyPort > 65535) fail('PROXY_PORT is invalid')

let u
try {
  u = new URL(vlessUrl)
} catch {
  fail('VLESS_URL is not a valid URL')
}

if (u.protocol !== 'vless:') fail('Only vless:// URL is supported')
if (!u.username) fail('UUID is missing in VLESS_URL')
if (!u.hostname) fail('Host is missing in VLESS_URL')

const security = u.searchParams.get('security') || 'none'
const network = u.searchParams.get('type') || 'tcp'
const flow = u.searchParams.get('flow') || ''
const sni = u.searchParams.get('sni') || u.hostname

const streamSettings = {
  network,
  security
}

if (security === 'tls') {
  streamSettings.tlsSettings = { serverName: sni }
}

if (security === 'reality') {
  streamSettings.realitySettings = {
    serverName: sni,
    fingerprint: u.searchParams.get('fp') || 'chrome',
    publicKey: u.searchParams.get('pbk') || '',
    shortId: u.searchParams.get('sid') || '',
    spiderX: u.searchParams.get('spx') || '/'
  }

  if (!streamSettings.realitySettings.publicKey) {
    fail('For security=reality, pbk is required in VLESS_URL')
  }
}

if (network === 'ws') {
  streamSettings.wsSettings = {
    path: u.searchParams.get('path') || '/',
    headers: {
      Host: u.searchParams.get('host') || u.hostname
    }
  }
}

const config = {
  log: { loglevel: 'warning' },
  inbounds: [
    {
      tag: 'http-in',
      listen: '0.0.0.0',
      port: proxyPort,
      protocol: 'http',
      settings: {
        accounts: [{ user: proxyUser, pass: proxyPass }]
      }
    }
  ],
  outbounds: [
    {
      tag: 'to-vless',
      protocol: 'vless',
      settings: {
        vnext: [
          {
            address: u.hostname,
            port: Number(u.port || '443'),
            users: [
              {
                id: decodeURIComponent(u.username),
                encryption: 'none',
                flow
              }
            ]
          }
        ]
      },
      streamSettings
    }
  ]
}

fs.writeFileSync('config.json', JSON.stringify(config, null, 2), 'utf8')
console.log('config.json created')
