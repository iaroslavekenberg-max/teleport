import { Hono } from 'hono'

type Bindings = {
  TELEGRAM_BOT_TOKEN: string
  TELEGRAM_WEBHOOK_SECRET?: string
  MARZBAN_URL: string
  MARZBAN_USERNAME: string
  MARZBAN_PASSWORD: string
  EXTENSION_API_TOKEN: string
  CLAIM_CODE_TTL_SECONDS?: string
  SUPPORT_TEXT?: string
  ADMIN_TG_IDS: string
  PAYMENT_CARD_NUMBER: string
  PAYMENT_CARD_HOLDER?: string
  PAYMENT_BANK_NAME?: string
  PAYMENT_SBP_PHONE?: string
  PAYMENT_NOTE?: string
  CORP_PROXY_HOST?: string
  CORP_PROXY_PORT?: string
  CORP_PROXY_USERNAME?: string
  CORP_PROXY_PASSWORD?: string
  CORP_PROXY_NOTE?: string
  DB: D1Database
}

type TelegramUser = {
  id: number
  username?: string
  first_name?: string
  last_name?: string
}

type PaymentRow = {
  payment_id: string
  tg_id: number
  chat_id: number
  amount_rub: string
  status: string
  plan_days: number
}

type ActiveSubscriptionRow = {
  vless_link: string
  expires_at: string
}

const app = new Hono<{ Bindings: Bindings }>()

const PLAN_NAME = 'VPN 30 РґРЅРµР№'
const PLAN_DAYS = 30
const PLAN_PRICE_RUB = '199.00'
const CORP_PROXY_BUTTON_TEXT = 'Корп. прокси'

function mainKeyboard() {
  return {
    keyboard: [
      [{ text: 'РљСѓРїРёС‚СЊ' }, { text: 'РџСЂРѕС„РёР»СЊ' }],
      [{ text: CORP_PROXY_BUTTON_TEXT }, { text: 'РџРѕРґРґРµСЂР¶РєР°' }]
    ],
    resize_keyboard: true
  }
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function adminIds(env: Bindings) {
  return env.ADMIN_TG_IDS.split(',')
    .map((x) => Number(x.trim()))
    .filter((x) => Number.isFinite(x) && x > 0)
}

function isAdmin(env: Bindings, tgId: number) {
  return adminIds(env).includes(tgId)
}

function extensionCorsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Cache-Control': 'no-store'
  }
}

function extensionJson(data: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...extensionCorsHeaders()
    }
  })
}

function codeTtlSeconds(env: Bindings) {
  const parsed = Number(env.CLAIM_CODE_TTL_SECONDS ?? '120')
  if (!Number.isFinite(parsed)) {
    return 120
  }
  return Math.max(60, Math.min(900, Math.floor(parsed)))
}

function generateClaimCode() {
  const arr = new Uint32Array(1)
  crypto.getRandomValues(arr)
  const code = arr[0] % 100000000
  return String(code).padStart(8, '0')
}

async function sha256Hex(input: string) {
  const bytes = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest))
    .map((x) => x.toString(16).padStart(2, '0'))
    .join('')
}

async function telegramApi(env: Bindings, method: string, payload: Record<string, unknown>) {
  const resp = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  })

  if (!resp.ok) {
    const err = await resp.text()
    throw new Error(`Telegram API ${method} failed: ${resp.status} ${err}`)
  }

  return resp.json()
}

async function sendMessage(
  env: Bindings,
  chatId: number,
  text: string,
  extra: Record<string, unknown> = {}
) {
  return telegramApi(env, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    ...extra
  })
}

async function upsertTelegramUser(env: Bindings, tgUser: TelegramUser) {
  await env.DB.prepare(
    `
      INSERT INTO users (tg_id, tg_username, first_name, last_name, created_at, updated_at)
      VALUES (?, ?, ?, ?, datetime('now'), datetime('now'))
      ON CONFLICT(tg_id) DO UPDATE SET
        tg_username = excluded.tg_username,
        first_name = excluded.first_name,
        last_name = excluded.last_name,
        updated_at = datetime('now')
    `
  )
    .bind(tgUser.id, tgUser.username ?? null, tgUser.first_name ?? null, tgUser.last_name ?? null)
    .run()
}

async function getMarzbanToken(env: Bindings) {
  const body = new URLSearchParams()
  body.append('username', env.MARZBAN_USERNAME)
  body.append('password', env.MARZBAN_PASSWORD)
  body.append('grant_type', 'password')

  const resp = await fetch(`${env.MARZBAN_URL}/api/admin/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  })

  if (!resp.ok) {
    const err = await resp.text()
    throw new Error(`Marzban auth failed: ${resp.status} ${err}`)
  }

  const data = (await resp.json()) as { access_token: string }
  return data.access_token
}

async function createMarzbanUser(env: Bindings, adminToken: string, marzbanUsername: string) {
  const resp = await fetch(`${env.MARZBAN_URL}/api/user`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${adminToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      username: marzbanUsername,
      status: 'active',
      expire: 0,
      data_limit: 0,
      proxies: {
        vless: {}
      }
    })
  })

  if (!resp.ok) {
    const err = await resp.text()
    throw new Error(`Marzban create user failed: ${resp.status} ${err}`)
  }

  const data = (await resp.json()) as { links?: string[] }
  return data.links ?? []
}

async function ensureVpnForUser(env: Bindings, tgId: number) {
  const existing = await env.DB.prepare(
    'SELECT vless_link FROM subscriptions WHERE tg_id = ? AND is_active = 1 ORDER BY id DESC LIMIT 1'
  )
    .bind(tgId)
    .first<{ vless_link: string | null }>()

  if (existing?.vless_link) {
    return existing.vless_link
  }

  const token = await getMarzbanToken(env)
  const marzbanUsername = `tg_${tgId}_${Math.floor(Math.random() * 100000)}`
  const links = await createMarzbanUser(env, token, marzbanUsername)
  const link = links.find((l) => l.startsWith('vless://')) ?? links[0]

  if (!link) {
    throw new Error('Marzban user created but VLESS link not found')
  }

  return link
}

async function activateSubscription(env: Bindings, tgId: number, chatId: number, planDays: number) {
  const vlessLink = await ensureVpnForUser(env, tgId)

  await env.DB.prepare('UPDATE subscriptions SET is_active = 0, updated_at = datetime(\'now\') WHERE tg_id = ?')
    .bind(tgId)
    .run()

  await env.DB.prepare(
    `
      INSERT INTO subscriptions (tg_id, chat_id, plan_name, is_active, started_at, expires_at, vless_link, created_at, updated_at)
      VALUES (?, ?, ?, 1, datetime('now'), datetime('now', ?), ?, datetime('now'), datetime('now'))
    `
  )
    .bind(tgId, chatId, PLAN_NAME, `+${planDays} day`, vlessLink)
    .run()

  await sendMessage(
    env,
    chatId,
    `вњ… <b>РћРїР»Р°С‚Р° РїРѕРґС‚РІРµСЂР¶РґРµРЅР°</b>\n\nР’Р°С€ РєР»СЋС‡:\n<code>${escapeHtml(vlessLink)}</code>\n\nРЎСЂРѕРє: ${planDays} РґРЅРµР№.`,
    { reply_markup: mainKeyboard() }
  )
}

async function showProfile(env: Bindings, chatId: number, tgId: number) {
  const sub = await env.DB.prepare(
    `
      SELECT plan_name, expires_at, vless_link
      FROM subscriptions
      WHERE tg_id = ? AND is_active = 1
      ORDER BY id DESC
      LIMIT 1
    `
  )
    .bind(tgId)
    .first<{ plan_name: string; expires_at: string; vless_link: string }>()

  if (!sub) {
    await sendMessage(
      env,
      chatId,
      'РЈ РІР°СЃ РїРѕРєР° РЅРµС‚ Р°РєС‚РёРІРЅРѕР№ РїРѕРґРїРёСЃРєРё.\nРќР°Р¶РјРёС‚Рµ <b>РљСѓРїРёС‚СЊ</b>, С‡С‚РѕР±С‹ РѕС„РѕСЂРјРёС‚СЊ РґРѕСЃС‚СѓРї.',
      { reply_markup: mainKeyboard() }
    )
    return
  }

  await sendMessage(
    env,
    chatId,
    `рџ‘¤ <b>РџСЂРѕС„РёР»СЊ</b>\n\nРўР°СЂРёС„: ${escapeHtml(sub.plan_name)}\nР”РµР№СЃС‚РІСѓРµС‚ РґРѕ: ${escapeHtml(
      sub.expires_at
    )}\n\nРљР»СЋС‡:\n<code>${escapeHtml(sub.vless_link)}</code>`,
    { reply_markup: mainKeyboard() }
  )
}

async function getActiveSubscription(env: Bindings, tgId: number) {
  return env.DB.prepare(
    `
      SELECT vless_link, expires_at
      FROM subscriptions
      WHERE tg_id = ?
        AND is_active = 1
        AND vless_link IS NOT NULL
        AND datetime(expires_at) > datetime('now')
      ORDER BY id DESC
      LIMIT 1
    `
  )
    .bind(tgId)
    .first<ActiveSubscriptionRow>()
}

async function createExtensionClaimCode(env: Bindings, tgId: number) {
  const sub = await getActiveSubscription(env, tgId)
  if (!sub) {
    return null
  }

  const code = generateClaimCode()
  const codeHash = await sha256Hex(code)
  const ttlSec = codeTtlSeconds(env)

  await env.DB.prepare(
    `
      UPDATE chrome_claims
      SET claimed_at = datetime('now')
      WHERE tg_id = ? AND claimed_at IS NULL
    `
  )
    .bind(tgId)
    .run()

  await env.DB.prepare(
    `
      INSERT INTO chrome_claims (tg_id, code_hash, expires_at, vless_link, created_at)
      VALUES (?, ?, datetime('now', ?), ?, datetime('now'))
    `
  )
    .bind(tgId, codeHash, `+${ttlSec} seconds`, sub.vless_link)
    .run()

  return {
    code,
    ttlSec,
    subscriptionExpiresAt: sub.expires_at
  }
}

async function showCorpProxy(env: Bindings, chatId: number, tgId: number) {
  const sub = await getActiveSubscription(env, tgId)
  if (!sub) {
    await sendMessage(
      env,
      chatId,
      'вќЊ РќРµС‚ Р°РєС‚РёРІРЅРѕР№ РїРѕРґРїРёСЃРєРё. РЎРЅР°С‡Р°Р»Р° РѕС„РѕСЂРјРёС‚Рµ РїРѕРґРїРёСЃРєСѓ, РїРѕС‚РѕРј Р·Р°РїСЂРѕСЃРёС‚Рµ /corp_proxy.',
      { reply_markup: mainKeyboard() }
    )
    return
  }

  const host = (env.CORP_PROXY_HOST || '').trim()
  const port = (env.CORP_PROXY_PORT || '3128').trim()
  const username = (env.CORP_PROXY_USERNAME || '').trim()
  const password = env.CORP_PROXY_PASSWORD || ''
  const note = env.CORP_PROXY_NOTE || 'Р•СЃР»Рё РЅРµ РїРѕРґРєР»СЋС‡Р°РµС‚СЃСЏ, РЅР°РїРёС€РёС‚Рµ РІ РїРѕРґРґРµСЂР¶РєСѓ.'

  if (!host || !username || !password) {
    await sendMessage(
      env,
      chatId,
      'вљ пёЏ РљРѕСЂРїРѕСЂР°С‚РёРІРЅС‹Р№ РїСЂРѕРєСЃРё РїРѕРєР° РЅРµ РЅР°СЃС‚СЂРѕРµРЅ РЅР° СЃРµСЂРІРµСЂРµ. РќР°РїРёС€РёС‚Рµ РІ РїРѕРґРґРµСЂР¶РєСѓ.',
      { reply_markup: mainKeyboard() }
    )
    return
  }

  const text = [
    'рџЏў <b>Р”РѕСЃС‚СѓРї РґР»СЏ РєРѕСЂРїРѕСЂР°С‚РёРІРЅРѕРіРѕ Р±СЂР°СѓР·РµСЂР°</b>',
    '',
    `Host: <code>${escapeHtml(host)}</code>`,
    `Port: <code>${escapeHtml(port)}</code>`,
    `Login: <code>${escapeHtml(username)}</code>`,
    `Password: <code>${escapeHtml(password)}</code>`,
    '',
    '<b>РљР°Рє РїРѕРґРєР»СЋС‡РёС‚СЊ:</b>',
    '1) РћС‚РєСЂРѕР№С‚Рµ РЅР°СЃС‚СЂРѕР№РєРё РєРѕСЂРїРѕСЂР°С‚РёРІРЅРѕРіРѕ proxy/СЂР°СЃС€РёСЂРµРЅРёСЏ РІ Р±СЂР°СѓР·РµСЂРµ.',
    '2) Р’РІРµРґРёС‚Рµ Host, Port, Login Рё Password РёР· СЌС‚РѕРіРѕ СЃРѕРѕР±С‰РµРЅРёСЏ.',
    '3) Р’РєР»СЋС‡РёС‚Рµ proxy Рё РїСЂРѕРІРµСЂСЊС‚Рµ РІРЅРµС€РЅРёР№ IP.',
    '',
    escapeHtml(note)
  ].join('\n')

  await sendMessage(env, chatId, text, { reply_markup: mainKeyboard() })
}

async function createOrGetPendingPayment(env: Bindings, tgId: number, chatId: number) {
  const existing = await env.DB.prepare(
    `
      SELECT payment_id, tg_id, chat_id, amount_rub, status, plan_days
      FROM payments
      WHERE tg_id = ? AND status IN ('pending', 'review')
      ORDER BY id DESC
      LIMIT 1
    `
  )
    .bind(tgId)
    .first<PaymentRow>()

  if (existing) {
    return existing
  }

  const paymentId = crypto.randomUUID()
  await env.DB.prepare(
    `
      INSERT INTO payments (payment_id, tg_id, chat_id, amount_rub, status, plan_days, method, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'pending', ?, 'manual', datetime('now'), datetime('now'))
    `
  )
    .bind(paymentId, tgId, chatId, PLAN_PRICE_RUB, PLAN_DAYS)
    .run()

  return {
    payment_id: paymentId,
    tg_id: tgId,
    chat_id: chatId,
    amount_rub: PLAN_PRICE_RUB,
    status: 'pending',
    plan_days: PLAN_DAYS
  }
}

function paymentInstruction(env: Bindings, requestId: string) {
  const lines = [
    `рџ’і <b>${PLAN_NAME}</b>`,
    `Р¦РµРЅР°: ${PLAN_PRICE_RUB} RUB`,
    '',
    '<b>РћРїР»Р°С‚Р° РІСЂСѓС‡РЅСѓСЋ:</b>',
    `РљР°СЂС‚Р°: <code>${escapeHtml(env.PAYMENT_CARD_NUMBER)}</code>`
  ]

  if (env.PAYMENT_CARD_HOLDER) {
    lines.push(`РџРѕР»СѓС‡Р°С‚РµР»СЊ: ${escapeHtml(env.PAYMENT_CARD_HOLDER)}`)
  }
  if (env.PAYMENT_BANK_NAME) {
    lines.push(`Р‘Р°РЅРє: ${escapeHtml(env.PAYMENT_BANK_NAME)}`)
  }
  if (env.PAYMENT_SBP_PHONE) {
    lines.push(`РЎР‘Рџ: <code>${escapeHtml(env.PAYMENT_SBP_PHONE)}</code>`)
  }
  if (env.PAYMENT_NOTE) {
    lines.push(`РљРѕРјРјРµРЅС‚Р°СЂРёР№ Рє РїРµСЂРµРІРѕРґСѓ: ${escapeHtml(env.PAYMENT_NOTE)}`)
  }

  lines.push('', `ID Р·Р°СЏРІРєРё: <code>${escapeHtml(requestId)}</code>`)
  lines.push('РџРѕСЃР»Рµ РѕРїР»Р°С‚С‹ РѕС‚РїСЂР°РІСЊС‚Рµ РІ СЌС‚РѕС‚ С‡Р°С‚ СЃРєСЂРёРЅ С‡РµРєР° РёР»Рё СЃРѕРѕР±С‰РµРЅРёРµ СЃ С‚РµРєСЃС‚РѕРј "С‡РµРє".')
  lines.push('Р”Р°Р»РµРµ СЏ РѕС‚РїСЂР°РІР»СЋ РІР°С€Сѓ Р·Р°СЏРІРєСѓ Р°РґРјРёРЅРёСЃС‚СЂР°С‚РѕСЂСѓ РЅР° РїСЂРѕРІРµСЂРєСѓ.')

  return lines.join('\n')
}

async function notifyAdminsAboutCheck(env: Bindings, tgUser: TelegramUser, payment: PaymentRow) {
  const username = tgUser.username ? `@${tgUser.username}` : 'Р±РµР· username'
  const text = [
    'рџ”” <b>РќРѕРІР°СЏ Р·Р°СЏРІРєР° РЅР° РїСЂРѕРІРµСЂРєСѓ РѕРїР»Р°С‚С‹</b>',
    `tg_id: <code>${tgUser.id}</code>`,
    `username: ${escapeHtml(username)}`,
    `РЎСѓРјРјР°: ${payment.amount_rub} RUB`,
    `РўР°СЂРёС„: ${payment.plan_days} РґРЅРµР№`,
    `ID Р·Р°СЏРІРєРё: <code>${escapeHtml(payment.payment_id)}</code>`,
    '',
    `РљРѕРјР°РЅРґС‹:`,
    `/approve ${tgUser.id}`,
    `/reject ${tgUser.id} РїСЂРёС‡РёРЅР°`
  ].join('\n')

  for (const adminId of adminIds(env)) {
    await sendMessage(env, adminId, text)
  }
}

async function markPaymentForReview(env: Bindings, tgUser: TelegramUser, note: string) {
  const payment = await env.DB.prepare(
    `
      SELECT payment_id, tg_id, chat_id, amount_rub, status, plan_days
      FROM payments
      WHERE tg_id = ? AND status IN ('pending', 'review')
      ORDER BY id DESC
      LIMIT 1
    `
  )
    .bind(tgUser.id)
    .first<PaymentRow>()

  if (!payment) {
    return false
  }

  await env.DB.prepare(
    `
      UPDATE payments
      SET status = 'review', proof_text = ?, updated_at = datetime('now')
      WHERE payment_id = ?
    `
  )
    .bind(note, payment.payment_id)
    .run()

  await notifyAdminsAboutCheck(env, tgUser, payment)
  return true
}

async function approveByTgId(env: Bindings, targetTgId: number) {
  const payment = await env.DB.prepare(
    `
      SELECT payment_id, tg_id, chat_id, amount_rub, status, plan_days
      FROM payments
      WHERE tg_id = ? AND status IN ('pending', 'review')
      ORDER BY id DESC
      LIMIT 1
    `
  )
    .bind(targetTgId)
    .first<PaymentRow>()

  if (!payment) {
    return { ok: false, message: 'Р—Р°СЏРІРєР° РЅРµ РЅР°Р№РґРµРЅР°.' }
  }

  await env.DB.prepare(
    `
      UPDATE payments
      SET status = 'approved', updated_at = datetime('now')
      WHERE payment_id = ?
    `
  )
    .bind(payment.payment_id)
    .run()

  await activateSubscription(env, payment.tg_id, payment.chat_id, payment.plan_days)
  return { ok: true, message: `РћРїР»Р°С‚Р° РїРѕРґС‚РІРµСЂР¶РґРµРЅР° РґР»СЏ tg_id ${targetTgId}.` }
}

async function rejectByTgId(env: Bindings, targetTgId: number, reason: string) {
  const payment = await env.DB.prepare(
    `
      SELECT payment_id, tg_id, chat_id
      FROM payments
      WHERE tg_id = ? AND status IN ('pending', 'review')
      ORDER BY id DESC
      LIMIT 1
    `
  )
    .bind(targetTgId)
    .first<{ payment_id: string; tg_id: number; chat_id: number }>()

  if (!payment) {
    return { ok: false, message: 'Р—Р°СЏРІРєР° РЅРµ РЅР°Р№РґРµРЅР°.' }
  }

  await env.DB.prepare(
    `
      UPDATE payments
      SET status = 'rejected', admin_note = ?, updated_at = datetime('now')
      WHERE payment_id = ?
    `
  )
    .bind(reason, payment.payment_id)
    .run()

  await sendMessage(
    env,
    payment.chat_id,
    `вќЊ РџР»Р°С‚РµР¶ РїРѕРєР° РЅРµ РїРѕРґС‚РІРµСЂР¶РґРµРЅ.\nРџСЂРёС‡РёРЅР°: ${escapeHtml(reason)}\n\nРџСЂРѕРІРµСЂСЊС‚Рµ СЂРµРєРІРёР·РёС‚С‹ Рё РѕС‚РїСЂР°РІСЊС‚Рµ С‡РµРє РµС‰Рµ СЂР°Р·.`,
    { reply_markup: mainKeyboard() }
  )

  return { ok: true, message: `Р—Р°СЏРІРєР° РѕС‚РєР»РѕРЅРµРЅР° РґР»СЏ tg_id ${targetTgId}.` }
}

app.get('/', (c) => c.text('OK'))

app.options('/api/extension/claim', () => new Response(null, { status: 204, headers: extensionCorsHeaders() }))

app.post('/api/extension/claim', async (c) => {
  const env = c.env
  const auth = c.req.header('authorization') || ''
  const expected = `Bearer ${env.EXTENSION_API_TOKEN}`

  if (!env.EXTENSION_API_TOKEN) {
    return extensionJson({ ok: false, error: 'Extension API token is not configured' }, 500)
  }

  if (auth !== expected) {
    return extensionJson({ ok: false, error: 'Unauthorized' }, 401)
  }

  let body: any
  try {
    body = await c.req.json()
  } catch {
    return extensionJson({ ok: false, error: 'Invalid JSON body' }, 400)
  }

  const code = String(body?.code ?? '').trim()
  if (!/^\d{8}$/.test(code)) {
    return extensionJson({ ok: false, error: 'Code must be 8 digits' }, 400)
  }

  const codeHash = await sha256Hex(code)
  const claim = await env.DB.prepare(
    `
      SELECT id, vless_link, expires_at
      FROM chrome_claims
      WHERE code_hash = ?
        AND claimed_at IS NULL
        AND datetime(expires_at) > datetime('now')
      ORDER BY id DESC
      LIMIT 1
    `
  )
    .bind(codeHash)
    .first<{ id: number; vless_link: string; expires_at: string }>()

  if (!claim) {
    return extensionJson({ ok: false, error: 'Code is invalid or expired' }, 404)
  }

  await env.DB.prepare(
    `
      UPDATE chrome_claims
      SET claimed_at = datetime('now')
      WHERE id = ?
    `
  )
    .bind(claim.id)
    .run()

  return extensionJson({
    ok: true,
    vlessLink: claim.vless_link,
    expiresAt: claim.expires_at
  })
})

app.post('/', async (c) => {
  const env = c.env

  if (env.TELEGRAM_WEBHOOK_SECRET) {
    const incoming = c.req.header('x-telegram-bot-api-secret-token')
    if (incoming !== env.TELEGRAM_WEBHOOK_SECRET) {
      return c.text('Forbidden', 403)
    }
  }

  try {
    const update = (await c.req.json()) as any
    const msg = update.message

    if (!msg || !msg.from) {
      return c.text('OK')
    }

    const chatId = msg.chat.id as number
    const tgUser = msg.from as TelegramUser
    const isPhoto = Array.isArray(msg.photo) && msg.photo.length > 0
    const text = String(msg.text || msg.caption || '').trim()

    await upsertTelegramUser(env, tgUser)

    if (text === '/start') {
      const name = tgUser.first_name ? escapeHtml(tgUser.first_name) : 'РґСЂСѓРі'
      await sendMessage(
        env,
        chatId,
        `РџСЂРёРІРµС‚, <b>${name}</b>!\nРЇ РїРѕРјРѕРіСѓ РєСѓРїРёС‚СЊ VPN Рё РІС‹РґР°Рј РєР»СЋС‡.`,
        { reply_markup: mainKeyboard() }
      )
      return c.text('OK')
    }

    if (text === '/get_key') {
      try {
        const link = await ensureVpnForUser(env, tgUser.id)
        await sendMessage(
          env,
          chatId,
          `вњ… РўРµСЃС‚РѕРІС‹Р№ РєР»СЋС‡:\n<code>${escapeHtml(link)}</code>`,
          { reply_markup: mainKeyboard() }
        )
      } catch (e: any) {
        await sendMessage(env, chatId, `вќЊ РћС€РёР±РєР° РІС‹РґР°С‡Рё РєР»СЋС‡Р°: ${escapeHtml(String(e.message || e))}`)
      }
      return c.text('OK')
    }

    if (text === '/chrome_key') {
      const claim = await createExtensionClaimCode(env, tgUser.id)
      if (!claim) {
        await sendMessage(
          env,
          chatId,
          'вќЊ РќРµС‚ Р°РєС‚РёРІРЅРѕР№ РїРѕРґРїРёСЃРєРё. РЎРЅР°С‡Р°Р»Р° РѕС„РѕСЂРјРёС‚Рµ РїРѕРґРїРёСЃРєСѓ, РїРѕС‚РѕРј РїРѕР»СѓС‡РёС‚Рµ РєРѕРґ РґР»СЏ Chrome.',
          { reply_markup: mainKeyboard() }
        )
        return c.text('OK')
      }

      await sendMessage(
        env,
        chatId,
        `рџ”ђ РљРѕРґ РґР»СЏ Chrome: <code>${claim.code}</code>\nРљРѕРґ СЂР°Р±РѕС‚Р°РµС‚ ${claim.ttlSec} СЃРµРє.\n\nРћС‚РєСЂРѕР№С‚Рµ СЂР°СЃС€РёСЂРµРЅРёРµ, РІСЃС‚Р°РІСЊС‚Рµ РєРѕРґ Рё РЅР°Р¶РјРёС‚Рµ "РџРѕР»СѓС‡РёС‚СЊ РєР»СЋС‡".`,
        { reply_markup: mainKeyboard() }
      )
      return c.text('OK')
    }

    if (text === '/corp_proxy' || text === CORP_PROXY_BUTTON_TEXT) {
      await showCorpProxy(env, chatId, tgUser.id)
      return c.text('OK')
    }

    if (isAdmin(env, tgUser.id) && text.startsWith('/approve ')) {
      const targetTgId = Number(text.replace('/approve', '').trim())
      if (!targetTgId) {
        await sendMessage(env, chatId, 'Р¤РѕСЂРјР°С‚: /approve 123456789')
        return c.text('OK')
      }
      const result = await approveByTgId(env, targetTgId)
      await sendMessage(env, chatId, result.message)
      return c.text('OK')
    }

    if (isAdmin(env, tgUser.id) && text.startsWith('/reject ')) {
      const payload = text.replace('/reject', '').trim()
      const firstSpace = payload.indexOf(' ')
      const targetTgId = Number(firstSpace > -1 ? payload.slice(0, firstSpace) : payload)
      const reason = firstSpace > -1 ? payload.slice(firstSpace + 1).trim() : 'РћРїР»Р°С‚Р° РЅРµ РЅР°Р№РґРµРЅР°'
      if (!targetTgId) {
        await sendMessage(env, chatId, 'Р¤РѕСЂРјР°С‚: /reject 123456789 РїСЂРёС‡РёРЅР°')
        return c.text('OK')
      }
      const result = await rejectByTgId(env, targetTgId, reason)
      await sendMessage(env, chatId, result.message)
      return c.text('OK')
    }

    if (text === 'РџСЂРѕС„РёР»СЊ') {
      await showProfile(env, chatId, tgUser.id)
      return c.text('OK')
    }

    if (text === 'РџРѕРґРґРµСЂР¶РєР°') {
      const support = env.SUPPORT_TEXT || 'РќР°РїРёС€РёС‚Рµ РІ РїРѕРґРґРµСЂР¶РєСѓ: @your_support'
      await sendMessage(env, chatId, support, { reply_markup: mainKeyboard() })
      return c.text('OK')
    }

    if (text === 'РљСѓРїРёС‚СЊ') {
      const payment = await createOrGetPendingPayment(env, tgUser.id, chatId)
      await sendMessage(env, chatId, paymentInstruction(env, payment.payment_id), {
        reply_markup: mainKeyboard()
      })
      return c.text('OK')
    }

    if (isPhoto || /^С‡РµРє\b/i.test(text)) {
      const noted = await markPaymentForReview(env, tgUser, text || 'Р§РµРє РѕС‚РїСЂР°РІР»РµРЅ С„РѕС‚Рѕ')
      if (noted) {
        await sendMessage(
          env,
          chatId,
          'вњ… Р§РµРє РїРѕР»СѓС‡РµРЅ. РџРµСЂРµРґР°Р» Р·Р°СЏРІРєСѓ Р°РґРјРёРЅРёСЃС‚СЂР°С‚РѕСЂСѓ, РѕР±С‹С‡РЅРѕ РїСЂРѕРІРµСЂРєР° Р·Р°РЅРёРјР°РµС‚ 5-15 РјРёРЅСѓС‚.',
          { reply_markup: mainKeyboard() }
        )
        return c.text('OK')
      }
    }

    await sendMessage(env, chatId, 'Р’С‹Р±РµСЂРёС‚Рµ РґРµР№СЃС‚РІРёРµ РІ РјРµРЅСЋ РЅРёР¶Рµ.', { reply_markup: mainKeyboard() })
    return c.text('OK')
  } catch (e: any) {
    console.error('Telegram webhook error', e)
    return c.text('Error', 500)
  }
})

export default app


