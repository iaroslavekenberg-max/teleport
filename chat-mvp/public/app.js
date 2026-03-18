const state = {
  token: localStorage.getItem('chat_token') || '',
  me: null,
  conversations: [],
  currentConversationId: '',
  socket: null
};

const authEl = document.getElementById('auth');
const appEl = document.getElementById('app');
const authErrorEl = document.getElementById('authError');
const meLabelEl = document.getElementById('meLabel');
const conversationsEl = document.getElementById('conversations');
const messagesEl = document.getElementById('messages');
const chatTitleEl = document.getElementById('chatTitle');
const chatMetaEl = document.getElementById('chatMeta');
const messageFormEl = document.getElementById('messageForm');
const messageInputEl = document.getElementById('messageInput');
const addMemberBtnEl = document.getElementById('addMemberBtn');

function setAuthError(message) {
  authErrorEl.textContent = message || '';
}

async function api(path, options = {}) {
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };
  if (state.token) {
    headers.Authorization = `Bearer ${state.token}`;
  }

  const response = await fetch(path, { ...options, headers });
  const data = await response.json().catch(() => ({ ok: false, error: 'Ошибка ответа сервера' }));
  if (!response.ok || !data.ok) {
    throw new Error(data.error || `HTTP ${response.status}`);
  }
  return data;
}

function saveToken(token) {
  state.token = token;
  localStorage.setItem('chat_token', token);
}

function clearToken() {
  state.token = '';
  localStorage.removeItem('chat_token');
}

function currentConversation() {
  return state.conversations.find((c) => c.id === state.currentConversationId) || null;
}

function renderConversations() {
  conversationsEl.innerHTML = '';
  for (const conversation of state.conversations) {
    const item = document.createElement('div');
    item.className = 'conversation-item';
    if (conversation.id === state.currentConversationId) {
      item.classList.add('active');
    }

    item.innerHTML = `
      <strong>${escapeHtml(conversation.title)}</strong>
      <div>${labelByType(conversation.type)}</div>
    `;

    item.addEventListener('click', async () => {
      state.currentConversationId = conversation.id;
      renderConversations();
      await loadMessages();
    });

    conversationsEl.appendChild(item);
  }
}

function labelByType(type) {
  if (type === 'direct') return 'Личный чат';
  if (type === 'group') return 'Группа';
  return 'Канал';
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function renderMessages(messages) {
  messagesEl.innerHTML = '';

  const conversation = currentConversation();
  if (!conversation) {
    chatTitleEl.textContent = 'Выберите чат';
    chatMetaEl.textContent = '';
    messageFormEl.classList.add('hidden');
    addMemberBtnEl.classList.add('hidden');
    return;
  }

  chatTitleEl.textContent = conversation.title;
  chatMetaEl.textContent = `${labelByType(conversation.type)} | участников: ${conversation.members.length}`;
  addMemberBtnEl.classList.toggle('hidden', conversation.ownerId !== state.me.id);
  messageFormEl.classList.remove('hidden');

  for (const message of messages) {
    const item = document.createElement('div');
    item.className = 'message';
    if (message.senderId === state.me.id) {
      item.classList.add('mine');
    }

    item.innerHTML = `
      <div class="meta">${escapeHtml(message.senderUsername)} | ${new Date(message.createdAt).toLocaleString()}</div>
      <div>${escapeHtml(message.text)}</div>
    `;
    messagesEl.appendChild(item);
  }

  messagesEl.scrollTop = messagesEl.scrollHeight;
}

async function loadMeAndConversations() {
  const meData = await api('/api/me');
  state.me = meData.user;
  meLabelEl.textContent = `@${state.me.username}`;

  const convData = await api('/api/conversations');
  state.conversations = convData.conversations;

  if (!state.currentConversationId && state.conversations.length > 0) {
    state.currentConversationId = state.conversations[0].id;
  }

  renderConversations();
  await loadMessages();
}

async function loadMessages() {
  const conversation = currentConversation();
  if (!conversation) {
    renderMessages([]);
    return;
  }

  const data = await api(`/api/conversations/${conversation.id}/messages`);
  renderMessages(data.messages);
}

function openApp() {
  authEl.classList.add('hidden');
  appEl.classList.remove('hidden');
  connectSocket();
}

function openAuth() {
  appEl.classList.add('hidden');
  authEl.classList.remove('hidden');
  if (state.socket) {
    state.socket.close();
    state.socket = null;
  }
}

function notifyIfNeeded(message) {
  if (document.visibilityState === 'visible') return;
  if (message.senderId === state.me.id) return;
  const conversation = state.conversations.find((c) => c.id === message.conversationId);
  if (!conversation) return;

  if (Notification.permission === 'granted') {
    new Notification(`Новое сообщение: ${conversation.title}`, {
      body: `${message.senderUsername}: ${message.text}`
    });
  }
}

function connectSocket() {
  if (!state.token) return;
  if (state.socket) {
    state.socket.close();
  }

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${location.host}/ws?token=${encodeURIComponent(state.token)}`;
  const socket = new WebSocket(url);
  state.socket = socket;

  socket.addEventListener('message', async (event) => {
    const msg = JSON.parse(event.data);

    if (msg.event === 'conversation_updated') {
      const incoming = msg.payload;
      const idx = state.conversations.findIndex((c) => c.id === incoming.id);
      if (idx >= 0) {
        state.conversations[idx] = incoming;
      } else {
        state.conversations.unshift(incoming);
      }
      renderConversations();
      return;
    }

    if (msg.event === 'message_new') {
      const message = msg.payload;
      notifyIfNeeded(message);
      if (message.conversationId === state.currentConversationId) {
        await loadMessages();
      }
    }
  });

  socket.addEventListener('close', () => {
    setTimeout(() => {
      if (state.token) {
        connectSocket();
      }
    }, 1500);
  });
}

document.getElementById('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  setAuthError('');

  const username = document.getElementById('loginUsername').value;
  const password = document.getElementById('loginPassword').value;

  try {
    const data = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({ username, password })
    });

    saveToken(data.token);
    openApp();
    await loadMeAndConversations();
  } catch (error) {
    setAuthError(error.message);
  }
});

document.getElementById('registerForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  setAuthError('');

  const username = document.getElementById('registerUsername').value;
  const password = document.getElementById('registerPassword').value;

  try {
    await api('/api/register', {
      method: 'POST',
      body: JSON.stringify({ username, password })
    });
    setAuthError('Регистрация успешна. Теперь войдите.');
  } catch (error) {
    setAuthError(error.message);
  }
});

document.getElementById('logoutBtn').addEventListener('click', () => {
  clearToken();
  state.me = null;
  state.conversations = [];
  state.currentConversationId = '';
  openAuth();
});

document.getElementById('newDirectBtn').addEventListener('click', async () => {
  const username = prompt('Username сотрудника для личного чата');
  if (!username) return;

  try {
    const data = await api('/api/conversations/direct', {
      method: 'POST',
      body: JSON.stringify({ username })
    });
    const idx = state.conversations.findIndex((c) => c.id === data.conversation.id);
    if (idx >= 0) state.conversations[idx] = data.conversation;
    else state.conversations.unshift(data.conversation);
    state.currentConversationId = data.conversation.id;
    renderConversations();
    await loadMessages();
  } catch (error) {
    alert(error.message);
  }
});

document.getElementById('newGroupBtn').addEventListener('click', async () => {
  const title = prompt('Название группы');
  if (!title) return;
  const membersRaw = prompt('Username участников через запятую (необязательно)') || '';
  const members = membersRaw.split(',').map((x) => x.trim()).filter(Boolean);

  try {
    const data = await api('/api/conversations/group', {
      method: 'POST',
      body: JSON.stringify({ title, members })
    });
    state.conversations.unshift(data.conversation);
    state.currentConversationId = data.conversation.id;
    renderConversations();
    await loadMessages();
  } catch (error) {
    alert(error.message);
  }
});

document.getElementById('newChannelBtn').addEventListener('click', async () => {
  const title = prompt('Название канала');
  if (!title) return;
  const membersRaw = prompt('Username подписчиков через запятую (необязательно)') || '';
  const members = membersRaw.split(',').map((x) => x.trim()).filter(Boolean);

  try {
    const data = await api('/api/conversations/channel', {
      method: 'POST',
      body: JSON.stringify({ title, members })
    });
    state.conversations.unshift(data.conversation);
    state.currentConversationId = data.conversation.id;
    renderConversations();
    await loadMessages();
  } catch (error) {
    alert(error.message);
  }
});

addMemberBtnEl.addEventListener('click', async () => {
  const conversation = currentConversation();
  if (!conversation) return;

  const username = prompt('Username нового участника');
  if (!username) return;

  try {
    await api(`/api/conversations/${conversation.id}/members`, {
      method: 'POST',
      body: JSON.stringify({ username })
    });
    await loadMeAndConversations();
  } catch (error) {
    alert(error.message);
  }
});

messageFormEl.addEventListener('submit', async (event) => {
  event.preventDefault();
  const conversation = currentConversation();
  if (!conversation) return;

  const text = messageInputEl.value.trim();
  if (!text) return;

  messageInputEl.value = '';

  try {
    await api(`/api/conversations/${conversation.id}/messages`, {
      method: 'POST',
      body: JSON.stringify({ text })
    });
  } catch (error) {
    alert(error.message);
  }
});

async function bootstrap() {
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {});
  }

  if (!state.token) {
    openAuth();
    return;
  }

  try {
    openApp();
    await loadMeAndConversations();
  } catch {
    clearToken();
    openAuth();
  }
}

bootstrap();

