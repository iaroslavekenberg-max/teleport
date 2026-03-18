import { createServer } from 'node:http';
import { randomBytes, randomUUID, scryptSync, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'store.json');
const PORT = Number(process.env.APP_PORT || 8787);

const DATA_TEMPLATE = {
  users: [],
  sessions: [],
  conversations: [],
  memberships: [],
  messages: []
};

let writeQueue = Promise.resolve();
const socketsByUserId = new Map();

function nowIso() {
  return new Date().toISOString();
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 1024 * 1024) {
        reject(new Error('Body is too large'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function json(res, status, payload) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

function sanitizeUsername(input) {
  return String(input || '').trim().toLowerCase();
}

function validatePassword(password) {
  return typeof password === 'string' && password.length >= 6;
}

function hashPassword(password, salt) {
  return scryptSync(password, salt, 64).toString('hex');
}

function verifyPassword(password, salt, hashHex) {
  const attempt = Buffer.from(hashPassword(password, salt), 'hex');
  const real = Buffer.from(hashHex, 'hex');
  if (attempt.length !== real.length) {
    return false;
  }
  return timingSafeEqual(attempt, real);
}

function parseEncryptionKey() {
  const raw = String(process.env.APP_ENCRYPTION_KEY || '').trim();
  if (/^[a-f0-9]{64}$/i.test(raw)) {
    return Buffer.from(raw, 'hex');
  }
  const generated = randomBytes(32);
  console.warn('APP_ENCRYPTION_KEY missing or invalid. Using temporary in-memory key. Messages will be unreadable after restart.');
  return generated;
}

const encryptionKey = parseEncryptionKey();

function encryptText(text) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey, iv);
  const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64'),
    ciphertext: encrypted.toString('base64'),
    tag: tag.toString('base64')
  };
}

function decryptText(record) {
  const iv = Buffer.from(record.iv, 'base64');
  const ciphertext = Buffer.from(record.ciphertext, 'base64');
  const tag = Buffer.from(record.tag, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', encryptionKey, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plain.toString('utf8');
}

async function ensureDataStore() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  if (!existsSync(DATA_FILE)) {
    await fs.writeFile(DATA_FILE, JSON.stringify(DATA_TEMPLATE, null, 2), 'utf8');
  }
}

async function readStore() {
  await ensureDataStore();
  const raw = await fs.readFile(DATA_FILE, 'utf8');
  const parsed = JSON.parse(raw.replace(/^\uFEFF/, ''));
  return {
    ...DATA_TEMPLATE,
    ...parsed
  };
}

function writeStore(nextStore) {
  writeQueue = writeQueue.then(() => fs.writeFile(DATA_FILE, JSON.stringify(nextStore, null, 2), 'utf8'));
  return writeQueue;
}

async function withStore(mutator) {
  const store = await readStore();
  const result = await mutator(store);
  await writeStore(store);
  return result;
}

function getAuthToken(req) {
  const auth = req.headers.authorization || '';
  if (!auth.startsWith('Bearer ')) {
    return null;
  }
  return auth.slice('Bearer '.length).trim();
}

function getSession(store, token) {
  if (!token) return null;
  return store.sessions.find((x) => x.token === token) || null;
}

function getUserById(store, userId) {
  return store.users.find((x) => x.id === userId) || null;
}

function displayConversation(store, conversation, currentUserId) {
  const members = store.memberships
    .filter((m) => m.conversationId === conversation.id)
    .map((m) => {
      const user = getUserById(store, m.userId);
      return {
        userId: m.userId,
        username: user?.username || 'unknown',
        role: m.role,
        canPost: !!m.canPost
      };
    });

  let title = conversation.title || 'Chat';
  if (conversation.type === 'direct') {
    const other = members.find((m) => m.userId !== currentUserId);
    title = other?.username || 'Direct chat';
  }

  return {
    id: conversation.id,
    type: conversation.type,
    title,
    ownerId: conversation.ownerId,
    members
  };
}

function userConversationIds(store, userId) {
  return new Set(store.memberships.filter((m) => m.userId === userId).map((m) => m.conversationId));
}

function userCanPost(store, userId, conversation) {
  const membership = store.memberships.find(
    (m) => m.userId === userId && m.conversationId === conversation.id
  );
  if (!membership) {
    return false;
  }
  if (conversation.type === 'channel') {
    return membership.canPost;
  }
  return true;
}

function websocketSend(ws, event, payload) {
  if (ws.readyState === 1) {
    ws.send(JSON.stringify({ event, payload }));
  }
}

function broadcastToUsers(userIds, event, payload) {
  for (const userId of userIds) {
    const sockets = socketsByUserId.get(userId);
    if (!sockets) continue;
    for (const ws of sockets) {
      websocketSend(ws, event, payload);
    }
  }
}

async function getAuthenticatedContext(req) {
  const token = getAuthToken(req);
  if (!token) {
    return null;
  }
  const store = await readStore();
  const session = getSession(store, token);
  if (!session) {
    return null;
  }
  const user = getUserById(store, session.userId);
  if (!user) {
    return null;
  }
  session.lastSeenAt = nowIso();
  await writeStore(store);
  return { store, user, session };
}

function collectConversationUserIds(store, conversationId) {
  return store.memberships.filter((m) => m.conversationId === conversationId).map((m) => m.userId);
}

async function handleApi(req, res, pathname) {
  if (req.method === 'POST' && pathname === '/api/register') {
    try {
      const body = await readJsonBody(req);
      const username = sanitizeUsername(body.username);
      const password = String(body.password || '');

      if (!/^[a-z0-9_]{3,24}$/.test(username)) {
        json(res, 400, { ok: false, error: 'Username: 3-24 символа, a-z, 0-9, _' });
        return true;
      }

      if (!validatePassword(password)) {
        json(res, 400, { ok: false, error: 'Пароль: минимум 6 символов' });
        return true;
      }

      const result = await withStore((store) => {
        const exists = store.users.some((u) => u.username === username);
        if (exists) {
          return { ok: false, error: 'Такой username уже занят' };
        }
        const salt = randomBytes(16).toString('hex');
        const user = {
          id: randomUUID(),
          username,
          passwordSalt: salt,
          passwordHash: hashPassword(password, salt),
          createdAt: nowIso()
        };
        store.users.push(user);
        return { ok: true };
      });

      if (!result.ok) {
        json(res, 409, result);
        return true;
      }

      json(res, 201, { ok: true });
      return true;
    } catch (error) {
      json(res, 400, { ok: false, error: error.message || 'Ошибка регистрации' });
      return true;
    }
  }

  if (req.method === 'POST' && pathname === '/api/login') {
    try {
      const body = await readJsonBody(req);
      const username = sanitizeUsername(body.username);
      const password = String(body.password || '');

      const result = await withStore((store) => {
        const user = store.users.find((u) => u.username === username);
        if (!user) {
          return { ok: false, error: 'Неверный логин или пароль' };
        }

        const valid = verifyPassword(password, user.passwordSalt, user.passwordHash);
        if (!valid) {
          return { ok: false, error: 'Неверный логин или пароль' };
        }

        const token = randomBytes(32).toString('hex');
        store.sessions.push({
          token,
          userId: user.id,
          createdAt: nowIso(),
          lastSeenAt: nowIso()
        });

        return {
          ok: true,
          token,
          user: {
            id: user.id,
            username: user.username
          }
        };
      });

      if (!result.ok) {
        json(res, 401, result);
        return true;
      }

      json(res, 200, result);
      return true;
    } catch (error) {
      json(res, 400, { ok: false, error: error.message || 'Ошибка входа' });
      return true;
    }
  }

  if (pathname.startsWith('/api/')) {
    const ctx = await getAuthenticatedContext(req);
    if (!ctx) {
      json(res, 401, { ok: false, error: 'Нужна авторизация' });
      return true;
    }

    const { user } = ctx;

    if (req.method === 'GET' && pathname === '/api/me') {
      json(res, 200, { ok: true, user: { id: user.id, username: user.username } });
      return true;
    }

    if (req.method === 'GET' && pathname === '/api/conversations') {
      const store = await readStore();
      const ids = userConversationIds(store, user.id);
      const conversations = store.conversations
        .filter((c) => ids.has(c.id))
        .map((c) => displayConversation(store, c, user.id));
      json(res, 200, { ok: true, conversations });
      return true;
    }

    if (req.method === 'POST' && pathname === '/api/conversations/direct') {
      const body = await readJsonBody(req);
      const targetUsername = sanitizeUsername(body.username);
      if (!targetUsername) {
        json(res, 400, { ok: false, error: 'Нужно указать username' });
        return true;
      }

      const result = await withStore((store) => {
        const target = store.users.find((u) => u.username === targetUsername);
        if (!target) {
          return { ok: false, status: 404, error: 'Пользователь не найден' };
        }
        if (target.id === user.id) {
          return { ok: false, status: 400, error: 'Нельзя создать чат с самим собой' };
        }

        const myDirects = store.memberships
          .filter((m) => m.userId === user.id)
          .map((m) => m.conversationId);

        const existing = store.conversations.find((c) => {
          if (c.type !== 'direct' || !myDirects.includes(c.id)) return false;
          const members = store.memberships
            .filter((m) => m.conversationId === c.id)
            .map((m) => m.userId)
            .sort();
          return members.length === 2 && members.includes(user.id) && members.includes(target.id);
        });

        if (existing) {
          return {
            ok: true,
            conversation: displayConversation(store, existing, user.id),
            memberUserIds: collectConversationUserIds(store, existing.id)
          };
        }

        const conversation = {
          id: randomUUID(),
          type: 'direct',
          title: null,
          ownerId: user.id,
          createdAt: nowIso()
        };
        store.conversations.push(conversation);
        store.memberships.push({ conversationId: conversation.id, userId: user.id, role: 'owner', canPost: true });
        store.memberships.push({ conversationId: conversation.id, userId: target.id, role: 'member', canPost: true });

        return {
          ok: true,
          conversation: displayConversation(store, conversation, user.id),
          memberUserIds: [user.id, target.id]
        };
      });

      if (!result.ok) {
        json(res, result.status || 400, result);
        return true;
      }

      for (const memberUserId of result.memberUserIds) {
        const store = await readStore();
        const conv = store.conversations.find((x) => x.id === result.conversation.id);
        if (!conv) continue;
        const payload = displayConversation(store, conv, memberUserId);
        broadcastToUsers([memberUserId], 'conversation_updated', payload);
      }

      json(res, 200, { ok: true, conversation: result.conversation });
      return true;
    }

    if (req.method === 'POST' && (pathname === '/api/conversations/group' || pathname === '/api/conversations/channel')) {
      const type = pathname.endsWith('/group') ? 'group' : 'channel';
      const body = await readJsonBody(req);
      const title = String(body.title || '').trim();
      const memberUsernames = Array.isArray(body.members) ? body.members : [];

      if (title.length < 2) {
        json(res, 400, { ok: false, error: 'Название слишком короткое' });
        return true;
      }

      const result = await withStore((store) => {
        const usernameSet = new Set(memberUsernames.map(sanitizeUsername).filter(Boolean));
        usernameSet.delete(user.username);

        const members = [];
        for (const username of usernameSet) {
          const person = store.users.find((u) => u.username === username);
          if (person) {
            members.push(person);
          }
        }

        const conversation = {
          id: randomUUID(),
          type,
          title,
          ownerId: user.id,
          createdAt: nowIso()
        };
        store.conversations.push(conversation);

        store.memberships.push({ conversationId: conversation.id, userId: user.id, role: 'owner', canPost: true });

        for (const person of members) {
          store.memberships.push({
            conversationId: conversation.id,
            userId: person.id,
            role: 'member',
            canPost: type === 'channel' ? false : true
          });
        }

        return {
          ok: true,
          conversation: displayConversation(store, conversation, user.id),
          memberUserIds: collectConversationUserIds(store, conversation.id)
        };
      });

      for (const memberUserId of result.memberUserIds) {
        const store = await readStore();
        const conv = store.conversations.find((x) => x.id === result.conversation.id);
        if (!conv) continue;
        const payload = displayConversation(store, conv, memberUserId);
        broadcastToUsers([memberUserId], 'conversation_updated', payload);
      }

      json(res, 201, { ok: true, conversation: result.conversation });
      return true;
    }

    if (req.method === 'POST' && /^\/api\/conversations\/[^/]+\/members$/.test(pathname)) {
      const conversationId = pathname.split('/')[3];
      const body = await readJsonBody(req);
      const username = sanitizeUsername(body.username);

      const result = await withStore((store) => {
        const conversation = store.conversations.find((c) => c.id === conversationId);
        if (!conversation) {
          return { ok: false, status: 404, error: 'Чат не найден' };
        }
        if (conversation.ownerId !== user.id) {
          return { ok: false, status: 403, error: 'Добавлять участников может только владелец' };
        }
        if (!username) {
          return { ok: false, status: 400, error: 'Нужен username' };
        }

        const target = store.users.find((u) => u.username === username);
        if (!target) {
          return { ok: false, status: 404, error: 'Пользователь не найден' };
        }

        const exists = store.memberships.some(
          (m) => m.conversationId === conversationId && m.userId === target.id
        );
        if (exists) {
          return { ok: false, status: 409, error: 'Пользователь уже в чате' };
        }

        store.memberships.push({
          conversationId,
          userId: target.id,
          role: 'member',
          canPost: conversation.type === 'channel' ? false : true
        });

        return {
          ok: true,
          addedUserId: target.id,
          memberUserIds: collectConversationUserIds(store, conversationId)
        };
      });

      if (!result.ok) {
        json(res, result.status || 400, result);
        return true;
      }

      const store = await readStore();
      const conversation = store.conversations.find((c) => c.id === conversationId);
      if (conversation) {
        for (const memberUserId of result.memberUserIds) {
          const payload = displayConversation(store, conversation, memberUserId);
          broadcastToUsers([memberUserId], 'conversation_updated', payload);
        }
      }

      json(res, 200, { ok: true });
      return true;
    }

    if (req.method === 'GET' && /^\/api\/conversations\/[^/]+\/messages$/.test(pathname)) {
      const conversationId = pathname.split('/')[3];
      const store = await readStore();

      const inConversation = store.memberships.some(
        (m) => m.conversationId === conversationId && m.userId === user.id
      );
      if (!inConversation) {
        json(res, 403, { ok: false, error: 'Нет доступа к чату' });
        return true;
      }

      const items = store.messages
        .filter((m) => m.conversationId === conversationId)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
        .slice(-200)
        .map((m) => {
          const sender = getUserById(store, m.senderId);
          return {
            id: m.id,
            senderId: m.senderId,
            senderUsername: sender?.username || 'unknown',
            text: decryptText(m),
            createdAt: m.createdAt
          };
        });

      json(res, 200, { ok: true, messages: items });
      return true;
    }

    if (req.method === 'POST' && /^\/api\/conversations\/[^/]+\/messages$/.test(pathname)) {
      const conversationId = pathname.split('/')[3];
      const body = await readJsonBody(req);
      const text = String(body.text || '').trim();
      if (!text) {
        json(res, 400, { ok: false, error: 'Пустое сообщение' });
        return true;
      }

      const result = await withStore((store) => {
        const conversation = store.conversations.find((c) => c.id === conversationId);
        if (!conversation) {
          return { ok: false, status: 404, error: 'Чат не найден' };
        }

        const inConversation = store.memberships.some(
          (m) => m.conversationId === conversationId && m.userId === user.id
        );
        if (!inConversation) {
          return { ok: false, status: 403, error: 'Нет доступа к чату' };
        }

        if (!userCanPost(store, user.id, conversation)) {
          return { ok: false, status: 403, error: 'В этом канале писать может только владелец' };
        }

        const encrypted = encryptText(text);
        const message = {
          id: randomUUID(),
          conversationId,
          senderId: user.id,
          ...encrypted,
          createdAt: nowIso()
        };
        store.messages.push(message);

        return {
          ok: true,
          message: {
            id: message.id,
            conversationId,
            senderId: user.id,
            senderUsername: user.username,
            text,
            createdAt: message.createdAt
          },
          targetUserIds: collectConversationUserIds(store, conversationId)
        };
      });

      if (!result.ok) {
        json(res, result.status || 400, result);
        return true;
      }

      broadcastToUsers(result.targetUserIds, 'message_new', result.message);
      json(res, 201, { ok: true, message: result.message });
      return true;
    }

    json(res, 404, { ok: false, error: 'API route not found' });
    return true;
  }

  return false;
}

function getContentType(filePath) {
  if (filePath.endsWith('.html')) return 'text/html; charset=utf-8';
  if (filePath.endsWith('.css')) return 'text/css; charset=utf-8';
  if (filePath.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (filePath.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'text/plain; charset=utf-8';
}

async function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  rel = rel.replace(/\\/g, '/');
  const safePath = path.normalize(rel).replace(/^([/\\])+/, '').replace(/^(\.\.(\/|\\|$))+/, '');
  const fullPath = path.join(PUBLIC_DIR, safePath);

  if (!fullPath.startsWith(PUBLIC_DIR)) {
    json(res, 403, { ok: false, error: 'Forbidden' });
    return;
  }

  try {
    const content = await fs.readFile(fullPath);
    res.writeHead(200, { 'Content-Type': getContentType(fullPath) });
    res.end(content);
  } catch {
    if (pathname !== '/') {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }

    const fallback = await fs.readFile(path.join(PUBLIC_DIR, 'index.html'));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(fallback);
  }
}

await ensureDataStore();

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const pathname = url.pathname;

    const handledApi = await handleApi(req, res, pathname);
    if (handledApi) {
      return;
    }

    await serveStatic(req, res, pathname);
  } catch (error) {
    console.error(error);
    json(res, 500, { ok: false, error: 'Internal server error' });
  }
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', async (req, socket, head) => {
  try {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    if (url.pathname !== '/ws') {
      socket.destroy();
      return;
    }

    const token = url.searchParams.get('token');
    const store = await readStore();
    const session = getSession(store, token);
    if (!session) {
      socket.destroy();
      return;
    }

    const user = getUserById(store, session.userId);
    if (!user) {
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.userId = user.id;
      wss.emit('connection', ws, req);
    });
  } catch {
    socket.destroy();
  }
});

wss.on('connection', (ws) => {
  const userId = ws.userId;
  if (!socketsByUserId.has(userId)) {
    socketsByUserId.set(userId, new Set());
  }
  socketsByUserId.get(userId).add(ws);

  websocketSend(ws, 'ready', { ok: true });

  ws.on('close', () => {
    const set = socketsByUserId.get(userId);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) {
      socketsByUserId.delete(userId);
    }
  });
});

server.listen(PORT, () => {
  console.log(`chat-mvp is running on http://localhost:${PORT}`);
});

