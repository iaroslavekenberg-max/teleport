# Chrome Extension + Telegram bot (VLESS)

Ниже короткая инструкция, чтобы схема работала end-to-end.

## Что уже добавлено в проект

1. В Worker добавлен endpoint: `POST /api/extension/claim`
2. В боте добавлена команда: `/chrome_key`
3. Добавлена таблица БД `chrome_claims` для одноразовых кодов
4. Создано расширение в папке `chrome-extension`

## Логика работы

1. Сотрудник в Telegram отправляет `/chrome_key`
2. Бот проверяет активную подписку и выдает код (8 цифр, живет 120 сек)
3. Сотрудник вставляет код в Chrome extension
4. Extension вызывает `POST /api/extension/claim`
5. Worker возвращает `vless://...` один раз

## Шаг 1. Применить миграцию БД

```bash
npx wrangler d1 execute vpn_bot_db --file=./schema.sql --remote
```

Если база локальная для теста:

```bash
npx wrangler d1 execute vpn_bot_db --file=./schema.sql
```

## Шаг 2. Добавить секреты Worker

```bash
npx wrangler secret put EXTENSION_API_TOKEN
```

Вставь длинный токен (минимум 32 символа).

Опционально (время жизни кода в секундах):

```bash
npx wrangler secret put CLAIM_CODE_TTL_SECONDS
```

Если не задавать, будет 120 секунд.

## Шаг 3. Деплой Worker

```bash
npm run deploy
```

После деплоя у тебя будет URL вида:
`https://<name>.<subdomain>.workers.dev`

## Шаг 4. Установить расширение в Chrome

1. Открыть `chrome://extensions`
2. Включить `Developer mode`
3. Нажать `Load unpacked`
4. Выбрать папку `chrome-extension`

## Шаг 5. Настроить расширение

1. Открыть popup расширения
2. В `API URL` вставить URL Worker
3. В `API Token` вставить `EXTENSION_API_TOKEN`
4. Нажать `Сохранить настройки`

## Шаг 6. Проверка

1. В Telegram отправить `/chrome_key`
2. Скопировать код (8 цифр)
3. Вставить код в extension
4. Нажать `Получить ключ`
5. Должен появиться `vless://...`

## Важно для безопасности

1. Никому не показывай `EXTENSION_API_TOKEN`
2. Используй только `https://` URL
3. Код одноразовый и быстро истекает (это уже сделано)
4. Рекомендуется ротация токена раз в 30-60 дней

## Корпоративный rollout

Для сотрудников лучше развернуть расширение централизованно через:
- Google Admin (если Chrome Browser Cloud Management)
- или GPO/AD (если Windows домен)

Тогда можно заранее прописать `apiBase` и `apiToken` через managed storage/политики.
