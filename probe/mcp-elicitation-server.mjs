// 最小 MCP server，唯一的用途是"触发 elicitation"。
//
// 为什么需要它（E115）：`mcpServer/elicitation/request` 是**服务端→客户端**的请求，
// 客户端无法自己发起，所以没有 elicitation 型 MCP server 就永远验证不到这条交互面。
// 这个 server 在 `tools/call` 里向客户端发一个 `elicitation/create` 请求
// （MCP 的 elicitation 就是这个方向：server 问 user），再把用户的回答当作工具结果返回。
//
// 它是测试夹具，不是产品代码：跑完就把它从 config 里摘掉。
//
// 用法（由 app-server 以 stdio 方式拉起）：
//   [mcp_servers.elicitation_probe]
//   command = "node"
//   args = ["/data/data/com.termux/files/home/codex-gui/probe/mcp-elicitation-server.mjs"]
import { createInterface } from "node:readline";

const TOOL = {
  name: "ask_me",
  description: "Ask the user one question through MCP elicitation and echo the answer back.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
};

let nextId = 1000;
const pendingOutgoing = new Map();

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\n");
}

// 向客户端（app-server）发一个请求，等它的响应。
function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pendingOutgoing.set(id, { resolve, reject });
    send({ jsonrpc: "2.0", id, method, params });
    setTimeout(() => {
      if (pendingOutgoing.delete(id)) reject(new Error(`${method} timed out`));
    }, 120000).unref();
  });
}

const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  const text = line.trim();
  if (!text) return;
  let message;
  try {
    message = JSON.parse(text);
  } catch {
    return;
  }

  // 客户端对我们的请求（elicitation 的响应）回到这里。
  if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
    const item = pendingOutgoing.get(message.id);
    if (!item) return;
    pendingOutgoing.delete(message.id);
    if (message.error) item.reject(new Error(message.error.message || JSON.stringify(message.error)));
    else item.resolve(message.result);
    return;
  }

  const { id, method, params } = message;
  if (id === undefined) return; // 通知，不用回

  try {
    if (method === "initialize") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: params?.protocolVersion || "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "elicitation-probe", version: "1.0.0" },
        },
      });
      return;
    }
    if (method === "tools/list") {
      send({ jsonrpc: "2.0", id, result: { tools: [TOOL] } });
      return;
    }
    if (method === "tools/call") {
      // 这就是被验证的那一步：从 server 侧发起 elicitation。
      const answer = await request("elicitation/create", {
        message: "请告诉我你的名字（MCP elicitation 测试）",
        requestedSchema: {
          type: "object",
          properties: {
            name: { type: "string", title: "你的名字", description: "随便写一个即可" },
            mode: { type: "string", title: "模式", enum: ["fast", "careful"] },
          },
          required: ["name"],
        },
      });
      send({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: "elicitation 返回：" + JSON.stringify(answer) }],
        },
      });
      return;
    }
    if (method === "ping") {
      send({ jsonrpc: "2.0", id, result: {} });
      return;
    }
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unsupported: ${method}` } });
  } catch (error) {
    send({ jsonrpc: "2.0", id, error: { code: -32000, message: error instanceof Error ? error.message : String(error) } });
  }
});

process.on("SIGTERM", () => process.exit(0));
