# Release Checklist

This branch releases one artifact: a GitHub Release on `brynne8/pi-web-bun`, cut from a tagged commit. **No npm package is published from this branch** — the README says so in both languages, `package.json` still carries upstream's name `@agegr/pi-web`, and npm Trusted Publishing is bound to `agegr/pi-web` together with a workflow file of that repository, so nothing here can publish that name.

Upstream publishes `@agegr/pi-web` from GitHub Actions when a `v*` tag is pushed ([`16f195c6`](https://github.com/agegr/pi-web/commit/16f195c6d84a4b341337635faf72a81a3c11c74d)), with its own `docs/release.md` describing that runbook. This branch keeps no `.github/workflows/publish.yml`: a copy of it here would either fail on the Trusted Publisher entry or publish upstream's package from this repository's build.

Tags carry a `-fork` suffix (`v0.9.0-fork`) so they never collide with upstream's `v<version>` tags — a clone of this branch already holds one of those per upstream release.

## 1. Preflight

```bash
git fetch bun && git fetch origin --tags
git status --short --branch
git log --oneline --decorate -5
gh auth status
node -e "const p=require('./package.json'); console.log(p.version)"
gh run list --branch main --workflow ci.yml --limit 1
```

Expected:

- `git status` is clean: `npm version` refuses a dirty tree.
- The branch you are releasing is aligned with its remote.
- GitHub is authenticated as an account that can push and create releases.
- CI on the commit you are releasing passed. Nothing here builds for you.

Nothing is uploaded, so a running dev server on port 30141 is harmless.

Before bumping, confirm both names are free (replace `<version>`):

```bash
git ls-remote --tags bun v<version>-fork   # expect empty
git tag --list "v<version>*"               # upstream's v<version> may already be here; that is expected
gh release view v<version>-fork --repo brynne8/pi-web-bun
```

## 2. Bump the Version

```bash
npm run release
```

which is:

```bash
npm version patch --no-git-tag-version
```

`--no-git-tag-version` is deliberate: `npm version` names its tag `v<version>`, which is upstream's namespace (`v0.13.0` exists upstream and in this clone), and the version number itself tracks upstream's, since this branch follows upstream's releases and adds its own version band. So the bump commits and the tag is made separately, one step below.

`npm run release` only bumps the patch number. For a minor release, set the version yourself and run the other step by hand:

```bash
npm version <x.y.0> --no-git-tag-version
```

Choosing the bump: look at `git log --oneline v<previous>-fork..HEAD`. A batch of `feat:` commits (new UI, new commands, new settings), or a sync that landed upstream features users can see, is a minor; only fixes and small adjustments is a patch.

Check the result before committing:

```bash
git show --stat HEAD
git status --short
```

`package-lock.json` moves with `package.json`, and it is the file upstream's CI installs from, so it belongs in the same commit.

## 3. Commit, Tag and Push

```bash
git add package.json package-lock.json
git commit -m "Release v<version>-fork"
git tag -a v<version>-fork -m "v<version>-fork"
git push bun <branch> v<version>-fork
```

Push the release tag by name. Never `git push --tags`: this clone holds upstream's tags and tags fetched from other remotes, and `--tags` would push all of them (upstream's own checklist records the same accident, a stray `v0.10.5` landing during its v0.11.0 release). If you ever need `--tags`, compare `git tag` with `git ls-remote --tags bun` first.

## 4. Generate Release Notes from Commits

Two ranges, because a release of this branch is both things at once:

```bash
# what this fork itself changed since the last fork release
git log --oneline --decorate v<previous>-fork..v<version>-fork --grep=""
git log --format='%h%x09%s%n%b' v<previous>-fork..v<version>-fork

# what the merge brought in from upstream
git log --oneline --decorate <previous-upstream-tip>..<new-upstream-tip>
```

Write the notes from those commits, not from memory. Include both Chinese and English sections. Keep commit hashes or PR numbers next to each item when useful.

- Check commands, flags and setting names against `README.md` and the code before writing them down.
- Name the upstream release being tracked (for example "based on upstream v0.13.0") and link it.
- For an entry copied from upstream's release notes, link upstream's PR rather than restating it as this branch's work — the README's *Differences from upstream* already says who owns what.
- Thank outside contributors by name: `git log --format='%h %an | %s'` lists authors.
- Open with how to run this branch from a clone (`bun install && bun run dev`, or the published launcher), not with an `npm install -g` line: there is no package to install.
- Write the notes to a file outside the repo (`NOTES=$(mktemp)`), or pass them through stdin as below. A `release-notes.md` in the repo root is an untracked file in the next release's `git status`.

Suggested structure:

```markdown
## 中文

基于 upstream v<upstream-version>，区间 `v<previous>-fork..v<version>-fork`。

### 新增

- ...

### 修复

- ...

### 从上游同步

- ...（带原版 PR 链接）

## English

Based on upstream v<upstream-version>, range `v<previous>-fork..v<version>-fork`.

### Added

- ...

### Fixed

- ...

### Synced from upstream

- ... (link upstream's PR)
```

## 5. Create or Update the GitHub Release

```bash
gh release create v<version>-fork \
  --repo brynne8/pi-web-bun \
  --verify-tag \
  --title "v<version>-fork" \
  --notes-file "$NOTES"
```

If the release already exists and only the notes need updating:

```bash
gh release edit v<version>-fork --repo brynne8/pi-web-bun --notes-file - <<'EOF'
## 中文

...

## English

...
EOF
```

## 6. Final Verification

```bash
gh release view v<version>-fork --repo brynne8/pi-web-bun
git status --short --branch
git log --oneline --decorate -3
git ls-remote --tags bun | grep "v<version>"
```

Expected:

- GitHub Release exists and is not a draft unless intentionally published as one.
- No npm command to run: nothing was published, and `npm view @agegr/pi-web` answering with some version says nothing about this release.
- `git ls-remote --tags bun` shows the `-fork` tag and nothing else you did not mean to push.
- The released branch is aligned with its remote, and `HEAD` points at the release commit and its tag.
