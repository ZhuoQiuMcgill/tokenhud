// Acceptance criterion 1: calendar periods across DST (America/Toronto), Monday 00:00 week
// boundaries, month boundaries and a +05:30 zone. Expected instants are worked out by
// hand from each zone's rules and written in UTC.
import { describe, expect, test } from "bun:test";
import { calendarSlices, equalBuckets, resolvePeriod } from "../../src/query/periods.ts";
import { isTimeZone, Zone } from "../../src/query/tz.ts";

const at = (iso: string) => Date.parse(iso);
const toronto = Zone.of("America/Toronto");
const kolkata = Zone.of("Asia/Kolkata");
const HOUR = 3_600_000;

describe("Zone", () => {
  test("offsets either side of Toronto's 2026 transitions", () => {
    // Spring forward: Sunday 2026-03-08, 02:00 EST -> 03:00 EDT, at 07:00Z.
    expect(toronto.offset(at("2026-03-08T06:59:59.999Z"))).toBe(-5 * HOUR);
    expect(toronto.offset(at("2026-03-08T07:00:00Z"))).toBe(-4 * HOUR);
    // Fall back: Sunday 2026-11-01, 02:00 EDT -> 01:00 EST, at 06:00Z.
    expect(toronto.offset(at("2026-11-01T05:59:59.999Z"))).toBe(-4 * HOUR);
    expect(toronto.offset(at("2026-11-01T06:00:00Z"))).toBe(-5 * HOUR);
  });

  test("local dates and ISO strings carry the zone's offset", () => {
    expect(toronto.dateAt(at("2026-03-08T04:59:59Z"))).toEqual({ year: 2026, month: 3, day: 7 });
    expect(toronto.dateAt(at("2026-03-08T05:00:00Z"))).toEqual({ year: 2026, month: 3, day: 8 });
    expect(toronto.iso(at("2026-03-08T05:00:00Z"))).toBe("2026-03-08T00:00:00.000-05:00");
    expect(toronto.iso(at("2026-03-09T04:00:00Z"))).toBe("2026-03-09T00:00:00.000-04:00");
    expect(kolkata.iso(at("2026-09-29T18:30:00Z"))).toBe("2026-09-30T00:00:00.000+05:30");
    expect(Zone.of("UTC").iso(0)).toBe("1970-01-01T00:00:00.000Z");
  });

  test("a day whose midnight a DST gap skips starts at the transition", () => {
    // Chile springs forward at 24:00 on Saturday 2026-09-05: 00:00 -04 becomes 01:00 -03,
    // so Sunday the 6th starts at 01:00 local, 04:00Z.
    const santiago = Zone.of("America/Santiago");
    expect(santiago.startOf({ year: 2026, month: 9, day: 6 })).toBe(at("2026-09-06T04:00:00Z"));
    expect(santiago.dateAt(at("2026-09-06T03:59:59.999Z")).day).toBe(5);
  });

  test("names are validated and canonicalised", () => {
    expect(isTimeZone("Europe/Paris")).toBe(true);
    expect(isTimeZone("Mars/Olympus_Mons")).toBe(false);
    expect(Zone.of("asia/kolkata").name).toBe("Asia/Kolkata");
  });
});

describe("today", () => {
  test("is 23 hours on Toronto's spring-forward day", () => {
    const range = resolvePeriod("today", at("2026-03-08T15:00:00Z"), toronto, null);
    expect(range).toEqual({ from: at("2026-03-08T05:00:00Z"), to: at("2026-03-09T04:00:00Z") });
    expect(range.to - range.from).toBe(23 * HOUR);
  });

  test("is 25 hours on Toronto's fall-back day", () => {
    const range = resolvePeriod("today", at("2026-11-01T15:00:00Z"), toronto, null);
    expect(range).toEqual({ from: at("2026-11-01T04:00:00Z"), to: at("2026-11-02T05:00:00Z") });
    expect(range.to - range.from).toBe(25 * HOUR);
  });

  test("starts at 18:30Z the day before in a +05:30 zone", () => {
    expect(resolvePeriod("today", at("2026-09-30T10:00:00Z"), kolkata, null)).toEqual({
      from: at("2026-09-29T18:30:00Z"),
      to: at("2026-09-30T18:30:00Z"),
    });
    // 23:59 local on the 30th is still the 30th; a minute later it is October 1st.
    expect(resolvePeriod("today", at("2026-09-30T18:29:59.999Z"), kolkata, null).from).toBe(
      at("2026-09-29T18:30:00Z"),
    );
    expect(resolvePeriod("today", at("2026-09-30T18:30:00Z"), kolkata, null).from).toBe(
      at("2026-09-30T18:30:00Z"),
    );
  });
});

describe("this_week", () => {
  test("runs Monday 00:00 to the next Monday 00:00", () => {
    // Thursday 2026-10-01 in Toronto: the week of Monday 2026-09-28.
    expect(resolvePeriod("this_week", at("2026-10-01T16:00:00Z"), toronto, null)).toEqual({
      from: at("2026-09-28T04:00:00Z"),
      to: at("2026-10-05T04:00:00Z"),
    });
  });

  test("turns over exactly at Monday 00:00 local", () => {
    const sundayNight = at("2026-10-05T03:59:59.999Z"); // Sunday 23:59:59.999 EDT
    const mondayMidnight = at("2026-10-05T04:00:00Z");
    expect(resolvePeriod("this_week", sundayNight, toronto, null).from).toBe(
      at("2026-09-28T04:00:00Z"),
    );
    expect(resolvePeriod("this_week", mondayMidnight, toronto, null).from).toBe(mondayMidnight);
  });

  test("is 167 hours across the spring-forward Sunday", () => {
    const range = resolvePeriod("this_week", at("2026-03-04T12:00:00Z"), toronto, null);
    expect(range).toEqual({ from: at("2026-03-02T05:00:00Z"), to: at("2026-03-09T04:00:00Z") });
    expect(range.to - range.from).toBe(167 * HOUR);
  });

  test("starts on Monday in a +05:30 zone too", () => {
    expect(resolvePeriod("this_week", at("2026-10-01T06:00:00Z"), kolkata, null)).toEqual({
      from: at("2026-09-27T18:30:00Z"),
      to: at("2026-10-04T18:30:00Z"),
    });
  });
});

describe("this_month", () => {
  test("runs from the 1st to the next 1st, across DST", () => {
    const range = resolvePeriod("this_month", at("2026-03-15T12:00:00Z"), toronto, null);
    expect(range).toEqual({ from: at("2026-03-01T05:00:00Z"), to: at("2026-04-01T04:00:00Z") });
    expect(range.to - range.from).toBe(31 * 24 * HOUR - HOUR);
  });

  test("handles February and the year's end", () => {
    expect(resolvePeriod("this_month", at("2026-02-14T12:00:00Z"), toronto, null)).toEqual({
      from: at("2026-02-01T05:00:00Z"),
      to: at("2026-03-01T05:00:00Z"),
    });
    expect(resolvePeriod("this_month", at("2027-01-01T04:59:59Z"), toronto, null)).toEqual({
      from: at("2026-12-01T05:00:00Z"),
      to: at("2027-01-01T05:00:00Z"),
    });
  });

  test("turns over at local midnight on the 1st in a +05:30 zone", () => {
    expect(resolvePeriod("this_month", at("2026-09-30T18:29:59.999Z"), kolkata, null).from).toBe(
      at("2026-08-31T18:30:00Z"),
    );
    expect(resolvePeriod("this_month", at("2026-09-30T18:30:00Z"), kolkata, null)).toEqual({
      from: at("2026-09-30T18:30:00Z"),
      to: at("2026-10-31T18:30:00Z"),
    });
  });
});

describe("rolling, all and custom", () => {
  const now = at("2026-10-01T12:34:56.789Z");

  test("rolling periods end at now inclusive", () => {
    expect(resolvePeriod("1h", now, toronto, null)).toEqual({ from: now - HOUR, to: now + 1 });
    expect(resolvePeriod("5h", now, toronto, null)).toEqual({ from: now - 5 * HOUR, to: now + 1 });
    expect(resolvePeriod("24h", now, toronto, null)).toEqual({
      from: now - 24 * HOUR,
      to: now + 1,
    });
  });

  test("all is the store's extent, and empty without data", () => {
    expect(resolvePeriod("all", now, toronto, { first: 10, last: 20 })).toEqual({
      from: 10,
      to: 21,
    });
    expect(resolvePeriod("all", now, toronto, null)).toEqual({ from: 0, to: 0 });
  });

  test("custom is taken as given", () => {
    expect(resolvePeriod({ since: 5, until: 9 }, now, toronto, null)).toEqual({ from: 5, to: 9 });
  });
});

describe("calendarSlices", () => {
  test("days across both Toronto transitions are 23 and 25 hours", () => {
    const spring = calendarSlices(
      { from: at("2026-03-07T05:00:00Z"), to: at("2026-03-10T04:00:00Z") },
      "day",
      toronto,
    );
    expect(spring.map((s) => [s.key, (s.to - s.from) / HOUR])).toEqual([
      ["2026-03-07", 24],
      ["2026-03-08", 23],
      ["2026-03-09", 24],
    ]);
    const fall = calendarSlices(
      { from: at("2026-11-01T04:00:00Z"), to: at("2026-11-03T05:00:00Z") },
      "day",
      toronto,
    );
    expect(fall.map((s) => [s.key, (s.to - s.from) / HOUR])).toEqual([
      ["2026-11-01", 25],
      ["2026-11-02", 24],
    ]);
  });

  test("clips the first and last group to the range", () => {
    const range = { from: at("2026-09-30T10:00:00Z"), to: at("2026-10-01T10:00:00Z") };
    expect(calendarSlices(range, "day", kolkata)).toEqual([
      { key: "2026-09-30", from: range.from, to: at("2026-09-30T18:30:00Z") },
      { key: "2026-10-01", from: at("2026-09-30T18:30:00Z"), to: range.to },
    ]);
  });

  test("weeks are keyed by their Monday and months by YYYY-MM", () => {
    const range = { from: at("2026-09-28T04:00:00Z"), to: at("2026-10-19T04:00:00Z") };
    expect(calendarSlices(range, "week", toronto).map((s) => s.key)).toEqual([
      "2026-09-28",
      "2026-10-05",
      "2026-10-12",
    ]);
    expect(calendarSlices(range, "month", toronto)).toEqual([
      { key: "2026-09", from: range.from, to: at("2026-10-01T04:00:00Z") },
      { key: "2026-10", from: at("2026-10-01T04:00:00Z"), to: range.to },
    ]);
  });

  test("an empty range has no groups", () => {
    expect(calendarSlices({ from: 5, to: 5 }, "day", toronto)).toEqual([]);
  });
});

test("equalBuckets splits a range into equal parts", () => {
  expect(equalBuckets({ from: 0, to: 24 * HOUR }, 72)).toHaveLength(73);
  expect(equalBuckets({ from: 0, to: 24 * HOUR }, 72)[1]).toBe(20 * 60_000);
  expect(equalBuckets({ from: 0, to: 10 }, 3)).toEqual([0, 3, 7, 10]);
});
