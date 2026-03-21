import { Hono } from 'hono'

type Bindings = {
  TELEGRAM_BOT_TOKEN: string
  TELEGRAM_WEBHOOK_SECRET?: string
  FREE_MODE?: string
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

const PLAN_NAME = 'VPN 30 дней'
const PLAN_DAYS = 30
const PLAN_PRICE_RUB = '199.00'
const CORP_PROXY_BUTTON_TEXT = 'Корп. прокси'

function mainKeyboard() {
  return {
    keyboard: [
      [{ text: 'Купить' }, { text: 'Профиль' }],
      [{ text: CORP_PROXY_BUTTON_TEXT }, { text: 'Поддержка' }]
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

function isFreeMode(env: Bindings) {
  const value = (env.FREE_MODE ?? '1').trim().toLowerCase()
  return value === '1' || value === 'true' || value === 'yes' || value === 'on'
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
    throw new Error(`Marzban auth failed (url=${env.MARZBAN_URL}): ${resp.status} ${err}`)
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

async function activateSubscription(
  env: Bindings,
  tgId: number,
  chatId: number,
  planDays: number,
  reason: 'payment' | 'free' = 'payment'
) {
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

  const title =
    reason === 'free' ? '🎁 <b>Тестовый доступ активирован</b>' : '✅ <b>Оплата подтверждена</b>'

  await sendMessage(env, chatId, `${title}\n\nВаш ключ:\n<code>${escapeHtml(vlessLink)}</code>\n\nСрок: ${planDays} дней.`, {
    reply_markup: mainKeyboard()
  })
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
      'У вас пока нет активной подписки.\nНажмите <b>Купить</b>, чтобы оформить доступ.',
      { reply_markup: mainKeyboard() }
    )
    return
  }

  await sendMessage(
    env,
    chatId,
    `👤 <b>Профиль</b>\n\nТариф: ${escapeHtml(sub.plan_name)}\nДействует до: ${escapeHtml(
      sub.expires_at
    )}\n\nКлюч:\n<code>${escapeHtml(sub.vless_link)}</code>`,
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
      '❌ Нет активной подписки. Сначала оформите подписку, потом запросите /corp_proxy.',
      { reply_markup: mainKeyboard() }
    )
    return
  }

  const host = (env.CORP_PROXY_HOST || '').trim()
  const port = (env.CORP_PROXY_PORT || '3128').trim()
  const username = (env.CORP_PROXY_USERNAME || '').trim()
  const password = env.CORP_PROXY_PASSWORD || ''
  const note = env.CORP_PROXY_NOTE || 'Если не подключается, напишите в поддержку.'

  if (!host || !username || !password) {
    await sendMessage(
      env,
      chatId,
      '⚠️ Корпоративный прокси пока не настроен на сервере. Напишите в поддержку.',
      { reply_markup: mainKeyboard() }
    )
    return
  }

  const text = [
    '🏢 <b>Доступ для корпоративного браузера</b>',
    '',
    `Host: <code>${escapeHtml(host)}</code>`,
    `Port: <code>${escapeHtml(port)}</code>`,
    `Login: <code>${escapeHtml(username)}</code>`,
    `Password: <code>${escapeHtml(password)}</code>`,
    '',
    '<b>Как подключить:</b>',
    '1) Откройте настройки корпоративного proxy/расширения в браузере.',
    '2) Введите Host, Port, Login и Password из этого сообщения.',
    '3) Включите proxy и проверьте внешний IP.',
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
    `💳 <b>${PLAN_NAME}</b>`,
    `Цена: ${PLAN_PRICE_RUB} RUB`,
    '',
    '<b>Оплата вручную:</b>',
    `Карта: <code>${escapeHtml(env.PAYMENT_CARD_NUMBER)}</code>`
  ]

  if (env.PAYMENT_CARD_HOLDER) {
    lines.push(`Получатель: ${escapeHtml(env.PAYMENT_CARD_HOLDER)}`)
  }
  if (env.PAYMENT_BANK_NAME) {
    lines.push(`Банк: ${escapeHtml(env.PAYMENT_BANK_NAME)}`)
  }
  if (env.PAYMENT_SBP_PHONE) {
    lines.push(`СБП: <code>${escapeHtml(env.PAYMENT_SBP_PHONE)}</code>`)
  }
  if (env.PAYMENT_NOTE) {
    lines.push(`Комментарий к переводу: ${escapeHtml(env.PAYMENT_NOTE)}`)
  }

  lines.push('', `ID заявки: <code>${escapeHtml(requestId)}</code>`)
  lines.push('После оплаты отправьте в этот чат скрин чека или сообщение с текстом "чек".')
  lines.push('Далее я отправлю вашу заявку администратору на проверку.')

  return lines.join('\n')
}

async function notifyAdminsAboutCheck(env: Bindings, tgUser: TelegramUser, payment: PaymentRow) {
  const username = tgUser.username ? `@${tgUser.username}` : 'без username'
  const text = [
    '🔔 <b>Новая заявка на проверку оплаты</b>',
    `tg_id: <code>${tgUser.id}</code>`,
    `username: ${escapeHtml(username)}`,
    `Сумма: ${payment.amount_rub} RUB`,
    `Тариф: ${payment.plan_days} дней`,
    `ID заявки: <code>${escapeHtml(payment.payment_id)}</code>`,
    '',
    `Команды:`,
    `/approve ${tgUser.id}`,
    `/reject ${tgUser.id} причина`
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
    return { ok: false, message: 'Заявка не найдена.' }
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
  return { ok: true, message: `Оплата подтверждена для tg_id ${targetTgId}.` }
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
    return { ok: false, message: 'Заявка не найдена.' }
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
    `❌ Платеж пока не подтвержден.\nПричина: ${escapeHtml(reason)}\n\nПроверьте реквизиты и отправьте чек еще раз.`,
    { reply_markup: mainKeyboard() }
  )

  return { ok: true, message: `Заявка отклонена для tg_id ${targetTgId}.` }
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
      const name = tgUser.first_name ? escapeHtml(tgUser.first_name) : 'друг'
      const extra = isFreeMode(env)
        ? '\n\n🎁 Сейчас тестовый режим: нажмите <b>Купить</b>, и доступ активируется бесплатно.'
        : ''
      await sendMessage(
        env,
        chatId,
        `Привет, <b>${name}</b>!\nЯ помогу купить VPN и выдам ключ.${extra}`,
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
          `✅ Тестовый ключ:\n<code>${escapeHtml(link)}</code>`,
          { reply_markup: mainKeyboard() }
        )
      } catch (e: any) {
        await sendMessage(env, chatId, `❌ Ошибка выдачи ключа: ${escapeHtml(String(e.message || e))}`)
      }
      return c.text('OK')
    }

    if (text === '/chrome_key') {
      const claim = await createExtensionClaimCode(env, tgUser.id)
      if (!claim) {
        await sendMessage(
          env,
          chatId,
          '❌ Нет активной подписки. Сначала оформите подписку, потом получите код для Chrome.',
          { reply_markup: mainKeyboard() }
        )
        return c.text('OK')
      }

      await sendMessage(
        env,
        chatId,
        `🔐 Код для Chrome: <code>${claim.code}</code>\nКод работает ${claim.ttlSec} сек.\n\nОткройте расширение, вставьте код и нажмите "Получить ключ".`,
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
        await sendMessage(env, chatId, 'Формат: /approve 123456789')
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
      const reason = firstSpace > -1 ? payload.slice(firstSpace + 1).trim() : 'Оплата не найдена'
      if (!targetTgId) {
        await sendMessage(env, chatId, 'Формат: /reject 123456789 причина')
        return c.text('OK')
      }
      const result = await rejectByTgId(env, targetTgId, reason)
      await sendMessage(env, chatId, result.message)
      return c.text('OK')
    }

    if (text === 'Профиль') {
      await showProfile(env, chatId, tgUser.id)
      return c.text('OK')
    }

    if (text === 'Поддержка') {
      const support = env.SUPPORT_TEXT || 'Напишите в поддержку: @your_support'
      await sendMessage(env, chatId, support, { reply_markup: mainKeyboard() })
      return c.text('OK')
    }

    if (text === 'Купить') {
      if (isFreeMode(env)) {
        try {
          await activateSubscription(env, tgUser.id, chatId, PLAN_DAYS, 'free')
        } catch (e: any) {
          console.error('Free activation failed', e)
          await sendMessage(
            env,
            chatId,
            `❌ Не удалось активировать тестовый доступ: ${escapeHtml(String(e?.message || e))}`,
            { reply_markup: mainKeyboard() }
          )
        }
        return c.text('OK')
      }

      const payment = await createOrGetPendingPayment(env, tgUser.id, chatId)
      await sendMessage(env, chatId, paymentInstruction(env, payment.payment_id), {
        reply_markup: mainKeyboard()
      })
      return c.text('OK')
    }

    if (isPhoto || /^чек\b/i.test(text)) {
      if (isFreeMode(env)) {
        await sendMessage(env, chatId, 'Сейчас тестовый бесплатный режим. Просто нажмите <b>Купить</b>.', {
          reply_markup: mainKeyboard()
        })
        return c.text('OK')
      }

      const noted = await markPaymentForReview(env, tgUser, text || 'Чек отправлен фото')
      if (noted) {
        await sendMessage(
          env,
          chatId,
          '✅ Чек получен. Передал заявку администратору, обычно проверка занимает 5-15 минут.',
          { reply_markup: mainKeyboard() }
        )
        return c.text('OK')
      }
    }

    await sendMessage(env, chatId, 'Выберите действие в меню ниже.', { reply_markup: mainKeyboard() })
    return c.text('OK')
  } catch (e: any) {
    console.error('Telegram webhook error', e)
    return c.text('Error', 500)
  }
})

export default app

