# Writing a README feature entry

`README.md` → *Differences from upstream* → *Features this fork adds* is a list of what a reader gets. `docs/agents/` owns why and how. An entry is the feature, not the work behind it: what someone sees, then one sentence on what upstream does instead, then the note link. Nothing else — no reason, no mechanism, no narrative.

- **One claim per bold title.** A headline like "…and the turn ends once" reads as a claim that upstream ends a turn several times, which it does not: the repetition it argued against came from this fork's own intermediate design. A reader compares us with upstream, never with our drafts, so a headline that sells a fix to our own earlier bug is both confusing and not a difference at all.
- **60–110 words of prose.** That is the section's own band, and the entry that stands out from the column is too long even when it reads fine. Count links as their text, and look at the whole column rather than one number:

  ```bash
  grep -n '^\*\*' README.md | cut -d: -f1 | while read -r n; do
    w=$(awk -v n="$n" 'NR==n' README.md | sed -E 's/\[([^]]*)\]\([^)]*\)/\1/g; s/`//g' | wc -w | tr -d ' ')
    printf '%4s  %3sw  %s\n' "$n" "$w" "$(awk -v n="$n" 'NR==n' README.md | grep -o '^\*\*[^*]*\*\*' | cut -c1-46)"
  done
  ```

- **No implementation numbers.** px, line height, milliseconds, byte sizes, line counts, CSS-variable counts, `!important`. A number stays only where the user meets it as behaviour — the two-minute hand-off, the 120 s auto-background. A type change is "a step smaller than upstream's"; the exact pair of sizes belongs to the note that owns the CSS.
- **No bare commit hashes in an entry.** PR and issue links stay, because the rule that each entry ends with what upstream does needs something to point at. A bare hash answers "who wrote this", which is git's to answer and the note's to record, not the README's.
- **No reasons, defences, or codas.** "because a file you are scanning reads at a glance", "it adds no syntax-highlighting dependency: 245 lines of scanner plus a renderer, six CSS variables", "so the fix cannot die quietly" — three shapes the same paragraph grows back. Each explains or defends a decision instead of naming the behaviour; the note is where the explanation lives.
- **One mention per fact.** A thinking card's font size appeared in the entry's title, in its body, and in the *Features* bullet. The bullet is the entry's short form, not a third copy of its caveat.
- **The detail is moved, not deleted.** Before a number or a mechanism leaves the README, confirm the note for that area holds it: this fork's rule is that every difference is written down somewhere, and the README is not that place.
- **`README.zh-CN.md` mirrors the English entry** — same claims, same one sentence on upstream, same level of detail, so a trim to one file is a trim to both. `README.ja.md` and `README.ru.md` carry the fork banner only, which is deliberate: a new feature entry has no counterpart there until someone translates the section.
- **A relative link resolves from its own file.** `README.md` sits at the repository root and writes `./docs/agents/sessions.md#anchor`; `README.zh-CN.md` sits in `docs/` and writes `./agents/sessions.md#anchor`. A link copied from the English copy into the Chinese one lands under `docs/docs/`, so GitHub answers 404 for it — 35 of the section's note links were in that state, invisible to anyone who reads only the English file or opens the Chinese one locally. After a README edit, resolve every relative target against the directory of the file that holds it.
- The gate that does run on these files is `bun test lib/markdown-emphasis.test.mjs` (see [tests.md](tests.md)): a bold run closed after a CJK sentence mark and before a letter renders as literal `**`.

Files: `README.md`, `README.zh-CN.md` (the *Features* bullets and *Features this fork adds*); each entry ends with a link into the note that owns its area.
