// Learning-guide Telegram bot, Render free-tier edition (512 MB).
// No opencode, no OpenMausBot server: Telegram long poll + direct Gemini calls.
// Memory persists to the PRIVATE git repo (guide-data/), because Render's disk is wiped on
// every redeploy/restart/spin-down. Secrets come only from env vars, never from files in git.
import http from "node:http";
import fs from "node:fs";
import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import * as L from "../guide/learner.mjs";
import * as T from "../guide/teach.mjs";

const TG_API = process.env.TELEGRAM_API_BASE || "https://api.telegram.org";
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const ALLOWED = String(process.env.TELEGRAM_ALLOWED_CHAT_ID || "");
const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-3.5-flash-lite";
const GEMINI_BASE = "https://generativelanguage.googleapis.com/v1beta/openai";
const DAILY_CAP = +process.env.RENDER_DAILY_CAP || 300;
const REPO_DIR = process.env.REPO_DIR || "./lgf-data";
const GIT_REPO = process.env.GIT_REPO || "https://github.com/ishitzzz/learning-guide-fork.git";
const GIT_TOKEN = process.env.GIT_TOKEN || "";
const LEARNER_FILE = process.env.LEARNER_FILE || REPO_DIR + "/guide-data/learner.json";
const LEDGER_FILE = REPO_DIR + "/guide-data/render-ledger.json";
const INTERNAL_PORT = 28998;

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---- daily call budget (Gemini's free counters reset at midnight America/Los_Angeles) ----
const dayKey = () => new Date().toLocaleDateString("en-CA", { timeZone: "America/Los_Angeles" });
function ledgerRead() { try { const j = JSON.parse(fs.readFileSync(LEDGER_FILE, "utf8")); return j.day === dayKey() ? j : { day: dayKey(), used: 0 }; } catch { return { day: dayKey(), used: 0 }; } }
function ledgerWrite(j) { try { fs.writeFileSync(LEDGER_FILE, JSON.stringify(j)); } catch {} }
function remaining() { return DAILY_CAP - ledgerRead().used; }

// ---- one model call at a time, through Gemini's OpenAI-compatible endpoint ----
let queue = Promise.resolve();
function askModel(messages) {
  const run = queue.then(async () => {
    const led = ledgerRead();
    if (led.used >= DAILY_CAP) throw new Error("daily free model budget used up");
    const r = await fetch(GEMINI_BASE + "/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + GEMINI_KEY }, body: JSON.stringify({ model: GEMINI_MODEL, messages }), signal: AbortSignal.timeout(90000) });
    const j = await r.json();
    if (!r.ok) throw new Error("model HTTP " + r.status);
    led.used += 1; ledgerWrite(led); schedulePush();
    return j.choices?.[0]?.message?.content || "";
  });
  queue = run.catch(() => {});
  return run;
}

// ---- internal-only endpoints so teach.mjs works unmodified (LEDGER_BASE=http://127.0.0.1:28998) ----
http.createServer(async (req, res) => {
  res.setHeader("content-type", "application/json");
  if (req.url === "/budget") return res.end(JSON.stringify({ remaining: remaining(), perModel: { [GEMINI_MODEL]: DAILY_CAP } }));
  if (req.url === "/v1/chat/completions" && req.method === "POST") {
    let b = ""; for await (const c of req) b += c;
    try { const { messages } = JSON.parse(b); const text = await askModel(messages); return res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: text } }] })); }
    catch (e) { res.statusCode = 429; return res.end(JSON.stringify({ error: { message: String(e.message) } })); }
  }
  res.statusCode = 404; res.end("{}");
}).listen(INTERNAL_PORT, "127.0.0.1");

// ---- public endpoint: only the health check (pinger + Render) ----
http.createServer((req, res) => { res.end(req.url === "/healthz" ? "ok" : "learning-guide bot"); }).listen(+process.env.PORT || 3000, "0.0.0.0");

// ---- git persistence: clone at boot, push memory after writes (debounced) and every 10 min ----
const git = (args) => new Promise((res) => {
  const H = "Authorization: Basic " + Buffer.from("x-access-token:" + GIT_TOKEN).toString("base64");
  execFile("git", ["-c", "http.extraheader=" + H, ...args], { cwd: REPO_DIR, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeout: 60000 }, (e, so, se) => res({ ok: !e, out: String(so), err: String(se).replaceAll(GIT_TOKEN, "***") }));
});
async function cloneAtBoot() {
  if (!GIT_TOKEN) { log("no GIT_TOKEN; memory will NOT persist"); return; }
  if (fs.existsSync(REPO_DIR + "/.git")) return;
  const H = "Authorization: Basic " + Buffer.from("x-access-token:" + GIT_TOKEN).toString("base64");
  await new Promise((res) => execFile("git", ["-c", "http.extraheader=" + H, "clone", "--depth", "1", GIT_REPO, REPO_DIR], { env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeout: 120000 }, (e, so, se) => { if (e) log("clone failed:", String(se).replaceAll(GIT_TOKEN, "***").slice(0, 200)); else log("repo cloned"); res(); }));
  await git(["config", "user.email", "guide-bot@render"]); await git(["config", "user.name", "guide-bot"]);
}
let pushing = null, pending = false;
async function pushNow() {
  if (!fs.existsSync(REPO_DIR + "/.git")) return;
  try { fs.writeFileSync(REPO_DIR + "/guide-data/render-heartbeat.json", JSON.stringify({ utc: new Date().toISOString(), memMB: Math.round(process.memoryUsage().rss / 1048576), remaining: remaining() })); } catch {}
  await git(["add", "guide-data"]);
  const d = await git(["diff", "--cached", "--quiet"]); if (d.ok) return; // rc 0 = no changes
  await git(["commit", "-qm", "render: memory " + new Date().toISOString().slice(11, 16) + "Z"]);
  await git(["pull", "--rebase", "--autostash", "origin", "main"]);
  const p = await git(["push", "--no-verify", "origin", "HEAD:main"]);
  log(p.ok ? "memory pushed" : "push failed: " + p.err.slice(0, 160));
}
function schedulePush() { pending = true; if (pushing) return; pushing = (async () => { while (pending) { pending = false; await sleep(5000); await pushNow(); } pushing = null; })(); }
setInterval(() => { pending = true; if (!pushing) schedulePush(); }, 600000);

// ---- Telegram ----
const tg = (m, body) => fetch(`${TG_API}/bot${TOKEN}/${m}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}), signal: AbortSignal.timeout(((body && body.timeout) || 0) * 1000 + 20000) }).then((r) => r.json());
const LEARNER_NAME = process.env.LEARNER_NAME || "the learner";
const GUIDE_PROMPT = "You are Guide, a study guide on Telegram for " + LEARNER_NAME + ". Plain words, short replies, no jargon. Help him learn: explain simply, ask one quick check question when it helps, use his learner memory if it is given. Never use the word 'agent'. Never claim to have done something you did not.";
async function chat(text) {
  const m = L.load(LEARNER_FILE);
  const s = L.summary(m);
  const mem = (s.cards || s.repeatedMistakes?.length) ? "\nLearner memory: " + JSON.stringify(s).slice(0, 800) : "";
  const msgs = [{ role: "system", content: GUIDE_PROMPT + mem }, { role: "user", content: text }];
  try { return await askModel(msgs); }
  catch (e) { log("model call failed:", e.message); await sleep(2500); return await askModel(msgs); } // one retry rides out transient 429/503
}
async function command(text) {
  const [head, ...rest] = text.trim().split(/\s+/); const arg = rest.join(" "); const m = L.load(LEARNER_FILE);
  if (head === "/quiz") { const d = L.dueCards(m); return d.length ? d.map((c) => `#${c.id} [${c.subject}] ${c.q}`).join("\n") + "\nReply /right N or /wrong N after you try." : "No cards due today. Teach me something with /prepare first."; }
  if (head === "/right" || head === "/wrong") { const c = L.review(m, +arg, head === "/right"); L.save(m, LEARNER_FILE); schedulePush(); const p = head === "/wrong" ? L.patternFor(m, c.subject, c.q) : null; return head === "/right" ? "Good. Next review in " + c.intervalDays + " day(s)." : "Marked wrong; it comes back today." + (p ? "\n" + p : ""); }
  if (head === "/believes") return L.believes(m);
  if (head === "/status") return JSON.stringify(L.summary(m));
  if (head === "/prepare") { const [subject, topic, ...urls] = arg.split("|").map((x) => x.trim()); const r = await T.prepare(topic, subject, urls, m); if (!r.refused) { L.save(m, LEARNER_FILE); schedulePush(); } return r.refused || `${r.explanation}\n\nRoadmap: ${(r.roadmap || []).join(" > ")}\n\nExplain it back: ${r.explain_back}\n(${r.cards?.length || 0} cards saved; /quiz to practise)`; }
  if (head === "/explain") { const [subject, topic, ...t] = arg.split("|").map((x) => x.trim()); const r = await T.explainBack(topic, subject, t.join("|"), m); if (!r.refused) { L.save(m, LEARNER_FILE); schedulePush(); } return r.refused || `Gaps I noticed (I may be wrong): ${(r.gaps || []).join("; ") || "none"}\nNext question: ${r.next_question}`; }
  if (head === "/start") return "Hi, I'm Guide. Send me anything you want to learn. /prepare subject | topic | links builds a roadmap, /quiz practises, /explain checks your own explanation, /status shows where you stand.";
  return null;
}
async function handle1(u) {
  const msg = u.message; if (!msg?.text) return;
  log("update", u.update_id, "chat", msg.chat.id, String(msg.chat.id) === ALLOWED ? "allowed" : "ignored", "chars", msg.text.length);
  if (!ALLOWED || String(msg.chat.id) !== ALLOWED || msg.chat.type !== "private") return;
  if (msg.text.startsWith("/")) { let out; try { out = await command(msg.text); } catch (e) { out = "That did not work: " + e.message; } if (out) return void (await tg("sendMessage", { chat_id: msg.chat.id, text: String(out).slice(0, 3900) })); }
  let reply;
  try { reply = (await chat(msg.text)).trim() || "I have nothing useful to say to that yet."; }
  catch (e) { log("chat failed after retry:", e.message); reply = /budget/.test(e.message) ? "Today's free model budget is used up. It resets at midnight US Pacific time." : "Something failed on my side. Try that again in a minute."; }
  const sent = await tg("sendMessage", { chat_id: msg.chat.id, text: String(reply).slice(0, 3900) });
  log("reply", sent.ok ? "sent" : "FAILED " + sent.description);
}
async function handle(u) { try { await handle1(u); } catch (e) { log("handler error", e.message); } }

await cloneAtBoot();
let offset = 0;
// keep the offset across restarts when possible, so a redeploy does not re-answer old messages
try { const j = JSON.parse(fs.readFileSync(REPO_DIR + "/guide-data/render-offset.json", "utf8")); if (j.offset > 0) offset = j.offset; } catch {}
log("bot up; budget", remaining(), "memory file", LEARNER_FILE);
for (;;) {
  const r = await tg("getUpdates", { offset, timeout: 25 }).catch(() => null);
  if (!r?.ok) { await sleep(3000); continue; }
  for (const u of r.result) {
    offset = u.update_id + 1;
    try { fs.writeFileSync(REPO_DIR + "/guide-data/render-offset.json", JSON.stringify({ offset })); } catch {}
    await handle(u);
  }
}
