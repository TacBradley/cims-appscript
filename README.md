# CIMS — Consignor Information Management System

**The Adorable Child** — first working slice: the tiering/banding engine, a back-office roster + threshold dashboard, a brand-new consignor sign-in screen, and a new-consignor signup flow for people not yet in the system. Built as a Google Apps Script project bound to a Google Sheet, the same pattern as the Storage Management System, so it's a paste-in-and-deploy setup rather than a separately hosted app — and, like SMS, the whole project lives in one file.

## What's in this folder

- `Code.gs` — everything: the tiering/banding engine (ports `classifyTier`/`statusFor` from the Decision Model), all sheet reads/writes, the one-time sheet initializer and CIMS Admin menu, the sign-in and admin dashboard UI (embedded as HTML strings and served via `HtmlService.createHtmlOutput()`), and the web app entry point. This is the only file you paste into the Apps Script editor.
- `mock-accounts.csv` — 21 synthetic accounts covering every tier × status combination, for testing before real data is loaded.
- `test/` — the tiering engine re-implemented in plain Node.js and unit-tested (26 checks, all passing) before being copied into `Code.gs`. Not part of the deployed app; keep it around if the policy model changes and the logic needs re-verifying.
- `legacy-split-files/` — the earlier 4-file version (`Code.gs`, `Setup.gs`, `SignIn.html`, `Admin.html`) before everything was merged into one file. Kept for reference only; not used by the current setup.

## Setup (one-time)

1. **Create the Sheet.** In Google Drive, create a new Google Sheet — e.g. "CIMS - Consignor Data".
2. **Open the script editor.** Extensions → Apps Script.
3. **Paste in the code.** You'll start with one default `Code.gs` file. Replace its entire contents with this project's `Code.gs`. That's it — nothing else to add.
4. **Save**, then reload the Google Sheet in your browser. You should see a new **CIMS Admin** menu.
5. **Initialize the sheets.** CIMS Admin → "Initialize sheets (first-time setup)". The first time, Google will ask you to authorize the script — approve it (it's your own script, running under your own account). This creates the `Accounts`, `Config`, `Dropoffs`, `NewSignups`, `Totes`, `AccountChanges`, and `ContactImport` tabs with headers and default thresholds.
6. **Load test data.** Open `mock-accounts.csv` (in this folder), select all, copy, and paste it starting at cell `A2` of the `Accounts` tab (below the header row). This gives you 21 realistic-looking test accounts to try the app with before real data is ready.
7. **Deploy as a web app.** Deploy → New deployment → gear icon → "Web app". Set:
   - Execute as: **Me**
   - Who has access: **Anyone** (needed for the tablet, which won't be logged into a Google account) — or **Anyone within [your Workspace domain]** if you'd rather restrict the admin dashboard's reachability and are comfortable with staff logging into that domain.
   - Click Deploy, and copy the Web app URL.
8. **Bookmark the two URLs:**
   - Sign-in screen (what the tablet shows): the Web app URL as-is.
   - Admin dashboard: the same URL with `?page=admin` appended.
   - (CIMS Admin → "Show web app URLs" in the Sheet menu will remind you of both once deployed.)

## Updating the code later

Apps Script pins a deployment to a specific saved version, so editing the files alone won't update what the tablet sees. After pasting in changes: **Deploy → Manage deployments → pencil/edit icon on the existing deployment → Version: "New version" → Deploy.** This keeps the same URL (so you don't have to re-bookmark the tablet), it just publishes the new code to it.

## Testing the sign-in flow

The kiosk home screen has two tiles, same as the original prototype: **Sign In / Check In** and **Print More Labels**. Tapping either one expands an inline phone field right there on the tile — but both tiles resolve through the exact same backend check, so which one a consignor taps only changes the *messaging*, never whether check-in happens first:

- Tap **Sign In / Check In**, and you haven't checked in yet today → straight into "Review Your Information" (confirm name/phone/email/zip, agree to the guidelines) → season → a status screen (welcome, heads-up, or hard block) → then labels.
- Tap **Sign In / Check In**, but you're already checked in today → a "Hi again" screen with a "Print More Labels" button — no re-registering.
- Tap **Print More Labels**, and you haven't checked in yet today → a "let's get you checked in first" screen whose only button leads into the same review screen above. There's no way to reach label counts from this tile without checking in first.
- Tap **Print More Labels**, and you're already checked in today → straight to the label-count screen.

With the mock data loaded, try phone number **865-555-1010** (Jasmine Ortiz, Marginal/Closed) — review → pick a season → you should get the hard-block message, no labels offered. Try **865-555-1012** (Marcus Tran, Marginal/Capped) for the heads-up message, then "Print Some Labels Now." Try **865-555-1001** (Amanda Cole, Star) for a normal check-in — a plain "you're checked in" message, then "Print Some Labels Now." Try **865-555-2000** to see the disambiguation screen (two accounts share that number in the mock data, by design). Try any number not in the mock data (e.g. **865-555-9999**) to see the new-consignor path — "No Account Found" → "I'm New — Sign Me Up" → review/consent (name, phone, email, and zip are all required for a brand-new signup) → season → welcome message → print — then check the `NewSignups` tab and the Admin dashboard's New Consignor Signups panel to confirm it landed there. Check in with that same number again (from either tile) to confirm it recognizes you.

**Getting unstuck:** every screen past Home now has a small "← Start Over" link at the bottom, below whatever screen-specific Back button it already had — a guaranteed, consistent way back to Welcome if a network hiccup, a failed lookup, or anything else leaves someone stuck. (Home itself doesn't need one — its own "Cancel" link collapses the phone-entry card back down. The brief Printing animation skips it too, since it auto-advances in about a second anyway.)

**Telling seasons apart on the label:** the physical label printer prints black ink only, so Fall/Winter and Spring/Summer are told apart visually rather than by color — Fall/Winter gets its season name in a solid black bar with white knockout text plus a snowflake icon; Spring/Summer stays plain black-on-white with a sun icon. Both are readable at a glance without anyone needing to actually read the words. The barcode itself is unaffected either way.

Each label you print creates its own row in the new `Totes` tab with a real, unique Tote ID (`MMDDYY-NN`, e.g. `091426-05`) — the store-wide running count for that day. There's no more upfront "how many totes" guess; a consignor prints a label each time they've filled one, whether that's during their first visit or a later "Need Even More?" return trip the same day.

**Corrections and Liberty REACT:** if an existing consignor edits their Name/Phone/Email/Zip on the review screen, CIMS updates its own `Accounts` row immediately and logs a before/after row in the new `AccountChanges` tab — check the Admin dashboard's **Account Change Requests** panel to see it (it now has a "Show applied changes" toggle too, so marking one Applied doesn't make its history disappear). Liberty REACT (your real POS) doesn't know about the edit until a staffer makes the same change there and marks it Applied. The quarterly performance import (see below) never touches Name/Phone/Email/Zip, so a kiosk correction is safe through that — the only way it'd get quietly overwritten is by re-running the Email/Zip contact import from a roster export that still has the old value, and that import already skips any cell that isn't blank. Email/Zip aren't required from existing accounts (most real accounts don't have them on file yet — see "Loading real data" below), only from brand-new signups. Staff no longer have to remember to check that dashboard panel on their own — see "Daily Liberty REACT change report" below.

**What's printed on the label:** name, phone, the season bar/rule, the barcode, and the Tote ID. Email is captured and shown on the review screen and in the drop-off notification email, but is deliberately left off the physical label itself.

**Childrens/Womens/Mens category:** the season screen also has an optional "What kind of items?" checkbox row (check all that apply — it doesn't block Check In the way season does). Whichever category boxes are checked apply to the *whole visit*, not per tote — if a consignor is dropping off both Kids and Womens items, every label they print that visit gets both a "C" and a "W" badge, not one or the other. The letters print as small monogram-style circles on the right end of the season line: a solid white circle punched into the Fall/Winter black bar, or a black-outlined circle on the plain Spring/Summer line. Skipping the category checkboxes entirely just means no badges print — nothing else changes.

> **One-time step on your live sheet:** this adds a new `Category` column to the `Totes` tab — deliberately appended as the *last* column rather than squeezed in next to `Season`, specifically so it can't shift any existing column over and misalign old data. After you paste in the updated code and redeploy, add a header labeled `Category` to the next open column on the live `Totes` tab (to the right of `Status`) so new rows land under a label. Nothing needs to change on old rows, and nothing breaks if you forget this step — new Category values would just land in an unlabeled column until you add the header.

**Important note on the mock data's medians:** with only 21 rows, the auto-computed volume/sell-through medians won't match the real store's (95.0 / 61.29%), so a couple of mock accounts may classify differently than their name suggests (e.g. "should be Bulk" landing as Star instead) — that's expected with a tiny sample, not a bug. To test against the *real* reference thresholds from the handoff, temporarily set `medCiOverride` to `95` and `medStOverride` to `0.6129` in the `Config` tab; every mock account then classifies exactly as intended. Clear those two cells once real data is loaded so medians go back to auto-computing live from the Accounts tab.

## New-consignor signups

Your real POS/APR system is still the system of record for official account numbers — CIMS doesn't invent one. So when a phone number doesn't match anything in `Accounts`, the kiosk offers a fork: "I'm New — Sign Me Up" or "I've Consigned Before" (for an existing consignor whose phone isn't on file — that one routes to a staff-assist screen rather than letting them self-enroll a duplicate account). Signing up captures name and phone into a new `NewSignups` tab as a **Pending** row through the same review/consent screen everyone uses, then lets them print labels right away — new consignors are never gated (there's no history to band them against yet), so they always get a friendly welcome message, never a Closed/Capped one. (Email is no longer collected here — the real `Accounts` sheet has no Email column, and a per-consignor field CIMS added on its own would just get wiped by the next quarterly APR/PBC re-import.)

If that same phone number checks in again before staff catches up, the kiosk recognizes them from `NewSignups` and — once they've completed today's review screen — goes straight to printing more labels, no re-registering.

On the staff side, the Admin dashboard has a **New Consignor Signups** panel listing everyone pending. Once you've created their real account in your POS/APR system (with a real AccountID), type that ID into the "Link to Account" box and click **Link** — this marks the `NewSignups` row Linked so it drops out of the review queue and out of future phone lookups (their real `Accounts` row takes over from there, once it exists — either typed in directly or arriving on the next APR import).

**What this deliberately does NOT automate:** CIMS doesn't create the real POS/APR account for you, and doesn't try to guess when one exists — linking is a manual staff action. That's intentional: the handoff doesn't describe how enrollment works in your actual POS system, so nothing about that process was assumed.

## Loading real data

The `Accounts` tab needs one row per consignor with: `AccountID, Name, Phone, Email, Zip, CheckedIn, Sold, AvgDaysToSell, AvgProfitPerItem, DonationRate, Spend`. `CheckedIn` through `DonationRate` come from the APR; `Spend` comes from the PBC join described in the handoff (§3.3, §5).

**Gaps to flag:** neither the APR nor the PBC report (as described in the handoff) includes phone number, email, or zip — but the kiosk looks accounts up by phone, and both email and zip are collected/shown on the review screen. You'll need to source phone numbers for the ~3,381 accounts from wherever consignors originally registered (the old Shopify customer records, or your POS system) and add `Phone` (required) and `Email`/`Zip` (nice to have — see below) values. Until a phone number is on file for an account, that consignor won't be found by the kiosk.

Email and Zip are handled more gently than Phone: the code reads those two columns by name, so they work as soon as they exist in `Accounts`, but nothing requires them to already be filled in — a blank Email/Zip just shows up blank on the review screen, ready for the consignor to fill in themselves. When they do, that correction writes straight back into `Accounts` and gets logged to the new `AccountChanges` tab, which is one real way to backfill missing emails over time without a special project. (Email and Zip are required, though, for anyone signing up as a brand-new consignor through "I'm New" — there's no legacy-data problem there, it's a small fresh form.)

### Bulk-importing Email/Zip from a Liberty REACT roster (and backfilling consignor history)

Rather than wait for every consignor to correct their own info one kiosk visit at a time, there's a safely re-runnable bulk import: **CIMS Admin > Import Email/Zip from Contact List**. Use the most *complete* contact roster you have here, not just a recent one — see step 3's second half for why.

1. Export a consignor contact roster from Liberty REACT — one row per account, with (at minimum) the account's `AccountID`, `Email`, and `Zip`. `Phone` and `Name` are optional but recommended (Phone gets backfilled the same way, only where it's still blank; Name helps you eyeball that a row looks right, and is used if this row ends up creating a brand-new Accounts row — see below).

   **Which report to pull matters.** Liberty REACT's "InfoList" report turned out to be bounded, not a true full roster — the Sept 11 2026 pull only covered AccountIDs 901 through 21,043, so it silently excluded anyone outside that range (including, oddly, both some very old low-numbered accounts and every consignor who signed up more recently than whatever moment that report's data was current as of). A separate, fuller Liberty REACT export (no "InfoList" name, includes address/city/state/zip as a combined field) covered a much wider range (680 through 26,740+ in the one pulled Oct 12 2026) and closed nearly the entire gap in one pass. Pull that fuller report instead of InfoList specifically, and after running the import, check the "no matching AccountID" count in the summary — if it's unexpectedly high, the export you pulled is probably bounded the same way InfoList was, and it's worth checking Liberty REACT for an even more complete option before assuming the data's simply missing.
2. Paste that roster into the `ContactImport` tab (created automatically by "Initialize sheets"), starting at row 2, under the headers `AccountID, Name, Phone, Email, Zip`.
3. Run **CIMS Admin > Import Email/Zip from Contact List**. It matches each `ContactImport` row to an `Accounts` row by `AccountID` — Liberty REACT's own account number, already the key CIMS uses — and fills in `Email`/`Zip` (and `Phone`, if that cell is still blank).

   For any `ContactImport` row whose `AccountID` has **no** existing `Accounts` row at all, it **adds one** — a bare identity row (AccountID, Name, Phone, Email, Zip) with zero performance data. This matters because `Accounts` only ever gets built/refreshed from window-based performance pulls (originally 15 months, now a 12-month rolling window each quarter — see "Quarterly refresh" above), so it's never actually contained *every* consignor, only whoever fell inside whichever window was current at the time. A consignor who'd already gone quiet before that window wouldn't have an `Accounts` row, which means the kiosk's phone lookup can't find them — they'd be funneled into the new-signup flow as if they'd never consigned before, even though they have real history. A new zero-performance row fixes that permanently: they're untiered and always open (no gating, no special message — the same quiet "you're checked in" treatment as anyone else) until a future quarterly import happens to include them again with real numbers.

   It shows a summary either way: how many existing accounts matched and got cells filled in, how many brand-new identity rows got added, and how many Accounts rows had no counterpart in the roster (left alone — not an error, just nothing to do for them this run).
4. It **never overwrites a cell that already has a value** — including anything a consignor has since corrected at the kiosk — and never adds the same `AccountID` twice, so it's safe to run again after a future roster export without undoing anyone's correction or double-adding anyone.

This is a straight `AccountID`-keyed merge, not a name/phone fuzzy match, so it only works if the roster's AccountID is the same Liberty REACT account number already in (or destined for) your `Accounts` tab. Spot-check a couple of rows after running it before trusting the full batch — especially any newly-added ones.

**Until the sign-in system is fully in production:** keep re-running this periodically with a fresher roster export (not just once). Right now the quarterly performance import is the only thing keeping `Accounts` current, and it only ever touches accounts already inside its rolling window — it was never meant to be the sole source of consignor *identity*. Re-running this contact import with an up-to-date roster is what keeps closing the gap for anyone who dropped off before CIMS had a row for them. Once the sign-in system is live and the quarterly performance import has been running for a while, `Accounts` should naturally stay current on its own and this can taper off to an occasional check rather than a routine task.

### Quarterly refresh from the Consignor Performance Dashboard

This used to mean re-running the APR/PBC join by hand each quarter (handoff §5) and pasting the result into `Accounts` — that's now productionized. Each quarter, once the Consignor Performance Dashboard's new 12-month rolling window is ready:

1. Export it with one row per account, keyed by `AccountID`, giving `CheckedIn, Sold, AvgDaysToSell, AvgProfitPerItem, DonationRate, Spend` (whatever subset it produces — see step 3).
2. Paste that export into the `PerformanceImport` tab (created automatically by "Initialize sheets"), starting at row 2, under the headers `AccountID, Name, CheckedIn, Sold, AvgDaysToSell, AvgProfitPerItem, DonationRate, Spend`. (`Name` isn't used by the merge — it's just there so you can eyeball that a row looks right.)
3. Run **CIMS Admin > Import Quarterly Performance Data**. It matches each `PerformanceImport` row to an `Accounts` row by `AccountID` and overwrites whichever of the six performance columns are present in the export — unlike the Email/Zip import above, this one is a real refresh, not a fill-in-blanks-only merge, since that's the point of a quarterly update. A metric cell left blank on a given row is skipped for that row rather than zeroed out, so an export that's missing one column (say, this quarter's dashboard doesn't include `Spend`) can't accidentally wipe it.
4. It shows a summary: how many existing accounts were updated, how many new accounts were added (present in the export but not yet in `Accounts` — Phone/Email/Zip start blank for these, same gap as any other new account), and how many existing accounts in `Accounts` were **not** in this quarter's export. That last number is worth a look each time — it's who's dropped out of the rolling 12-month window (closed accounts, mostly) but CIMS leaves their row as-is rather than guessing whether to archive it.
5. `Name`, `Phone`, `Email`, and `Zip` are never touched by this import, so nothing about a quarterly refresh can undo a consignor's kiosk correction or a contact-list backfill. It clears the medians cache automatically when done, so the new tiers take effect immediately rather than waiting up to 6 hours.

Safe to run again if you need to re-paste and re-run a given quarter's export.

**What happens to a consignor who ages out of the rolling window:** nothing — this import never deletes an `Accounts` row, so a consignor who drops out of the dashboard's 12-month window just keeps their existing row (Name, Phone, Email, Zip, and whatever performance numbers they last had) exactly as it was; they're only counted in the "not in this export" tally. Since the kiosk looks accounts up by phone number against `Accounts`, they're still found and recognized as an existing consignor if they come back — never funneled into the new-signup flow. `Accounts` is effectively the permanent consignor history already; no separate history file is needed.

The one real tradeoff of this (by design, for now): their tier/status stays frozen at whatever it was the last time they appeared in an import, even across a long gap, until a future import happens to include them again with fresh numbers. **This import must be the only way `Accounts` gets refreshed each quarter** — pasting the dashboard's export over the whole tab (or any other wholesale "replace the sheet" approach) would erase every rolled-off consignor's row instead of just leaving it alone, which is exactly the scenario that would make them look brand-new at the kiosk.

**Loading new data does NOT require a redeploy.** The web app reads the `Accounts` tab live on every request, so a fresh "Replace current sheet" import takes effect immediately — the redeploy step in "Updating the code later" above is only needed when the `.gs`/`.html` files themselves change.

The one exception is the volume/sell-through medians, which are cached for 6 hours (`CacheService`) so they aren't recomputed on every single sign-in. See "Keeping medians fresh" below.

## Keeping medians fresh automatically

By default, a newly loaded medians value can take up to 6 hours to take effect (whenever the cache happens to expire). To avoid relying on that, CIMS Admin → **"Enable daily 2am data refresh"** schedules a trigger that clears the medians cache automatically every night at ~2am (Apps Script fires it sometime within that hour, not at the exact minute), so the next morning's sign-ins always reflect whatever data was loaded the day before.

- Run it once — it's a persistent trigger on the project itself, independent of deployments, so it keeps running across future code redeploys without needing to be re-enabled.
- CIMS Admin → **"Disable daily data refresh"** turns it off.
- CIMS Admin → **"Refresh medians now"** clears the cache on demand, if you don't want to wait for the nightly run (e.g. right after loading new data mid-day).

## Team drop-off notification email

Every completed check-in — new signup, pending-signup return visit, or an existing account (open, capped, or closed) — sends one email to the team inbox in `Config`'s `notifyEmail` cell (defaults to `adorableconsignments@gmail.com`), from `sendDropoffNotification_()` in `Code.gs`. This replaces the old Shopify-form-triggered internal email: same purpose (pricers use it to confirm they're pulling up the right consignor account, and it's a record the visit happened and the guidelines were agreed to), same "NEW"/"EXISTING" subject-line split, but with a bit more on it — Account ID, Zip, which season they're dropping off, which category (Childrens/Womens/Mens, if any were checked), their current status/tier, and (if they corrected anything on the review screen) what changed.

- **To change the destination address:** edit the `notifyEmail` cell on the `Config` tab — no code change or redeploy needed.
- **Sent from `adorableconsignments@gmail.com`, not your personal address.** The script itself is owned by (and runs as) the Google account you use to open the Sheet/Apps Script editor — by default, that's whose address mail would show as "From." To have the notification instead show as coming from `adorableconsignments@gmail.com`, that address needs to be added as a verified **"Send mail as"** alias on your own Google account (Gmail → Settings → Accounts and Import → Send mail as), and `Config`'s `notifyFromEmail`/`notifyFromName` cells configure the alias address and display name (`GmailApp.sendEmail`, not `MailApp`, is what makes sending-as-an-alias possible). If `notifyFromEmail` is left blank, or the alias isn't verified yet, it automatically falls back to sending from your own account instead — the check-in is never blocked either way.
- **If sending fails** (bad address, alias not verified, quota, transient Google error), the check-in itself still completes and the consignor still gets their labels — the email send is wrapped so it can never block or fail a real check-in, and there's a second fallback attempt via your own account's address if the alias send fails. Failures are logged (Apps Script → Executions) but not retried beyond that.
- **Sending quota:** counted against whichever Google account actually sends the mail — your own account, alias or not (Gmail aliases don't get their own separate quota). A personal Gmail account caps outgoing mail at roughly 100 recipients/day; a Google Workspace account gets ~1,500/day. Each check-in notification counts as one send. At ~25–30 walk-ins/day that's comfortable headroom either way, but worth knowing if volume grows a lot or this account starts sending other automated mail too.
- **Not yet built:** the consignor-facing confirmation email (currently sent via a Shopify web form, soon to move to Klaviyo) and a periodic consignor activity summary email are still planned next phases, not part of this notification. (The internal daily activity digest — who dropped off, tote counts, seasonal distribution — is a separate, still-unscoped idea; don't confuse it with the change report below, which is about *corrections*, not overall volume.)

## Daily Liberty REACT change report

A second, separate email from `sendLibertyChangeReport_()` in `Code.gs` — a daily to-do list for staff, not a per-visit notification like the one above. It lists everything still outstanding that needs to be keyed into Liberty REACT by hand: every `AccountChanges` row not yet marked **Applied in Liberty REACT?**, and every `NewSignups` row not yet **Linked** to a real account. Items from yesterday (or today, for an on-demand copy) are shown as new; anything older is labeled "carried over" so nothing quietly sits unresolved for days without anyone noticing. It reflects whatever's outstanding *at the moment it runs* — not a frozen snapshot — and skips sending entirely on a day with nothing to report, so it never becomes noise.

- CIMS Admin → **"Enable daily Liberty REACT change report (~4am)"** schedules it to run automatically every morning — early enough for team members who come in ahead of opening — same trigger pattern as the 2am medians refresh — run once, keeps working across future redeploys.
- CIMS Admin → **"Disable daily change report"** turns it off.
- CIMS Admin → **"Send change report now"** sends an on-demand copy immediately, useful right after a busy day or before you'd otherwise wait for the next morning's run.
- It sends to the same `notifyEmail` address as the drop-off notifications, using the same alias/fallback sending logic — no separate setup needed if that's already working.
- Marking something Applied or Linked (from the Admin dashboard's existing panels) is what takes it off the *next* report — the email itself doesn't have a way to mark things done, by design, so there's one place staff go to actually resolve an item.

## What this first slice deliberately does NOT do yet

Per the handoff's open questions (§6) — these are left as clean extension points, not guesses baked into the code:

- **No overage handling.** If a Capped consignor drops off more than their cap, CIMS logs the tote count as given; there's no workflow yet for what staff do when they discover the overage while processing totes. The `Notes` column on the `Dropoffs` tab is there for that to plug into once you decide how it should work.
- **No staff tote-processing view.** The reconciliation screen where staff open totes and log real item counts against a cap isn't built yet — this slice only covers sign-in and the admin dashboard.
- **No running quarterly total shown at sign-in.** The Capped message shows the flat configured cap number (e.g. "up to 12 items"), not a live "you've already brought X this quarter" remaining balance — the handoff explicitly flags this as unresolved, so this doesn't try to solve it. The `Dropoffs` log has what's needed to compute that later if you decide you want it.
- **New-consignor enrollment is self-service intake, not full enrollment.** The sign-up flow captures name/phone/email and lets them check in totes, but creating the real account in your POS/APR system is still a manual staff step (see "New-consignor signups" above) — CIMS doesn't assume how that process works.
- **Store-spend closure is a hard gate, not a manual second look.** The handoff notes (§6) this is still an open question; this build implements the hard-gate version from §3.2/§4 since that's what's needed for the sign-in screen to actually work today. Easy to soften later (e.g. route Closed accounts to a staff-review queue instead of an outright block) if you decide that's the better call.
- **Draft consignor-facing copy is used as-is** (§4) but is fully editable — the exact wording lives in the `Config` tab (`msgClosed`, `msgCappedTemplate`), not hardcoded in the script, since the handoff marks it "subject to revision."

## Suggested next steps

1. ~~Get real phone numbers matched to the 3,381 accounts~~ — mostly done: 3,289 of 3,381 already have a real number recovered from the old InfoList/PBC data. The remaining 92 (`CIMS_Missing_Phone_Numbers.csv`) are being left alone for now rather than chased down — Brad's call, since they're likely inactive/legacy accounts. Still worth double-checking whether `CIMS_Accounts_Real_Data.csv` actually made it into the live `Accounts` tab, or whether this is still pending.
2. Load real performance data and sanity-check the roster against a known snapshot. This is now productionized — see "Quarterly refresh from the Consignor Performance Dashboard" above — but it still needs its first real run against the new 12-month-rolling export, and a fresh sanity-check snapshot to compare against (the old one — Stars 640 / Bulk 555 / Efficient 554 / Marginal 635; Marginal 274 closed / 305 capped / 56 open; Bulk 0 / 500 / 55 — was taken under the old windowing method, so it's no longer a valid baseline for the new rolling-window numbers).
3. Decide on the open questions in handoff §6 that block further build-out — especially overage handling, since that's what the staff tote-processing view needs next.
4. Deploy to the actual sign-in tablet and do a real walk-through with a staff member before going live.
5. **Email buildout, in order:** consignor same-day confirmation via Klaviyo (needs the Klaviyo connector + API key), then the internal daily activity digest (who dropped off, tote counts, seasonal split — decide email vs. Admin-dashboard view before building; not the same thing as the change report, which already shipped), then the periodic/monthly consignor activity summary via Klaviyo.
6. **Printing (Kiosk Pro Enterprise / PDF fallback)** — flagged as the next priority after the admin-dashboard fixes; not yet started.
7. **Keep re-running the contact import with a fresher roster export** (see "Bulk-importing Email/Zip" above) every so often until the sign-in system is fully in production — it's the thing closing the consignor-identity gap in the meantime, not a one-time task.
