import assert from "node:assert/strict";
import test from "node:test";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  jsx: { runtime: "automatic" },
  tsconfigPaths: true,
});
const React = await jiti.import("react");
const { renderToStaticMarkup } = await jiti.import("react-dom/server");
const { DelimitedTable } = await jiti.import("./DelimitedTable.tsx");

const slice = "alice,plain\nbob,\"two\nlines\"\ncarol,last\n";

function render(props) {
  // The component never scrolls itself: the viewer owns the box, and a server
  // render never reads it.
  return renderToStaticMarkup(React.createElement(DelimitedTable, {
    complete: true,
    scrollRef: { current: null },
    ...props,
  }));
}

test("the gutter numbers a slice's rows by the file line each starts on", () => {
  const whole = render({ content: "name,note\n" + slice, filePath: "/tmp/a.csv" });
  // Header on line 1, then line 2, line 3 (which spans 3 and 4) and line 5.
  assert.match(whole, /role="rowheader"[^>]*>1<\/div>/);
  assert.match(whole, /role="rowheader"[^>]*>2<\/div>/);
  assert.match(whole, /role="rowheader"[^>]*>3<\/div>/);
  assert.match(whole, /role="rowheader"[^>]*>5<\/div>/);

  const offset = render({ content: slice, filePath: "/tmp/a.csv", firstLine: 40 });
  assert.match(offset, /role="rowheader"[^>]*>40<\/div>/);
  assert.match(offset, /role="rowheader"[^>]*>41<\/div>/);
  assert.match(offset, /role="rowheader"[^>]*>43<\/div>/);
});

test("a slice from mid-file keeps every record and numbers its columns", () => {
  const html = render({ content: slice, filePath: "/tmp/a.csv", firstLine: 40 });
  assert.match(html, /aria-rowcount="4"/);
  assert.match(html, /role="columnheader"[^>]*>#1<\/div>/);
  assert.match(html, /role="columnheader"[^>]*>#2<\/div>/);
  // No record was eaten as a header row.
  assert.match(html, /alice/);
});

test("text with a header renders it, and no record at all renders nothing", () => {
  const withHeader = render({ content: "name,note\nalice,plain\n", filePath: "/tmp/a.csv" });
  assert.match(withHeader, /role="columnheader"[^>]*>name<\/div>/);
  assert.match(withHeader, /aria-rowcount="2"/);
  // The viewer falls back to highlighted source on this: no scroller, no shell.
  assert.equal(render({ content: "\n\n", filePath: "/tmp/a.csv" }), "");
});
