# 校园聊天室

这是一个面向 Scout 招新题目的轻量一对一聊天室练习项目。它实现了题目要求的完整链路：用户注册/进入、查找其他用户、建立会话、发送和接收消息，以及刷新页面后恢复历史消息。

## 技术选择

- 前端：原生 HTML、CSS、JavaScript
- 后端：Node.js 原生 `http` 模块
- 实时推送：Server-Sent Events（浏览器端 `EventSource`）
- 数据保存：后端本地 JSON 文件
- 第三方依赖：无

不依赖 npm 包是为了让初学者能先理解完整流程。客户端通过 `fetch` 发送请求，服务端把消息写入 JSON 后，再通过 SSE 推给当前会话的双方。

## 如何启动

1. 安装 Node.js 18 或更高版本。
2. 在项目根目录打开终端。
3. 启动后端：

   ```powershell
   node .\backend\server.js
   ```

   如果本机安装了 npm，也可以执行：

   ```powershell
   npm --prefix .\backend start
   ```

4. 浏览器打开 `http://localhost:3000`。

## 如何让别人通过互联网访问

本地的 `localhost` 只能被你自己的电脑访问。要让别人访问，需要把项目部署到一台有公网地址的服务器。对于本项目，最简单的方式是使用 Render 部署一个 Node Web Service。

### 方式一：部署到 Render，适合提交演示

1. 在 GitHub 新建一个仓库。
2. 把整个项目上传到 GitHub，注意 `frontend`、`backend`、`render.yaml` 都要上传。
3. 注册并登录 Render。
4. 选择从 GitHub 创建新的 Web Service，并选择这个仓库。
5. 如果 Render 自动读取 `render.yaml`，直接确认配置；如果需要手动填写：
   - Runtime：`Node`
   - Root Directory：`backend`
   - Build Command：留空
   - Start Command：`node server.js`
   - Health Check Path：`/api/health`
6. 点击部署，等待构建完成。
7. Render 会生成一个公网 HTTPS 地址，例如 `https://你的项目名.onrender.com`，把这个地址发给别人即可。

这个项目已经通过 `render.yaml` 写好了上面的配置。服务器会根据云平台提供的 `PORT` 环境变量启动，并监听 `0.0.0.0`，所以不需要手动修改端口。

### 方式二：只在同一个 Wi-Fi 下给同学访问

这种方式不需要部署到互联网，但访问者必须和你的电脑连接同一个路由器：

1. 在你的电脑运行 `ipconfig`。
2. 找到当前网络适配器的 IPv4 地址，例如 `192.168.1.23`。
3. 启动服务器：`node .\\backend\\server.js`。
4. 让同学打开 `http://192.168.1.23:3000`。

如果打不开，通常是 Windows 防火墙没有允许 Node.js 接受专用网络访问。这个地址只适合现场演示，不适合作为长期网站。

### 数据保存的重要说明

当前消息保存在 `backend/data/chat-data.json`。它可以满足本地演示和答辩要求，但很多云平台的普通 Web Service 文件系统不是永久磁盘，服务重启、重新部署或迁移后，JSON 数据可能丢失。

因此：

- 面试现场演示：当前 JSON 方案足够。
- 想长期给别人使用：需要把消息保存改成 SQLite、PostgreSQL 或其他云数据库。
- 想保护真实用户：还需要密码登录、身份验证、HTTPS、限流和更严格的权限校验。

## 如何演示

1. 第一个浏览器窗口输入昵称“张三”。
2. 再打开一个隐私窗口或其他浏览器，输入昵称“李四”。
3. 在“查找同学”中搜索对方，点击“聊天”。
4. 任意一方发送消息，另一方会收到实时更新。
5. 刷新页面，重新打开同一个会话，历史消息仍然存在。

## 已实现功能

- 使用昵称进入聊天室
- 搜索用户
- 建立唯一的一对一会话
- 双方发送和接收消息
- 消息写入 `backend/data/chat-data.json`
- 刷新页面后恢复用户、会话和历史消息
- SSE 连接断开后由浏览器自动重连
- 基础输入校验和 HTML 转义，避免直接把消息当 HTML 插入页面

## 已知问题

- 当前没有密码和真正的登录鉴权，同一个昵称会被视为同一个用户，仅适合本地演示。
- JSON 文件适合小规模学习项目，不适合很多人同时写入或生产环境。
- 当前只支持一对一会话，没有群聊、图片、未读数和消息撤回。
- SSE 是单向推送，因此客户端发送消息仍然使用普通 HTTP POST；如果要做更复杂的双向通信，可以升级为 WebSocket。

## 目录结构

```text
frontend/
  index.html       页面结构
  styles.css       页面样式
  app.js           登录、会话、收发消息逻辑
backend/
  server.js        HTTP API、SSE 推送、静态文件服务
  package.json     可选的启动脚本
  data/            运行后自动生成消息数据
docs/
  design.md        设计说明和答辩思路
```

## 适合答辩的一句话

“发送消息时，前端用 POST 把会话 ID、发送者 ID 和消息内容交给后端；后端先校验会话成员，再写入 JSON 文件，写入成功后通过 SSE 广播给会话双方。页面刷新时重新请求历史消息，所以消息不会只存在于内存中。”
