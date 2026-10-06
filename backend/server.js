// Node.js 自带的 http 模块可以创建一个最基础的 Web 服务器。
// 本项目没有引入 Express，是为了让初学者能直接看到：
// 浏览器请求是怎样进入后端、后端又是怎样返回响应的。
const http = require('node:http');

// fs 用来读写本地文件。这里把 JSON 文件当作一个非常简单的“小型数据库”。
// 真实项目通常会使用 SQLite、MySQL 或 PostgreSQL，但 JSON 更容易入门。
const fs = require('node:fs');

// path 用来拼接和规范化文件路径，避免手动拼接字符串时出现跨平台问题。
const path = require('node:path');

// crypto.randomUUID() 用来生成不会轻易重复的用户、会话和消息 ID。
const crypto = require('node:crypto');

// URL 用来解析请求地址中的路径和查询参数，例如：
// /api/users?search=张三 中的 pathname 和 searchParams。
const { URL } = require('node:url');

// 如果启动服务器时设置了 PORT 环境变量，就使用环境变量中的端口；
// 如果没有设置，就默认使用 3000 端口。
// 云平台通常会通过 PORT 环境变量告诉程序应该监听哪个端口。
// 本地没有这个变量时使用 3000，方便直接运行。
const PORT = Number(process.env.PORT) || 3000;

// 监听 0.0.0.0 表示接受来自本机和其他网络设备的访问。
// 如果只监听 localhost，云平台的外部请求无法进入 Node.js 服务。
const HOST = process.env.HOST || '0.0.0.0';

// 项目根目录位于 backend 的上一级目录。
// 后端除了提供 API，还会把 frontend 文件夹中的页面发送给浏览器。
const ROOT_DIR = path.resolve(__dirname, '..');
const FRONTEND_DIR = path.join(ROOT_DIR, 'frontend');

// 所有运行时数据都保存到 backend/data 目录中。
// 这个目录不存在时，ensureStore() 会自动创建它。
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'chat-data.json');

// SSE（Server-Sent Events）连接建立后不会立即结束，而是会保持打开状态。
// clients 用来保存当前在线的浏览器连接：
// key 是本次连接的临时 ID，value 中保存用户 ID 和对应的 HTTP 响应对象。
// 发送新消息时，后端会遍历它，找到会话双方并推送事件。
const clients = new Map();

// 创建一个空的数据仓库。
// 数据仓库的结构统一为：用户数组、会话数组、消息数组。
// 这样无论数据文件第一次创建，还是文件损坏后恢复，都有固定的数据结构。
function createEmptyStore() {
  return { users: [], conversations: [], messages: [] };
}

// 确保保存数据所需的目录和文件存在。
// mkdirSync 的 recursive: true 表示父目录不存在时一并创建。
// 这里使用同步方法，是因为它只在服务启动或每次读写前做很短的准备工作，
// 代码更直观，适合本项目的学习用途。
function ensureStore() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(createEmptyStore(), null, 2));
  }
}

// 从 JSON 文件读取全部数据。
// 返回值一定应该包含 users、conversations、messages 三个数组。
// 如果 JSON 被手动改坏，catch 会避免整个服务器直接崩溃，
// 同时退回到空数据，让服务器至少还能继续运行。
function readStore() {
  ensureStore();
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch (error) {
    console.error('读取数据文件失败，将使用空数据：', error.message);
    return createEmptyStore();
  }
}

// 把当前内存中的数据整体写回 JSON 文件。
// JSON.stringify 的第三个参数 2 用于格式化缩进，便于我们打开文件检查数据。
// 本项目每次新增用户、会话或消息时都会调用它，所以刷新页面后数据仍然存在。
function writeStore(store) {
  ensureStore();
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}

// 统一发送 JSON 响应。
// statusCode 表示 HTTP 状态码，例如 200 是成功，400 是请求错误，404 是资源不存在。
// 设置 Content-Type 后，浏览器和前端代码才知道响应内容是 JSON。
function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

// 统一发送错误响应，避免每个接口都重复写相同的 JSON 结构。
// 前端会读取返回值中的 error 字段，并把错误提示显示给用户。
function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { error: message });
}

// 读取 POST 请求中的 JSON 请求体。
// HTTP 请求的数据不是一次性直接放在 req.body 中，而是通过 data 事件分块到达，
// 所以需要先把每一块字符串拼接起来，等 end 事件发生后再统一 JSON.parse。
// 这里限制最大长度为 32KB，防止有人发送过大的请求占用服务器内存。
function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
      if (raw.length > 32 * 1024) {
        // 请求太大时主动终止连接，并让 Promise 进入 reject 分支。
        reject(new Error('请求内容过大'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!raw) {
        // 没有请求体时，统一返回空对象，避免调用方处理 null。
        resolve({});
        return;
      }
      try {
        // 前端通过 JSON.stringify 发送对象，后端需要 JSON.parse 把字符串还原成对象。
        resolve(JSON.parse(raw));
      } catch {
        // JSON 格式错误时不继续执行接口逻辑，交给最外层错误处理。
        reject(new Error('请求必须是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

// 对用户输入做最基础的文本清洗：
// 1. 只接受字符串，避免数字、对象等意外类型；
// 2. trim 去除首尾空格；
// 3. slice 限制最大长度，避免昵称或消息无限增长。
// 注意：这不是完整的安全方案，真正项目还需要更严格的校验和鉴权。
function text(value, maxLength) {
  return typeof value === 'string' ? value.trim().slice(0, maxLength) : '';
}

// 返回可以暴露给前端的用户字段。
// 以后如果用户对象中增加 password、token 等敏感字段，
// 只要不把它们写在这里，就不会意外返回给浏览器。
function publicUser(user) {
  return { id: user.id, username: user.username, createdAt: user.createdAt };
}

// 根据用户 ID 查找用户。
// find 找不到时返回 undefined，调用方可以据此判断用户是否存在。
function findUser(store, userId) {
  return store.users.find((user) => user.id === userId);
}

// 根据会话 ID 查找会话。
// 会话不存在时返回 undefined，后续的成员检查会拒绝这次请求。
function findConversation(store, conversationId) {
  return store.conversations.find((conversation) => conversation.id === conversationId);
}

// 权限检查的核心函数。
// 会话对象中保存了 userIds 数组，只有数组里包含 userId，
// 才说明这个用户是会话成员，允许查看或发送消息。
// 这类检查必须在后端完成，不能只依赖前端按钮是否显示。
function isConversationMember(conversation, userId) {
  return Boolean(conversation && conversation.userIds.includes(userId));
}

// 生成当前用户看到的会话摘要。
// 数据文件中的会话只保存两个成员 ID，前端更需要的是“对方昵称”和“最后一条消息”，
// 所以这里把原始会话数据加工成适合页面展示的结构。
function conversationForUser(store, conversation, userId) {
  // 一对一会话中，排除当前用户后剩下的 ID 就是聊天对象。
  const otherUserId = conversation.userIds.find((id) => id !== userId);
  const otherUser = findUser(store, otherUserId);

  // 找到属于当前会话的所有消息，再取最后一条作为会话列表预览。
  const messages = store.messages.filter((message) => message.conversationId === conversation.id);
  const lastMessage = messages.at(-1) || null;
  return {
    id: conversation.id,
    otherUser: otherUser ? publicUser(otherUser) : null,
    createdAt: conversation.createdAt,
    lastMessage,
  };
}

// 向指定用户的所有在线连接发送 SSE 事件。
// SSE 格式要求每条事件至少包含 data 行，并以两个换行符结束。
// event 行用于区分事件名称，前端可以用 addEventListener('message', ...) 监听。
function broadcastToUsers(userIds, eventName, payload) {
  const message = `event: ${eventName}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const client of clients.values()) {
    if (userIds.includes(client.userId)) {
      // response 仍然打开时，write 会把事件推送给浏览器。
      // 如果浏览器断开，close 事件会把它从 clients 中删除。
      client.response.write(message);
    }
  }
}

// 发送前端静态文件，例如 index.html、styles.css 和 app.js。
// 访问根路径 / 时，默认返回 frontend/index.html。
function serveStatic(res, pathname) {
  const requestedPath = pathname === '/' ? '/index.html' : pathname;

  // path.resolve 会把路径规范化成绝对路径。
  // 例如用户构造 /../backend/server.js 时，最终路径会落到 frontend 目录之外。
  const filePath = path.resolve(FRONTEND_DIR, `.${requestedPath}`);
  if (!filePath.startsWith(FRONTEND_DIR)) {
    sendError(res, 403, '禁止访问该文件');
    return;
  }

  // 先检查文件是否存在且确实是普通文件，再创建读取流。
  fs.stat(filePath, (statError, stats) => {
    if (statError || !stats.isFile()) {
      sendError(res, 404, '页面不存在');
      return;
    }

    // 浏览器根据 Content-Type 决定如何解析响应。
    // 如果扩展名不在列表中，就使用二进制类型作为兜底。
    const extensions = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
    };
    res.writeHead(200, {
      'Content-Type': extensions[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });

    // 使用流读取文件，避免一次性把整个文件读到内存中。
    fs.createReadStream(filePath).pipe(res);
  });
}

// 所有 API 请求的统一入口。
// 通过 method + pathname 区分不同接口，类似一个非常简化的路由系统。
// 每个分支完成自己的校验、数据处理和响应后都要 return，
// 这样后面的分支不会再次处理同一个请求。
async function handleApi(req, res, url) {
  const store = readStore();
  const method = req.method || 'GET';
  const pathname = url.pathname;

  // 健康检查接口：用于快速确认服务器是否正常启动。
  if (method === 'GET' && pathname === '/api/health') {
    sendJson(res, 200, { ok: true, time: new Date().toISOString() });
    return;
  }

  // 用户进入聊天室。
  // 本项目没有密码系统，所以“输入昵称”同时承担注册和登录的作用。
  if (method === 'POST' && pathname === '/api/users') {
    const body = await parseBody(req);
    const username = text(body.username, 20);
    if (username.length < 2) {
      sendError(res, 400, '用户名至少需要 2 个字符');
      return;
    }

    // 同名用户复用旧记录，避免每次刷新都创建一个新用户。
    let user = store.users.find((item) => item.username === username);
    if (!user) {
      // 新用户需要一个稳定的 ID，后续会话和消息都通过这个 ID 关联。
      user = { id: crypto.randomUUID(), username, createdAt: new Date().toISOString() };
      store.users.push(user);
      writeStore(store);
    }
    sendJson(res, 200, { user: publicUser(user) });
    return;
  }

  // 搜索其他用户。
  // exclude 参数用于排除当前登录者自己，search 参数用于昵称模糊搜索。
  if (method === 'GET' && pathname === '/api/users') {
    const currentUserId = url.searchParams.get('exclude') || '';
    const search = text(url.searchParams.get('search') || '', 20).toLowerCase();
    const users = store.users
      .filter((user) => user.id !== currentUserId)
      .filter((user) => !search || user.username.toLowerCase().includes(search))
      .map(publicUser);
    sendJson(res, 200, { users });
    return;
  }

  // 获取当前用户参与的所有会话。
  if (method === 'GET' && pathname === '/api/conversations') {
    const userId = url.searchParams.get('userId') || '';
    if (!findUser(store, userId)) {
      sendError(res, 401, '请先登录');
      return;
    }
    const conversations = store.conversations
      .filter((conversation) => isConversationMember(conversation, userId))
      .map((conversation) => conversationForUser(store, conversation, userId))
      .sort((a, b) => (b.lastMessage?.createdAt || b.createdAt).localeCompare(a.lastMessage?.createdAt || a.createdAt));
    sendJson(res, 200, { conversations });
    return;
  }

  // 创建或复用一对一会话。
  if (method === 'POST' && pathname === '/api/conversations') {
    const body = await parseBody(req);
    const userId = text(body.userId, 100);
    const otherUserId = text(body.otherUserId, 100);
    if (!findUser(store, userId) || !findUser(store, otherUserId) || userId === otherUserId) {
      sendError(res, 400, '会话成员不合法');
      return;
    }

    // 排序后再比较两个用户 ID，这样 A 找 B 和 B 找 A 得到的 key 相同，
    // 可以防止同一对用户被重复创建两条会话。
    const userIds = [userId, otherUserId].sort();
    let conversation = store.conversations.find((item) =>
      item.userIds.length === 2 && item.userIds[0] === userIds[0] && item.userIds[1] === userIds[1]
    );
    if (!conversation) {
      // 第一次聊天才真正写入会话记录，之后重复点击“聊天”只返回原会话。
      conversation = { id: crypto.randomUUID(), userIds, createdAt: new Date().toISOString() };
      store.conversations.push(conversation);
      writeStore(store);
    }
    sendJson(res, 200, { conversation: conversationForUser(store, conversation, userId) });
    return;
  }

  // 用正则提取动态路径参数 conversationId。
  // 例如 /api/conversations/abc/messages 会提取出 abc。
  const messagesMatch = pathname.match(/^\/api\/conversations\/([^/]+)\/messages$/);
  if (messagesMatch && method === 'GET') {
    // 查询历史消息时，同样要校验请求者是否属于这个会话，
    // 防止任意用户通过修改 URL 读取别人的聊天记录。
    const conversation = findConversation(store, messagesMatch[1]);
    const userId = url.searchParams.get('userId') || '';
    if (!isConversationMember(conversation, userId)) {
      sendError(res, 403, '你不是该会话的成员');
      return;
    }
    const messages = store.messages.filter((message) => message.conversationId === conversation.id);
    sendJson(res, 200, { messages });
    return;
  }

  // 发送一条新消息。
  if (messagesMatch && method === 'POST') {
    const conversation = findConversation(store, messagesMatch[1]);
    const body = await parseBody(req);
    const senderId = text(body.senderId, 100);
    const content = text(body.content, 1000);
    // 发送者 ID 来自请求体，但不能因为客户端传了一个 ID 就相信它。
    // 必须重新根据会话记录确认发送者确实是成员。
    if (!isConversationMember(conversation, senderId)) {
      sendError(res, 403, '你不是该会话的成员');
      return;
    }
    if (!content) {
      sendError(res, 400, '消息不能为空');
      return;
    }

    // 只有完成校验后才创建消息对象。
    // createdAt 使用 ISO 字符串，便于保存、排序和在不同客户端显示。
    const message = {
      id: crypto.randomUUID(),
      conversationId: conversation.id,
      senderId,
      content,
      createdAt: new Date().toISOString(),
    };
    // 先持久化，再广播。
    // 这样可以保证用户看到的消息已经写入数据文件，刷新后仍然找得到。
    store.messages.push(message);
    writeStore(store);
    broadcastToUsers(conversation.userIds, 'message', { message });
    sendJson(res, 201, { message });
    return;
  }

  // 建立 SSE 长连接。
  // 请求完成后不会调用 res.end()，因为服务器需要继续保持连接，
  // 以后有新消息时可以主动向浏览器写入事件。
  if (method === 'GET' && pathname === '/api/events') {
    const userId = url.searchParams.get('userId') || '';
    if (!findUser(store, userId)) {
      sendError(res, 401, '请先登录');
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    });
    // 冒号开头的内容是 SSE 注释，浏览器不会把它当成业务事件，
    // 但可以用来告诉客户端连接已经建立。
    res.write(': connected\n\n');
    const clientId = crypto.randomUUID();
    clients.set(clientId, { userId, response: res });

    // 浏览器刷新、关闭标签页或网络断开时，Node 会触发 close。
    // 及时删除连接，避免 clients 中积累已经失效的响应对象。
    req.on('close', () => clients.delete(clientId));
    return;
  }

  sendError(res, 404, 'API 不存在');
}

// 创建 HTTP 服务器。
// 每次收到请求时，先解析 URL，再决定交给 API 路由还是静态文件服务。
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      // /api/ 开头的请求全部交给 API 处理。
      await handleApi(req, res, url);
      return;
    }
    if (req.method === 'GET') {
      // 其他 GET 请求视为页面或静态资源请求。
      serveStatic(res, url.pathname);
      return;
    }
    // 当前项目只为静态资源提供 GET，其他未匹配方法返回 405。
    sendError(res, 405, '只支持 GET 请求');
  } catch (error) {
    // 任何未捕获异常都会来到这里，避免服务器进程直接退出。
    console.error(error);
    if (!res.headersSent) {
      sendError(res, 500, '服务器内部错误');
    } else {
      res.end();
    }
  }
});

// 启动前先创建数据文件，确保服务刚启动时数据目录已经存在。
ensureStore();
server.listen(PORT, HOST, () => {
  // listen 回调只在端口成功监听后执行，说明浏览器现在可以访问服务。
  // HOST 可能是 0.0.0.0，它代表“所有网卡”，不是用户实际输入浏览器的地址。
  const displayHost = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`校园聊天室已启动：http://${displayHost}:${PORT}`);
  console.log(`数据文件：${DATA_FILE}`);
});
