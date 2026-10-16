// Learner memory + spaced repetition + mistake patterns. Plain JSON on disk, NO model calls.
// Entries about the learner are stored as the learner's own words/facts; web text never goes in here.
import fs from "node:fs";
import * as F from "./fsrs.mjs";
const BOX_DAYS = [0, 1, 2, 4, 8, 16];           // old Leitner boxes, only used to carry over cards saved before FSRS
const DAY = 86400000;
export function load(file = process.env.LEARNER_FILE || "learner.json") {
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { subjects: {}, cards: [], mistakes: [], tests: [], routines: [] };
}
export function save(m, file = process.env.LEARNER_FILE || "learner.json") {
  const tmp = file + ".tmp"; fs.writeFileSync(tmp, JSON.stringify(m, null, 1)); fs.renameSync(tmp, file);
}
const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
export function setSubject(m, name, { bestWith, level } = {}) { const s = (m.subjects[name] ??= {}); if (bestWith) s.bestWith = bestWith; if (level) s.level = level; return m; }
export function addTest(m, subject, dateISO) { m.tests.push({ subject, date: dateISO }); return m; }
export function upcomingTests(m, now = Date.now()) { return m.tests.filter((t) => Date.parse(t.date) >= now - DAY).sort((a, b) => Date.parse(a.date) - Date.parse(b.date)); }
export function addCard(m, subject, q, a, now = Date.now()) { if (!m.cards.some((c) => c.subject === subject && norm(c.q) === norm(q))) m.cards.push({ id: m.cards.length + 1, subject, q, a, box: 0, due: now, reviews: 0 }); return m; }
export function dueCards(m, now = Date.now(), limit = 5) { return m.cards.filter((c) => c.due <= now).sort((a, b) => a.due - b.due).slice(0, limit); }
// Spaced repetition is FSRS-4.5 (see fsrs.mjs). `correct` may be true/false (Good/Again) or a grade 1..4.
export function review(m, id, result, now = Date.now()) {
  const c = m.cards.find((x) => x.id === id); if (!c) throw new Error("no card " + id);
  const grade = typeof result === "number" ? result : result ? F.Grade.Good : F.Grade.Again;
  if (!c.fsrs && c.reviews > 0 && c.box > 0) c.fsrs = { s: Math.max(BOX_DAYS[c.box], 0.5), d: 5, last: now - BOX_DAYS[c.box] * DAY, reps: c.reviews, lapses: 0 };   // carry over an old Leitner card
  const r = F.schedule(c.fsrs, grade, now); c.fsrs = r.state; c.due = r.due; c.intervalDays = r.days; c.reviews++; c.box = Math.min(5, Math.floor(Math.log2(r.days + 1)));
  if (grade === F.Grade.Again) logMistake(m, c.subject, c.q, now);
  return c;
}
export const recall = (c, now = Date.now()) => (c.fsrs ? F.retrievability((now - c.fsrs.last) / DAY, c.fsrs.s) : null);
// A mistake is a (subject, topic) the learner got wrong; topic text is normalised so repeats are counted.
export function logMistake(m, subject, topic, now = Date.now()) {
  m.mistakes.push({ subject, topic: norm(topic), at: now }); return patternFor(m, subject, topic);
}
export function patternFor(m, subject, topic) {
  const n = m.mistakes.filter((x) => x.subject === subject && x.topic === norm(topic)).length;
  return n >= 3 ? `That is time number ${n} that "${topic}" has tripped you up in ${subject}. Worth a different approach, not more of the same.` : null;
}
export function summary(m, now = Date.now()) {
  const byTopic = {}; for (const x of m.mistakes) byTopic[x.subject + "|" + x.topic] = (byTopic[x.subject + "|" + x.topic] || 0) + 1;
  return { due: dueCards(m, now, 100).length, cards: m.cards.length, repeatedMistakes: Object.entries(byTopic).filter(([, n]) => n >= 3).map(([k, n]) => ({ subject: k.split("|")[0], topic: k.split("|")[1], times: n })), nextTest: upcomingTests(m, now)[0] ?? null };
}
// "What the guide believes about you": readable, editable file.
export function believes(m) {
  const L = ["# What the guide believes about you", ""];
  for (const [s, v] of Object.entries(m.subjects)) L.push(`- ${s}: level ${v.level ?? "unknown"}, learns best with ${v.bestWith ?? "unknown"}`);
  for (const t of upcomingTests(m)) L.push(`- Test: ${t.subject} on ${t.date}`);
  return L.join("\n");
}
