import assert from "node:assert/strict";
import test from "node:test";

import {
  formatDuration,
  formatRelativeTime,
  formatShortRelativeTime,
  formatUpdatedTime,
  interpolateMessage,
  translateMessage,
} from "./format.ts";

test("interpolates string and numeric parameters", () => {
  assert.equal(interpolateMessage("Hello, {name} ({count})", { name: "Pi", count: 2 }), "Hello, Pi (2)");
});

test("falls back to English and returns the key when both are missing", () => {
  assert.equal(translateMessage("zh-CN", "common.ok", { en: { "common.ok": "OK" }, "zh-CN": {} }), "OK");
  assert.equal(translateMessage("zh-CN", "missing.key", { en: {}, "zh-CN": {} }), "missing.key");
});

test("formats relative time using the selected locale", () => {
  const now = new Date("2026-01-01T00:00:00.000Z");
  assert.equal(formatRelativeTime(new Date("2026-01-01T00:05:00.000Z"), "en", now), "in 5 minutes");
  assert.equal(formatRelativeTime(new Date("2025-12-31T23:00:00.000Z"), "zh-CN", now), "1小时前");
  // ICU's zh-TW data puts a space before the unit in Node's build and none in Bun's.
  assert.match(formatRelativeTime(new Date("2025-12-31T23:00:00.000Z"), "zh-TW", now), /^1 ?小時前$/);
});

test("shows a clock time today and a relative day for earlier updates", () => {
  const now = new Date(2026, 8, 22, 21, 18, 0);
  const today = new Date(2026, 8, 22, 9, 5, 0);
  const earlier = new Date(2026, 8, 19, 21, 18, 0);
  assert.equal(
    formatUpdatedTime(today.getTime(), "zh-CN", now),
    today.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" }),
  );
  assert.equal(formatUpdatedTime(earlier.getTime(), "zh-CN", now), "3天前");
  assert.equal(formatUpdatedTime(earlier.getTime(), "en", now), "3 days ago");
  assert.match(formatUpdatedTime(earlier.getTime(), "zh-TW", now), /^3 ?天前$/);
});

test("formats compact sidebar times in every locale", () => {
  const now = new Date("2026-10-07T12:00:00.000Z");
  const ago = (ms) => new Date(now.getTime() - ms);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const cases = [
    [ago(59_999), "now", "刚刚", "剛剛"],
    [ago(minute), "1m", "1分", "1分"],
    [ago(59 * minute), "59m", "59分", "59分"],
    [ago(hour), "1h", "1小时", "1小時"],
    [ago(23 * hour + 59 * minute), "23h", "23小时", "23小時"],
    [ago(day), "1d", "1天", "1天"],
    [ago(6 * day), "6d", "6天", "6天"],
    [ago(7 * day), "1w", "1周", "1週"],
    [ago(29 * day), "4w", "4周", "4週"],
    [ago(30 * day), "1mo", "1个月", "1個月"],
    [ago(364 * day), "12mo", "12个月", "12個月"],
    [ago(365 * day), "1y", "1年", "1年"],
    [ago(800 * day), "2y", "2年", "2年"],
  ];
  for (const [date, en, zhCN, zhTW] of cases) {
    assert.equal(formatShortRelativeTime(date, "en", now), en);
    assert.equal(formatShortRelativeTime(date, "zh-CN", now), zhCN);
    assert.equal(formatShortRelativeTime(date, "zh-TW", now), zhTW);
  }
});

test("compact sidebar times accept ISO strings and tolerate odd input", () => {
  const now = new Date("2026-10-07T12:00:00.000Z");
  assert.equal(formatShortRelativeTime("2026-10-07T09:30:00.000Z", "en", now), "2h");
  assert.equal(formatShortRelativeTime("2026-10-08T12:00:00.000Z", "en", now), "now", "future dates count as now");
  assert.equal(formatShortRelativeTime("not a date", "en", now), "");
  assert.equal(formatShortRelativeTime(new Date(Number.NaN), "zh-CN", now), "");
  assert.equal(formatShortRelativeTime("2026-10-07T11:55:00.000Z", "fr", now), "5m", "unknown locales use English");
});

test("formats a duration in the compact shape the chat and the stats rows use", () => {
  assert.equal(formatDuration(0, "en"), "0s");
  assert.equal(formatDuration(14_900, "en"), "14s");
  assert.equal(formatDuration(185_000, "en"), "3m 5s");
  assert.equal(formatDuration(3_725_000, "en"), "1h 2m 5s");
  // A unit that is zero is left out rather than spelled out.
  assert.equal(formatDuration(4_800_000, "en"), "1h 20m");
  assert.equal(formatDuration(-50, "en"), "0s");
});

test("takes a duration's units from the language, where the runtime has DurationFormat", () => {
  // Node 22.19, which CI runs the suite on, has no Intl.DurationFormat; there the
  // compact shape is built by hand and the units stay in English, as they always
  // were. Only a runtime with the API can be asked for another language's units.
  if (typeof Intl.DurationFormat !== "function") {
    assert.equal(formatDuration(185_000, "zh-CN"), "3m 5s");
    return;
  }
  assert.equal(formatDuration(185_000, "zh-CN"), "3分钟5秒");
  assert.equal(formatDuration(3_725_000, "zh-CN"), "1小时2分钟5秒");
  assert.equal(formatDuration(14_900, "zh-TW"), "14秒");
});

test("builds the same compact shape by hand where Intl.DurationFormat is missing", () => {
  // Safari before 16.4 has no Intl.DurationFormat; the rows there read exactly
  // as they did before it was used, so the language only changes the units.
  const original = Intl.DurationFormat;
  Intl.DurationFormat = undefined;
  try {
    assert.equal(formatDuration(0, "zh-CN"), "0s");
    assert.equal(formatDuration(14_900, "zh-CN"), "14s");
    assert.equal(formatDuration(185_000, "zh-CN"), "3m 5s");
    assert.equal(formatDuration(3_725_000, "zh-CN"), "1h 2m 5s");
  } finally {
    Intl.DurationFormat = original;
  }
});
