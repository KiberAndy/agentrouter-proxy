# 🔀 Agent Router Proxy v5

> OpenAI-совместимый прокси для [Agent Router](https://agentrouter.org).  
> Один `.exe` — без установки Node.js, без Docker, без танцев с бубном.

---

## ⚡ Быстрый старт (Windows)

### 1. Скачай
Скачай [последний релиз](../../releases/latest) — файл `agentrouter-proxy-v5-win64.zip`

### 2. Распакуй и запусти
Распакуй `.zip` → двойной клик на `agentrouter-proxy.exe`

Откроется консоль:
```
╔═══════════════════════════════════════════════════════╗
║         🔀  Agent Router Proxy  v5.0                 ║
║         OpenAI-compatible proxy for AgentRouter      ║
╚═══════════════════════════════════════════════════════╝

▸ Статус:      РАБОТАЕТ
▸ Порт:        3001

✓ Сервер запущен и слушает порт 3001
```

### 3. Настрой своё приложение
В **Cursor**, **Cline**, **Continue** или любом OpenAI-совместимом клиенте укажи:

| Параметр | Значение |
|----------|----------|
| **Base URL** | `http://localhost:3001/v1` |
| **API Key** | `sk-ваш-ключ-от-agentrouter` |

### 4. Готово! 🎉
Пиши код, общайся с ИИ — прокси всё пробрасывает.

---

## 🎯 Зачем нужен прокси?

Agent Router иногда блокирует запросы по заголовкам или содержимому. Этот прокси:

- ✅ Подставляет **правильные заголовки** (User-Agent) — запросы не блокируются
- ✅ **Автоматически ретраит** при блокировке контента (до 3 попыток)
- ✅ **Фоллбэк на другую модель** — если одна не отвечает, пробует другую
- ✅ **Чистит** запросы от слов-триггеров для content-фильтров
- ✅ Работает как **один .exe** — никаких зависимостей

---

## 🤖 Выбор модели

По умолчанию используется **Claude Haiku 4.5** с автоматическим фоллбэком.

Чтобы принудительно выбрать модель — измени Base URL:

| Base URL | Модель |
|----------|--------|
| `http://localhost:3001/v1` | Claude Haiku 4.5 *(авто-фоллбэк)* |
| `http://localhost:3001/opus/v1` | Claude Opus 4.6 |
| `http://localhost:3001/deepseek/v1` | DeepSeek v3.2 |
| `http://localhost:3001/glm/v1` | GLM 5.1 |

---

## ⚙️ Настройки

При первом запуске рядом с `.exe` появится файл `config.txt`:

```ini
# Порт прокси (по умолчанию 3001)
PORT=3001

# URL Agent Router API (менять обычно не нужно)
AGENT_ROUTER_URL=https://agentrouter.org/v1
```

---

## 📊 Мониторинг

Прокси логирует каждый запрос в консоль с цветами:
- 🟢 Зелёный — успешный ответ
- 🟡 Жёлтый — контент-блок, ретрай
- 🔴 Красный — ошибка

Эндпоинты:
- `http://localhost:3001/health` — статус прокси
- `http://localhost:3001/stats` — статистика запросов

Ошибки сохраняются в файл `proxy-errors.log` рядом с `.exe`.

---

## 🔧 Сборка из исходников

Если хочешь собрать сам:

```bash
# Клонируй
git clone https://github.com/YOUR_USERNAME/agentrouter-proxy.git
cd agentrouter-proxy

# Установи зависимости
npm install

# Скомпилируй TypeScript
npx tsc

# Запусти
node dist/proxy.js

# Или собери .exe (Node.js 20+)
node --experimental-sea-config sea-config.json
copy node.exe agentrouter-proxy.exe
npx postject agentrouter-proxy.exe NODE_SEA_BLOB sea-prep.blob --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2
```

---

## ❓ FAQ

**Q: Нужен ли Node.js для запуска .exe?**  
A: Нет, всё встроено в исполняемый файл.

**Q: Где взять API-ключ?**  
A: Зарегистрируйся на [agentrouter.org](https://agentrouter.org)

**Q: Windows Defender / антивирус ругается?**  
A: Это нормально для .exe, собранных из Node.js. Исходный код открыт — можешь проверить и собрать сам.

**Q: Порт 3001 занят?**  
A: Поменяй `PORT` в `config.txt`.

**Q: Поддерживается ли стриминг?**  
A: Пока нет, ответы приходят целиком.

---

## 📋 Как это работает

```
Твоё приложение (Cursor / Cline / ...)
   │
   │  POST /v1/chat/completions
   │  Authorization: Bearer sk-...
   │
   ▼
Agent Router Proxy (localhost:3001)
   │  ✓ Подмена заголовков
   │  ✓ Скрабинг контента
   │  ✓ Ретраи при блокировке
   │
   ▼
Agent Router API (agentrouter.org)
   │
   ▼
Claude / DeepSeek / GLM
```

---

## 🙏 Поддержать

Если прокси тебе помог — буду рад донату!  

---

## 📄 Лицензия

MIT — делай что хочешь.
