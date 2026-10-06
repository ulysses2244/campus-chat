// state 是整个前端页面的“当前状态”。
// 页面上的列表和消息不会自己永久保存，而是根据 state 重新渲染。
// 这样可以把“数据”和“显示数据的 HTML”分开，后续修改页面会更容易。
const state = {
  // 当前登录用户，登录成功后由后端返回。
  currentUser: null,

  // 搜索结果中的其他用户。
  users: [],

  // 当前用户参与的会话列表。
  conversations: [],

  // 当前正在打开的会话；没有选择会话时为 null。
  selectedConversation: null,

  // EventSource 对象，负责接收后端推送的新消息。
  eventSource: null,
};

// 简化 document.querySelector 的写法。
// 例如 $('#message-input') 等价于 document.querySelector('#message-input')。
const $ = (selector) => document.querySelector(selector);

// 封装前端访问后端 API 的公共函数。
// path 是请求地址，例如 /api/users；options 中可以传 method 和 body。
// 这个函数统一完成三件事：发送请求、解析 JSON、处理错误状态码。
async function api(path, options = {}) {
  const response = await fetch(path, {
    // 所有 API 请求默认按照 JSON 发送。
    // GET 请求虽然通常没有 body，但设置这个请求头不会影响本项目。
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json();

  // response.ok 只在 HTTP 状态码为 200-299 时为 true。
  // 后端返回 400、401、403、404 等错误时，统一转成 JavaScript 异常，
  // 调用方可以用 try/catch 显示给用户。
  if (!response.ok) throw new Error(data.error || '请求失败');
  return data;
}

// 将用户输入转换成安全的 HTML 文本。
// 本项目使用 innerHTML 来快速渲染消息，如果不转义，
// 用户输入的 <script> 等内容可能会被浏览器当成真正的 HTML 执行。
// 因此展示昵称和消息前，都必须经过这个函数。
function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

// 把后端保存的 ISO 时间转换成页面上的“小时:分钟”。
// 后端保存完整时间，前端只展示当前聊天场景最需要的部分。
function formatTime(isoString) {
  return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit' }).format(new Date(isoString));
}

// 登录页面和聊天页面通过 hidden class 切换显示状态。
// 登录页面只负责收集昵称，聊天页面在登录成功后才显示。
function showLogin() {
  $('#login-view').classList.remove('hidden');
  $('#chat-view').classList.add('hidden');
}

// 进入聊天页面后，把当前用户昵称和头像首字显示到左侧个人信息区域。
function showChat() {
  $('#login-view').classList.add('hidden');
  $('#chat-view').classList.remove('hidden');
  $('#profile-name').textContent = state.currentUser.username;
  $('#profile-avatar').textContent = state.currentUser.username.slice(0, 1).toUpperCase();
}

// 修改连接状态文本和 CSS class。
// 连接成功显示绿色，连接出错显示“正在重连”，让用户知道实时功能是否可用。
function setConnectionStatus(text, className = '') {
  const element = $('#connection-status');
  element.textContent = text;
  element.className = `status-text ${className}`;
}

// 登录或注册用户。
// 由于后端没有密码系统，本项目把“输入昵称”简化成进入聊天室的动作。
// 成功后先保存当前用户，再加载用户列表和会话列表，最后建立 SSE 连接。
async function login(username) {
  const data = await api('/api/users', { method: 'POST', body: JSON.stringify({ username }) });
  state.currentUser = data.user;
  localStorage.setItem('campus-chat-user', JSON.stringify(state.currentUser));
  showChat();
  await Promise.all([loadUsers(), loadConversations()]);
  connectEvents();
}

// 根据搜索框中的文字请求用户列表。
// 每次调用都会覆盖 state.users，然后重新渲染左侧“查找同学”区域。
async function loadUsers() {
  const search = $('#search-input').value.trim();
  const data = await api(`/api/users?exclude=${encodeURIComponent(state.currentUser.id)}&search=${encodeURIComponent(search)}`);
  state.users = data.users;
  renderUsers();
}

// 请求当前用户参与的会话。
// 刷新页面、建立新会话、收到新消息后都需要重新加载，
// 这样最近消息预览和会话顺序才能保持最新。
async function loadConversations() {
  const data = await api(`/api/conversations?userId=${encodeURIComponent(state.currentUser.id)}`);
  state.conversations = data.conversations;
  renderConversations();
}

// 把 state.users 变成左侧用户列表的 HTML。
// 使用事件委托，所以这里生成的按钮只需要带上 data-user-id，
// 真正的点击处理统一写在文件底部的 users-list 监听器中。
function renderUsers() {
  const container = $('#users-list');
  if (!state.users.length) {
    container.innerHTML = '<p class="muted-empty">暂时没有匹配的同学。可以打开另一个窗口注册一个昵称。</p>';
    return;
  }
  container.innerHTML = state.users.map((user) => `
    <div class="list-item">
      <div class="list-item-main"><span class="mini-avatar">${escapeHtml(user.username.slice(0, 1))}</span><span>${escapeHtml(user.username)}</span></div>
      <button class="list-action" data-user-id="${user.id}" type="button">聊天</button>
    </div>
  `).join('');
}

// 把 state.conversations 变成最近会话列表。
// 当前打开的会话会增加 active class，让用户知道自己正在查看哪一项。
function renderConversations() {
  const container = $('#conversations-list');
  if (!state.conversations.length) {
    container.innerHTML = '<p class="muted-empty">还没有会话。</p>';
    return;
  }
  container.innerHTML = state.conversations.map((conversation) => {
    const active = state.selectedConversation?.id === conversation.id ? 'active' : '';
    const preview = conversation.lastMessage ? escapeHtml(conversation.lastMessage.content) : '开始聊天';
    return `
      <button class="list-item ${active}" data-conversation-id="${conversation.id}" type="button">
        <span class="list-item-main"><span class="mini-avatar">${escapeHtml(conversation.otherUser.username.slice(0, 1))}</span><span>${escapeHtml(conversation.otherUser.username)}</span></span>
        <span class="muted-empty">${preview}</span>
      </button>
    `;
  }).join('');
}

// 打开一个会话。
// 这里先更新当前会话和标题，再请求历史消息，最后渲染消息列表。
// 请求历史消息是“刷新后仍然能找回消息”的关键步骤之一。
async function openConversation(conversation) {
  state.selectedConversation = conversation;
  renderConversations();
  $('#conversation-header').innerHTML = `
    <div><p class="eyebrow">PRIVATE CONVERSATION</p><h2>${escapeHtml(conversation.otherUser.username)}</h2></div>
  `;
  $('#message-form').classList.remove('hidden');
  const data = await api(`/api/conversations/${conversation.id}/messages?userId=${encodeURIComponent(state.currentUser.id)}`);
  renderMessages(data.messages);
  $('#message-input').focus();
}

// 根据消息数组重新生成聊天区域。
// 每条消息都会根据 senderId 判断是否为当前用户发送，
// 从而决定气泡显示在左边还是右边。
function renderMessages(messages) {
  const container = $('#messages-list');
  container.classList.toggle('empty-state', messages.length === 0);
  if (!messages.length) {
    container.innerHTML = '<p>会话已经建立，发送第一条消息吧。</p>';
    return;
  }

  // map 把每条消息转换成 HTML，join('') 把 HTML 数组合并成一个字符串。
  container.innerHTML = messages.map((message) => {
    const mine = message.senderId === state.currentUser.id;
    return `
      <div class="message-row ${mine ? 'mine' : ''}">
        <div class="message-bubble">
          <p class="message-content">${escapeHtml(message.content)}</p>
          <span class="message-meta">${formatTime(message.createdAt)}</span>
        </div>
      </div>
    `;
  }).join('');

  // 新消息出现后自动滚动到底部，保证用户看到最新内容。
  container.scrollTop = container.scrollHeight;
}

// 创建或打开与某个用户的一对一会话。
// 后端会自动复用已经存在的相同会话，因此重复点击不会产生重复会话。
async function startConversation(otherUserId) {
  const data = await api('/api/conversations', {
    method: 'POST',
    body: JSON.stringify({ userId: state.currentUser.id, otherUserId }),
  });
  await loadConversations();
  await openConversation(data.conversation);
}

// 向当前会话发送消息。
// 真正的保存和推送由后端完成，这里只负责把发送者、会话和正文提交过去。
async function sendMessage(content) {
  if (!state.selectedConversation) return;
  await api(`/api/conversations/${state.selectedConversation.id}/messages`, {
    method: 'POST',
    body: JSON.stringify({ senderId: state.currentUser.id, content }),
  });
  $('#message-input').value = '';
}

// 建立浏览器到服务器的 SSE 长连接。
// EventSource 在连接断开后通常会自动尝试重连，
// 所以这里不需要自己写定时器不断请求服务器。
function connectEvents() {
  if (state.eventSource) state.eventSource.close();
  state.eventSource = new EventSource(`/api/events?userId=${encodeURIComponent(state.currentUser.id)}`);

  // 连接成功时更新状态。
  state.eventSource.onopen = () => setConnectionStatus('已连接', 'online');

  // 连接失败时不直接退出登录，显示重连状态，等待浏览器自动恢复连接。
  state.eventSource.onerror = () => setConnectionStatus('连接中断，正在重连...', 'offline');

  // 监听后端 broadcastToUsers 发送的 message 事件。
  state.eventSource.addEventListener('message', async (event) => {
    const { message } = JSON.parse(event.data);

    // 如果收到的消息属于当前正在查看的会话，就重新拉取该会话历史。
    // 重新拉取虽然比直接 append 一条消息多一次请求，但逻辑简单，
    // 并且可以确保页面和服务器保存的消息顺序一致。
    if (state.selectedConversation?.id === message.conversationId) {
      const data = await api(`/api/conversations/${message.conversationId}/messages?userId=${encodeURIComponent(state.currentUser.id)}`);
      renderMessages(data.messages);
    }

    // 即使用户当前没有打开这个会话，也要刷新左侧会话列表，
    // 让最后一条消息预览和排序及时更新。
    await loadConversations();
  });
}

// 登录表单提交事件。
// preventDefault 防止浏览器按照传统表单方式刷新整个页面，
// 后续登录流程由 JavaScript 异步完成。
$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#login-error').textContent = '';
  try {
    await login($('#username-input').value.trim());
  } catch (error) {
    $('#login-error').textContent = error.message;
  }
});

// 退出登录：关闭实时连接、删除浏览器中的当前用户缓存，然后刷新页面。
$('#logout-button').addEventListener('click', () => {
  state.eventSource?.close();
  localStorage.removeItem('campus-chat-user');
  window.location.reload();
});

// 搜索输入使用简单的防抖。
// 用户连续输入“张三”时，不要每敲一个字符就立即请求后端，
// 而是等待 250ms 没有继续输入后再搜索，减少无意义请求。
$('#search-input').addEventListener('input', () => {
  clearTimeout(window.searchTimer);
  window.searchTimer = setTimeout(() => loadUsers().catch(console.error), 250);
});

// 用户列表事件委托。
// users-list 容器本身只绑定一次监听器，点击内部按钮时通过 closest 找到具体用户 ID。
// 这样即使 renderUsers 重新替换了内部 HTML，监听器仍然有效。
$('#users-list').addEventListener('click', (event) => {
  const button = event.target.closest('[data-user-id]');
  if (button) startConversation(button.dataset.userId).catch((error) => alert(error.message));
});

// 最近会话列表也使用事件委托。
$('#conversations-list').addEventListener('click', (event) => {
  const button = event.target.closest('[data-conversation-id]');
  const conversation = state.conversations.find((item) => item.id === button?.dataset.conversationId);
  if (conversation) openConversation(conversation).catch((error) => alert(error.message));
});

// 发送消息表单事件。
// 空消息直接忽略，非空消息交给 sendMessage 发送。
$('#message-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const input = $('#message-input');
  const content = input.value.trim();
  if (!content) return;
  try {
    await sendMessage(content);
  } catch (error) {
    alert(error.message);
  }
});

// 页面初始化函数。
// 先检查 localStorage 中是否有上次登录的用户：
// - 没有用户：显示登录页；
// - 有用户：恢复聊天页、加载数据并重新建立 SSE 连接。
async function bootstrap() {
  const savedUser = localStorage.getItem('campus-chat-user');
  if (!savedUser) {
    showLogin();
    return;
  }
  try {
    // localStorage 保存的是字符串，所以需要 JSON.parse 还原成对象。
    state.currentUser = JSON.parse(savedUser);
    showChat();
    await Promise.all([loadUsers(), loadConversations()]);
    connectEvents();
  } catch {
    // 如果缓存格式错误，或者后端认为用户已经不存在，
    // 清除缓存并回到登录页面，避免页面停留在不可用状态。
    localStorage.removeItem('campus-chat-user');
    showLogin();
  }
}

// 脚本加载后立即开始初始化页面。
bootstrap();
