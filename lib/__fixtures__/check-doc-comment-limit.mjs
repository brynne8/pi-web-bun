// Prints every over-long top comment in the files named on the command line, so a
// change can be checked one file at a time while the rest of the tree still has work
// left in it. Exit status is 1 when anything is found.
//
//   bun lib/__fixtures__/check-doc-comment-limit.mjs lib/markdown.ts components/McpConfig.tsx
import { findLongTopComments } from "./doc-comment-limit.mjs";

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error("usage: bun lib/__fixtures__/check-doc-comment-limit.mjs <file> …");
  process.exit(2);
}

const findings = findLongTopComments({ files });
for (const finding of findings) {
  console.log(`${finding.file}:${finding.line}  ${finding.contentLines} lines  "${finding.firstLine.slice(0, 70)}"`);
}
console.log(findings.length === 0 ? "clean" : `${findings.length} over the limit in ${files.length} file(s)`);
process.exit(findings.length === 0 ? 0 : 1);
