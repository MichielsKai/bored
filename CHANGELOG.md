# Changelog

Version numbers: **major.minor.patch**. Kai decides whether a release is minor or major.

## Unreleased

### Added
- **Points**: every session earns points (10 per minute) times a multiplier built from bonuses: streak (+10% per day, up to +100%), rediscovering something untouched for 2+ weeks (+50%/+100%), the wheel's pick (+25% when the timer starts from a spin), live timer (+20%) and focus (+20% for 1 h, +40% for 2 h). Streak milestones (3 to 365 days) and finishing a project pay one-off bonuses. Up to 8 hours a day count, and time added more than 2 days late earns nothing.
- **Points reveal** after logging time: the bonuses pop in one by one and the total counts up.
- **Streak card** on the spin screen, showing today's progress and the bonus for your next session.
- **Friends**: add people by username, accept or decline requests, remove friends. Friends see only points, hours and streak.
- **Leaderboard** for this week, this month and all time, with rank changes since your last visit.
- Points tiles in Stats and points per session in the history. Sessions from before 1.1 get base points.

### Changed
- The line above a spin result no longer mentions a time of day ("Tonight you're doing").

## 1.0.0 — 2026-11-27

First official release (commit `296d8a7`).

- Spin-the-wheel for hobbies, games and projects, favouring neglected ones
- Live timer and manual time logging, wishlist, one purchase unlocked per 20 hours
- Invite-only accounts with an admin, password resets, signed-in device management
- Security hardening and a penetration test, with 42 automated attack tests
- Automatic deployment to the Raspberry Pi through GitHub and the Pi updater
