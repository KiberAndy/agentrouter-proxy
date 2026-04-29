import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

// ─── Resolve paths relative to the .exe (or script) location ───
const EXE_DIR = path.dirname(process.execPath.endsWith('.exe') ? process.execPath : process.argv[1]);
const CONFIG_PATH = path.join(EXE_DIR, 'config.txt');
const LOG_PATH = path.join(EXE_DIR, 'proxy-errors.log');

// ─── Colors for console ───
const c = {
  reset: '\x1b[0m', bright: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m',
  red: '\x1b[31m', magenta: '\x1b[35m', white: '\x1b[37m',
  bgGreen: '\x1b[42m',
};

// ─── Config ───
interface Config { port: number; agentRouterUrl: string; timeoutMs: number; }

const CONFIG_DEFAULTS: Config = { port: 3001, agentRouterUrl: 'https://agentrouter.org/v1', timeoutMs: 120_000 };
const CONFIG_TEMPLATE = `# Agent Router Proxy — Настройки\nPORT=3001\nAGENT_ROUTER_URL=https://agentrouter.org/v1\nTIMEOUT_MS=120000\n`;

function applyPort(result: Config, val: string): void {
  const p = Number.parseInt(val, 10);
  if (Number.isNaN(p) || p < 1 || p > 65535) console.warn(`  ${c.yellow}⚠ Неверный PORT="${val}", использую 3001${c.reset}`);
  else result.port = p;
}

function applyUrl(result: Config, val: string): void {
  try { new URL(val); result.agentRouterUrl = val; }
  catch { console.warn(`  ${c.yellow}⚠ Неверный AGENT_ROUTER_URL="${val}", использую дефолт${c.reset}`); }
}

function applyTimeout(result: Config, val: string): void {
  const p = Number.parseInt(val, 10);
  if (Number.isNaN(p) || p < 1000) console.warn(`  ${c.yellow}⚠ Неверный TIMEOUT_MS="${val}", использую 120000${c.reset}`);
  else result.timeoutMs = p;
}

function parseConfigLine(result: Config, line: string): void {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith('#')) return;
  const eqIdx = trimmed.indexOf('=');
  if (eqIdx < 0) return;
  const key = trimmed.slice(0, eqIdx).trim();
  const val = trimmed.slice(eqIdx + 1).trim();
  if (key === 'PORT') applyPort(result, val);
  else if (key === 'AGENT_ROUTER_URL') applyUrl(result, val);
  else if (key === 'TIMEOUT_MS') applyTimeout(result, val);
}

function readConfig(): Config {
  if (!fs.existsSync(CONFIG_PATH)) {
    fs.writeFileSync(CONFIG_PATH, CONFIG_TEMPLATE, 'utf-8');
    return { ...CONFIG_DEFAULTS };
  }
  const result = { ...CONFIG_DEFAULTS };
  for (const line of fs.readFileSync(CONFIG_PATH, 'utf-8').split('\n')) {
    parseConfigLine(result, line);
  }
  return result;
}

// ─── Scrubbing ───
const SCRUB_PATTERNS: Array<[RegExp, string]> = [
  [/vpn[_\-\s]*russia[_\-\s]*\w*/gi, 'session_x'],
  [/russia[_\-\s]*vpn[_\-\s]*\w*/gi, 'session_x'],
  [/sender=[\w\-]+/g, 'sender=user'],
];
function scrub(body: string): string {
  let out = body;
  for (const [re, repl] of SCRUB_PATTERNS) out = out.replace(re, repl);
  return out;
}

// ─── Model routing ───
const MODEL_PREFIX_MAP: Record<string, string> = {
  '/haiku': 'claude-haiku-4-5-20251001',
  '/deepseek': 'deepseek-v3.2',
  '/glm': 'glm-5.1',
  '/opus': 'claude-opus-4-6',
};
const SENSITIVE_RE = /sensitive_words_detected|sensitive words detected|content[_-]?blocked/i;
const RATE_LIMIT_RE = /Too Many Requests|总请求数限制|rate.?limit/i;
type Attempt = { model: string; reduce: boolean };
const ATTEMPTS: Attempt[] = [
  { model: 'claude-haiku-4-5-20251001', reduce: false },
  { model: 'claude-haiku-4-5-20251001', reduce: true },
  { model: 'deepseek-v3.2', reduce: true },
];

function reduceMessages(body: string): string {
  try {
    const j = JSON.parse(body);
    const msgs = j.messages || [];
    const sys = msgs.find((m: any) => m.role === 'system');
    const lastUser = [...msgs].reverse().find((m: any) => m.role === 'user');
    j.messages = [sys, lastUser].filter(Boolean);
    return JSON.stringify(j);
  } catch { return body; }
}

function logFailure(status: number, url: string, body: string, response: string) {
  try {
    fs.appendFileSync(LOG_PATH,
      `\n=== ${new Date().toISOString()} status=${status} url=${url} ===\nREQUEST:\n${(body||'').slice(0,4000)}\nRESPONSE:\n${response.slice(0,800)}\n`);
  } catch {}
}

// ─── Stats ───
let totalRequests = 0, successRequests = 0, failedRequests = 0;
const startTime = Date.now();
function uptime(): string {
  const sec = Math.floor((Date.now() - startTime) / 1000);
  return `${Math.floor(sec/3600)}h ${Math.floor((sec%3600)/60)}m ${sec%60}s`;
}
function timestamp(): string { return new Date().toLocaleTimeString('ru-RU', { hour12: false }); }

// ─── [FIX #1] fetch с таймаутом ───
const AR_HEADERS = {
  'Content-Type': 'application/json',
  'User-Agent': 'QwenCode/0.12.6 (win32; x64)',
  'x-stainless-lang': 'js',
  'x-stainless-package-version': '5.11.0',
  'x-stainless-os': 'Windows',
  'x-stainless-arch': 'x64',
  'x-stainless-runtime': 'node',
  'x-stainless-runtime-version': 'v24.3.0',
  'accept-language': '*',
  'sec-fetch-mode': 'cors',
};

// ─── Safe URL builder (no string concatenation of user-controlled paths) ───
function buildTargetUrl(baseUrl: string, urlPath: string): string {
  const base = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
  const safePath = urlPath.startsWith('/') ? urlPath : `/${urlPath}`;
  // Validate path contains only allowed characters to prevent injection
  const clean = safePath.replace(/[^a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=%]/g, '');
  return `${base}${clean}`;
}

async function callAR(baseUrl: string, urlPath: string, authHeader: string, timeoutMs: number, body?: string): Promise<{ status: number; body: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(buildTargetUrl(baseUrl, urlPath), {
      method: body !== undefined ? 'POST' : 'GET',
      headers: { ...AR_HEADERS, 'Authorization': authHeader, 'Accept': 'application/json' },
      body,
      signal: controller.signal,
    });
    return { status: response.status, body: await response.text() };
  } catch (err: any) {
    if (err.name === 'AbortError') return { status: 504, body: JSON.stringify({ error: { message: `Timeout after ${timeoutMs}ms`, type: 'timeout' } }) };
    return { status: 502, body: JSON.stringify({ error: { message: err.message, type: 'network_error' } }) };
  } finally {
    clearTimeout(timer);
  }
}

// ─── [FIX #2] SSE стриминг ───
async function callARStream(baseUrl: string, urlPath: string, authHeader: string, timeoutMs: number, body: string, res: http.ServerResponse): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(buildTargetUrl(baseUrl, urlPath), {
      method: 'POST',
      headers: { ...AR_HEADERS, 'Authorization': authHeader, 'Accept': 'text/event-stream' },
      body,
      signal: controller.signal,
    });

    if (!response.ok || !response.body) { clearTimeout(timer); return false; }

    res.writeHead(response.status, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value, { stream: true }));
    }
    clearTimeout(timer);
    res.end();
    return true;
  } catch (err: any) {
    clearTimeout(timer);
    if (!res.headersSent) return false;
    res.write(`data: ${JSON.stringify({ error: err.message })}\n\ndata: [DONE]\n\n`);
    res.end();
    return true;
  }
}

// ─── Banner ───
function printBanner(config: Config) {
  console.clear();
  console.log(`
${c.cyan}${c.bright}  ╔═══════════════════════════════════════════════════════╗
  ║         🔀  Agent Router Proxy  v5.1 (patched)       ║
  ╚═══════════════════════════════════════════════════════╝${c.reset}

  ${c.green}▸ Статус:${c.reset}     ${c.bgGreen}${c.bright} РАБОТАЕТ ${c.reset}
  ${c.green}▸ Порт:${c.reset}       ${c.bright}${config.port}${c.reset}
  ${c.green}▸ Таймаут:${c.reset}    ${c.bright}${config.timeoutMs / 1000}s${c.reset}
  ${c.green}▸ Backend:${c.reset}    ${c.dim}${config.agentRouterUrl}${c.reset}
  ${c.green}▸ Стриминг:${c.reset}  ${c.bright}✓ включён${c.reset}

  ${c.yellow}── Base URL ──────────────────────────────────────────${c.reset}
    ${c.cyan}http://localhost:${config.port}/v1${c.reset}

  ${c.yellow}── Модели через URL ─────────────────────────────────${c.reset}
    ${c.dim}/haiku/v1${c.reset}    → claude-haiku-4.5
    ${c.dim}/opus/v1${c.reset}     → claude-opus-4.6
    ${c.dim}/deepseek/v1${c.reset} → deepseek-v3.2
    ${c.dim}/glm/v1${c.reset}      → glm-5.1

  ${c.dim}Нажмите Ctrl+C чтобы остановить${c.reset}
`);
}

// ─── Main ───
async function main() {
  const config = readConfig();

  const server = http.createServer(async (req, res) => {
    totalRequests++;
    const reqNum = totalRequests;
    const ts = timestamp();

    if (req.method === 'OPTIONS') {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' });
      res.end(); return;
    }
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, uptime: uptime(), requests: totalRequests, success: successRequests, failed: failedRequests })); return;
    }
    if (req.method === 'GET' && req.url === '/stats') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ uptime: uptime(), totalRequests, successRequests, failedRequests })); return;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let body: string | undefined = Buffer.concat(chunks).toString() || undefined;

    let url = req.url || '/';
    let forcedModel: string | undefined;
    for (const [prefix, model] of Object.entries(MODEL_PREFIX_MAP)) {
      if (url === prefix || url.startsWith(prefix + '/')) {
        forcedModel = model; url = url.slice(prefix.length) || '/'; break;
      }
    }

    const authHeader = (req.headers.authorization as string) || '';
    const isChat = req.method === 'POST' && (url === '/chat/completions' || url.endsWith('/chat/completions'));

    if (!isChat) {
      console.log(`  ${c.dim}${ts}${c.reset} ${c.cyan}#${reqNum}${c.reset} ${req.method} ${url}`);
      const r = await callAR(config.agentRouterUrl, url, authHeader, config.timeoutMs, body);
      if (r.status >= 400) { failedRequests++; logFailure(r.status, req.url||'', body||'', r.body); console.log(`  ${c.dim}${ts}${c.reset} ${c.red}#${reqNum} ← ${r.status} ERROR${c.reset}`); }
      else { successRequests++; console.log(`  ${c.dim}${ts}${c.reset} ${c.green}#${reqNum} ← ${r.status} OK${c.reset} ${c.dim}(${r.body.length}b)${c.reset}`); }
      res.writeHead(r.status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(r.body); return;
    }

    if (body) body = scrub(body);

    // Detect streaming
    let isStreaming = false;
    if (body) { try { isStreaming = JSON.parse(body).stream === true; } catch {} }

    const attempts: Attempt[] = forcedModel ? [{ model: forcedModel, reduce: false }] : ATTEMPTS;

    // ── Streaming path ──
    if (isStreaming && body) {
      const { model } = attempts[0];
      let sBody = body;
      try { const p = JSON.parse(body); p.model = model; sBody = JSON.stringify(p); } catch {}
      console.log(`  ${c.dim}${ts}${c.reset} ${c.cyan}#${reqNum}${c.reset} ${c.magenta}→${c.reset} ${model.slice(0,15)} ${c.dim}[stream]${c.reset}`);
      const done = await callARStream(config.agentRouterUrl, url, authHeader, config.timeoutMs, sBody, res);
      if (done) { successRequests++; console.log(`  ${c.dim}${ts}${c.reset} ${c.green}#${reqNum} ← stream OK${c.reset}`); return; }
      console.log(`  ${c.dim}${ts}${c.reset} ${c.yellow}#${reqNum} stream fail → ретрай без стриминга${c.reset}`);
      try { const p = JSON.parse(body); p.stream = false; body = JSON.stringify(p); } catch {}
    }

    // ── Non-streaming / retry path ──
    let lastStatus = 500, lastBody = '';
    for (let i = 0; i < attempts.length; i++) {
      const { model, reduce } = attempts[i];
      let aBody = reduce && body ? reduceMessages(body) : body;
      if (aBody) { try { const p = JSON.parse(aBody); p.model = model; aBody = JSON.stringify(p); } catch {} }
      const short = model.replace('claude-','').replace('-20251001','').slice(0,12);
      console.log(`  ${c.dim}${ts}${c.reset} ${c.cyan}#${reqNum}${c.reset} ${c.magenta}→${c.reset} ${short} ${reduce ? c.yellow+'(reduced)'+c.reset : ''} ${c.dim}#${i+1}/${attempts.length}${c.reset}`);
      const r = await callAR(config.agentRouterUrl, url, authHeader, config.timeoutMs, aBody);
      lastStatus = r.status; lastBody = r.body;

      if (r.status < 400) {
        successRequests++;
        let usage = '';
        try { const p = JSON.parse(r.body); if (p.usage) usage = ` ${c.dim}${p.usage.prompt_tokens}→${p.usage.completion_tokens} tok${c.reset}`; } catch {}
        console.log(`  ${c.dim}${ts}${c.reset} ${c.green}#${reqNum} ← ${r.status} OK${c.reset} ${c.dim}(${r.body.length}b)${c.reset}${usage}`);
        res.writeHead(r.status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(r.body); return;
      }

      logFailure(r.status, `${req.url} #${i} model=${model}`, aBody||'', r.body);
      const isTimeout = r.status === 504;
      const isRateLimit = r.status === 429 || RATE_LIMIT_RE.test(r.body);
      const isContentBlock = SENSITIVE_RE.test(r.body);
      const isServerErr = r.status >= 500 && !isContentBlock;
      const shouldContinue = !isRateLimit && !isTimeout && (isContentBlock || isServerErr);

      if (isTimeout) console.log(`  ${c.dim}${ts}${c.reset} ${c.red}#${reqNum} ← 504 TIMEOUT (стоп)${c.reset}`);
      else if (isRateLimit) console.log(`  ${c.dim}${ts}${c.reset} ${c.red}#${reqNum} ← 429 RATE LIMIT (стоп)${c.reset}`);
      else if (isContentBlock) console.log(`  ${c.dim}${ts}${c.reset} ${c.yellow}#${reqNum} ← CONTENT BLOCKED${shouldContinue ? ' (ретрай...)' : ''}${c.reset}`);
      else console.log(`  ${c.dim}${ts}${c.reset} ${c.red}#${reqNum} ← ${r.status} ERROR${c.reset}`);

      if (!shouldContinue) break;
    }

    failedRequests++;
    res.writeHead(lastStatus, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
    res.end(lastBody);
  });

  printBanner(config);
  server.listen(config.port, () => console.log(`  ${c.green}${c.bright}✓ Сервер запущен на порту ${config.port}${c.reset}\n`));
  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') console.error(`\n  ${c.red}✗ Порт ${config.port} занят!${c.reset}\n`);
    else console.error(`\n  ${c.red}Ошибка: ${err.message}${c.reset}\n`);
    process.exit(1);
  });
}

main();
