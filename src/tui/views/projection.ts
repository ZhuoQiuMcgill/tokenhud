// How a projected 100 % is written wherever it shows (T26), so the Overview's cards and the
// Accounts view agree: how long until it first, then when.
import { countdownTo } from "../../limits/derive.ts";

/**
 * A window projected to reach 100 % at `at`, as seen at `now`, in each of its forms, widest
 * first: `100% in <2h (12:13)` (a weekly window's time is coarse: `100% in ~2d (~Sun
 * evening)`), then without the time, `100% in <2h`, then `100% <2h`. Under a minute, `100%
 * now` in every form. `when` is the time as the view writes it. The countdown is worked out
 * here, from the instant and the frame's `now`, so it is as fresh as the frame.
 */
export function projectedForms(
  at: number,
  now: number,
  when: string,
): readonly [string, string, string] {
  const left = countdownTo(at, now);
  if (left === "now") return ["100% now", "100% now", "100% now"];
  return [`100% in ${left} (${when})`, `100% in ${left}`, `100% ${left}`];
}
