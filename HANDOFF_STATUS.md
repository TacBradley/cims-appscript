# CIMS Kiosk — Session Status (as of 2026-10-23)

## Where things stand

Printer connectivity and the network issues are **fully resolved** — the
Brother QL-810W prints silently via Kiosk Pro's Automatic Kiosk Print Mode
over 2.4GHz. Root causes along the way: iPad was on 5GHz while the printer
is 2.4GHz-only; a stale Kiosk Pro printer reference needed a Reset Printer;
Wi-Fi's WPS being enabled was blocking the iPad's reconnect to 2.4GHz
(disabled, fixed it — leave WPS off).

## Fixed and deployed this session

1. **Season icons rendering jagged on thermal print** — fixed. Added
   `︎` (text presentation selector) to both the snowflake and sun
   characters so they render as plain monochrome glyphs instead of color
   emoji that dithers badly on a monochrome thermal printer.
2. **Label printing in portrait instead of landscape** — fixed, but it
   wasn't a code bug. `Code.gs`'s own `@page` CSS was already correct
   (100mm × 62mm). The actual cause was Kiosk Pro's own AirPrint setting
   (Settings → Printing → AirPrint → **Print Orientation**), which was set
   to Portrait. Brad flipped it to Landscape directly in the app.
3. **Barcode/Tote ID library (JsBarcode) wasn't loading at all** — fixed.
   It was loaded from `cdnjs.cloudflare.com`, which the kiosk's locked-down
   network likely couldn't reach; every call site silently swallowed the
   failure (`if (window.JsBarcode)` + empty `catch`), so nothing ever
   indicated why barcodes were blank. Fix: embedded the actual JsBarcode
   v3.11.5 source directly in `Code.gs` (new `JSBARCODE_LIB_JS` constant +
   a `doGet(?asset=jsbarcode)` branch), served from the same deployment —
   same self-hosting pattern the project already used for
   `kiosk_functions.js`, for the same reason. `<script src>` now points at
   the deployment's own URL instead of the CDN.
4. **Barcode SVG not scaled to fit (missing from preview + the post-print
   success list)** — fixed. `buildPrintArea_()` (the real print path) was
   already correctly calling `fitBarcodeSvg_(svgId, 90, 26)` after
   generating each barcode; `renderPreview()` and the success-list drawing
   loop were missing that same call. Added it to both.

## STILL OPEN — pick up here

1. **Real printed label is missing the barcode AND the Tote ID number text
   entirely** (the whole bottom row), even though:
   - The on-screen preview *does* show the barcode now (after fix #4
     above) — but it's rendering **too wide, overflowing the label edge,
     not scannable**, meaning the preview's fit fix may not actually be
     taking effect as intended, or something else is overriding it.
   - The real *print* path losing the Tote ID plain-text too (not just the
     barcode graphic) is a different symptom than preview and doesn't yet
     have a confirmed explanation. Was mid-way through requesting a fresh
     preview screenshot + a fresh print photo to compare directly before
     this was interrupted — **still need those two pieces of visual
     evidence** to diagnose further rather than keep guessing blind.
   - Earlier theory (fixed-height `.label-art` box with near-zero margin
     before content gets silently clipped by `overflow: hidden`) was
     tested via a padding/gap trim (~10px reclaimed) — confirmed deployed,
     did NOT resolve it on its own, so it's likely not the full story, or
     not the dominant factor once a real (wider) barcode is actually
     rendering into that space.
2. **"Created by a Google Apps Script user" banner** — partially improved,
   not resolved. Originally printed baked directly into the label content;
   after removing `GmailApp` (see below), it now prints on its own
   separate label/page instead of corrupting the real one — better, but
   still consumes an extra physical label every print and still isn't
   actually gone. Root cause not fully confirmed; working theory (sensitive
   OAuth scope triggering Google's unreviewed-app banner project-wide) was
   only partially right, since removing the one identified sensitive scope
   didn't eliminate it. Needs more investigation — possibly this banner is
   shown on ANY public web app from a personal (non-Workspace) Gmail
   account regardless of scopes, which would mean the scope route was a
   dead end and a different approach is needed.
3. **Dead code identified, not yet removed**: `recordDropoff()` and
   `recordNewSignupDropoff()` — old stepper-based check-in entry points,
   explicitly self-documented in the code as unused. Safe to delete
   whenever convenient; low priority, cosmetic cleanup only.
4. **Unidentified CSS/formatting bloat** Brad recalls being added "a few
   days ago" to "cover all possibilities of printing or formatting" —
   searched for duplicate `@media print` blocks, legacy/deprecated markers;
   found none. Could not identify without either (a) Brad pointing to the
   specific section, or (b) a diff against the file as it stood before
   that session (which is exactly the kind of thing real version history
   would make trivial — see below).

## A tradeoff made this session, worth remembering

Removed `GmailApp.sendEmail()` (used to send drop-off notification emails
and the daily Liberty change report *as* the `adorableconsignments@gmail.com`
alias) in favor of `MailApp` only, as part of the banner investigation
(#2 above). **Emails now send from whichever Google account owns the
script**, not from that alias — display name ("The Adorable Child") is
preserved, but the From address changed. Confirmed this does NOT affect
the Klaviyo integration (`fireKlaviyoDropoffEvent_`), which pushes events
directly to Klaviyo's API via `UrlFetchApp` and never touches email at all.

## Open ask: project memory going forward

Brad wants an authoritative, persistent source of project context so a
new session doesn't depend on chat memory (this conversation got
auto-summarized partway through and lost some detail, which is part of
what prompted this). Proposed approach, not yet set up:

1. A git repo for `Code.gs` (real version history — answers "what did we
   add recently" with an actual diff instead of a guess).
2. This kind of handoff/status doc, kept current, living in a Claude
   Project alongside the repo so every new session starts with it loaded.
3. **Brad mentioned a prior "CIMS handoff (§3.2)" document already exists**
   (referenced directly in a `Code.gs` comment, line ~54, as the source of
   `CONFIG_DEFAULTS` fallback values) — need to track that down and use it
   as the seed of whatever gets built next, rather than starting over.

## Project facts worth keeping handy

- Brother QL-810W, 2.4GHz-only Wi-Fi, DK-1202 die-cut labels (3.9in × 2.4in
  / 100mm × 62mm, landscape).
- Kiosk Pro Enterprise running Automatic Kiosk Print Mode on an iPad.
- Apps Script web app deployment URL:
  `https://script.google.com/macros/s/AKfycbzH3z9dVoUreUST72ISKBbxNBabhJOrrhmNyJGwZ72Rqs4laoQem15f2cCnPMG0NXCaRA/exec`
- Spectrum router/gateway admin at `192.168.1.1` (firmware 1.2.4) — WPS is
  intentionally OFF on 2.4GHz; leave it that way.
- Klaviyo: `fireKlaviyoDropoffEvent_()` fires a "Consignment Drop-Off"
  event per check-in via direct API call (not email-based) — confirmed
  independent of the email alias changes above.
