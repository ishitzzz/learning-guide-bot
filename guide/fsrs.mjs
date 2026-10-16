// FSRS-4.5 spaced repetition, written from the public algorithm description (open-spaced-repetition wiki,
// "The Algorithm" / FSRS-4.5). No model calls, no dependencies. Time is passed in, never read, so tests can simulate a clock.
// Memory state per card: S = stability (days for retrievability to fall to 90%), D = difficulty (1..10).
export const W = [0.4872, 1.4003, 3.7145, 13.8206, 5.1618, 1.2298, 0.8975, 0.031, 1.6474, 0.1367, 1.0461, 2.1072, 0.0793, 0.3246, 1.587, 0.2272, 2.8755];
export const DECAY = -0.5, FACTOR = 19 / 81, REQUEST_RETENTION = 0.9, MAX_DAYS = 36500;
export const Grade = { Again: 1, Hard: 2, Good: 3, Easy: 4 };
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const clampD = (d) => clamp(d, 1, 10);
export const retrievability = (elapsedDays, S) => Math.pow(1 + (FACTOR * Math.max(0, elapsedDays)) / S, DECAY);
export const intervalFor = (S, retention = REQUEST_RETENTION) => clamp(Math.round((S / FACTOR) * (Math.pow(retention, 1 / DECAY) - 1)), 1, MAX_DAYS);
export const initStability = (g, w = W) => Math.max(w[g - 1], 0.1);
export const initDifficulty = (g, w = W) => clampD(w[4] - w[5] * (g - 3));
export function nextDifficulty(D, g, w = W) { const d1 = D - w[6] * (g - 3); return clampD(w[7] * initDifficulty(4, w) + (1 - w[7]) * d1); }
export function nextRecallStability(D, S, R, g, w = W) {
  const hard = g === Grade.Hard ? w[15] : 1, easy = g === Grade.Easy ? w[16] : 1;
  return S * (1 + Math.exp(w[8]) * (11 - D) * Math.pow(S, -w[9]) * (Math.exp(w[10] * (1 - R)) - 1) * hard * easy);
}
export function nextForgetStability(D, S, R, w = W) { return w[11] * Math.pow(D, -w[12]) * (Math.pow(S + 1, w[13]) - 1) * Math.exp(w[14] * (1 - R)); }
const DAY = 86400000;
// card.fsrs = { s, d, last (ms), reps, lapses } ; returns the new state and the due time.
export function schedule(prev, grade, now, w = W) {
  if (![1, 2, 3, 4].includes(grade)) throw new Error("grade must be 1..4");
  let s, d, lapses = prev?.lapses || 0;
  if (!prev) { s = initStability(grade, w); d = initDifficulty(grade, w); }
  else {
    const R = retrievability((now - prev.last) / DAY, prev.s);
    d = nextDifficulty(prev.d, grade, w);
    if (grade === Grade.Again) { s = Math.min(nextForgetStability(prev.d, prev.s, R, w), prev.s); lapses++; } else s = nextRecallStability(prev.d, prev.s, R, grade, w);
  }
  const state = { s, d, last: now, reps: (prev?.reps || 0) + 1, lapses };
  const days = grade === Grade.Again ? 0 : intervalFor(s);   // a missed card comes back the same session
  return { state, days, due: now + days * DAY };
}
