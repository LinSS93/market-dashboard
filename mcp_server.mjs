// MCP (Model Context Protocol) 只读接口 — Streamable HTTP transport
//
// 让 AI agent（Trae / Claude / Cursor 等）通过 JSON-RPC 2.0 读取看板数据。
// 端点：POST /mcp（Streamable HTTP，支持 application/json 响应）。
//
// 安全：只读 — 仅暴露查询类工具，复用 server.mjs 已导入的数据函数（进程内缓存）。
// 遵循 MCP 规范 2025-06-18 的 Streamable HTTP transport：
//   - 客户端每个 JSON-RPC 消息发一次 POST 到 /mcp
//   - 服务端返回单个 JSON 对象（Content-Type: application/json）
//   - 交互顺序：initialize -> notifications/initialized -> tools/list -> tools/call
//
// 工具集覆盖：
//   - 股票监控（stock_*）：watchlist / analysis / positions / signal-audit / alerts
//   - 机会雷达 v2（radar_v2_*）：candidates / candidate-detail / runs / stats / dossiers / opportunities / queue

const PROTOCOL_VERSION = '2025-06-18';
const SERVER_INFO = { name: 'market-dashboard-mcp', version: '0.1.0' };

// 工具定义与处理器。handler 通过 deps 调用 server.mjs 注入的数据函数（只读）。
// args 为 tools/call 的 arguments；返回值会被 JSON 序列化后返回给 agent。
function defineTools(deps) {
  return [
    {
      name: 'stock_watchlist',
      description: '读取股票监控自选股列表（代码、市场、所属分组）。',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      handler: async () => deps.getWatchlist(),
    },
    {
      name: 'stock_analysis',
      description: '读取全部自选股的实时分析结果（信号/档位、现价、波段判定等），返回按 symbol 索引的对象。',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      handler: async () => deps.getLatestAnalysis(),
    },
    {
      name: 'stock_positions',
      description: '读取当前持仓（由操作事件推算的持仓状态）。',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      handler: async () => deps.getStockPositions(),
    },
    {
      name: 'stock_signal_audit',
      description: '读取某只自选股的信号审计记录（历史信号档位变更）。',
      inputSchema: {
        type: 'object',
        properties: {
          symbol: { type: 'string', description: '股票代码（大写，如 AAPL）' },
          limit: { type: 'integer', description: '返回条数上限，默认 200' },
        },
        required: ['symbol'],
        additionalProperties: false,
      },
      handler: async ({ symbol, limit }) => deps.getStockSignalAudit(symbol, limit || 200),
    },
    {
      name: 'stock_alerts',
      description: '读取最近的通知/告警审计记录（含渠道、信号、状态）。',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: '返回条数上限，默认 200' },
          symbol: { type: 'string', description: '按代码过滤' },
        },
        additionalProperties: false,
      },
      handler: async ({ limit, symbol }) => deps.getAlertAudit({ limit: limit || 200, symbol: symbol || '' }),
    },
    {
      name: 'radar_v2_candidates',
      description: '读取机会雷达 v2 的候选标的列表（按优先级排序）。',
      inputSchema: {
        type: 'object',
        properties: {
          market: { type: 'string', description: '市场，如 US / CN / HK / KR' },
          limit: { type: 'integer', description: '返回条数上限，默认 50' },
          tier: { type: 'string', description: '按档位过滤' },
        },
        additionalProperties: false,
      },
      handler: async ({ market, limit, tier }) => deps.getRadarTopCandidates({ market, limit: limit || 50, tier }),
    },
    {
      name: 'radar_v2_candidate_detail',
      description: '读取某个雷达 v2 候选标的的详情（含 outcome）。',
      inputSchema: {
        type: 'object',
        properties: {
          market: { type: 'string', description: '市场，如 US' },
          symbol: { type: 'string', description: '股票代码' },
        },
        required: ['market', 'symbol'],
        additionalProperties: false,
      },
      handler: async ({ market, symbol }) => deps.getRadarCandidateDetail(market, symbol),
    },
    {
      name: 'radar_v2_runs',
      description: '读取雷达 v2 的扫描历史记录。',
      inputSchema: {
        type: 'object',
        properties: {
          market: { type: 'string', description: '市场' },
          limit: { type: 'integer', description: '返回条数上限，默认 20' },
        },
        additionalProperties: false,
      },
      handler: async ({ market, limit }) => deps.getRadarRunHistory({ market, limit: limit || 20 }),
    },
    {
      name: 'radar_v2_stats',
      description: '读取雷达 v2 的扫描统计信息。',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
      handler: async () => deps.getRadarScanStats(),
    },
    {
      name: 'radar_v2_dossiers',
      description: '读取雷达 v2 的研究档案列表。',
      inputSchema: {
        type: 'object',
        properties: {
          market: { type: 'string', description: '市场' },
          status: { type: 'string', description: '状态，默认 active；传空字符串返回所有状态' },
          channel: { type: 'string', description: '渠道过滤' },
          limit: { type: 'integer', description: '返回条数上限，默认 50' },
        },
        additionalProperties: false,
      },
      handler: async ({ market, status, channel, limit }) => deps.listRadarDossiers({ market, status, channel, limit: limit || 50 }),
    },
    {
      name: 'radar_v2_dossier_detail',
      description: '读取某个雷达 v2 研究档案的详情（含 source_refs、observations、评估审计）。',
      inputSchema: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: '档案 id' },
        },
        required: ['id'],
        additionalProperties: false,
      },
      handler: async ({ id }) => deps.getRadarDossierDetail(Number(id)),
    },
    {
      name: 'radar_v2_opportunities',
      description: '读取雷达 v2 的投资机会列表（confirmed dossier + candidate 聚合，按优先级排序）。',
      inputSchema: {
        type: 'object',
        properties: {
          market: { type: 'string', description: '市场' },
          channel: { type: 'string', description: '渠道过滤' },
          limit: { type: 'integer', description: '返回条数上限，默认 50' },
        },
        additionalProperties: false,
      },
      handler: async ({ market, channel, limit }) => deps.listRadarOpportunities({ market, channel, limit: limit || 50 }),
    },
    {
      name: 'radar_v2_queue',
      description: '读取雷达 v2 的研究队列。',
      inputSchema: {
        type: 'object',
        properties: {
          market: { type: 'string', description: '市场' },
          limit: { type: 'integer', description: '返回条数上限，默认 30' },
          search: { type: 'string', description: '按代码/名称服务端搜索整个候选池' },
        },
        additionalProperties: false,
      },
      handler: async ({ market, limit, search }) => deps.listRadarResearchQueue({ market, limit: limit || 30, search }),
    },
  ];
}

// JSON-RPC 内部工具
function jsonRpcError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: '2.0', id, error: err };
}
function jsonRpcResult(id, result) {
  return { jsonrpc: '2.0', id, result };
}

// 校验 Origin 头，防 DNS rebinding（MCP 规范强制要求）。
// 经 Caddy HTTPS 反代的浏览器会带公共 HTTPS Origin；该 Origin 必须显式写入
// MCP_ALLOWED_ORIGINS，且连接本身仍必须来自 loopback proxy。
function isAllowedOrigin(origin) {
  if (!origin) return true; // 本地 CLI 客户端可能不带 Origin
  try {
    const u = new URL(origin);
    const host = u.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') return true;
    const configured = String(process.env.MCP_ALLOWED_ORIGINS || '')
      .split(',')
      .map((value) => value.trim().replace(/\/$/, ''))
      .filter(Boolean);
    return configured.includes(u.origin.replace(/\/$/, ''));
  } catch { return false; }
}

function isLoopbackPeer(req) {
  const remote = String(req.socket?.remoteAddress || req.connection?.remoteAddress || '').toLowerCase();
  return remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';
}

/**
 * 处理 MCP 请求（挂载在 server.mjs 的 /mcp）。
 * @param {object} req - 原生 http request
 * @param {object} res - 原生 http response
 * @param {object} deps - 注入的数据访问函数（只读）
 * @returns {Promise<boolean>} 是否已处理
 */
export async function registerMcpRoutes(req, res, p, u, readBody, deps) {
  if (p !== '/mcp') return false;

  // Node 8080 同时承载看板 UI。MCP 不应因“无 Origin 的本地 CLI”例外而暴露给
  // 局域网直连：外部访问必须先经同机 Caddy，再由 Caddy 从 loopback 转发。
  if (!isLoopbackPeer(req)) {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(jsonRpcError(null, -32600, 'MCP requires loopback or trusted local proxy')));
    return true;
  }

  // 安全：仅允许 localhost/localhost 来源的 Origin，防 DNS rebinding
  const origin = req.headers?.origin;
  if (!isAllowedOrigin(origin)) {
    res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(jsonRpcError(null, -32600, 'Invalid Origin')));
    return true;
  }

  // GET：规范要求服务端要么返回 SSE 流，要么 405。本实现不维护 SSE 流，返回 405。
  if (req.method === 'GET') {
    res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8', 'Allow': 'POST' });
    res.end(JSON.stringify({ ok: false, error: 'MCP endpoint only accepts POST (no SSE stream is offered)' }));
    return true;
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8', 'Allow': 'POST' });
    res.end(JSON.stringify(jsonRpcError(null, -32600, 'Method not allowed')));
    return true;
  }

  const bodyStr = await readBody(req);
  let msg;
  try { msg = JSON.parse(bodyStr || '{}'); }
  catch { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(jsonRpcError(null, -32700, 'Parse error'))); return true; }

  const id = msg.id ?? null;
  const method = msg.method;
  const params = msg.params || {};

  // tools 列表（懒构建一次，避免每次请求重建）
  const tools = deps._tools || (deps._tools = defineTools(deps));

  try {
    switch (method) {
      case 'initialize': {
        const result = {
          protocolVersion: (params.protocolVersion && params.protocolVersion <= PROTOCOL_VERSION) ? params.protocolVersion : PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
        };
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(jsonRpcResult(id, result)));
        return true;
      }
      case 'notifications/initialized': {
        // 通知：无响应体，返回 202
        res.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end();
        return true;
      }
      case 'tools/list': {
        const result = { tools: tools.map(t => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) };
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(jsonRpcResult(id, result)));
        return true;
      }
      case 'tools/call': {
        const tool = tools.find(t => t.name === params.name);
        if (!tool) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(jsonRpcResult(id, {
            content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${params.name}` }) }],
            isError: true,
          })));
          return true;
        }
        try {
          const raw = await tool.handler(params.arguments || {});
          const text = typeof raw === 'string' ? raw : JSON.stringify(raw, null, 2);
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(jsonRpcResult(id, { content: [{ type: 'text', text }], isError: false })));
        } catch (e) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify(jsonRpcResult(id, {
            content: [{ type: 'text', text: JSON.stringify({ error: String(e?.message || e) }) }],
            isError: true,
          })));
        }
        return true;
      }
      default: {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(jsonRpcError(id, -32601, `Method not found: ${method || '(empty)'}`)));
        return true;
      }
    }
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(jsonRpcError(id, -32603, String(e?.message || e))));
    return true;
  }
}
