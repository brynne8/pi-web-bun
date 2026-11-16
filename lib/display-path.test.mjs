import assert from "node:assert/strict";
import test from "node:test";
import { displayPathWithin, relativeToRoot, shortenPath } from "./display-path.ts";

test("shows a macOS or Linux home folder as ~", () => {
  assert.equal(shortenPath("/Users/alex/repo/a.md"), "~/repo/a.md");
  assert.equal(shortenPath("/home/alex"), "~");
  assert.equal(shortenPath("/opt/repo"), "/opt/repo");
  // Only a leading home folder counts.
  assert.equal(shortenPath("/srv/Users/alex"), "/srv/Users/alex");
});

test("shows a path inside the root relative to it", () => {
  assert.equal(displayPathWithin("/Users/alex/repo/.pi/skills/a/SKILL.md", "/Users/alex/repo"), "./.pi/skills/a/SKILL.md");
  assert.equal(displayPathWithin("/Users/alex/repo/x", "/Users/alex/repo/"), "./x");
  assert.equal(displayPathWithin("C:\\repo\\x\\SKILL.md", "C:\\repo"), "./x\\SKILL.md");
});

test("a sibling folder that shares the root's prefix is not inside it", () => {
  assert.equal(displayPathWithin("/Users/alex/repo-other/x", "/Users/alex/repo"), "~/repo-other/x");
  assert.equal(displayPathWithin("/opt/elsewhere/x", "/Users/alex/repo"), "/opt/elsewhere/x");
  assert.equal(displayPathWithin("/Users/alex/x", ""), "~/x");
});

test("a path inside the root reads from there, without a leading separator", () => {
  assert.equal(relativeToRoot("/repo/app/src/x.ts", "/repo/app"), "src/x.ts");
  assert.equal(relativeToRoot("/repo/app/src/x.ts", "/repo/app/"), "src/x.ts");
  assert.equal(relativeToRoot("/repo/appx/src/x.ts", "/repo/app"), null);
  assert.equal(relativeToRoot("/repo/app", "/repo/app"), null);
  assert.equal(relativeToRoot("src/x.ts", "/repo/app"), null);
  assert.equal(relativeToRoot("/repo/app/src/x.ts", undefined), null);
  assert.equal(relativeToRoot("/repo/app/src/x.ts", "/"), null);
});
