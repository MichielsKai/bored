# Working on bored?

Kai's spin-the-wheel app. It runs on his Raspberry Pi at bored.kaikawaka.com, and every push to `main` deploys there automatically within about 10 minutes.

## Release rules (from Kai)

- **Never push to GitHub until Kai says so.** Commit locally and keep working; features are batched into a release.
- **Before pushing, ask Kai whether it's a minor or a major release.** Then bump `version` in `package.json` (minor: 1.0.0 → 1.1.0; major: 1.x → 2.0.0), move the "Unreleased" notes in `CHANGELOG.md` under the new version with today's date, commit, and push.
- Every user-facing change gets a line under "Unreleased" in `CHANGELOG.md`, written for the people using the app (it's shown in Settings → What's new): plain language, no commit IDs or jargon. Group under `### New`, `### Changed`, `### Fixed`.
- Pushing tags isn't possible from Claude sessions. Kai can create a GitHub release for the version himself if he wants one.

## Before every commit

- `node --experimental-sqlite test/security.js` must pass. CI runs it too, and nothing deploys if it fails.
- New endpoints need: login check (`auth: true`), ownership checks (`user_id = ?`), input limits via `str()`/`int()`, and a test in `test/security.js` if they touch other users' data.
- Text from users goes into HTML only through `esc()`.
- No new npm dependencies: the app is deliberately dependency-free.

## Design

Calm, minimal, mobile first. Figtree font, indigo accent `#5457E0`, pastel wheel slices with dark text, filled surfaces instead of outlines. Sentence-case copy, no time-of-day assumptions.
