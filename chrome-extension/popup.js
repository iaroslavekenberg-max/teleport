const apiBaseEl = document.getElementById('apiBase')
const apiTokenEl = document.getElementById('apiToken')
const claimCodeEl = document.getElementById('claimCode')
const claimBtnEl = document.getElementById('claimBtn')
const keyResultEl = document.getElementById('keyResult')
const copyBtnEl = document.getElementById('copyBtn')
const saveBtnEl = document.getElementById('saveBtn')
const statusEl = document.getElementById('status')

function setStatus(text, type = '') {
  statusEl.textContent = text
  statusEl.className = `status ${type}`.trim()
}

function normalizeBaseUrl(value) {
  return value.trim().replace(/\/$/, '')
}

async function loadSettings() {
  const data = await chrome.storage.local.get(['apiBase', 'apiToken', 'lastVlessKey'])
  apiBaseEl.value = data.apiBase || ''
  apiTokenEl.value = data.apiToken || ''
  keyResultEl.value = data.lastVlessKey || ''
}

async function saveSettings() {
  const apiBase = normalizeBaseUrl(apiBaseEl.value)
  const apiToken = apiTokenEl.value.trim()

  if (!apiBase.startsWith('https://')) {
    setStatus('API URL должен начинаться с https://', 'error')
    return
  }

  if (!apiToken) {
    setStatus('Укажи API Token', 'error')
    return
  }

  await chrome.storage.local.set({ apiBase, apiToken })
  setStatus('Настройки сохранены', 'ok')
}

async function claimKey() {
  const code = claimCodeEl.value.trim()
  const apiBase = normalizeBaseUrl(apiBaseEl.value)
  const apiToken = apiTokenEl.value.trim()

  if (!/^\d{8}$/.test(code)) {
    setStatus('Код должен быть из 8 цифр', 'error')
    return
  }

  if (!apiBase.startsWith('https://')) {
    setStatus('API URL должен начинаться с https://', 'error')
    return
  }

  if (!apiToken) {
    setStatus('Укажи API Token', 'error')
    return
  }

  claimBtnEl.disabled = true
  setStatus('Получаем ключ...')

  try {
    const resp = await fetch(`${apiBase}/api/extension/claim`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiToken}`
      },
      body: JSON.stringify({ code })
    })

    const data = await resp.json()
    if (!resp.ok || !data.ok) {
      throw new Error(data.error || 'Не удалось получить ключ')
    }

    const vlessLink = String(data.vlessLink || '')
    if (!vlessLink.startsWith('vless://')) {
      throw new Error('Сервер вернул некорректный ключ')
    }

    keyResultEl.value = vlessLink
    claimCodeEl.value = ''
    await chrome.storage.local.set({
      apiBase,
      apiToken,
      lastVlessKey: vlessLink,
      lastClaimAt: new Date().toISOString()
    })

    setStatus('Ключ получен. Теперь можно скопировать.', 'ok')
  } catch (error) {
    setStatus(error.message || 'Ошибка сети', 'error')
  } finally {
    claimBtnEl.disabled = false
  }
}

async function copyKey() {
  const value = keyResultEl.value.trim()
  if (!value) {
    setStatus('Нет ключа для копирования', 'error')
    return
  }

  await navigator.clipboard.writeText(value)
  setStatus('Ключ скопирован', 'ok')
}

saveBtnEl.addEventListener('click', saveSettings)
claimBtnEl.addEventListener('click', claimKey)
copyBtnEl.addEventListener('click', copyKey)

loadSettings().catch(() => setStatus('Не удалось загрузить настройки', 'error'))
