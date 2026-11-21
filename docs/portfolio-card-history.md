# How this project got presented on ryanxu.dev

Moved here 2026-11-21 from the `personal-site-planning` repo, which was
merged into `personal-site/docs/planning/` and archived. This history is
about *this* project, so it lives with this project.

Nothing here is new to this repo — `CLAUDE.md` already documents the
Trulioo/Courtly dual-deployment split in detail. This is the decision trail
for how the project appeared on a personal portfolio site, and the branding
problem that trail uncovered.

## The decision: link out, never embed

Decided 2026-08-19. The portfolio shows seven projects; `finance-monorepo`
embeds live in an iframe on click, but this one was deliberately held to a
link-out card.

The reason was data, not polish: the Trulioo deployment holds a real
badminton group's real schedule, so embedding it as a "try it live" surface
would have let a stranger edit real data. A thumbnail plus an outbound link
was the compromise.

(That reasoning applied to the Trulioo deployment. It does not describe
Courtly, which is multi-tenant, requires no signup, and stores no group's
data — see "Group scoping" in `CLAUDE.md`.)

## The branding problem

A screenshot of the public homepage was captured 2026-08-19 for the project
card. A privacy check passed — the page loaded as an empty Setup tab with no
player names, emails, or phone numbers, and the tabs holding real schedule
data were deliberately never opened.

But the capture surfaced something the privacy check wasn't looking for. The
page header carried the **Trulioo wordmark** and the label
`INTERNAL TOOLS · V1.7.0`, served from `trulioo-badminton.onrender.com`.
Three objections to publishing that on a personal site:

1. It displays an employer's trademark on a personal, commercial-ish site,
   which can read as implied endorsement.
2. "Internal Tools" makes a personal side project look like company-internal
   work product, muddying who owns it.
3. It invites the question of whether this was built on company time or with
   company resources — a question a portfolio should not raise unprompted.

**First fix (2026-08-19): crop the header.** Top 64px removed, leaving
1456x750. Wordmark and label fully gone, tab bar and Setup UI intact.

That fixed the image and not the link. The card still pointed at
`trulioo-badminton.onrender.com`, so anyone clicking through landed on the
employer-branded page anyway. Logged at the time as a separate open
question: rebrand the app, move it to a neutral URL, or drop the live link.

## How it actually got resolved

The rename, August 2026. The product became **Courtly** on its own neutral
domain, and the portfolio card now points at `courtly.ryanxu.dev` with a
designed OG card (`og-courtly.png`) rather than a cropped screenshot. The
repository kept its old name; only the product was renamed.

Both cropped and uncropped screenshots were deleted on 2026-11-21 — they
captured a pre-rename page, and the uncropped one was the employer-branded
asset the crop existed to avoid. The designed OG card supersedes both.

**Still true as of 2026-11-21:** `trulioo-badminton.onrender.com` is live
(HTTP 200) and still serves the Trulioo wordmark and the "Internal Tools"
label. That is fine — it is the internal deployment, doing its job, and
nothing on the portfolio points at it any more. Worth knowing before that
URL gets handed to anyone.

## One tooling note worth keeping

`sips -c ... --cropOffset` **silently no-ops** on this macOS build: it
returns the source image unchanged with exit code 0. ImageMagick, ffmpeg,
and PIL were all absent. What worked was a small Swift/CoreGraphics script —
`CGImageSourceCreateWithURL` → `img.cropping(to:)` →
`CGImageDestinationCreateWithURL`.

A crop that reports success and changes nothing is the dangerous case here:
it would have shipped the uncropped, employer-branded image while looking
like it had worked.
