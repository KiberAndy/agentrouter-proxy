import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

// ─── Resolve paths relative to the .exe (or script) location ───
const EXE_DIR = path.dirname(process.execPath.endsWith('.exe') ? process.execPath : process.argv[1]);
const CONFIG_PATH = path.join(EXE_DIR, 'config.txt');
const LOG_PATH = path.join(EXE_DIR, 'proxy-errors.log');

// ─── Colors for console ───
const c = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  red: '\x1b[31m',
  magenta: '\x1b[35m',
  white: '\x1b[37m',
  bgBlue: '\x1b[44m',
  bgGreen: '\x1b[42m',
  bgRed: '\x1b[41m',
};

// ─── Config ───
interface Config {
  port: number;
  agentRouterUrl: string;
}

function readConfig(): Config {
  const defaults: Config = {
    port: 3001,
    agentRouterUrl: 'https://agentrouter.org/v1',
  };

  if (!fs.existsSync(CONFIG_PATH)) {
    // Create default config.txt
    const template = `# ═══════════════════════════════════════════════
# Agent Router Proxy — Настройки
# ═══════════════════════════════════════════════

# Порт прокси (по умолчанию 3001)
PORT=3001

# URL Agent Router API (менять обычно не нужно)
AGENT_ROUTER_URL=https://agentrouter.org/v1
`;
    fs.writeFileSync(CONFIG_PATH, template, 'utf-8');
    return defaults;
  }

  const text = fs.readFileSync(CONFIG_PATH, 'utf-8');
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 0) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (key === 'PORT') defaults.port = parseInt(val, 10) || 3001;
    if (key === 'AGENT_ROUTER_URL') defaults.agentRouterUrl = val;
  }
  return defaults;
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
  } catch {
    return body;
  }
}

function logFailure(status: number, url: string, body: string, response: string) {
  try {
    const ts = new Date().toISOString();
    fs.appendFileSync(LOG_PATH,
      `\n=== ${ts} status=${status} url=${url} ===\nREQUEST BODY:\n${(body || '').slice(0, 4000)}\nRESPONSE:\n${response.slice(0, 800)}\n`);
  } catch {}
}

// ─── Stats ───
let totalRequests = 0;
let successRequests = 0;
let failedRequests = 0;
let startTime = Date.now();

// ─── Call Agent Router ───
async function callAR(baseUrl: string, urlPath: string, authHeader: string, body?: string): Promise<{ status: number; body: string }> {
  const targetUrl = `${baseUrl}${urlPath}`;
  const response = await fetch(targetUrl, {
    method: body !== undefined ? 'POST' : 'GET',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': authHeader,
      'Accept': 'application/json',
      'User-Agent': 'QwenCode/0.12.6 (win32; x64)',
      'x-stainless-lang': 'js',
      'x-stainless-package-version': '5.11.0',
      'x-stainless-os': 'Windows',
      'x-stainless-arch': 'x64',
      'x-stainless-runtime': 'node',
      'x-stainless-runtime-version': 'v24.3.0',
      'accept-language': '*',
      'sec-fetch-mode': 'cors',
    },
    body,
  });
  return { status: response.status, body: await response.text() };
}

function uptime(): string {
  const sec = Math.floor((Date.now() - startTime) / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}h ${m}m ${s}s`;
}

function timestamp(): string {
  return new Date().toLocaleTimeString('ru-RU', { hour12: false });
}

// ─── Banner ───
function printBanner(config: Config) {
  console.clear();
  console.log(`
${c.cyan}${c.bright}  ╔═══════════════════════════════════════════════════════╗
  ║         🔀  Agent Router Proxy  v5.0                 ║
  ║         OpenAI-compatible proxy for AgentRouter      ║
  ╚═══════════════════════════════════════════════════════╝${c.reset}

  ${c.green}▸ Статус:${c.reset}     ${c.bgGreen}${c.bright} РАБОТАЕТ ${c.reset}
  ${c.green}▸ Порт:${c.reset}       ${c.bright}${config.port}${c.reset}
  ${c.green}▸ Backend:${c.reset}    ${c.dim}${config.agentRouterUrl}${c.reset}
  ${c.green}▸ Конфиг:${c.reset}    ${c.dim}${CONFIG_PATH}${c.reset}
  ${c.green}▸ Логи:${c.reset}      ${c.dim}${LOG_PATH}${c.reset}

  ${c.yellow}── Как использовать ──────────────────────────────────${c.reset}
  ${c.white}В вашем приложении (Cursor, Cline, и т.д.):${c.reset}

    ${c.cyan}Base URL:${c.reset}  ${c.bright}http://localhost:${config.port}/v1${c.reset}
    ${c.cyan}API Key:${c.reset}   ${c.bright}sk-ваш-ключ-от-agentrouter${c.reset}

  ${c.yellow}── Модели через URL ─────────────────────────────────${c.reset}
    ${c.dim}/haiku/chat/completions${c.reset}    → claude-haiku-4.5
    ${c.dim}/opus/chat/completions${c.reset}     → claude-opus-4.6
    ${c.dim}/deepseek/chat/completions${c.reset} → deepseek-v3.2
    ${c.dim}/glm/chat/completions${c.reset}      → glm-5.1

  ${c.yellow}── Авто-ретраи ──────────────────────────────────────${c.reset}
    ${c.dim}#0 claude-haiku (полный контекст)${c.reset}
    ${c.dim}#1 claude-haiku (урезанный контекст)${c.reset}
    ${c.dim}#2 deepseek-v3.2 (фоллбэк)${c.reset}

  ${c.dim}─────────────────────────────────────────────────────${c.reset}
  ${c.dim}Нажмите Ctrl+C чтобы остановить${c.reset}
  ${c.dim}─────────────────────────────────────────────────────${c.reset}
`);
}

// ─── Main ───
async function main() {
  const config = readConfig();

  const server = http.createServer(async (req, res) => {
    totalRequests++;
    const reqNum = totalRequests;
    const ts = timestamp();

    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*', // NOSONAR - localhost-only proxy
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      });
      res.end();
      return;
    }

    // Health check
    if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, uptime: uptime(), requests: totalRequests, success: successRequests, failed: failedRequests }));
      return;
    }

    // Stats endpoint
    if (req.method === 'GET' && req.url === '/stats') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ uptime: uptime(), totalRequests, successRequests, failedRequests }));
      return;
    }

    // Collect body
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    let body = Buffer.concat(chunks).toString() || undefined;

    // Model prefix routing
    let url = req.url || '/';
    let forcedModel: string | undefined;
    for (const [prefix, model] of Object.entries(MODEL_PREFIX_MAP)) {
      if (url === prefix || url.startsWith(prefix + '/')) {
        forcedModel = model;
        url = url.slice(prefix.length) || '/';
        break;
      }
    }

    const authHeader = (req.headers.authorization as string) || '';
    const isChat = req.method === 'POST' && (url === '/chat/completions' || url.endsWith('/chat/completions'));

    // Non-chat requests — simple forward
    if (!isChat) {
      console.log(`  ${c.dim}${ts}${c.reset} ${c.cyan}#${reqNum}${c.reset} ${req.method} ${url}`);
      const r = await callAR(config.agentRouterUrl, url, authHeader, body);
      if (r.status >= 400) {
        failedRequests++;
        logFailure(r.status, req.url || '', body || '', r.body);
        console.log(`  ${c.dim}${ts}${c.reset} ${c.red}#${reqNum} ← ${r.status} ERROR${c.reset}`);
      } else {
        successRequests++;
        console.log(`  ${c.dim}${ts}${c.reset} ${c.green}#${reqNum} ← ${r.status} OK${c.reset} ${c.dim}(${r.body.length}b)${c.reset}`);
      }
      res.writeHead(r.status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); // NOSONAR - localhost-only proxy
      res.end(r.body);
      return;
    }

    // Chat request — scrub + retry logic
    if (body) body = scrub(body);

    const attempts: Attempt[] = forcedModel ? [{ model: forcedModel, reduce: false }] : ATTEMPTS;

    let lastStatus = 500;
    let lastBody = '';

    for (let i = 0; i < attempts.length; i++) {
      const { model, reduce } = attempts[i];
      let attemptBody = reduce && body ? reduceMessages(body) : body;
      if (attemptBody) {
        try {
          const parsed = JSON.parse(attemptBody);
          parsed.model = model;
          attemptBody = JSON.stringify(parsed);
        } catch {}
      }

      const modelShort = model.replace('claude-', '').replace('-20251001', '').slice(0, 12);
      console.log(`  ${c.dim}${ts}${c.reset} ${c.cyan}#${reqNum}${c.reset} ${c.magenta}→${c.reset} ${modelShort} ${reduce ? c.yellow + '(reduced)' + c.reset : ''} ${c.dim}attempt ${i + 1}/${attempts.length}${c.reset}`);

      const r = await callAR(config.agentRouterUrl, url, authHeader, attemptBody);
      lastStatus = r.status;
      lastBody = r.body;

      if (r.status < 400) {
        successRequests++;
        let usage = '';
        try {
          const p = JSON.parse(r.body);
          if (p.usage) usage = ` ${c.dim}${p.usage.prompt_tokens}→${p.usage.completion_tokens} tok${c.reset}`;
        } catch {}
        console.log(`  ${c.dim}${ts}${c.reset} ${c.green}#${reqNum} ← ${r.status} OK${c.reset} ${c.dim}(${r.body.length}b)${c.reset}${usage}`);
        res.writeHead(r.status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); // NOSONAR - localhost-only proxy
        res.end(r.body);
        return;
      }

      logFailure(r.status, `${req.url} #${i} model=${model} reduce=${reduce}`, attemptBody || '', r.body);

      const isRateLimit = r.status === 429 || RATE_LIMIT_RE.test(r.body);
      const isContentBlock = SENSITIVE_RE.test(r.body);
      const isServerErr = r.status >= 500 && !isContentBlock;
      const shouldContinue = !isRateLimit && (isContentBlock || isServerErr);

      if (isRateLimit) {
        console.log(`  ${c.dim}${ts}${c.reset} ${c.red}#${reqNum} ← 429 RATE LIMIT${c.reset} ${c.dim}(стоп)${c.reset}`);
      } else if (isContentBlock) {
        console.log(`  ${c.dim}${ts}${c.reset} ${c.yellow}#${reqNum} ← ${r.status} CONTENT BLOCKED${c.reset} ${shouldContinue ? c.dim + '(ретрай...)' + c.reset : ''}`);
      } else {
        console.log(`  ${c.dim}${ts}${c.reset} ${c.red}#${reqNum} ← ${r.status} ERROR${c.reset}`);
      }

      if (!shouldContinue) break;
    }

    failedRequests++;
    res.writeHead(lastStatus, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); // NOSONAR - localhost-only proxy
    res.end(lastBody);
  });

  printBanner(config);

  server.listen(config.port, () => {
    console.log(`  ${c.green}${c.bright}✓ Сервер запущен и слушает порт ${config.port}${c.reset}\n`);
  });

  server.on('error', (err: any) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  ${c.red}${c.bright}✗ Порт ${config.port} уже занят!${c.reset}`);
      console.error(`  ${c.dim}Измените PORT в config.txt или закройте другую программу.${c.reset}\n`);
    } else {
      console.error(`\n  ${c.red}Ошибка сервера: ${err.message}${c.reset}\n`);
    }
    process.exit(1);
  });
}

main();
