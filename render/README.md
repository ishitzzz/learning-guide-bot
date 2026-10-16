# Learning-guide Telegram bot (Render free tier)

Self-contained: Telegram long poll + direct Gemini calls + git-backed memory. No opencode, no server.

- Render web service: build command empty, start command `node render/bot.mjs`, plan free.
- Env vars (Render dashboard, never in git): TELEGRAM_BOT_TOKEN, TELEGRAM_ALLOWED_CHAT_ID, GEMINI_API_KEY, GIT_TOKEN, GIT_REPO (private repo for memory), REPO_DIR (default ./lgf-data), RENDER_DAILY_CAP (default 300), GEMINI_MODEL (default gemini-3.5-flash-lite), PORT (set by Render).
- Health URL for the pinger: /healthz . Memory (guide-data/learner.json, ledger, offset, render-heartbeat) is committed and pushed to GIT_REPO after writes and every 10 min.
- Repo layout the bot expects: render/bot.mjs + guide/{learner,fsrs,teach}.mjs beside it (as in this repo or the public mirror).
