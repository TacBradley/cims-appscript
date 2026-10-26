/**
 * CIMS — Consignor Information Management System
 * The Adorable Child
 *
 * Code.gs — the entire project in one file, same pattern as SMS: the
 * tiering/banding engine, sheet I/O, the setup menu, and the sign-in +
 * admin UI (embedded below as HTML strings) all live here. Paste this
 * into the single Script file named "Code" in the Apps Script editor
 * (Extensions > Apps Script) bound to the CIMS Google Sheet — no other
 * files needed. See README.md for full setup steps.
 */

// ---------------------------------------------------------------------------
// SHEET NAMES
// ---------------------------------------------------------------------------
var SHEET_ACCOUNTS = 'Accounts';
var SHEET_CONFIG = 'Config';
var SHEET_DROPOFFS = 'Dropoffs';
var SHEET_NEW_SIGNUPS = 'NewSignups';

// Email/Zip aren't in the real POS/APR export yet -- Brad is adding those
// columns on his end. getAccountsFromSheet_() below reads them by header
// name (not position), so this works whether or not they're populated yet;
// until they are, every account just reads back a blank email/zip.
var ACCOUNTS_HEADERS = [
  'AccountID', 'Name', 'Phone', 'Email', 'Zip', 'CheckedIn', 'Sold',
  'AvgDaysToSell', 'AvgProfitPerItem', 'DonationRate', 'Spend'
];

var DROPOFFS_HEADERS = [
  'Timestamp', 'AccountID', 'Name', 'Phone', 'ToteCount',
  'Tier', 'Status', 'CapShown', 'Notes'
];

// New consignors aren't in the real POS/APR system yet (that's the actual
// system of record for AccountID) — this tab just captures their intake
// info so staff can finish real enrollment and link it back. See
// registerNewConsignor() / linkNewSignup() below.
var NEW_SIGNUPS_HEADERS = [
  'Timestamp', 'TempID', 'Name', 'Phone', 'Email', 'Zip', 'Status', 'LinkedAccountID', 'Notes'
];

// Every time an existing consignor corrects their Name/Phone/Email/Zip on
// the kiosk's review screen, CIMS updates its own Accounts copy right away
// AND logs the before/after here -- because Liberty REACT (the real POS)
// is still the system of record, and won't pick up the correction on its
// own. Staff work this list from the Admin dashboard and mark each one
// "Applied" once they've made the same edit inside Liberty REACT.
var SHEET_ACCOUNT_CHANGES = 'AccountChanges';
var ACCOUNT_CHANGES_HEADERS = [
  'Timestamp', 'AccountID', 'Consignor', 'Field', 'Old Value', 'New Value', 'Applied in Liberty REACT?'
];

// Reference constants from the CIMS handoff (§3.2), used only as fallback
// defaults when the Config sheet is missing a value. The Config sheet is
// always the source of truth once initialized — nothing here is hardcoded
// into the decision logic itself.
var CONFIG_DEFAULTS = {
  margClose: 25,
  margOpen: 550,
  margCap: 12,
  bulkClose: 0,
  bulkOpen: 950,
  bulkCap: 36,
  medCiOverride: '',   // blank = auto-compute live from Accounts sheet
  medStOverride: '',   // blank = auto-compute live from Accounts sheet
  quarters: 4.753,
  avgProfit: 466.41,
  // Every completed check-in emails this address a snapshot of the visit
  // (see sendDropoffNotification_ below) -- change it here, no code edit
  // needed, if the team inbox ever moves.
  notifyEmail: 'adorableconsignments@gmail.com',
  // Sent FROM this address instead of the script owner's personal Gmail --
  // requires adorableconsignments@gmail.com to be a verified "Send mail as"
  // alias on the script owner's Google account (Gmail Settings > Accounts
  // and Import > Send mail as). Leave blank to fall back to MailApp, which
  // sends from whichever account owns the script, alias or not.
  notifyFromEmail: 'adorableconsignments@gmail.com',
  notifyFromName: 'The Adorable Child',
  msgClosed: "Thanks for checking in! We're not able to add new items to this account right now — we're at capacity and working through what's already on hand.",
  msgCappedTemplate: "Thanks for checking in! We're able to take up to {{cap}} items from you today — anything beyond that, you'll need to hold onto and bring back another time.",
  msgNotFound: "We couldn't find an account with that phone number.",
  msgNewWelcome: "Welcome to The Adorable Child! We've logged your totes and let our team know you're here — we'll finish setting up your consignor account soon. Thanks for consigning with us!"
};

// ---------------------------------------------------------------------------
// TIERING / BANDING ENGINE (pure logic — unit-tested outside Apps Script;
// see test/tiering.js and test/test.js in the CIMS handoff project. Keep
// these functions in sync with that file if the policy model changes.)
// ---------------------------------------------------------------------------

function median(nums) {
  if (!nums.length) return 0;
  var sorted = nums.slice().sort(function (a, b) { return a - b; });
  var mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
  return sorted[mid];
}

function hasOverride_(config, key) {
  return !!config && config[key] !== undefined && config[key] !== '' && config[key] !== null;
}

// active20 = accounts with checkedIn >= 20 (handoff §3.1). Accounts under
// that threshold are not tiered and are excluded from the median calc.
function computeMedians(accounts, config) {
  var active = accounts.filter(function (a) { return (a.checkedIn || 0) >= 20; });
  var ciVals = active.map(function (a) { return a.checkedIn; });
  var stVals = active.map(function (a) {
    return a.checkedIn > 0 ? a.sold / a.checkedIn : 0;
  });
  var medCi = hasOverride_(config, 'medCiOverride') ? Number(config.medCiOverride) : median(ciVals);
  var medSt = hasOverride_(config, 'medStOverride') ? Number(config.medStOverride) : median(stVals);
  return { medCi: medCi, medSt: medSt, activeCount: active.length };
}

// 2x2 quadrant per handoff §3.1. Ties (== median) count as "high" on that
// axis. Accounts under 20 items checked in are NOT tiered (returns null).
function classifyTier(checkedIn, sellThrough, medCi, medSt) {
  if (checkedIn < 20) return null;
  var highVolume = checkedIn >= medCi;
  var highSellThrough = sellThrough >= medSt;
  if (highVolume && highSellThrough) return 'star';
  if (highVolume && !highSellThrough) return 'bulk';
  if (!highVolume && highSellThrough) return 'efficient';
  return 'marginal';
}

// Store-spend banding per handoff §3.2. Stars, Efficient, and untiered
// (ci<20) accounts are always open — their volume is revenue-justified or
// they haven't hit the tiering threshold yet. Marginal/Bulk are banded by
// shopper store spend against tier-specific close/open thresholds.
function statusFor(tier, spend, config) {
  if (tier === null || tier === 'star' || tier === 'efficient') {
    return { status: 'open', cap: null };
  }
  var s = spend || 0;
  if (tier === 'marginal') {
    if (s < config.margClose) return { status: 'closed', cap: null };
    if (s < config.margOpen) return { status: 'capped', cap: config.margCap };
    return { status: 'open', cap: null };
  }
  if (tier === 'bulk') {
    if (s < config.bulkClose) return { status: 'closed', cap: null };
    if (s < config.bulkOpen) return { status: 'capped', cap: config.bulkCap };
    return { status: 'open', cap: null };
  }
  return { status: 'open', cap: null };
}

// Real Accounts data (from the APR/PBC import) stores names as "Last, First"
// -- the POS/import format. Everywhere a name is shown to a person (sign-in
// screen, admin roster), display it "First Last" instead, no comma. This
// doesn't touch the stored value, so quarterly re-imports keep working as
// before. Safe to call on a name that's already "First Last" -- no comma
// means it passes through unchanged (e.g. names typed at the new-consignor
// signup form, which are already in that order).
function formatDisplayName_(rawName) {
  var name = (rawName || '').toString().trim();
  var commaIdx = name.indexOf(',');
  if (commaIdx === -1) return name;
  var last = name.slice(0, commaIdx).trim();
  var first = name.slice(commaIdx + 1).trim();
  if (!first || !last) return name;
  return first + ' ' + last;
}

function classifyAccount(account, medians, config) {
  var checkedIn = account.checkedIn || 0;
  var sold = account.sold || 0;
  var spend = account.spend || 0;
  var sellThrough = checkedIn > 0 ? sold / checkedIn : 0;
  var tier = classifyTier(checkedIn, sellThrough, medians.medCi, medians.medSt);
  var result = statusFor(tier, spend, config);
  return {
    accountId: account.accountId,
    name: formatDisplayName_(account.name),
    phone: account.phone,
    email: account.email || '',
    zip: account.zip || '',
    checkedIn: checkedIn,
    sold: sold,
    sellThrough: sellThrough,
    spend: spend,
    tier: tier,
    status: result.status,
    cap: result.cap
  };
}

// ---------------------------------------------------------------------------
// SHEET I/O
// ---------------------------------------------------------------------------

function getSheet_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error('Missing sheet "' + name + '". Run initializeSheets() from Setup.gs first.');
  return sheet;
}

function getConfig_() {
  var sheet = getSheet_(SHEET_CONFIG);
  var values = sheet.getDataRange().getValues(); // [ [Key, Value], ... ] including header row
  var config = {};
  for (var i = 1; i < values.length; i++) {
    var key = values[i][0];
    if (!key) continue;
    config[key] = values[i][1];
  }
  // fall back to defaults for any missing key
  for (var k in CONFIG_DEFAULTS) {
    if (config[k] === undefined || config[k] === '') {
      if (CONFIG_DEFAULTS[k] !== '') config[k] = CONFIG_DEFAULTS[k];
    }
  }
  return config;
}

function getAccountsFromSheet_() {
  var sheet = getSheet_(SHEET_ACCOUNTS);
  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  var col = {};
  headers.forEach(function (h, i) { col[h] = i; });

  var accounts = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (!row[col['AccountID']]) continue;
    accounts.push({
      accountId: String(row[col['AccountID']]),
      name: row[col['Name']],
      phone: normalizePhone_(row[col['Phone']]),
      // Email/Zip: blank until Brad's next data load adds these columns --
      // col[...] is undefined until then, so this just reads as ''.
      email: (col['Email'] !== undefined ? row[col['Email']] : '') || '',
      zip: (col['Zip'] !== undefined ? row[col['Zip']] : '') || '',
      checkedIn: Number(row[col['CheckedIn']]) || 0,
      sold: Number(row[col['Sold']]) || 0,
      avgDaysToSell: Number(row[col['AvgDaysToSell']]) || 0,
      avgProfitPerItem: Number(row[col['AvgProfitPerItem']]) || 0,
      donationRate: Number(row[col['DonationRate']]) || 0,
      spend: Number(row[col['Spend']]) || 0,
      _row: i + 1 // 1-indexed sheet row, for lookups that need to write back
    });
  }
  return accounts;
}

function normalizePhone_(raw) {
  if (!raw) return '';
  return String(raw).replace(/\D/g, '').slice(-10); // last 10 digits
}

// Converts a raw sheet cell value to a plain string, safe to send over
// google.script.run. A populated "Timestamp" column comes back from
// getValues() as a real JS Date object -- passing that straight through in
// an RPC response has been observed to make the *entire* response arrive
// as a bare null on the client (no error, nothing in the failure handler),
// even though every other field in the same object is a normal string or
// number. Converting to a string here avoids sending a raw Date at all.
function toDateString_(raw) {
  if (!raw) return '';
  if (Object.prototype.toString.call(raw) === '[object Date]') {
    return isNaN(raw.getTime()) ? '' : raw.toISOString();
  }
  return String(raw);
}

function getNewSignupsFromSheet_() {
  var sheet = getSheet_(SHEET_NEW_SIGNUPS);
  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  var col = {};
  headers.forEach(function (h, i) { col[h] = i; });

  var signups = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (!row[col['TempID']]) continue;
    signups.push({
      timestamp: toDateString_(row[col['Timestamp']]),
      tempId: String(row[col['TempID']]),
      name: String(row[col['Name']] || ''),
      phone: normalizePhone_(row[col['Phone']]),
      email: String(row[col['Email']] || ''),
      zip: (col['Zip'] !== undefined ? row[col['Zip']] : '') || '',
      status: row[col['Status']] || 'Pending',
      linkedAccountId: String(row[col['LinkedAccountID']] || ''),
      notes: String(row[col['Notes']] || ''),
      _row: i + 1
    });
  }
  return signups;
}

// ---------------------------------------------------------------------------
// CACHING — medians only need recomputing when Accounts data changes, and
// this store does ~25-30 signins/day, so a short cache avoids re-scanning
// thousands of rows on every lookup without risking stale data for long.
// ---------------------------------------------------------------------------

var MEDIANS_CACHE_KEY = 'cims_medians_v1';
var MEDIANS_CACHE_TTL_SECONDS = 6 * 60 * 60; // 6 hours

function getMediansCached_(accounts, config) {
  var cache = CacheService.getScriptCache();
  var cached = cache.get(MEDIANS_CACHE_KEY);
  if (cached) {
    try { return JSON.parse(cached); } catch (e) { /* fall through to recompute */ }
  }
  var medians = computeMedians(accounts, config);
  cache.put(MEDIANS_CACHE_KEY, JSON.stringify(medians), MEDIANS_CACHE_TTL_SECONDS);
  return medians;
}

function clearMediansCache_() {
  CacheService.getScriptCache().remove(MEDIANS_CACHE_KEY);
}

// ---------------------------------------------------------------------------
// PUBLIC SERVER FUNCTIONS — called from the HTML pages via google.script.run
// ---------------------------------------------------------------------------

// Shared by lookupAccountByPhone() and lookupAndResolve() below so the
// matching logic (Accounts first, then pending NewSignups) lives in one
// place. Returns an array of matches, each tagged with a type:
//   { type: 'account', accountId, name }  — a real, tiered account
//   { type: 'pending', tempId, name }     — an unlinked new-signup record
// More than one match (either type) means a shared phone number — the
// client should let the person pick which one is theirs.
function findPhoneMatches_(normalized) {
  var accounts = getAccountsFromSheet_();
  var accountMatches = accounts.filter(function (a) { return a.phone === normalized; });
  if (accountMatches.length > 0) {
    return accountMatches.map(function (a) {
      return { type: 'account', accountId: a.accountId, name: formatDisplayName_(a.name) };
    });
  }
  var signups = getNewSignupsFromSheet_();
  var pendingMatches = signups.filter(function (s) {
    return s.phone === normalized && s.status === 'Pending';
  });
  return pendingMatches.map(function (s) {
    return { type: 'pending', tempId: s.tempId, name: s.name };
  });
}

/**
 * Look up account(s) by phone number. Used for the multi-match "which
 * account is yours" picker, where the client can't resolve home-state until
 * the person picks one. For the common single-match case, the kiosk calls
 * lookupAndResolve() instead — see below — to avoid a second round trip.
 */
function lookupAccountByPhone(phoneInput) {
  var config = getConfig_();
  var normalized = normalizePhone_(phoneInput);
  if (normalized.length < 7) {
    return { ok: false, error: 'Please enter a valid phone number.' };
  }
  var matches = findPhoneMatches_(normalized);
  if (matches.length === 0) {
    return { ok: true, matches: [], notFoundMessage: config.msgNotFound };
  }
  return { ok: true, matches: matches };
}

/**
 * Combines the phone lookup with the home-state check (getConsignorHome)
 * into one round trip whenever there's exactly one match -- the vast
 * majority of real lookups. Each Apps Script round trip carries its own
 * fixed overhead, so this roughly halves the wait after typing a phone
 * number versus the old two-call sequence (lookupAccountByPhone, then
 * getConsignorHome). Multi-match lookups still need a second call once the
 * person picks which account is theirs -- there's no way around that one.
 */
function lookupAndResolve(phoneInput) {
  var config = getConfig_();
  var normalized = normalizePhone_(phoneInput);
  if (normalized.length < 7) {
    return { ok: false, error: 'Please enter a valid phone number.' };
  }
  var matches = findPhoneMatches_(normalized);
  if (matches.length === 0) {
    return { ok: true, matches: [], notFoundMessage: config.msgNotFound };
  }
  if (matches.length > 1) {
    return { ok: true, matches: matches };
  }
  var only = matches[0];
  var mode = only.type === 'pending' ? 'pending' : 'account';
  var id = only.type === 'pending' ? only.tempId : only.accountId;
  return { ok: true, matches: matches, single: { id: id, mode: mode, home: resolveConsignorHome_(id, mode) } };
}

/**
 * Register a new consignor who isn't in the Accounts sheet yet (the real
 * POS/APR system is still the system of record for official AccountIDs —
 * see NEW_SIGNUPS_HEADERS comment above). Creates a Pending row in
 * NewSignups that staff can later link to a real AccountID once that
 * account is formally created.
 */
function registerNewConsignor(data) {
  var name = (data && data.name || '').toString().trim();
  var phone = normalizePhone_(data && data.phone);
  var email = (data && data.email || '').toString().trim();

  if (!name) return { ok: false, error: 'Please enter your name.' };
  if (phone.length < 7) return { ok: false, error: 'Please enter a valid phone number.' };

  var tempId = 'NEW' + Utilities.getUuid().slice(0, 8).toUpperCase();
  var sheet = getSheet_(SHEET_NEW_SIGNUPS);
  sheet.appendRow([new Date(), tempId, name, phone, email, 'Pending', '', '']);

  return { ok: true, tempId: tempId, name: name };
}

/**
 * Record a tote drop-off for an account and return the status message (if
 * any) to show the consignor privately on screen. This is the only gated
 * write path for sign-in — it both logs the event and computes the current
 * status fresh (so it always reflects the live Config sheet).
 */
// A consignor often doesn't know their tote count until they've unpacked and
// sorted (that's also why "Print More Labels" exists as a repeat visit) — the
// sign-in screen lets them skip straight past the stepper for that. '' / null
// / undefined all mean "not given yet," distinct from an actual 0. Keep this
// distinction all the way into the Dropoffs log (blank cell + a Notes flag)
// rather than silently writing 0, which would misread as "zero totes."
function normalizeToteCount_(toteCount) {
  if (toteCount === '' || toteCount === null || toteCount === undefined) return null;
  var n = Number(toteCount);
  return isNaN(n) ? null : n;
}

function recordDropoff(accountId, toteCount) {
  var config = getConfig_();
  var accounts = getAccountsFromSheet_();
  var account = accounts.filter(function (a) { return a.accountId === String(accountId); })[0];
  if (!account) {
    return { ok: false, error: 'Account not found.' };
  }

  var medians = getMediansCached_(accounts, config);
  var classified = classifyAccount(account, medians, config);
  var countUnknown = normalizeToteCount_(toteCount) === null;

  // Closed is a hard gate — no drop-off is logged, nothing to reconcile later.
  if (classified.status === 'closed') {
    logDropoff_(account, classified, toteCount, 'BLOCKED - not logged');
    return {
      ok: true,
      allowed: false,
      status: 'closed',
      message: config.msgClosed
    };
  }

  // Capped and Open are both logged as normal — capped is a heads-up only,
  // not an enforced stop, per handoff §4 (tote contents aren't visible at
  // sign-in). What happens if a capped consignor is later found over-cap
  // during tote processing is an open question (handoff §6) — intentionally
  // not handled here. See the "Notes" column in Dropoffs as the extension
  // point for that workflow once it's decided.
  logDropoff_(account, classified, toteCount, '');

  if (classified.status === 'capped') {
    var msg = String(config.msgCappedTemplate).replace('{{cap}}', classified.cap);
    return { ok: true, allowed: true, status: 'capped', cap: classified.cap, message: msg };
  }

  // Open: no message at all, per handoff §4 — just confirm the totes logged
  // (or, if the count wasn't given, let the client know to use that wording).
  return { ok: true, allowed: true, status: 'open', message: null, toteCountUnknown: countUnknown };
}

function logDropoff_(account, classified, toteCount, notes) {
  var sheet = getSheet_(SHEET_DROPOFFS);
  var count = normalizeToteCount_(toteCount);
  var allNotes = notes || '';
  if (count === null) {
    allNotes = (allNotes ? allNotes + ' - ' : '') + 'Count TBD (consignor will let staff know after unpacking)';
  }
  sheet.appendRow([
    new Date(),
    account.accountId,
    account.name,
    account.phone,
    count === null ? '' : count,
    classified.tier || 'untiered',
    classified.status,
    classified.cap === null || classified.cap === undefined ? '' : classified.cap,
    allNotes
  ]);
}

/**
 * Log a tote drop-off for a pending new consignor (not yet a real, tiered
 * account). New signups are never gated — there's no history to band them
 * against yet — so this always logs and always returns the welcome message.
 * Uses the same Dropoffs log as recordDropoff(), tagged so staff can find
 * these rows (AccountID starts with "NEW") when reconciling totes.
 */
function recordNewSignupDropoff(tempId, toteCount) {
  var config = getConfig_();
  var signups = getNewSignupsFromSheet_();
  var signup = signups.filter(function (s) { return s.tempId === String(tempId); })[0];
  if (!signup) {
    return { ok: false, error: 'Signup not found. Please see a staff member.' };
  }

  var sheet = getSheet_(SHEET_DROPOFFS);
  var count = normalizeToteCount_(toteCount);
  sheet.appendRow([
    new Date(),
    signup.tempId,
    signup.name,
    signup.phone,
    count === null ? '' : count,
    'new',
    'pending-signup',
    '',
    count === null
      ? 'New consignor — pending staff enrollment (see NewSignups tab); count TBD, consignor will let staff know'
      : 'New consignor — pending staff enrollment (see NewSignups tab)'
  ]);

  return { ok: true, status: 'new', message: config.msgNewWelcome };
}

/**
 * Full roster with computed tier/status, for the admin dashboard.
 */
function getRosterData() {
  var config = getConfig_();
  var accounts = getAccountsFromSheet_();
  var medians = computeMedians(accounts, config); // uncached — admin view should always be fresh
  var roster = accounts.map(function (a) { return classifyAccount(a, medians, config); });

  var summary = { star: 0, bulk: 0, efficient: 0, marginal: 0, untiered: 0, open: 0, capped: 0, closed: 0 };
  roster.forEach(function (r) {
    summary[r.tier || 'untiered']++;
    summary[r.status]++;
  });

  return { roster: roster, medians: medians, config: config, summary: summary };
}

function getConfigForAdmin() {
  return getConfig_();
}

function saveConfig(newConfig) {
  var sheet = getSheet_(SHEET_CONFIG);
  var values = sheet.getDataRange().getValues();
  var keyRow = {};
  for (var i = 1; i < values.length; i++) {
    if (values[i][0]) keyRow[values[i][0]] = i + 1; // 1-indexed row
  }
  Object.keys(newConfig).forEach(function (key) {
    var val = newConfig[key];
    if (keyRow[key]) {
      sheet.getRange(keyRow[key], 2).setValue(val);
    } else {
      sheet.appendRow([key, val]);
    }
  });
  clearMediansCache_();
  return { ok: true };
}

/**
 * Pending (and recently-linked) new consignor signups, for the admin
 * dashboard's review queue.
 */
function getNewSignupsData() {
  try {
    var signups = getNewSignupsFromSheet_();
    signups.sort(function (a, b) { return new Date(b.timestamp) - new Date(a.timestamp); });
    return { signups: signups };
  } catch (e) {
    // Always return a valid shape -- never let an exception here (e.g. a
    // missing NewSignups tab) turn into a bare null on the client, which is
    // indistinguishable from "nothing went wrong, there's just no data."
    return { signups: [], error: (e && e.message) ? e.message : String(e) };
  }
}

/**
 * Staff action: once a new consignor's real account has been created in the
 * POS/APR system, link the pending signup to that AccountID so it stops
 * showing up in the review queue and future phone lookups find the real
 * account instead. This does NOT touch the Accounts sheet — staff still
 * add the real account there themselves (or it arrives on the next APR
 * import); this just closes the loop on the NewSignups side.
 */
function linkNewSignup(tempId, accountId) {
  var sheet = getSheet_(SHEET_NEW_SIGNUPS);
  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  var col = {};
  headers.forEach(function (h, i) { col[h] = i; });

  for (var i = 1; i < values.length; i++) {
    if (String(values[i][col['TempID']]) === String(tempId)) {
      sheet.getRange(i + 1, col['Status'] + 1).setValue('Linked');
      sheet.getRange(i + 1, col['LinkedAccountID'] + 1).setValue(accountId);
      return { ok: true };
    }
  }
  return { ok: false, error: 'Signup not found.' };
}

// ---------------------------------------------------------------------------
// SETUP / ADMIN MENU (formerly Setup.gs, now merged into this single file
// per SMS's pattern -- everything CIMS needs lives in one Code.gs)
// ---------------------------------------------------------------------------
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('CIMS Admin')
    .addItem('Initialize sheets (first-time setup)', 'initializeSheets')
    .addItem('Show web app URLs', 'showWebAppUrls')
    .addSeparator()
    .addItem('Enable daily 2am data refresh', 'setupDailyRefreshTrigger')
    .addItem('Disable daily data refresh', 'removeDailyRefreshTrigger')
    .addItem('Refresh medians now', 'dailyRefresh_')
    .addSeparator()
    .addItem('Enable daily Liberty REACT change report (~4am)', 'setupChangeReportTrigger')
    .addItem('Disable daily change report', 'removeChangeReportTrigger')
    .addItem('Send change report now', 'sendChangeReportNow')
    .addSeparator()
    .addItem('Import Quarterly Performance Data', 'importPerformanceData')
    .addItem('Import Email/Zip from Contact List', 'importContactInfo')
    .addSeparator()
    .addItem('Diagnose: Accounts not in Contact List', 'diagnoseUnmatchedAccounts')
    .addToUi();
}

/**
 * Runs once a day (see setupDailyRefreshTrigger below). Clears the cached
 * medians so that any Accounts data you loaded during the day is picked up
 * by the next sign-in the following morning, instead of waiting up to 6
 * hours for the cache to expire on its own.
 *
 * Safe to extend later with other daily housekeeping (e.g. auto-archiving
 * old Dropoffs rows) — this is the one place that runs on a schedule.
 */
function dailyRefresh_() {
  clearMediansCache_();
}

/**
 * One-time setup: run this once (from this editor, or via the CIMS Admin
 * menu) to schedule dailyRefresh_ to run automatically every day at 2am.
 * Apps Script triggers run against the project itself, independent of any
 * web app deployment/version, so this keeps working across future code
 * redeploys without needing to be re-run — you only need to run this once.
 *
 * Note: Apps Script time-based triggers fire within the chosen hour, not
 * at the exact minute (so "2am" means sometime between 2:00 and 2:59am).
 *
 * Safe to run more than once — it removes any existing dailyRefresh_
 * trigger first so you never end up with duplicates.
 */
function setupDailyRefreshTrigger() {
  removeDailyRefreshTrigger();
  ScriptApp.newTrigger('dailyRefresh_')
    .timeBased()
    .atHour(2)
    .everyDays(1)
    .create();
  SpreadsheetApp.getUi().alert('Daily refresh scheduled for ~2am every day.');
}

/**
 * Removes any scheduled dailyRefresh_ trigger(s). Use this if you want to
 * turn the automatic daily refresh off.
 */
function removeDailyRefreshTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  var removed = 0;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'dailyRefresh_') {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }
  if (removed > 0) {
    SpreadsheetApp.getUi().alert('Daily refresh trigger removed.');
  }
}

/**
 * Creates the Accounts / Config / Dropoffs tabs with headers and default
 * config values, if they don't already exist. Safe to run more than once —
 * it will not overwrite existing sheets or data.
 */
function initializeSheets() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  // Accounts
  var accountsSheet = ss.getSheetByName(SHEET_ACCOUNTS);
  if (!accountsSheet) {
    accountsSheet = ss.insertSheet(SHEET_ACCOUNTS);
    accountsSheet.appendRow(ACCOUNTS_HEADERS);
    accountsSheet.getRange(1, 1, 1, ACCOUNTS_HEADERS.length).setFontWeight('bold');
    accountsSheet.setFrozenRows(1);
  }

  // Dropoffs
  var dropoffsSheet = ss.getSheetByName(SHEET_DROPOFFS);
  if (!dropoffsSheet) {
    dropoffsSheet = ss.insertSheet(SHEET_DROPOFFS);
    dropoffsSheet.appendRow(DROPOFFS_HEADERS);
    dropoffsSheet.getRange(1, 1, 1, DROPOFFS_HEADERS.length).setFontWeight('bold');
    dropoffsSheet.setFrozenRows(1);
  }

  // NewSignups
  var newSignupsSheet = ss.getSheetByName(SHEET_NEW_SIGNUPS);
  if (!newSignupsSheet) {
    newSignupsSheet = ss.insertSheet(SHEET_NEW_SIGNUPS);
    newSignupsSheet.appendRow(NEW_SIGNUPS_HEADERS);
    newSignupsSheet.getRange(1, 1, 1, NEW_SIGNUPS_HEADERS.length).setFontWeight('bold');
    newSignupsSheet.setFrozenRows(1);
  }

  // Totes -- one row per physical tote, created the moment its label is
  // printed from the kiosk (see printLabels() / reserveToteIds_()).
  var totesSheet = ss.getSheetByName(SHEET_TOTES);
  if (!totesSheet) {
    totesSheet = ss.insertSheet(SHEET_TOTES);
    totesSheet.appendRow(TOTES_HEADERS);
    totesSheet.getRange(1, 1, 1, TOTES_HEADERS.length).setFontWeight('bold');
    totesSheet.setFrozenRows(1);
  }

  // AccountChanges -- corrections consignors make at the kiosk, for staff
  // to key into Liberty REACT (see applyAccountChanges_()).
  var accountChangesSheet = ss.getSheetByName(SHEET_ACCOUNT_CHANGES);
  if (!accountChangesSheet) {
    accountChangesSheet = ss.insertSheet(SHEET_ACCOUNT_CHANGES);
    accountChangesSheet.appendRow(ACCOUNT_CHANGES_HEADERS);
    accountChangesSheet.getRange(1, 1, 1, ACCOUNT_CHANGES_HEADERS.length).setFontWeight('bold');
    accountChangesSheet.setFrozenRows(1);
  }

  // ContactImport -- staging tab for importContactInfo() below. Paste a
  // roster exported from Liberty REACT here (AccountID, Name, Phone, Email,
  // Zip) and run "Import Email/Zip from Contact List" from the CIMS Admin
  // menu to merge it into Accounts by AccountID.
  var contactImportSheet = ss.getSheetByName(SHEET_CONTACT_IMPORT);
  if (!contactImportSheet) {
    contactImportSheet = ss.insertSheet(SHEET_CONTACT_IMPORT);
    contactImportSheet.appendRow(CONTACT_IMPORT_HEADERS);
    contactImportSheet.getRange(1, 1, 1, CONTACT_IMPORT_HEADERS.length).setFontWeight('bold');
    contactImportSheet.setFrozenRows(1);
  }

  // PerformanceImport -- staging tab for importPerformanceData() below.
  // Paste this quarter's export from the Consignor Performance Dashboard
  // here (AccountID, Name, CheckedIn, Sold, AvgDaysToSell,
  // AvgProfitPerItem, DonationRate, Spend) and run "Import Quarterly
  // Performance Data" from the CIMS Admin menu to refresh Accounts by
  // AccountID.
  var performanceImportSheet = ss.getSheetByName(SHEET_PERFORMANCE_IMPORT);
  if (!performanceImportSheet) {
    performanceImportSheet = ss.insertSheet(SHEET_PERFORMANCE_IMPORT);
    performanceImportSheet.appendRow(PERFORMANCE_IMPORT_HEADERS);
    performanceImportSheet.getRange(1, 1, 1, PERFORMANCE_IMPORT_HEADERS.length).setFontWeight('bold');
    performanceImportSheet.setFrozenRows(1);
  }

  // Config
  var configSheet = ss.getSheetByName(SHEET_CONFIG);
  if (!configSheet) {
    configSheet = ss.insertSheet(SHEET_CONFIG);
    configSheet.appendRow(['Key', 'Value', 'Notes']);
    configSheet.getRange(1, 1, 1, 3).setFontWeight('bold');
    configSheet.setFrozenRows(1);

    var notes = {
      margClose: 'Marginal tier: below this store spend, account is Closed.',
      margOpen: 'Marginal tier: at/above this store spend, account is fully Open.',
      margCap: 'Marginal tier: item cap shown when Capped (backstop, not a real volume lever — see handoff §3.2).',
      bulkClose: 'Bulk-mover tier: below this store spend, account is Closed. (0 = never triggers; spend can\'t be negative.)',
      bulkOpen: 'Bulk-mover tier: at/above this store spend, account is fully Open.',
      bulkCap: 'Bulk-mover tier: item cap shown when Capped (the real volume lever).',
      medCiOverride: 'Leave blank to auto-compute the volume median live from the Accounts tab (active20 only). Set a number to freeze it.',
      medStOverride: 'Leave blank to auto-compute the sell-through median live from the Accounts tab (active20 only). Set a number to freeze it.',
      quarters: 'Length of the current APR data window, in quarters. Used only for reporting, not the close/cap/open decision.',
      avgProfit: 'Reference avg. profit/item, for reporting only — not part of the close/cap/open decision.',
      msgClosed: 'Message shown to a Closed consignor at sign-in.',
      msgCappedTemplate: 'Message shown to a Capped consignor at sign-in. Use {{cap}} where the item cap number should appear.',
      msgNotFound: 'Message shown when a phone number doesn\'t match any account (they\'ll then be offered the new-consignor signup screen).',
      msgNewWelcome: 'Message shown to a brand-new consignor after they sign up and check in for the first time.'
    };

    Object.keys(CONFIG_DEFAULTS).forEach(function (key) {
      configSheet.appendRow([key, CONFIG_DEFAULTS[key], notes[key] || '']);
    });
    configSheet.autoResizeColumn(1);
    configSheet.setColumnWidth(2, 320);
    configSheet.setColumnWidth(3, 420);
  }

  SpreadsheetApp.getUi().alert(
    'CIMS sheets are ready.\n\n' +
    '1. Paste your Accounts data into the "Accounts" tab (or the mock data from mock-accounts.csv to test first).\n' +
    '2. Review the thresholds in the "Config" tab.\n' +
    '3. New consignors who sign up on the tablet land in the "NewSignups" tab — review them in the Admin dashboard.\n' +
    '4. Deploy this project as a web app (Deploy > New deployment) to get the sign-in and admin URLs.'
  );
}

function showWebAppUrls() {
  var url = ScriptApp.getService().getUrl();
  if (!url) {
    SpreadsheetApp.getUi().alert('This project hasn\'t been deployed as a web app yet. Use Deploy > New deployment > Web app.');
    return;
  }
  SpreadsheetApp.getUi().alert(
    'Sign-in screen:\n' + url + '\n\n' +
    'Admin dashboard:\n' + url + '?page=admin'
  );
}

// ---------------------------------------------------------------------------
// CONTACT IMPORT — safely re-runnable merge of Email/Zip (and Phone, if
// still blank) into the Accounts tab, sourced from a roster exported from
// Liberty REACT and matched by AccountID. Liberty REACT's own AccountID is
// the same one already sitting in the Accounts tab (it's the real system of
// record — see ACCOUNTS_HEADERS above), so this is a plain exact-key join,
// not name/phone fuzzy matching.
//
// To use: paste your roster into the "ContactImport" tab (headers:
// AccountID, Name, Phone, Email, Zip), then run "Import Email/Zip from
// Contact List" from the CIMS Admin menu.
//
// For an AccountID in the roster with no existing Accounts row, this also
// ADDS a bare identity-only Accounts row (AccountID, Name, Phone, Email,
// Zip, zero performance data) -- this is what makes ContactImport the right
// place to paste your *complete* all-time consignor roster, not just a
// recent subset: without an Accounts row, a consignor who's been quiet
// longer than whatever window-based performance pull last built/refreshed
// Accounts isn't findable by phone at the kiosk at all, and would get
// funneled into the new-signup flow as if they'd never consigned before.
// Giving them a zero-performance row fixes that permanently -- they're
// untiered and always open (never gated) until a future quarterly
// performance import happens to include them with real numbers again.
//
// Never overwrites a cell that already has something in it, and never adds
// the same AccountID twice, so it's safe to run again later (e.g. after a
// fresh quarterly performance import) without clobbering a value a
// consignor has since corrected at the kiosk.
// ---------------------------------------------------------------------------
var SHEET_CONTACT_IMPORT = 'ContactImport';
var CONTACT_IMPORT_HEADERS = ['AccountID', 'Name', 'Phone', 'Email', 'Zip'];

function importContactInfo() {
  var ui = SpreadsheetApp.getUi();
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var importSheet = ss.getSheetByName(SHEET_CONTACT_IMPORT);
  if (!importSheet) {
    ui.alert('No "' + SHEET_CONTACT_IMPORT + '" tab found. Run "Initialize sheets" first, paste your contact roster into it (starting row 2), then run this again.');
    return;
  }
  var importValues = importSheet.getDataRange().getValues();
  if (importValues.length < 2) {
    ui.alert('The "' + SHEET_CONTACT_IMPORT + '" tab is empty. Paste your contact roster into it (starting row 2) and run this again.');
    return;
  }
  var importCol = {};
  importValues[0].forEach(function (h, i) { importCol[h] = i; });
  var missing = ['AccountID', 'Email', 'Zip'].filter(function (need) { return importCol[need] === undefined; });
  if (missing.length) {
    ui.alert('The "' + SHEET_CONTACT_IMPORT + '" tab is missing column(s): ' + missing.join(', ') + '.\nExpected headers: ' + CONTACT_IMPORT_HEADERS.join(', '));
    return;
  }

  // Build a lookup from the pasted roster, keyed by AccountID.
  var byAccountId = {};
  var importOrder = [];
  for (var i = 1; i < importValues.length; i++) {
    var row = importValues[i];
    var id = String(row[importCol['AccountID']]).trim();
    if (!id) continue;
    byAccountId[id] = {
      name: importCol['Name'] !== undefined ? String(row[importCol['Name']]).trim() : '',
      phone: importCol['Phone'] !== undefined ? String(row[importCol['Phone']]).trim() : '',
      email: String(row[importCol['Email']]).trim(),
      zip: String(row[importCol['Zip']]).trim()
    };
    importOrder.push(id);
  }

  // Walk the real Accounts tab and fill in any blank Email/Zip (and Phone,
  // if that column exists and is blank) cells for a matching AccountID.
  var accountsSheet = getSheet_(SHEET_ACCOUNTS);
  var accountsValues = accountsSheet.getDataRange().getValues();
  var col = {};
  accountsValues[0].forEach(function (h, i) { col[h] = i; });

  if (col['AccountID'] === undefined) {
    ui.alert('The Accounts tab is missing an "AccountID" column — can\'t match rows without it.');
    return;
  }

  // Email/Zip aren't part of the real APR/PBC export, so most real Accounts
  // tabs won't have these columns the first time this runs. Add whichever
  // is missing automatically (appended at the end) instead of making you go
  // edit the sheet by hand first -- every part of CIMS reads Email/Zip by
  // header name, not column position, so it doesn't matter where they land.
  var addedCols = [];
  ['Email', 'Zip'].forEach(function (name) {
    if (col[name] === undefined) {
      var newCol1Indexed = accountsSheet.getLastColumn() + 1;
      accountsSheet.getRange(1, newCol1Indexed).setValue(name).setFontWeight('bold');
      col[name] = newCol1Indexed - 1;
      addedCols.push(name);
    }
  });
  if (addedCols.length) {
    accountsValues = accountsSheet.getDataRange().getValues(); // pick up the new column(s)
  }

  // Fill blanks IN MEMORY (mutating the accountsValues array we already read)
  // rather than one getRange().setValue() call per cell -- at real-world
  // scale (thousands of rows) that's thousands of separate round trips to
  // the Sheets backend, slow enough to hit Apps Script's execution time
  // limit and die partway through. Every change here gets written back to
  // the sheet in one single batched setValues() call below instead.
  var filledEmail = 0, filledZip = 0, filledPhone = 0, matched = 0, alreadyHadBoth = 0, noRosterMatch = 0;
  var matchedIds = {};
  var accountsChanged = false;
  for (var r = 1; r < accountsValues.length; r++) {
    var acctId = String(accountsValues[r][col['AccountID']]).trim();
    if (!acctId) continue;
    var contact = byAccountId[acctId];
    if (!contact) { noRosterMatch++; continue; }
    matched++;
    matchedIds[acctId] = true;
    var curEmail = accountsValues[r][col['Email']];
    var curZip = accountsValues[r][col['Zip']];
    var curPhone = col['Phone'] !== undefined ? accountsValues[r][col['Phone']] : null;
    var didFill = false;
    if (!curEmail && contact.email) {
      accountsValues[r][col['Email']] = contact.email;
      filledEmail++; didFill = true;
    }
    if (!curZip && contact.zip) {
      accountsValues[r][col['Zip']] = contact.zip;
      filledZip++; didFill = true;
    }
    if (col['Phone'] !== undefined && !curPhone && contact.phone) {
      accountsValues[r][col['Phone']] = contact.phone;
      filledPhone++; didFill = true;
    }
    if (didFill) accountsChanged = true;
    if (!didFill && curEmail && curZip) alreadyHadBoth++;
  }

  // One batched write for every filled-in blank above, instead of one call
  // per cell.
  if (accountsChanged) {
    accountsSheet.getRange(1, 1, accountsValues.length, accountsValues[0].length).setValues(accountsValues);
  }

  // ContactImport rows with no existing Accounts row -- these are consignors
  // ContactImport knows about that never made it into Accounts at all, most
  // likely because they'd already gone quiet before whatever window-based
  // performance pull last built/refreshed Accounts (see "Quarterly refresh
  // from the Consignor Performance Dashboard" in README.md). Without an
  // Accounts row, the kiosk's phone lookup can't find them, so a returning
  // consignor would be funneled into the new-signup flow as if they'd never
  // consigned before -- even though they have real history. Adding a bare
  // identity-only row here (zero performance data, same as any other
  // never-tiered account) fixes that permanently: they're found and
  // recognized as an existing account from now on, and the next quarterly
  // performance import will fill in real numbers for them automatically if
  // they show up in a future window again.
  // Collect every new row in memory first, then append them all in one
  // batched write -- same reasoning as above: one appendRow() call per new
  // account (there can be thousands at real scale) is what actually hangs
  // this import, not anything about the data itself.
  var newRows = [];
  importOrder.forEach(function (id) {
    if (matchedIds[id]) return;
    matchedIds[id] = true; // guard against duplicate rows in the pasted roster
    var contact = byAccountId[id];
    newRows.push(ACCOUNTS_HEADERS.map(function (h) {
      if (h === 'AccountID') return id;
      if (h === 'Name') return contact.name || '';
      if (h === 'Phone') return contact.phone || '';
      if (h === 'Email') return contact.email || '';
      if (h === 'Zip') return contact.zip || '';
      return ''; // performance columns start blank -- untiered, always open, never gated
    }));
  });
  var added = newRows.length;
  if (added > 0) {
    accountsSheet.getRange(accountsSheet.getLastRow() + 1, 1, newRows.length, ACCOUNTS_HEADERS.length).setValues(newRows);
    clearMediansCache_();
  }

  ui.alert(
    'Contact import complete.\n\n' +
    (addedCols.length ? ('Added missing column(s) to Accounts: ' + addedCols.join(', ') + '\n\n') : '') +
    'Existing accounts matched by AccountID: ' + matched + '\n' +
    'Email filled in: ' + filledEmail + '\n' +
    'Zip filled in: ' + filledZip + '\n' +
    (col['Phone'] !== undefined ? ('Phone filled in (was blank): ' + filledPhone + '\n') : '') +
    'Already had both Email and Zip (left alone): ' + alreadyHadBoth + '\n' +
    'Accounts rows with no matching AccountID in the roster (left alone): ' + noRosterMatch + '\n\n' +
    'New accounts added (known to the roster, had no Accounts row yet -- e.g. consignors who went quiet before the current performance window): ' + added + '\n' +
    (added > 0 ? 'These start with zero performance data (untiered, always open, never gated) and will pick up real numbers automatically the next time they fall inside a quarterly performance import.\n\n' : '\n') +
    'Safe to run again any time — it never overwrites a cell that already has a value, and never adds the same account twice.'
  );
}

// ---------------------------------------------------------------------------
// DIAGNOSE UNMATCHED ACCOUNTS — read-only helper for the "Accounts rows with
// no matching AccountID in the roster" count importContactInfo() reports.
// Doesn't touch Accounts or ContactImport at all; just writes the unmatched
// Accounts rows out to their own tab (overwriting that tab's old contents
// each time it's run) so they're easy to eyeball, sort, and filter directly
// instead of guessing at what they are from a number in an alert box.
// ---------------------------------------------------------------------------
var SHEET_UNMATCHED_DIAGNOSTIC = 'UnmatchedDiagnostic';

function diagnoseUnmatchedAccounts() {
  var ui = SpreadsheetApp.getUi();
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var importSheet = ss.getSheetByName(SHEET_CONTACT_IMPORT);
  if (!importSheet) {
    ui.alert('No "' + SHEET_CONTACT_IMPORT + '" tab found — nothing to compare Accounts against.');
    return;
  }
  var importValues = importSheet.getDataRange().getValues();
  var importCol = {};
  if (importValues.length) importValues[0].forEach(function (h, i) { importCol[h] = i; });
  if (importCol['AccountID'] === undefined) {
    ui.alert('The "' + SHEET_CONTACT_IMPORT + '" tab is missing an "AccountID" column.');
    return;
  }
  var rosterIds = {};
  for (var i = 1; i < importValues.length; i++) {
    var id = String(importValues[i][importCol['AccountID']]).trim();
    if (id) rosterIds[id] = true;
  }

  var accountsSheet = getSheet_(SHEET_ACCOUNTS);
  var accountsValues = accountsSheet.getDataRange().getValues();
  var headerRow = accountsValues[0];
  var col = {};
  headerRow.forEach(function (h, i) { col[h] = i; });
  if (col['AccountID'] === undefined) {
    ui.alert('The Accounts tab is missing an "AccountID" column.');
    return;
  }

  var unmatched = [headerRow];
  for (var r = 1; r < accountsValues.length; r++) {
    var acctId = String(accountsValues[r][col['AccountID']]).trim();
    if (!acctId) continue;
    if (!rosterIds[acctId]) unmatched.push(accountsValues[r]);
  }

  var diagSheet = ss.getSheetByName(SHEET_UNMATCHED_DIAGNOSTIC);
  if (diagSheet) {
    diagSheet.clear();
  } else {
    diagSheet = ss.insertSheet(SHEET_UNMATCHED_DIAGNOSTIC);
  }
  if (unmatched.length > 1) {
    diagSheet.getRange(1, 1, unmatched.length, headerRow.length).setValues(unmatched);
    diagSheet.getRange(1, 1, 1, headerRow.length).setFontWeight('bold');
    diagSheet.setFrozenRows(1);
  } else {
    diagSheet.getRange(1, 1, 1, headerRow.length).setValues([headerRow]);
    diagSheet.getRange(1, 1, 1, headerRow.length).setFontWeight('bold');
    diagSheet.setFrozenRows(1);
  }

  ui.alert(
    'Diagnostic complete — nothing in Accounts or ContactImport was changed.\n\n' +
    (unmatched.length - 1) + ' Accounts row(s) have an AccountID not found in ContactImport.\n\n' +
    'They\'ve been copied to a new "' + SHEET_UNMATCHED_DIAGNOSTIC + '" tab (full Accounts columns, so you can sort/filter/eyeball them directly). ' +
    'Safe to delete that tab whenever you\'re done with it — re-running this will recreate it fresh.'
  );
}

// ---------------------------------------------------------------------------
// PERFORMANCE IMPORT — the quarterly refresh of each account's computed
// performance numbers (CheckedIn, Sold, AvgDaysToSell, AvgProfitPerItem,
// DonationRate, Spend), sourced from Brad's Consignor Performance Dashboard
// (now a 12-month rolling window, refreshed once a quarter). This replaces
// the old by-hand pandas merge of the APR + PBC reports (handoff §5) with a
// repeatable menu action.
//
// To use: paste the dashboard's export into the "PerformanceImport" tab
// (headers: AccountID, Name, CheckedIn, Sold, AvgDaysToSell,
// AvgProfitPerItem, DonationRate, Spend — Name isn't used by the merge,
// it's just there so you can eyeball that a row looks right), then run
// "Import Quarterly Performance Data" from the CIMS Admin menu.
//
// Matches by AccountID (Liberty REACT's own account number, the same key
// already in the Accounts tab) and OVERWRITES the performance columns for
// matching rows — that's the point of a quarterly refresh, unlike the
// Email/Zip contact import above, which only ever fills in blanks. Name,
// Phone, Email, and Zip are never touched here, so nothing this import does
// can undo a consignor's kiosk correction or a contact-list backfill.
//
// A metric cell left blank on a given import row is skipped for that row
// (the existing value in Accounts is left alone) rather than zeroed out —
// so a partial export (e.g. one that doesn't include Spend this quarter)
// can't accidentally wipe a column it wasn't meant to touch.
//
// AccountIDs in the import with no existing Accounts row are added as new
// rows (Phone/Email/Zip start blank, same gap as any other new account —
// see "Loading real data" in README.md). AccountIDs in Accounts with no
// matching row in this quarter's import are left exactly as they were, and
// just counted in the summary so you can review whether they've closed or
// dropped out of the rolling 12-month window.
//
// Clears the medians cache when it's done, same as "Refresh medians now",
// so the new numbers are reflected immediately instead of waiting up to 6
// hours for the cache to expire on its own.
// ---------------------------------------------------------------------------
var SHEET_PERFORMANCE_IMPORT = 'PerformanceImport';
var PERFORMANCE_IMPORT_HEADERS = ['AccountID', 'Name', 'CheckedIn', 'Sold', 'AvgDaysToSell', 'AvgProfitPerItem', 'DonationRate', 'Spend'];
var PERFORMANCE_METRIC_FIELDS_ = ['CheckedIn', 'Sold', 'AvgDaysToSell', 'AvgProfitPerItem', 'DonationRate', 'Spend'];

function importPerformanceData() {
  var ui = SpreadsheetApp.getUi();
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  var importSheet = ss.getSheetByName(SHEET_PERFORMANCE_IMPORT);
  if (!importSheet) {
    ui.alert('No "' + SHEET_PERFORMANCE_IMPORT + '" tab found. Run "Initialize sheets" first, paste this quarter\'s performance export into it (starting row 2), then run this again.');
    return;
  }
  var importValues = importSheet.getDataRange().getValues();
  if (importValues.length < 2) {
    ui.alert('The "' + SHEET_PERFORMANCE_IMPORT + '" tab is empty. Paste this quarter\'s performance export into it (starting row 2) and run this again.');
    return;
  }
  var importCol = {};
  importValues[0].forEach(function (h, i) { importCol[h] = i; });
  if (importCol['AccountID'] === undefined) {
    ui.alert('The "' + SHEET_PERFORMANCE_IMPORT + '" tab is missing an "AccountID" column — can\'t match rows without it.\nExpected headers: ' + PERFORMANCE_IMPORT_HEADERS.join(', '));
    return;
  }
  var presentMetrics = PERFORMANCE_METRIC_FIELDS_.filter(function (f) { return importCol[f] !== undefined; });
  if (presentMetrics.length === 0) {
    ui.alert('The "' + SHEET_PERFORMANCE_IMPORT + '" tab has no recognized metric columns.\nExpected headers: ' + PERFORMANCE_IMPORT_HEADERS.join(', '));
    return;
  }

  // Build a lookup from the pasted export, keyed by AccountID.
  var byAccountId = {};
  var importOrder = [];
  for (var i = 1; i < importValues.length; i++) {
    var row = importValues[i];
    var id = String(row[importCol['AccountID']]).trim();
    if (!id) continue;
    var rowData = { name: importCol['Name'] !== undefined ? String(row[importCol['Name']]).trim() : '' };
    presentMetrics.forEach(function (f) {
      var raw = row[importCol[f]];
      rowData[f] = (raw === '' || raw === null || raw === undefined) ? null : raw;
    });
    byAccountId[id] = rowData;
    importOrder.push(id);
  }

  var accountsSheet = getSheet_(SHEET_ACCOUNTS);
  var accountsValues = accountsSheet.getDataRange().getValues();
  var col = {};
  accountsValues[0].forEach(function (h, i) { col[h] = i; });

  if (col['AccountID'] === undefined) {
    ui.alert('The Accounts tab is missing an "AccountID" column — can\'t match rows without it.');
    return;
  }

  // Apply updates IN MEMORY (mutating the accountsValues array already
  // read above), then write everything back in one batched call -- one
  // getRange().setValue() per changed cell is thousands of separate round
  // trips to the Sheets backend at real-world scale, slow enough to hit
  // Apps Script's execution time limit and die partway through.
  var matched = 0, updated = 0, unchanged = 0, notInImport = 0;
  var matchedIds = {};
  var accountsChanged = false;
  for (var r = 1; r < accountsValues.length; r++) {
    var acctId = String(accountsValues[r][col['AccountID']]).trim();
    if (!acctId) continue;
    var perf = byAccountId[acctId];
    if (!perf) { notInImport++; continue; }
    matched++;
    matchedIds[acctId] = true;
    var rowChanged = false;
    presentMetrics.forEach(function (f) {
      if (perf[f] === null || col[f] === undefined) return; // blank on import, or column doesn't exist in Accounts -- leave alone
      accountsValues[r][col[f]] = perf[f];
      rowChanged = true;
    });
    if (rowChanged) { updated++; accountsChanged = true; } else { unchanged++; }
  }

  // One batched write for every updated cell above, instead of one call
  // per cell.
  if (accountsChanged) {
    accountsSheet.getRange(1, 1, accountsValues.length, accountsValues[0].length).setValues(accountsValues);
  }

  // AccountIDs in the import with no existing Accounts row -- add them as
  // new accounts, collected in memory and appended in one batched write.
  // Phone/Email/Zip start blank, same gap as any other new account (see
  // "Loading real data" in README.md).
  var newRows = [];
  importOrder.forEach(function (id) {
    if (matchedIds[id]) return;
    matchedIds[id] = true; // guard against duplicate rows in the pasted export
    var perf = byAccountId[id];
    newRows.push(ACCOUNTS_HEADERS.map(function (h) {
      if (h === 'AccountID') return id;
      if (h === 'Name') return perf.name || '';
      if (presentMetrics.indexOf(h) !== -1 && perf[h] !== null) return perf[h];
      return '';
    }));
  });
  var added = newRows.length;
  if (added > 0) {
    accountsSheet.getRange(accountsSheet.getLastRow() + 1, 1, newRows.length, ACCOUNTS_HEADERS.length).setValues(newRows);
  }

  clearMediansCache_();

  ui.alert(
    'Quarterly performance import complete.\n\n' +
    'Columns found in this export: ' + presentMetrics.join(', ') + '\n\n' +
    'Existing accounts matched and updated: ' + updated + '\n' +
    'Existing accounts matched but already up to date (blank cells in export, nothing to change): ' + unchanged + '\n' +
    'New accounts added (were in the export, not yet in Accounts): ' + added + '\n' +
    'Existing accounts NOT in this export (left unchanged — review whether these have closed or dropped out of the 12-month window): ' + notInImport + '\n\n' +
    'Name, Phone, Email, and Zip were never touched by this import.\n' +
    'Medians have been refreshed, so new tiers take effect immediately.'
  );
}

// ---------------------------------------------------------------------------
// TOTES — individual tote-level tracking, added when Consignor Check-In and
// Print Labels were merged into one flow. Each row is one physical tote with
// its own real, unique Tote ID (see reserveToteIds_ below) -- this replaces
// the old "how many totes" upfront guess entirely: a consignor never states
// a count anymore, they just print a label each time they fill a tote.
// ---------------------------------------------------------------------------
var SHEET_TOTES = 'Totes';
// Category ('C'/'W'/'M', any combination, e.g. "CW") is optional and
// whole-visit -- same value on every tote from one visit, not chosen per
// tote. Added as the LAST column on purpose, not inserted in the middle:
// printLabels() below writes these positionally, so appending it at the
// end means an existing live Totes tab (created before this column
// existed) keeps every prior column exactly where it was -- no risk of
// misaligning Season/Consignment Date/Printed At/Status on old rows. Just
// add a "Category" header cell in the next open column on the live sheet
// after redeploying (see README) so new rows land under a label.
var TOTES_HEADERS = [
  'Tote ID', 'AccountID', 'Consignor', 'Season', 'Consignment Date',
  'Printed At', 'Status', 'Category'
];

// Tote IDs are MMDDYY-NN: the date plus that day's running count, shared
// store-wide (not per-account, not per-season) -- e.g. the 5th tote printed
// anywhere in the store today is 091426-05. The counter lives in the Config
// sheet (two keys below) behind a LockService lock so two kiosks printing at
// the same moment can never hand out the same number, and resets itself the
// first time it's used on a new day.
var TOTE_SEQ_DATE_KEY = 'toteSeqDate';
var TOTE_SEQ_NEXT_KEY = 'toteSeqNext';

function todayKey_() {
  var tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  return Utilities.formatDate(new Date(), tz, 'yyyyMMdd');
}

function formatToteId_(seq) {
  var tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  var mmddyy = Utilities.formatDate(new Date(), tz, 'MMddyy');
  return mmddyy + '-' + (seq < 10 ? '0' + seq : String(seq));
}

// Reserves `count` consecutive sequence numbers and returns them as real
// Tote ID strings, e.g. reserveToteIds_(3) -> ['091426-05','091426-06','091426-07'].
// Locked so concurrent prints (two kiosks, or two visits landing at once)
// never collide or double-hand-out a number.
function reserveToteIds_(count) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    var sheet = getSheet_(SHEET_CONFIG);
    var values = sheet.getDataRange().getValues();
    var dateRow = -1, nextRow = -1, dateVal = '', nextVal = 0;
    for (var i = 1; i < values.length; i++) {
      if (values[i][0] === TOTE_SEQ_DATE_KEY) { dateRow = i + 1; dateVal = values[i][1]; }
      if (values[i][0] === TOTE_SEQ_NEXT_KEY) { nextRow = i + 1; nextVal = Number(values[i][1]) || 0; }
    }
    var today = todayKey_();
    if (dateVal !== today) {
      // First reservation of a new day -- reset the counter to 1.
      nextVal = 0;
      if (dateRow === -1) { sheet.appendRow([TOTE_SEQ_DATE_KEY, today, 'Internal -- do not edit by hand.']); }
      else { sheet.getRange(dateRow, 2).setValue(today); }
    }
    var start = nextVal + 1;
    var ids = [];
    for (var s = start; s < start + count; s++) { ids.push(formatToteId_(s)); }
    var newNext = start + count - 1;
    if (nextRow === -1) { sheet.appendRow([TOTE_SEQ_NEXT_KEY, newNext, 'Internal -- do not edit by hand.']); }
    else { sheet.getRange(nextRow, 2).setValue(newNext); }
    return ids;
  } finally {
    lock.releaseLock();
  }
}

function getTotesSheet_() {
  return getSheet_(SHEET_TOTES);
}

// Every tote printed anywhere today, for the "already checked in" /
// "printed so far today" detection. Read once per lookup and reused for
// both hasSessionToday_ and getTodayToteCounts_ so a lookup is one sheet
// read, not several.
function getTodayTotesFor_(idKey) {
  var sheet = getTotesSheet_();
  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  var col = {};
  headers.forEach(function (h, i) { col[h] = i; });
  var today = todayKey_();
  var tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (String(row[col['AccountID']]) !== String(idKey)) continue;
    var printedAt = row[col['Printed At']];
    if (!printedAt) continue;
    var printedDay = Utilities.formatDate(new Date(printedAt), tz, 'yyyyMMdd');
    if (printedDay === today) rows.push({ season: row[col['Season']] });
  }
  return rows;
}

function getTodayToteCounts_(idKey) {
  var rows = getTodayTotesFor_(idKey);
  var counts = { fw: 0, ss: 0 };
  rows.forEach(function (r) {
    if (r.season === 'FW') counts.fw++;
    else if (r.season === 'SS') counts.ss++;
  });
  return counts;
}

// ---------------------------------------------------------------------------
// MERGED CHECK-IN + PRINT LABELS — public server functions called from the
// single kiosk home screen. Replaces the old separate stepper-based
// recordDropoff() entry point for the UI (recordDropoff/recordNewSignupDropoff
// above are left in place since Admin/back-office code doesn't call them
// anymore from here, but nothing else references them either -- fine to leave
// as dead code for now rather than risk removing something still relied on).
// ---------------------------------------------------------------------------

/**
 * After a phone lookup resolves to one match (existing account or a pending
 * new-signup), this tells the client which screen to show next: already
 * checked in today (-> straight to Print Labels) or not yet (-> the review +
 * season + status flow). Also hands back today's per-season print counts and,
 * for an existing account, its on-file Name/Phone/Email/Zip to prefill the
 * review form. Kept as its own public entry point for the multi-match
 * "which account is yours" picker and for re-checking counts later in a
 * visit; the common single-match kiosk lookup calls resolveConsignorHome_()
 * directly from lookupAndResolve() instead, to save a round trip.
 */
function getConsignorHome(idKey, mode) {
  return resolveConsignorHome_(idKey, mode);
}

function resolveConsignorHome_(idKey, mode) {
  var name, phone, email, zip;
  if (mode === 'account') {
    var accounts = getAccountsFromSheet_();
    var account = accounts.filter(function (a) { return a.accountId === String(idKey); })[0];
    if (!account) return { ok: false, error: 'Account not found.' };
    name = formatDisplayName_(account.name);
    phone = account.phone;
    email = account.email;
    zip = account.zip;
  } else if (mode === 'pending') {
    var signups = getNewSignupsFromSheet_();
    var signup = signups.filter(function (s) { return s.tempId === String(idKey); })[0];
    if (!signup) return { ok: false, error: 'Signup not found.' };
    name = signup.name;
    phone = signup.phone;
    email = signup.email;
    zip = signup.zip;
  } else {
    return { ok: false, error: 'Unknown lookup type.' };
  }

  var hasSession = getTodayTotesFor_(idKey).length > 0;
  var counts = getTodayToteCounts_(idKey);
  return { ok: true, name: name, phone: phone, email: email || '', zip: zip || '', hasSessionToday: hasSession, todayCounts: counts };
}

// Compares what the consignor just typed on the review screen against what's
// on file and returns only the fields that actually changed (skips a field
// if they left it blank -- that's "didn't touch it," not "clear it out").
// Name is compared/stored in the kiosk's "First Last" convention, so a
// correction also fixes an old "Last, First" record going forward.
function diffAccountChanges_(account, reviewed) {
  var changes = [];
  function check(field, oldVal, newVal) {
    oldVal = (oldVal || '').toString().trim();
    newVal = (newVal || '').toString().trim();
    if (newVal && newVal !== oldVal) changes.push({ field: field, oldVal: oldVal, newVal: newVal });
  }
  check('Name', formatDisplayName_(account.name), reviewed.name);
  check('Phone', account.phone, normalizePhone_(reviewed.phone));
  check('Email', account.email, reviewed.email);
  check('Zip', account.zip, reviewed.zip);
  return changes;
}

// Writes corrections straight into the Accounts sheet (so CIMS itself is
// right immediately) and logs each one to AccountChanges -- since Liberty
// REACT is still the real system of record, staff need that list to go
// make the same edit there, or the next quarterly re-import will just
// overwrite the correction with Liberty REACT's stale value again.
function applyAccountChanges_(account, changes) {
  if (!changes.length) return;
  var sheet = getSheet_(SHEET_ACCOUNTS);
  var headerRow = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var col = {};
  headerRow.forEach(function (h, i) { col[h] = i + 1; }); // 1-indexed columns
  var changesSheet = getSheet_(SHEET_ACCOUNT_CHANGES);
  var now = new Date();
  var displayName = formatDisplayName_(account.name);
  changes.forEach(function (c) {
    var colIndex = col[c.field];
    if (colIndex) sheet.getRange(account._row, colIndex).setValue(c.newVal);
    changesSheet.appendRow([now, account.accountId, displayName, c.field, c.oldVal, c.newVal, false]);
  });
}

// Human-readable label for each tier, used only in the team notification
// email below -- keeps the internal keys (star/bulk/efficient/marginal)
// out of an email staff have to read at a glance.
var TIER_LABELS_ = { star: 'Star', bulk: 'Bulk mover', efficient: 'Efficient', marginal: 'Marginal' };

/**
 * Emails a snapshot of one completed check-in to the team inbox (Config's
 * notifyEmail) -- the CIMS replacement for the old Shopify-form
 * notification, same purpose: pricers use it to confirm they're pulling up
 * the right consignor account, and it's a record that the visit happened
 * and the guidelines were agreed to. Fires once per check-in, from
 * submitCheckIn() below, for all four outcomes (new, pending, and
 * existing-account open/capped/closed) -- every completed check-in, same
 * as the form did before.
 *
 * f: { isNew, name, accountId, phone, email, zip, seasonNote, categoryText,
 *      statusLabel, statusColor, tier, changes }
 */
function sendDropoffNotification_(f) {
  var config = getConfig_();
  var to = (config.notifyEmail || CONFIG_DEFAULTS.notifyEmail || '').toString().trim();
  if (!to) return; // no destination configured -- skip rather than error out a real check-in over it

  var subject = 'You have another ' + (f.isNew ? 'NEW' : 'EXISTING') + ' Consignor Drop-Off!';
  var seasonText = { FW: 'Fall / Winter', SS: 'Spring / Summer', 'FW+SS': 'Fall / Winter + Spring / Summer' }[f.seasonNote] || 'Not specified';

  function row(label, valueHtml) {
    return '<div style="margin:0 0 10px; font-size:16px; color:#222;">' + esc_(label) + ': ' + valueHtml + '</div>';
  }
  var rows = '';
  rows += row('Name', '<b>' + esc_(f.name) + '</b>');
  rows += row('Account ID', f.accountId ? esc_(f.accountId) : '<i>New signup &mdash; pending staff enrollment</i>');
  rows += row('Email', f.email ? '<a href="mailto:' + esc_(f.email) + '" style="color:#1155cc;">' + esc_(f.email) + '</a>' : '<i>none on file</i>');
  rows += row('Phone', f.phone ? '<a href="tel:' + esc_(f.phone) + '" style="color:#1155cc;">' + esc_(formatPhoneDisplay_(f.phone)) + '</a>' : '<i>none on file</i>');
  rows += row('Zip', f.zip || '<i>none on file</i>');
  rows += row('Dropping off', seasonText);
  if (f.categoryText) rows += row('Category', f.categoryText);
  rows += row('Status', '<b style="color:' + f.statusColor + ';">' + esc_(f.statusLabel) + '</b>' + (f.tier ? ' &middot; ' + esc_(TIER_LABELS_[f.tier] || f.tier) + ' tier' : ''));
  if (f.changes && f.changes.length) {
    var chg = f.changes.map(function (c) {
      return esc_(c.field) + ': "' + esc_(c.oldVal) + '" &rarr; "' + esc_(c.newVal) + '"';
    }).join('<br>');
    rows += row('Corrected this visit', chg);
  }
  rows += row('I agree to the Consignment Guidelines and Agreement', 'Yes');

  var html = '' +
    '<div style="font-family:Arial,Helvetica,sans-serif; max-width:600px;">' +
      '<div style="background:#f5f5f5; padding:28px 24px;">' +
        '<h1 style="margin:0; font-size:26px; color:#3c3c3c;">' + esc_(subject) + '</h1>' +
      '</div>' +
      '<div style="padding:24px;">' + rows + '</div>' +
    '</div>';

  var plainFallback = subject + '\n\n' + f.name +
    (f.accountId ? ' (' + f.accountId + ')' : ' (new signup)') +
    ' -- status: ' + f.statusLabel + '. Open in an HTML-capable mail client to see full details.';

  // GmailApp (alias sending) intentionally removed. Its OAuth scope is
  // classified "sensitive" by Google, and scope authorization in Apps
  // Script is computed for the WHOLE PROJECT, not per function -- so
  // GmailApp being used anywhere (even here, nothing to do with the
  // kiosk's print page) made Google treat the entire deployment as an
  // unreviewed app, which is what was printing that "This application was
  // created by a Google Apps Script user" banner onto physical labels on
  // the Kiosk Pro iPad. MailApp's scope isn't sensitive, so it doesn't
  // trigger that. Tradeoff: this now always sends from whichever Google
  // account owns the script, not from notifyFromEmail's alias address --
  // notifyFromEmail is left in CONFIG for reference but is no longer read
  // here. The display name (notifyFromName) still applies either way.
  var fromName = (config.notifyFromName || '').toString().trim();

  try {
    MailApp.sendEmail({ to: to, subject: subject, body: plainFallback, htmlBody: html, name: fromName || undefined });
  } catch (e) {
    // A mail-quota or transient failure here should never fail the actual
    // check-in the consignor is standing at the kiosk waiting on.
    Logger.log('sendDropoffNotification_ MailApp failed: ' + e);
  }
}
function esc_(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function formatPhoneDisplay_(digits) {
  digits = String(digits || '').replace(/\D/g, '');
  return digits.length === 10 ? '(' + digits.slice(0, 3) + ') ' + digits.slice(3, 6) + '-' + digits.slice(6) : digits;
}
// E.164-ish formatting for Klaviyo's phone_number identifier -- store is
// US-only, so a 10-digit normalized number just gets a '+1' prefix. Numbers
// that aren't exactly 10 digits (bad data, partial entry) are left alone
// rather than guessed at; Klaviyo will just ignore an unusable value.
function formatPhoneE164_(digits) {
  digits = String(digits || '').replace(/\D/g, '');
  return digits.length === 10 ? '+1' + digits : '';
}

// Diagnostic sheet for fireKlaviyoDropoffEvent_ -- Stackdriver/Cloud Logging
// output (Logger.log) for a web-app execution can lag or simply not show up
// in the Apps Script Executions panel for a long time (observed: over an
// hour, on executions that completed normally), which makes it useless for
// real-time troubleshooting of this integration. Every attempt -- skipped,
// succeeded, or failed -- also writes one row here instead/in addition, so
// the result is visible immediately just by opening the spreadsheet tab,
// no Executions panel or log propagation involved. Self-creates the sheet
// on first use. Wrapped so a problem writing the diagnostic row itself can
// never be the thing that breaks a check-in.
var SHEET_KLAVIYO_LOG = 'KlaviyoLog';
function logKlaviyoDiag_(status, detail) {
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    var sheet = ss.getSheetByName(SHEET_KLAVIYO_LOG);
    if (!sheet) {
      sheet = ss.insertSheet(SHEET_KLAVIYO_LOG);
      sheet.appendRow(['Timestamp', 'Status', 'Detail']);
    }
    sheet.appendRow([new Date(), status, String(detail).substring(0, 500)]);
  } catch (e) {
    // never let diagnostic logging be the thing that breaks a check-in
  }
}

/**
 * Fires the "Consignment Drop-Off" event to Klaviyo so the matching
 * EXISTING/NEW consignor confirmation flow (metric-triggered, filtered on
 * the ConsignorType property) sends -- on every visit, including repeat
 * ones, which the old list-subscribe-triggered flows structurally couldn't
 * do (a profile's "Subscribed to List" event only fires once, the first
 * time it's added -- re-adding an existing member never re-fires it).
 *
 * Never throws and never blocks the check-in: a Klaviyo outage, a bad/
 * missing API key, or a malformed response must never fail the actual
 * check-in the consignor is standing at the kiosk waiting on. Any problem
 * here is logged (to both Logger.log and the KlaviyoLog sheet -- see
 * logKlaviyoDiag_ above) and swallowed.
 *
 * profile: { name, email, phone, accountId }. accountId should only be
 * passed for mode 'account' (a real POS AccountID) -- it's sent as
 * Klaviyo's external_id so repeat visits from the same account always
 * resolve to the same Klaviyo profile even on days when email/phone on
 * file are blank. New/pending signups don't have a durable AccountID yet
 * (just a CIMS-internal TempID, which may later map to a different real
 * AccountID once staff enrolls them), so for those, email is the
 * identifier -- it's required at signup and far less likely to fragment
 * their eventual Klaviyo profile than a throwaway TempID would.
 * consignorType: 'Existing' | 'New' -- must match the ConsignorType value
 * each flow's trigger filter checks for in Klaviyo.
 */
function fireKlaviyoDropoffEvent_(profile, consignorType) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('KLAVIYO_PRIVATE_API_KEY');
  if (!apiKey) {
    Logger.log('fireKlaviyoDropoffEvent_: no KLAVIYO_PRIVATE_API_KEY script property set -- skipping.');
    logKlaviyoDiag_('skipped', 'No KLAVIYO_PRIVATE_API_KEY script property set.');
    return;
  }

  var profileAttrs = {};
  if (profile.accountId) profileAttrs.external_id = String(profile.accountId);
  if (profile.email) profileAttrs.email = String(profile.email).trim();
  var e164 = formatPhoneE164_(profile.phone);
  if (e164) profileAttrs.phone_number = e164;
  if (profile.name) {
    var nameParts = String(profile.name).trim().split(/\s+/);
    profileAttrs.first_name = nameParts[0] || '';
    if (nameParts.length > 1) profileAttrs.last_name = nameParts.slice(1).join(' ');
  }
  if (!profileAttrs.external_id && !profileAttrs.email && !profileAttrs.phone_number) {
    Logger.log('fireKlaviyoDropoffEvent_: no usable identifier (accountId/email/phone) -- skipping.');
    logKlaviyoDiag_('skipped', 'No usable identifier (accountId/email/phone) for ' + consignorType + ' profile "' + (profile.name || '') + '".');
    return;
  }

  var payload = {
    data: {
      type: 'event',
      attributes: {
        properties: { ConsignorType: consignorType },
        metric: { data: { type: 'metric', attributes: { name: 'Consignment Drop-Off' } } },
        profile: { data: { type: 'profile', attributes: profileAttrs } },
        unique_id: Utilities.getUuid()
      }
    }
  };

  logKlaviyoDiag_('attempting', consignorType + ' profile, identifiers: ' + Object.keys(profileAttrs).join(', '));

  try {
    var resp = UrlFetchApp.fetch('https://a.klaviyo.com/api/events/', {
      method: 'post',
      contentType: 'application/json',
      headers: {
        Authorization: 'Klaviyo-API-Key ' + apiKey,
        accept: 'application/json',
        revision: '2026-04-15'
      },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    var code = resp.getResponseCode();
    if (code < 200 || code >= 300) {
      Logger.log('fireKlaviyoDropoffEvent_: Klaviyo returned ' + code + ': ' + resp.getContentText());
      logKlaviyoDiag_('error', 'HTTP ' + code + ': ' + resp.getContentText());
    } else {
      logKlaviyoDiag_('success', 'HTTP ' + code);
    }
  } catch (e) {
    Logger.log('fireKlaviyoDropoffEvent_ failed: ' + e);
    logKlaviyoDiag_('exception', String(e));
  }
}

/**
 * First-of-day check-in: runs the tier/volume gate (same logic as before,
 * now triggered by season selection instead of a guessed tote count) and
 * logs one Dropoffs row marking the day's check-in. New consignors
 * (mode 'new') are never gated, same as before -- there's no history to
 * band them against yet.
 *
 * data: { name, phone, email, zip, seasons: { FW: bool, SS: bool } }
 * For mode 'new', this ALSO creates the NewSignups row (previously a
 * separate registerNewConsignor call) -- one submit instead of two.
 *
 * Every outcome below also fires sendDropoffNotification_() -- the CIMS
 * replacement for the old Shopify-form team notification (see that
 * function for what it sends and why) -- and, except for the 'closed'
 * (blocked/not logged) case, fireKlaviyoDropoffEvent_(), which drives the
 * consignor-facing EXISTING/NEW confirmation emails in Klaviyo (see that
 * function for why 'closed' is skipped and how identity is chosen).
 */
function submitCheckIn(idKey, mode, data) {
  var config = getConfig_();
  var seasons = (data && data.seasons) || {};
  var seasonNote = (seasons.FW ? 'FW' : '') + (seasons.FW && seasons.SS ? '+' : '') + (seasons.SS ? 'SS' : '');
  // Childrens/Womens/Mens is no longer decided at check-in time -- it's
  // asked fresh before each print request instead (see prepareCounts()/
  // goToPreview() client-side, and printLabels()'s own categoryNote param
  // below), since what's being dropped off can change batch to batch
  // within the same day. data.categories is never sent from the client
  // any more, so this always resolves empty here -- left in place (rather
  // than deleted) so the check-in Dropoffs note/notification degrade
  // gracefully instead of erroring if that ever changes again.
  var categories = (data && data.categories) || {};
  var categoryNote = (categories.C ? 'C' : '') + (categories.W ? 'W' : '') + (categories.M ? 'M' : '');
  var categoryLabel = { C: 'Childrens', W: 'Womens', M: 'Mens' };
  var categoryText = categoryNote ? categoryNote.split('').map(function (c) { return categoryLabel[c]; }).join(' + ') : '';

  if (mode === 'new') {
    var name = ((data && data.name) || '').toString().trim();
    var phone = normalizePhone_(data && data.phone);
    var email = ((data && data.email) || '').toString().trim();
    var zip = ((data && data.zip) || '').toString().trim();
    if (!name) return { ok: false, error: 'Please enter your name.' };
    if (phone.length < 7) return { ok: false, error: 'Please enter a valid phone number.' };
    if (!email) return { ok: false, error: 'Please enter an email address.' };
    if (!zip) return { ok: false, error: 'Please enter a zip code.' };
    var tempId = 'NEW' + Utilities.getUuid().slice(0, 8).toUpperCase();
    getSheet_(SHEET_NEW_SIGNUPS).appendRow([new Date(), tempId, name, phone, email, zip, 'Pending', '', '']);
    getSheet_(SHEET_DROPOFFS).appendRow([
      new Date(), tempId, name, phone, '', 'new', 'pending-signup', '',
      'New consignor — pending staff enrollment (see NewSignups tab). Dropping off: ' + (seasonNote || 'unspecified') +
        (categoryText ? ' (' + categoryText + ')' : '')
    ]);
    sendDropoffNotification_({
      isNew: true, name: name, accountId: '', phone: phone, email: email, zip: zip,
      seasonNote: seasonNote, categoryText: categoryText, statusLabel: 'New signup — pending enrollment', statusColor: '#b8863b',
      tier: '', changes: null
    });
    fireKlaviyoDropoffEvent_({ name: name, email: email, phone: phone }, 'New');
    return { ok: true, id: tempId, mode: 'new', name: name, status: 'new', message: config.msgNewWelcome };
  }

  if (mode === 'pending') {
    var signups = getNewSignupsFromSheet_();
    var signup = signups.filter(function (s) { return s.tempId === String(idKey); })[0];
    if (!signup) return { ok: false, error: 'Signup not found. Please see a staff member.' };
    // Pending signups aren't a real POS account yet -- freely overwrite
    // with whatever they just confirmed/corrected, no change-log needed.
    var pendingName = ((data && data.name) || signup.name || '').toString().trim();
    var pendingPhone = normalizePhone_((data && data.phone) || signup.phone);
    var pendingEmail = ((data && data.email) || signup.email || '').toString().trim();
    var pendingZip = ((data && data.zip) || signup.zip || '').toString().trim();
    var signupsSheet = getSheet_(SHEET_NEW_SIGNUPS);
    signupsSheet.getRange(signup._row, 3, 1, 4).setValues([[pendingName, pendingPhone, pendingEmail, pendingZip]]);
    getSheet_(SHEET_DROPOFFS).appendRow([
      new Date(), signup.tempId, pendingName, pendingPhone, '', 'new', 'pending-signup', '',
      'New consignor — pending staff enrollment (see NewSignups tab). Dropping off: ' + (seasonNote || 'unspecified') +
        (categoryText ? ' (' + categoryText + ')' : '')
    ]);
    sendDropoffNotification_({
      isNew: true, name: pendingName, accountId: '', phone: pendingPhone, email: pendingEmail, zip: pendingZip,
      seasonNote: seasonNote, categoryText: categoryText, statusLabel: 'New signup — pending enrollment', statusColor: '#b8863b',
      tier: '', changes: null
    });
    fireKlaviyoDropoffEvent_({ name: pendingName, email: pendingEmail, phone: pendingPhone }, 'New');
    return { ok: true, id: signup.tempId, mode: 'pending', name: pendingName, status: 'new', message: config.msgNewWelcome };
  }

  // mode === 'account'
  var accounts = getAccountsFromSheet_();
  var account = accounts.filter(function (a) { return a.accountId === String(idKey); })[0];
  if (!account) return { ok: false, error: 'Account not found.' };

  // Apply/log any corrections to Name/Phone/Email/Zip before the gating
  // check below -- a correction doesn't depend on whether they're allowed
  // to drop off today.
  var changes = diffAccountChanges_(account, data || {});
  applyAccountChanges_(account, changes);
  if (changes.length) {
    // Re-read so classification/messaging below uses the corrected row.
    accounts = getAccountsFromSheet_();
    account = accounts.filter(function (a) { return a.accountId === String(idKey); })[0];
  }

  var medians = getMediansCached_(accounts, config);
  var classified = classifyAccount(account, medians, config);

  if (classified.status === 'closed') {
    getSheet_(SHEET_DROPOFFS).appendRow([
      new Date(), account.accountId, account.name, account.phone, '',
      classified.tier || 'untiered', classified.status, '', 'BLOCKED - not logged'
    ]);
    sendDropoffNotification_({
      isNew: false, name: formatDisplayName_(account.name), accountId: account.accountId,
      phone: account.phone, email: account.email, zip: account.zip,
      seasonNote: seasonNote, categoryText: categoryText, statusLabel: 'Closed', statusColor: '#b5433a',
      tier: classified.tier, changes: changes
    });
    return { ok: true, id: account.accountId, mode: 'account', name: formatDisplayName_(account.name), status: 'closed', message: config.msgClosed };
  }

  getSheet_(SHEET_DROPOFFS).appendRow([
    new Date(), account.accountId, account.name, account.phone, '',
    classified.tier || 'untiered', classified.status,
    classified.cap === null || classified.cap === undefined ? '' : classified.cap,
    'Dropping off: ' + (seasonNote || 'unspecified') + (categoryText ? ' (' + categoryText + ')' : '')
  ]);

  if (classified.status === 'capped') {
    var msg = String(config.msgCappedTemplate).replace('{{cap}}', classified.cap);
    sendDropoffNotification_({
      isNew: false, name: formatDisplayName_(account.name), accountId: account.accountId,
      phone: account.phone, email: account.email, zip: account.zip,
      seasonNote: seasonNote, categoryText: categoryText, statusLabel: 'Capped (up to ' + classified.cap + ' items)', statusColor: '#b8863b',
      tier: classified.tier, changes: changes
    });
    fireKlaviyoDropoffEvent_({ name: formatDisplayName_(account.name), email: account.email, phone: account.phone, accountId: account.accountId }, 'Existing');
    return { ok: true, id: account.accountId, mode: 'account', name: formatDisplayName_(account.name), status: 'capped', cap: classified.cap, message: msg };
  }

  sendDropoffNotification_({
    isNew: false, name: formatDisplayName_(account.name), accountId: account.accountId,
    phone: account.phone, email: account.email, zip: account.zip,
    seasonNote: seasonNote, categoryText: categoryText, statusLabel: 'Open', statusColor: '#3f7d5c',
    tier: classified.tier, changes: changes
  });
  fireKlaviyoDropoffEvent_({ name: formatDisplayName_(account.name), email: account.email, phone: account.phone, accountId: account.accountId }, 'Existing');
  return { ok: true, id: account.accountId, mode: 'account', name: formatDisplayName_(account.name), status: 'open', message: null };
}

/**
 * Account Change Requests (Admin dashboard): every correction a consignor
 * made at the kiosk that staff still need to key into Liberty REACT.
 */
function getAccountChangesData() {
  try {
    var sheet = getSheet_(SHEET_ACCOUNT_CHANGES);
    var values = sheet.getDataRange().getValues();
    var headers = values[0];
    var col = {};
    headers.forEach(function (h, i) { col[h] = i; });
    var changes = [];
    for (var i = 1; i < values.length; i++) {
      var row = values[i];
      if (!row[col['AccountID']]) continue;
      changes.push({
        row: i + 1,
        timestamp: toDateString_(row[col['Timestamp']]),
        accountId: String(row[col['AccountID']]),
        consignor: String(row[col['Consignor']] || ''),
        field: String(row[col['Field']] || ''),
        oldValue: String(row[col['Old Value']] || ''),
        newValue: String(row[col['New Value']] || ''),
        applied: row[col['Applied in Liberty REACT?']] === true
      });
    }
    return { changes: changes };
  } catch (e) {
    // Same reasoning as getNewSignupsData -- never surface a bare null to
    // the client for something like a missing AccountChanges tab.
    return { changes: [], error: (e && e.message) ? e.message : String(e) };
  }
}

function markAccountChangeApplied(rowNum) {
  var sheet = getSheet_(SHEET_ACCOUNT_CHANGES);
  var col = ACCOUNT_CHANGES_HEADERS.indexOf('Applied in Liberty REACT?') + 1;
  sheet.getRange(rowNum, col).setValue(true);
  return { ok: true };
}

// ---------------------------------------------------------------------------
// DAILY LIBERTY REACT CHANGE REPORT -- one email each morning listing every
// AccountChanges correction not yet marked "Applied in Liberty REACT?" and
// every NewSignups row not yet "Linked" to a real account, so staff have a
// single daily to-do list for keying the previous day's kiosk activity into
// Liberty REACT instead of having to remember to check the Admin dashboard.
// The dashboard's own Account Change Requests / New Consignor Signups
// panels are still where staff actually mark something Applied/Linked --
// this email is just the proactive nudge, and it always reflects whatever
// is unresolved *right now* rather than a frozen prior-day snapshot, so
// running it again later the same day (or from "Send change report now")
// just shows less.
// ---------------------------------------------------------------------------

// Splits a list of { timestamp } items into "fresh" (dated yesterday or
// today -- covers both the scheduled ~4am run, which naturally only has
// through yesterday, and an on-demand same-day "Send now") vs "carried"
// (older than yesterday -- still unresolved from a prior report, called out
// separately so nothing quietly falls through the cracks if a day gets
// missed).
function splitByRecency_(items, tz) {
  var yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  var yKey = Utilities.formatDate(yesterday, tz, 'yyyyMMdd');
  var fresh = [], carried = [];
  items.forEach(function (item) {
    var key = Utilities.formatDate(new Date(item.timestamp), tz, 'yyyyMMdd');
    (key >= yKey ? fresh : carried).push(item);
  });
  return { fresh: fresh, carried: carried };
}

function buildChangeReportData_() {
  var tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  var changes = getAccountChangesData().changes.filter(function (c) { return !c.applied; });
  var signups = getNewSignupsFromSheet_().filter(function (s) { return s.status !== 'Linked'; });
  return {
    changes: splitByRecency_(changes, tz),
    signups: splitByRecency_(signups, tz),
    total: changes.length + signups.length
  };
}

function changeReportRow_(cells) {
  return '<tr>' + cells.map(function (c) {
    return '<td style="padding:8px 10px; border-bottom:1px solid #e7e0d8; font-size:14px; color:#2b2320;">' + c + '</td>';
  }).join('') + '</tr>';
}

function changeReportTable_(headers, rows) {
  if (!rows.length) return '';
  var head = '<tr>' + headers.map(function (h) {
    return '<th style="text-align:left; padding:8px 10px; font-size:12px; text-transform:uppercase; letter-spacing:0.04em; color:#79716b; border-bottom:2px solid #2b2320;">' + esc_(h) + '</th>';
  }).join('') + '</tr>';
  return '<table style="width:100%; border-collapse:collapse; margin:0 0 20px;">' + head + rows.join('') + '</table>';
}

/**
 * Builds and sends the daily "what to update in Liberty REACT" email.
 * Skips sending entirely if nothing is outstanding -- an empty report every
 * morning is worse than no report. Returns { sent, total } so the manual
 * "Send change report now" menu item can tell staff what happened.
 */
function sendLibertyChangeReport_() {
  var config = getConfig_();
  var to = (config.notifyEmail || CONFIG_DEFAULTS.notifyEmail || '').toString().trim();
  var data = buildChangeReportData_();
  if (!to || data.total === 0) return { sent: false, total: data.total };

  var tz = SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone();
  var subject = 'CIMS: ' + data.total + ' update' + (data.total === 1 ? '' : 's') + ' needed in Liberty REACT';

  function correctionRow(c, isFresh) {
    return changeReportRow_([
      '<b>' + esc_(c.consignor) + '</b>' + (isFresh ? '' : ' <span style="color:#b8863b;">&middot; carried over</span>'),
      esc_(c.accountId),
      esc_(c.field),
      esc_(c.oldValue) + ' &rarr; <b>' + esc_(c.newValue) + '</b>',
      Utilities.formatDate(new Date(c.timestamp), tz, 'MMM d')
    ]);
  }
  function signupRow(s, isFresh) {
    return changeReportRow_([
      '<b>' + esc_(s.name) + '</b>' + (isFresh ? '' : ' <span style="color:#b8863b;">&middot; carried over</span>'),
      esc_(formatPhoneDisplay_(s.phone)),
      s.email ? esc_(s.email) : '<i>none</i>',
      s.zip ? esc_(s.zip) : '<i>none</i>',
      Utilities.formatDate(new Date(s.timestamp), tz, 'MMM d')
    ]);
  }

  var body = '';
  if (data.changes.fresh.length || data.changes.carried.length) {
    body += '<h2 style="margin:0 0 4px; font-size:18px; color:#2b2320;">Account corrections</h2>' +
      '<div style="font-size:13px; color:#79716b; margin:0 0 10px;">Key each of these into Liberty REACT, then mark it Applied on the Admin dashboard' +
      '&rsquo;s Account Change Requests panel.</div>';
    var rows = data.changes.fresh.map(function (c) { return correctionRow(c, true); })
      .concat(data.changes.carried.map(function (c) { return correctionRow(c, false); }));
    body += changeReportTable_(['Consignor', 'Account ID', 'Field', 'Change', 'Flagged'], rows);
  }
  if (data.signups.fresh.length || data.signups.carried.length) {
    body += '<h2 style="margin:0 0 4px; font-size:18px; color:#2b2320;">New consignor signups awaiting enrollment</h2>' +
      '<div style="font-size:13px; color:#79716b; margin:0 0 10px;">Create each of these in Liberty REACT, then Link it to the new Account ID on the Admin dashboard' +
      '&rsquo;s New Consignor Signups panel.</div>';
    var srows = data.signups.fresh.map(function (s) { return signupRow(s, true); })
      .concat(data.signups.carried.map(function (s) { return signupRow(s, false); }));
    body += changeReportTable_(['Name', 'Phone', 'Email', 'Zip', 'Signed up'], srows);
  }

  var html = '' +
    '<div style="font-family:Arial,Helvetica,sans-serif; max-width:640px;">' +
      '<div style="background:#f5f5f5; padding:28px 24px;">' +
        '<h1 style="margin:0; font-size:24px; color:#3c3c3c;">' + esc_(subject) + '</h1>' +
        '<div style="margin-top:6px; font-size:13px; color:#79716b;">Carried-over items were flagged before yesterday and are still unresolved -- worth a quick check that nothing is stuck.</div>' +
      '</div>' +
      '<div style="padding:24px;">' + body + '</div>' +
    '</div>';

  var plainFallback = subject + '. Open in an HTML-capable mail client for the full list, or check the CIMS Admin dashboard.';
  // See sendDropoffNotification_ above for why GmailApp alias-sending was
  // removed (it was causing Google's "unreviewed app" banner to print
  // onto physical labels on the Kiosk Pro iPad).
  var fromName = (config.notifyFromName || '').toString().trim();
  try {
    MailApp.sendEmail({ to: to, subject: subject, body: plainFallback, htmlBody: html, name: fromName || undefined });
  } catch (e) {
    Logger.log('sendLibertyChangeReport_ MailApp failed: ' + e);
  }
  return { sent: true, total: data.total };
}

/**
 * One-time setup: schedules sendLibertyChangeReport_ to run automatically
 * every day at ~4am (early enough for team members who come in before the
 * store opens), same trigger pattern as the medians refresh above. Safe to
 * run more than once -- removes any existing trigger first so you never end
 * up with duplicates. The report itself skips sending on a day with nothing
 * outstanding, so this is safe to leave running indefinitely without
 * generating noise.
 */
function setupChangeReportTrigger() {
  removeChangeReportTrigger();
  ScriptApp.newTrigger('sendLibertyChangeReport_')
    .timeBased()
    .atHour(4)
    .everyDays(1)
    .create();
  SpreadsheetApp.getUi().alert('Daily change report scheduled for ~4am every day. It only sends when something is actually outstanding.');
}

/**
 * Removes any scheduled sendLibertyChangeReport_ trigger(s).
 */
function removeChangeReportTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  var removed = 0;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'sendLibertyChangeReport_') {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }
  if (removed > 0) {
    SpreadsheetApp.getUi().alert('Daily change report trigger removed.');
  }
}

/**
 * CIMS Admin > "Send change report now" -- an on-demand copy of the daily
 * report, reflecting whatever is unresolved at this exact moment.
 */
function sendChangeReportNow() {
  var result = sendLibertyChangeReport_();
  var msg = !result.sent
    ? 'Nothing outstanding right now — no report sent.'
    : 'Change report sent (' + result.total + ' item' + (result.total === 1 ? '' : 's') + ').';
  SpreadsheetApp.getUi().alert(msg);
}

/**
 * Prints N labels (creates N real Totes rows with real, unique Tote IDs) for
 * an account, pending signup, or brand-new consignor. counts: {fw, ss}.
 * Order is all FW ids first, then all SS ids, so IDs stay a simple
 * contiguous block per visit. category is an optional whole-visit tag
 * ('C'/'W'/'M', any combination, e.g. "CW") -- same value on every tote
 * created here, not chosen per tote (see the season screen's Childrens/
 * Womens/Mens checkboxes).
 */
function printLabels(idKey, mode, consignorName, counts, category) {
  var fw = Math.max(0, Number(counts && counts.fw) || 0);
  var ss = Math.max(0, Number(counts && counts.ss) || 0);
  var total = fw + ss;
  if (total === 0) return { ok: false, error: 'Pick at least one label to print.' };
  if (total > 50) return { ok: false, error: 'That’s a lot for one visit — please see a staff member.' };

  var categoryNote = (category || '').toString().trim();
  var ids = reserveToteIds_(total);
  var sheet = getTotesSheet_();
  var now = new Date();
  var today = Utilities.formatDate(now, SpreadsheetApp.getActiveSpreadsheet().getSpreadsheetTimeZone(), 'MM/dd/yyyy');
  var rows = [];
  var idx = 0;
  var made = [];
  for (var i = 0; i < fw; i++, idx++) {
    rows.push([ids[idx], idKey, consignorName, 'FW', today, now, 'Printed', categoryNote]);
    made.push({ toteId: ids[idx], season: 'FW', category: categoryNote });
  }
  for (var j = 0; j < ss; j++, idx++) {
    rows.push([ids[idx], idKey, consignorName, 'SS', today, now, 'Printed', categoryNote]);
    made.push({ toteId: ids[idx], season: 'SS', category: categoryNote });
  }
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, TOTES_HEADERS.length).setValues(rows);

  return { ok: true, totes: made, firstId: ids[0], lastId: ids[ids.length - 1], count: total };
}

// ---------------------------------------------------------------------------
// EMBEDDED UI (formerly SignIn.html and Admin.html, now inlined here as
// template-literal strings so the whole project is one file, same as SMS.
// Served directly via HtmlService.createHtmlOutput() in doGet() below --
// no separate .html files needed in the Apps Script project anymore.
// ---------------------------------------------------------------------------

// Kiosk Pro Enterprise's generated JS-API bridge file (Settings > Content > JavaScript API >
// Generate API Functions File > Create kiosk_functions.js), version 11.3.1.15150 at the time this
// was pulled off the iPad. Served below via doGet(?asset=kiosk_functions) and loaded by SIGNIN_HTML
// with an absolute <script src> (see its <head>) -- Kiosk Pro's own docs call for this file to be
// referenced "by import" before any script that calls a kp_* bridge function (e.g.
// kp_BrotherPrinter_printHTMLString, wired up in triggerPrint_() below). Re-generate and re-paste
// this whole block if Kiosk Pro Enterprise is ever updated to a materially newer version.
var KIOSK_FUNCTIONS_JS = `
// Kiosk API of KP Enterprise (11.3.1.15150)

if (typeof(___kp_executeURL) !== "function")
{
	// Common JS-ObjC-Bridge API:
	function ___kp_executeURL(url)
	{
		var iframe = document.createElement("IFRAME");
		iframe.setAttribute("src", url);
		document.documentElement.appendChild(iframe);
		iframe.parentNode.removeChild(iframe);
		iframe = null;
	}
}


if (typeof(_kp_frames_special_) === "undefined")
{
	// iFrame support:
	var _kp_i_, _kp_frames_special_;
	_kp_frames_special_ = document.getElementsByTagName("iframe");
}

// Kiosk Version API:
if (typeof(kp_VersionAPI_requestFullVersion) !== "function")
{
	function kp_VersionAPI_requestFullVersion(callback)
	{
		___kp_executeURL("kioskpro://kp_VersionAPI_requestFullVersion?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_VersionAPI_requestFullVersion'] = function(callback) { kp_VersionAPI_requestFullVersion(callback); };
}

if (typeof(kp_VersionAPI_requestMainVersion) !== "function")
{
	function kp_VersionAPI_requestMainVersion(callback)
	{
		___kp_executeURL("kioskpro://kp_VersionAPI_requestMainVersion?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_VersionAPI_requestMainVersion'] = function(callback) { kp_VersionAPI_requestMainVersion(callback); };
}

if (typeof(kp_VersionAPI_requestBuildNumber) !== "function")
{
	function kp_VersionAPI_requestBuildNumber(callback)
	{
		___kp_executeURL("kioskpro://kp_VersionAPI_requestBuildNumber?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_VersionAPI_requestBuildNumber'] = function(callback) { kp_VersionAPI_requestBuildNumber(callback); };
}

if (typeof(kp_VersionAPI_requestProductName) !== "function")
{
	function kp_VersionAPI_requestProductName(callback)
	{
		___kp_executeURL("kioskpro://kp_VersionAPI_requestProductName?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_VersionAPI_requestProductName'] = function(callback) { kp_VersionAPI_requestProductName(callback); };
}

if (typeof(kp_VersionAPI_requestProductNameWithFullVersion) !== "function")
{
	function kp_VersionAPI_requestProductNameWithFullVersion(callback)
	{
		___kp_executeURL("kioskpro://kp_VersionAPI_requestProductNameWithFullVersion?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_VersionAPI_requestProductNameWithFullVersion'] = function(callback) { kp_VersionAPI_requestProductNameWithFullVersion(callback); };
}

// Kiosk Accessibility API:
if (typeof(kp_AccessibilityAPI_isVoiceOverRunning) !== "function")
{
	function kp_AccessibilityAPI_isVoiceOverRunning(callback)
	{
		___kp_executeURL("kioskpro://kp_AccessibilityAPI_isVoiceOverRunning?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_AccessibilityAPI_isVoiceOverRunning'] = function(callback) { kp_AccessibilityAPI_isVoiceOverRunning(callback); };
}

if (typeof(kp_AccessibilityAPI_enableVoiceOver) !== "function")
{
	function kp_AccessibilityAPI_enableVoiceOver(callback)
	{
		___kp_executeURL("kioskpro://kp_AccessibilityAPI_enableVoiceOver?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_AccessibilityAPI_enableVoiceOver'] = function(callback) { kp_AccessibilityAPI_enableVoiceOver(callback); };
}

if (typeof(kp_AccessibilityAPI_disableVoiceOver) !== "function")
{
	function kp_AccessibilityAPI_disableVoiceOver(callback)
	{
		___kp_executeURL("kioskpro://kp_AccessibilityAPI_disableVoiceOver?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_AccessibilityAPI_disableVoiceOver'] = function(callback) { kp_AccessibilityAPI_disableVoiceOver(callback); };
}

// Identification API:
if (typeof(kp_requestKioskId) !== "function")
{
	function kp_requestKioskId(callback)
	{
		___kp_executeURL("kioskpro://kp_requestKioskId?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_requestKioskId'] = function(callback) { kp_requestKioskId(callback); };
}

if (typeof(kp_Identification_setKioskId) !== "function")
{
	function kp_Identification_setKioskId(kioskId,callback)
	{
		___kp_executeURL("kioskpro://kp_Identification_setKioskId?" + encodeURIComponent(kioskId) + "&" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_Identification_setKioskId'] = function(kioskId,callback) { kp_Identification_setKioskId(kioskId,callback); };
}

if (typeof(kp_Identification_getGroupIDs) !== "function")
{
	function kp_Identification_getGroupIDs()
	{
		___kp_executeURL("kioskpro://kp_Identification_getGroupIDs");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_Identification_getGroupIDs'] = function() { kp_Identification_getGroupIDs(); };
}

if (typeof(kp_Identification_requestDeviceContextInfo) !== "function")
{
	function kp_Identification_requestDeviceContextInfo(callback)
	{
		___kp_executeURL("kioskpro://kp_Identification_requestDeviceContextInfo?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_Identification_requestDeviceContextInfo'] = function(callback) { kp_Identification_requestDeviceContextInfo(callback); };
}

// File API:
if (typeof(writeToFile) !== "function")
{
	function writeToFile(fileName,data,callback)
	{
		___kp_executeURL("kioskpro://writeToFile?" + encodeURIComponent(fileName) + "&" + encodeURIComponent(data) + "&" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['writeToFile'] = function(fileName,data,callback) { writeToFile(fileName,data,callback); };
}

if (typeof(fileExists) !== "function")
{
	function fileExists(filename,callback)
	{
		___kp_executeURL("kioskpro://fileExists?" + encodeURIComponent(filename) + "&" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['fileExists'] = function(filename,callback) { fileExists(filename,callback); };
}

if (typeof(deleteFile) !== "function")
{
	function deleteFile(filename,callback)
	{
		___kp_executeURL("kioskpro://deleteFile?" + encodeURIComponent(filename) + "&" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['deleteFile'] = function(filename,callback) { deleteFile(filename,callback); };
}

if (typeof(kp_FileAPI_renameFile) !== "function")
{
	function kp_FileAPI_renameFile(oldFilename,newFilename,callback)
	{
		___kp_executeURL("kioskpro://kp_FileAPI_renameFile?" + encodeURIComponent(oldFilename) + "&" + encodeURIComponent(newFilename) + "&" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_FileAPI_renameFile'] = function(oldFilename,newFilename,callback) { kp_FileAPI_renameFile(oldFilename,newFilename,callback); };
}

if (typeof(kp_FileAPI_base64FromFile) !== "function")
{
	function kp_FileAPI_base64FromFile(filename,callback)
	{
		___kp_executeURL("kioskpro://kp_FileAPI_base64FromFile?" + encodeURIComponent(filename) + "&" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_FileAPI_base64FromFile'] = function(filename,callback) { kp_FileAPI_base64FromFile(filename,callback); };
}

// Photo & Video API:
if (typeof(saveScreenToPng) !== "function")
{
	function saveScreenToPng(filename,x,y,width,height,callback)
	{
		___kp_executeURL("kioskpro://saveScreenToPng?" + encodeURIComponent(filename) + "&" + encodeURIComponent(x) + "&" + encodeURIComponent(y) + "&" + encodeURIComponent(width) + "&" + encodeURIComponent(height) + "&" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['saveScreenToPng'] = function(filename,x,y,width,height,callback) { saveScreenToPng(filename,x,y,width,height,callback); };
}

if (typeof(kp_PhotoVideo_setCameraType) !== "function")
{
	function kp_PhotoVideo_setCameraType(shouldUseFrontCamera,callback)
	{
		___kp_executeURL("kioskpro://kp_PhotoVideo_setCameraType?" + encodeURIComponent(shouldUseFrontCamera) + "&" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_PhotoVideo_setCameraType'] = function(shouldUseFrontCamera,callback) { kp_PhotoVideo_setCameraType(shouldUseFrontCamera,callback); };
}

if (typeof(kp_PhotoVideo_getCameraType) !== "function")
{
	function kp_PhotoVideo_getCameraType(callback)
	{
		___kp_executeURL("kioskpro://kp_PhotoVideo_getCameraType?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_PhotoVideo_getCameraType'] = function(callback) { kp_PhotoVideo_getCameraType(callback); };
}

if (typeof(kp_PhotoVideo_setFlashMode) !== "function")
{
	function kp_PhotoVideo_setFlashMode(flashMode)
	{
		___kp_executeURL("kioskpro://kp_PhotoVideo_setFlashMode?" + encodeURIComponent(flashMode));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_PhotoVideo_setFlashMode'] = function(flashMode) { kp_PhotoVideo_setFlashMode(flashMode); };
}

if (typeof(kp_PhotoVideo_getFlashMode) !== "function")
{
	function kp_PhotoVideo_getFlashMode(callback)
	{
		___kp_executeURL("kioskpro://kp_PhotoVideo_getFlashMode?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_PhotoVideo_getFlashMode'] = function(callback) { kp_PhotoVideo_getFlashMode(callback); };
}

if (typeof(takePhotoToFile) !== "function")
{
	function takePhotoToFile(filename,callback)
	{
		___kp_executeURL("kioskpro://takePhotoToFile?" + encodeURIComponent(filename) + "&" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['takePhotoToFile'] = function(filename,callback) { takePhotoToFile(filename,callback); };
}

if (typeof(kp_PhotoVideo_takePhotoToFileResize) !== "function")
{
	function kp_PhotoVideo_takePhotoToFileResize(filename,callback,photoWidthPxls,photoHeightPxls)
	{
		___kp_executeURL("kioskpro://kp_PhotoVideo_takePhotoToFileResize?" + encodeURIComponent(filename) + "&" + encodeURIComponent(callback) + "&" + encodeURIComponent(photoWidthPxls) + "&" + encodeURIComponent(photoHeightPxls));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_PhotoVideo_takePhotoToFileResize'] = function(filename,callback,photoWidthPxls,photoHeightPxls) { kp_PhotoVideo_takePhotoToFileResize(filename,callback,photoWidthPxls,photoHeightPxls); };
}

if (typeof(takePhotoWithCountdownToFile) !== "function")
{
	function takePhotoWithCountdownToFile(filename,callback,counter,message,showingTime)
	{
		___kp_executeURL("kioskpro://takePhotoWithCountdownToFile?" + encodeURIComponent(filename) + "&" + encodeURIComponent(callback) + "&" + encodeURIComponent(counter) + "&" + encodeURIComponent(message) + "&" + encodeURIComponent(showingTime));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['takePhotoWithCountdownToFile'] = function(filename,callback,counter,message,showingTime) { takePhotoWithCountdownToFile(filename,callback,counter,message,showingTime); };
}

if (typeof(kp_PhotoVideo_takePhotoWithCountdownToFileResize) !== "function")
{
	function kp_PhotoVideo_takePhotoWithCountdownToFileResize(filename,callback,counter,message,showingTime,photoWidthPxls,photoHeightPxls)
	{
		___kp_executeURL("kioskpro://kp_PhotoVideo_takePhotoWithCountdownToFileResize?" + encodeURIComponent(filename) + "&" + encodeURIComponent(callback) + "&" + encodeURIComponent(counter) + "&" + encodeURIComponent(message) + "&" + encodeURIComponent(showingTime) + "&" + encodeURIComponent(photoWidthPxls) + "&" + encodeURIComponent(photoHeightPxls));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_PhotoVideo_takePhotoWithCountdownToFileResize'] = function(filename,callback,counter,message,showingTime,photoWidthPxls,photoHeightPxls) { kp_PhotoVideo_takePhotoWithCountdownToFileResize(filename,callback,counter,message,showingTime,photoWidthPxls,photoHeightPxls); };
}

if (typeof(takeVideoToFile) !== "function")
{
	function takeVideoToFile(filename,callback)
	{
		___kp_executeURL("kioskpro://takeVideoToFile?" + encodeURIComponent(filename) + "&" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['takeVideoToFile'] = function(filename,callback) { takeVideoToFile(filename,callback); };
}

if (typeof(kp_PhotoVideo_takeVideoWithCountdown) !== "function")
{
	function kp_PhotoVideo_takeVideoWithCountdown(filename,callback,intervalBeforeStart,recordingTime,showRecordingCountdownTimer,successMessage)
	{
		___kp_executeURL("kioskpro://kp_PhotoVideo_takeVideoWithCountdown?" + encodeURIComponent(filename) + "&" + encodeURIComponent(callback) + "&" + encodeURIComponent(intervalBeforeStart) + "&" + encodeURIComponent(recordingTime) + "&" + encodeURIComponent(showRecordingCountdownTimer) + "&" + encodeURIComponent(successMessage));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_PhotoVideo_takeVideoWithCountdown'] = function(filename,callback,intervalBeforeStart,recordingTime,showRecordingCountdownTimer,successMessage) { kp_PhotoVideo_takeVideoWithCountdown(filename,callback,intervalBeforeStart,recordingTime,showRecordingCountdownTimer,successMessage); };
}

if (typeof(kp_PhotoVideo_takeVideoWithEndingByTouchingScreen) !== "function")
{
	function kp_PhotoVideo_takeVideoWithEndingByTouchingScreen(filename,callback,intervalBeforeStart,maxRecordingTime,messageDuringRecording,showRecordingTimer,successMessage)
	{
		___kp_executeURL("kioskpro://kp_PhotoVideo_takeVideoWithEndingByTouchingScreen?" + encodeURIComponent(filename) + "&" + encodeURIComponent(callback) + "&" + encodeURIComponent(intervalBeforeStart) + "&" + encodeURIComponent(maxRecordingTime) + "&" + encodeURIComponent(messageDuringRecording) + "&" + encodeURIComponent(showRecordingTimer) + "&" + encodeURIComponent(successMessage));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_PhotoVideo_takeVideoWithEndingByTouchingScreen'] = function(filename,callback,intervalBeforeStart,maxRecordingTime,messageDuringRecording,showRecordingTimer,successMessage) { kp_PhotoVideo_takeVideoWithEndingByTouchingScreen(filename,callback,intervalBeforeStart,maxRecordingTime,messageDuringRecording,showRecordingTimer,successMessage); };
}

if (typeof(kp_PhotoVideo_base64FromScaledPhoto) !== "function")
{
	function kp_PhotoVideo_base64FromScaledPhoto(filename,photoDesiredWidthPxls,photoHeightPxls,callback)
	{
		___kp_executeURL("kioskpro://kp_PhotoVideo_base64FromScaledPhoto?" + encodeURIComponent(filename) + "&" + encodeURIComponent(photoDesiredWidthPxls) + "&" + encodeURIComponent(photoHeightPxls) + "&" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_PhotoVideo_base64FromScaledPhoto'] = function(filename,photoDesiredWidthPxls,photoHeightPxls,callback) { kp_PhotoVideo_base64FromScaledPhoto(filename,photoDesiredWidthPxls,photoHeightPxls,callback); };
}

if (typeof(kp_PhotoVideo_startNewCaptureFlow) !== "function")
{
	function kp_PhotoVideo_startNewCaptureFlow(captureFlowTaskJSONString,parsingJSONReportCallback,workingReportCallback)
	{
		___kp_executeURL("kioskpro://kp_PhotoVideo_startNewCaptureFlow?" + encodeURIComponent(captureFlowTaskJSONString) + "&" + encodeURIComponent(parsingJSONReportCallback) + "&" + encodeURIComponent(workingReportCallback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_PhotoVideo_startNewCaptureFlow'] = function(captureFlowTaskJSONString,parsingJSONReportCallback,workingReportCallback) { kp_PhotoVideo_startNewCaptureFlow(captureFlowTaskJSONString,parsingJSONReportCallback,workingReportCallback); };
}

if (typeof(kp_PhotoVideo_cancelCaptureFlow) !== "function")
{
	function kp_PhotoVideo_cancelCaptureFlow(callback)
	{
		___kp_executeURL("kioskpro://kp_PhotoVideo_cancelCaptureFlow?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_PhotoVideo_cancelCaptureFlow'] = function(callback) { kp_PhotoVideo_cancelCaptureFlow(callback); };
}

if (typeof(kp_PhotoVideo_isCaptureFlowInProgress) !== "function")
{
	function kp_PhotoVideo_isCaptureFlowInProgress(callback)
	{
		___kp_executeURL("kioskpro://kp_PhotoVideo_isCaptureFlowInProgress?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_PhotoVideo_isCaptureFlowInProgress'] = function(callback) { kp_PhotoVideo_isCaptureFlowInProgress(callback); };
}

// iDynamo Card Reader API::
if (typeof(kp_iDynamoCardReader_requestDeviceType) !== "function")
{
	function kp_iDynamoCardReader_requestDeviceType()
	{
		___kp_executeURL("kioskpro://kp_iDynamoCardReader_requestDeviceType");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_iDynamoCardReader_requestDeviceType'] = function() { kp_iDynamoCardReader_requestDeviceType(); };
}

if (typeof(kp_iDynamoCardReader_requestStateOfConnection) !== "function")
{
	function kp_iDynamoCardReader_requestStateOfConnection()
	{
		___kp_executeURL("kioskpro://kp_iDynamoCardReader_requestStateOfConnection");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_iDynamoCardReader_requestStateOfConnection'] = function() { kp_iDynamoCardReader_requestStateOfConnection(); };
}

if (typeof(kp_iDynamoCardReader_requestSwipe) !== "function")
{
	function kp_iDynamoCardReader_requestSwipe(swipeInfo)
	{
		___kp_executeURL("kioskpro://kp_iDynamoCardReader_requestSwipe?" + encodeURIComponent(swipeInfo));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_iDynamoCardReader_requestSwipe'] = function(swipeInfo) { kp_iDynamoCardReader_requestSwipe(swipeInfo); };
}

if (typeof(kp_iDynamoCardReader_cancelSwipe) !== "function")
{
	function kp_iDynamoCardReader_cancelSwipe()
	{
		___kp_executeURL("kioskpro://kp_iDynamoCardReader_cancelSwipe");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_iDynamoCardReader_cancelSwipe'] = function() { kp_iDynamoCardReader_cancelSwipe(); };
}

if (typeof(kp_iDynamoCardReader_mps_doCreditSaleOperation) !== "function")
{
	function kp_iDynamoCardReader_mps_doCreditSaleOperation(amount,invoiceNumber)
	{
		___kp_executeURL("kioskpro://kp_iDynamoCardReader_mps_doCreditSaleOperation?" + encodeURIComponent(amount) + "&" + encodeURIComponent(invoiceNumber));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_iDynamoCardReader_mps_doCreditSaleOperation'] = function(amount,invoiceNumber) { kp_iDynamoCardReader_mps_doCreditSaleOperation(amount,invoiceNumber); };
}

// External Screen API:
if (typeof(kp_ExternalScreen_requestStateOfConnection) !== "function")
{
	function kp_ExternalScreen_requestStateOfConnection()
	{
		___kp_executeURL("kioskpro://kp_ExternalScreen_requestStateOfConnection");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_ExternalScreen_requestStateOfConnection'] = function() { kp_ExternalScreen_requestStateOfConnection(); };
}

if (typeof(kp_ExternalScreen_requestProperties) !== "function")
{
	function kp_ExternalScreen_requestProperties(callback)
	{
		___kp_executeURL("kioskpro://kp_ExternalScreen_requestProperties?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_ExternalScreen_requestProperties'] = function(callback) { kp_ExternalScreen_requestProperties(callback); };
}

if (typeof(kp_ExternalScreen_setScreenMode) !== "function")
{
	function kp_ExternalScreen_setScreenMode(width,height,callback)
	{
		___kp_executeURL("kioskpro://kp_ExternalScreen_setScreenMode?" + encodeURIComponent(width) + "&" + encodeURIComponent(height) + "&" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_ExternalScreen_setScreenMode'] = function(width,height,callback) { kp_ExternalScreen_setScreenMode(width,height,callback); };
}

if (typeof(kp_ExternalScreen_setOverscanCompensationMode) !== "function")
{
	function kp_ExternalScreen_setOverscanCompensationMode(mode,callback)
	{
		___kp_executeURL("kioskpro://kp_ExternalScreen_setOverscanCompensationMode?" + encodeURIComponent(mode) + "&" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_ExternalScreen_setOverscanCompensationMode'] = function(mode,callback) { kp_ExternalScreen_setOverscanCompensationMode(mode,callback); };
}

if (typeof(kp_ExternalScreen_connectToScreen) !== "function")
{
	function kp_ExternalScreen_connectToScreen()
	{
		___kp_executeURL("kioskpro://kp_ExternalScreen_connectToScreen");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_ExternalScreen_connectToScreen'] = function() { kp_ExternalScreen_connectToScreen(); };
}

if (typeof(kp_ExternalScreen_disconnectFromScreen) !== "function")
{
	function kp_ExternalScreen_disconnectFromScreen()
	{
		___kp_executeURL("kioskpro://kp_ExternalScreen_disconnectFromScreen");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_ExternalScreen_disconnectFromScreen'] = function() { kp_ExternalScreen_disconnectFromScreen(); };
}

if (typeof(kp_ExternalScreen_openDocument) !== "function")
{
	function kp_ExternalScreen_openDocument(filePath,callback)
	{
		___kp_executeURL("kioskpro://kp_ExternalScreen_openDocument?" + encodeURIComponent(filePath) + "&" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_ExternalScreen_openDocument'] = function(filePath,callback) { kp_ExternalScreen_openDocument(filePath,callback); };
}

if (typeof(kp_ExternalScreen_openDocumentEx) !== "function")
{
	function kp_ExternalScreen_openDocumentEx(filePath,scalePageToFit,callback)
	{
		___kp_executeURL("kioskpro://kp_ExternalScreen_openDocumentEx?" + encodeURIComponent(filePath) + "&" + encodeURIComponent(scalePageToFit) + "&" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_ExternalScreen_openDocumentEx'] = function(filePath,scalePageToFit,callback) { kp_ExternalScreen_openDocumentEx(filePath,scalePageToFit,callback); };
}

if (typeof(kp_ExternalScreen_setBrowserBgColor) !== "function")
{
	function kp_ExternalScreen_setBrowserBgColor(bgColor,callback)
	{
		___kp_executeURL("kioskpro://kp_ExternalScreen_setBrowserBgColor?" + encodeURIComponent(bgColor) + "&" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_ExternalScreen_setBrowserBgColor'] = function(bgColor,callback) { kp_ExternalScreen_setBrowserBgColor(bgColor,callback); };
}

if (typeof(kp_ExternalScreen_getBrowserBgColor) !== "function")
{
	function kp_ExternalScreen_getBrowserBgColor(callback)
	{
		___kp_executeURL("kioskpro://kp_ExternalScreen_getBrowserBgColor?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_ExternalScreen_getBrowserBgColor'] = function(callback) { kp_ExternalScreen_getBrowserBgColor(callback); };
}

if (typeof(kp_ExternalScreen_doJScript) !== "function")
{
	function kp_ExternalScreen_doJScript(script)
	{
		___kp_executeURL("kioskpro://kp_ExternalScreen_doJScript?" + encodeURIComponent(script));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_ExternalScreen_doJScript'] = function(script) { kp_ExternalScreen_doJScript(script); };
}

if (typeof(kp_ExternalScreen_setPlayVideoParams) !== "function")
{
	function kp_ExternalScreen_setPlayVideoParams(fadeDuration,fadeBgColor,callback)
	{
		___kp_executeURL("kioskpro://kp_ExternalScreen_setPlayVideoParams?" + encodeURIComponent(fadeDuration) + "&" + encodeURIComponent(fadeBgColor) + "&" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_ExternalScreen_setPlayVideoParams'] = function(fadeDuration,fadeBgColor,callback) { kp_ExternalScreen_setPlayVideoParams(fadeDuration,fadeBgColor,callback); };
}

if (typeof(kp_ExternalScreen_setPlayVideoParamsEx) !== "function")
{
	function kp_ExternalScreen_setPlayVideoParamsEx(paramsDic,callback)
	{
		___kp_executeURL("kioskpro://kp_ExternalScreen_setPlayVideoParamsEx?" + encodeURIComponent(paramsDic) + "&" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_ExternalScreen_setPlayVideoParamsEx'] = function(paramsDic,callback) { kp_ExternalScreen_setPlayVideoParamsEx(paramsDic,callback); };
}

if (typeof(kp_ExternalScreen_getPlayVideoParams) !== "function")
{
	function kp_ExternalScreen_getPlayVideoParams(callback)
	{
		___kp_executeURL("kioskpro://kp_ExternalScreen_getPlayVideoParams?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_ExternalScreen_getPlayVideoParams'] = function(callback) { kp_ExternalScreen_getPlayVideoParams(callback); };
}

if (typeof(kp_ExternalScreen_getPlayVideoParamsEx) !== "function")
{
	function kp_ExternalScreen_getPlayVideoParamsEx(callback)
	{
		___kp_executeURL("kioskpro://kp_ExternalScreen_getPlayVideoParamsEx?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_ExternalScreen_getPlayVideoParamsEx'] = function(callback) { kp_ExternalScreen_getPlayVideoParamsEx(callback); };
}

if (typeof(kp_ExternalScreen_playVideo) !== "function")
{
	function kp_ExternalScreen_playVideo(filePath,loop,callback)
	{
		___kp_executeURL("kioskpro://kp_ExternalScreen_playVideo?" + encodeURIComponent(filePath) + "&" + encodeURIComponent(loop) + "&" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_ExternalScreen_playVideo'] = function(filePath,loop,callback) { kp_ExternalScreen_playVideo(filePath,loop,callback); };
}

if (typeof(kp_ExternalScreen_getCurrentVideoPlaybackState) !== "function")
{
	function kp_ExternalScreen_getCurrentVideoPlaybackState(callback)
	{
		___kp_executeURL("kioskpro://kp_ExternalScreen_getCurrentVideoPlaybackState?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_ExternalScreen_getCurrentVideoPlaybackState'] = function(callback) { kp_ExternalScreen_getCurrentVideoPlaybackState(callback); };
}

if (typeof(kp_ExternalScreen_stopVideo) !== "function")
{
	function kp_ExternalScreen_stopVideo()
	{
		___kp_executeURL("kioskpro://kp_ExternalScreen_stopVideo");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_ExternalScreen_stopVideo'] = function() { kp_ExternalScreen_stopVideo(); };
}

if (typeof(kp_ExternalScreen_stopVideoWithFading) !== "function")
{
	function kp_ExternalScreen_stopVideoWithFading(shouldFadeOut)
	{
		___kp_executeURL("kioskpro://kp_ExternalScreen_stopVideoWithFading?" + encodeURIComponent(shouldFadeOut));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_ExternalScreen_stopVideoWithFading'] = function(shouldFadeOut) { kp_ExternalScreen_stopVideoWithFading(shouldFadeOut); };
}

if (typeof(kp_ExternalScreen_pauseVideo) !== "function")
{
	function kp_ExternalScreen_pauseVideo()
	{
		___kp_executeURL("kioskpro://kp_ExternalScreen_pauseVideo");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_ExternalScreen_pauseVideo'] = function() { kp_ExternalScreen_pauseVideo(); };
}

if (typeof(kp_ExternalScreen_resumeVideo) !== "function")
{
	function kp_ExternalScreen_resumeVideo()
	{
		___kp_executeURL("kioskpro://kp_ExternalScreen_resumeVideo");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_ExternalScreen_resumeVideo'] = function() { kp_ExternalScreen_resumeVideo(); };
}

if (typeof(kp_ExternalScreen_changeCurrentTimeOfVideo) !== "function")
{
	function kp_ExternalScreen_changeCurrentTimeOfVideo(time)
	{
		___kp_executeURL("kioskpro://kp_ExternalScreen_changeCurrentTimeOfVideo?" + encodeURIComponent(time));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_ExternalScreen_changeCurrentTimeOfVideo'] = function(time) { kp_ExternalScreen_changeCurrentTimeOfVideo(time); };
}

if (typeof(kp_ExternalScreen_requestNumberOfPdfPages) !== "function")
{
	function kp_ExternalScreen_requestNumberOfPdfPages(callback)
	{
		___kp_executeURL("kioskpro://kp_ExternalScreen_requestNumberOfPdfPages?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_ExternalScreen_requestNumberOfPdfPages'] = function(callback) { kp_ExternalScreen_requestNumberOfPdfPages(callback); };
}

if (typeof(kp_ExternalScreen_showPdfPage) !== "function")
{
	function kp_ExternalScreen_showPdfPage(pageNumber,callback)
	{
		___kp_executeURL("kioskpro://kp_ExternalScreen_showPdfPage?" + encodeURIComponent(pageNumber) + "&" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_ExternalScreen_showPdfPage'] = function(pageNumber,callback) { kp_ExternalScreen_showPdfPage(pageNumber,callback); };
}

if (typeof(kp_ExternalScreen_requestNumberOfCurrentPdfPage) !== "function")
{
	function kp_ExternalScreen_requestNumberOfCurrentPdfPage(callback)
	{
		___kp_executeURL("kioskpro://kp_ExternalScreen_requestNumberOfCurrentPdfPage?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_ExternalScreen_requestNumberOfCurrentPdfPage'] = function(callback) { kp_ExternalScreen_requestNumberOfCurrentPdfPage(callback); };
}

if (typeof(kp_ExternalScreen_showImage) !== "function")
{
	function kp_ExternalScreen_showImage(filePath,contentMode,callback)
	{
		___kp_executeURL("kioskpro://kp_ExternalScreen_showImage?" + encodeURIComponent(filePath) + "&" + encodeURIComponent(contentMode) + "&" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_ExternalScreen_showImage'] = function(filePath,contentMode,callback) { kp_ExternalScreen_showImage(filePath,contentMode,callback); };
}

// iMag2 Card Reader API:
if (typeof(getReaderData) !== "function")
{
	function getReaderData(callback)
	{
		___kp_executeURL("kioskpro://getReaderData?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['getReaderData'] = function(callback) { getReaderData(callback); };
}

if (typeof(kp_iMagCardReader_requestSwipe) !== "function")
{
	function kp_iMagCardReader_requestSwipe(swipeInfo)
	{
		___kp_executeURL("kioskpro://kp_iMagCardReader_requestSwipe?" + encodeURIComponent(swipeInfo));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_iMagCardReader_requestSwipe'] = function(swipeInfo) { kp_iMagCardReader_requestSwipe(swipeInfo); };
}

if (typeof(kp_iMagCardReader_cancelSwipe) !== "function")
{
	function kp_iMagCardReader_cancelSwipe()
	{
		___kp_executeURL("kioskpro://kp_iMagCardReader_cancelSwipe");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_iMagCardReader_cancelSwipe'] = function() { kp_iMagCardReader_cancelSwipe(); };
}

if (typeof(kp_iMagCardReader_requestStateOfSupporting) !== "function")
{
	function kp_iMagCardReader_requestStateOfSupporting()
	{
		___kp_executeURL("kioskpro://kp_iMagCardReader_requestStateOfSupporting");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_iMagCardReader_requestStateOfSupporting'] = function() { kp_iMagCardReader_requestStateOfSupporting(); };
}

if (typeof(kp_iMagCardReader_requestStateOfConnection) !== "function")
{
	function kp_iMagCardReader_requestStateOfConnection()
	{
		___kp_executeURL("kioskpro://kp_iMagCardReader_requestStateOfConnection");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_iMagCardReader_requestStateOfConnection'] = function() { kp_iMagCardReader_requestStateOfConnection(); };
}

// Memory & Privacy API:
if (typeof(kp_Browser_clearCookies) !== "function")
{
	function kp_Browser_clearCookies()
	{
		___kp_executeURL("kioskpro://kp_Browser_clearCookies");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_Browser_clearCookies'] = function() { kp_Browser_clearCookies(); };
}

if (typeof(kp_Browser_clearCache) !== "function")
{
	function kp_Browser_clearCache()
	{
		___kp_executeURL("kioskpro://kp_Browser_clearCache");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_Browser_clearCache'] = function() { kp_Browser_clearCache(); };
}

if (typeof(kp_Browser_clearLocalStorage) !== "function")
{
	function kp_Browser_clearLocalStorage()
	{
		___kp_executeURL("kioskpro://kp_Browser_clearLocalStorage");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_Browser_clearLocalStorage'] = function() { kp_Browser_clearLocalStorage(); };
}

// ZBar Scanner API:
if (typeof(kp_ZBarScanner_startScan) !== "function")
{
	function kp_ZBarScanner_startScan()
	{
		___kp_executeURL("kioskpro://kp_ZBarScanner_startScan");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_ZBarScanner_startScan'] = function() { kp_ZBarScanner_startScan(); };
}

if (typeof(kp_ZBarScanner_startScanWithConfig) !== "function")
{
	function kp_ZBarScanner_startScanWithConfig(configJSON)
	{
		___kp_executeURL("kioskpro://kp_ZBarScanner_startScanWithConfig?" + encodeURIComponent(configJSON));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_ZBarScanner_startScanWithConfig'] = function(configJSON) { kp_ZBarScanner_startScanWithConfig(configJSON); };
}

if (typeof(kp_ZBarScanner_cancelScan) !== "function")
{
	function kp_ZBarScanner_cancelScan()
	{
		___kp_executeURL("kioskpro://kp_ZBarScanner_cancelScan");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_ZBarScanner_cancelScan'] = function() { kp_ZBarScanner_cancelScan(); };
}

if (typeof(kp_ZBarScanner_requestStateOfSupporting) !== "function")
{
	function kp_ZBarScanner_requestStateOfSupporting()
	{
		___kp_executeURL("kioskpro://kp_ZBarScanner_requestStateOfSupporting");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_ZBarScanner_requestStateOfSupporting'] = function() { kp_ZBarScanner_requestStateOfSupporting(); };
}

// MPS API:
if (typeof(kp_MercuryPaySystem_generateFullReportToFile) !== "function")
{
	function kp_MercuryPaySystem_generateFullReportToFile(fileName,callback)
	{
		___kp_executeURL("kioskpro://kp_MercuryPaySystem_generateFullReportToFile?" + encodeURIComponent(fileName) + "&" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_MercuryPaySystem_generateFullReportToFile'] = function(fileName,callback) { kp_MercuryPaySystem_generateFullReportToFile(fileName,callback); };
}

if (typeof(kp_MercuryPaySystem_getSettings) !== "function")
{
	function kp_MercuryPaySystem_getSettings()
	{
		___kp_executeURL("kioskpro://kp_MercuryPaySystem_getSettings");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_MercuryPaySystem_getSettings'] = function() { kp_MercuryPaySystem_getSettings(); };
}

if (typeof(kp_MercuryPaySystem_requestLastRegisteredOperation) !== "function")
{
	function kp_MercuryPaySystem_requestLastRegisteredOperation()
	{
		___kp_executeURL("kioskpro://kp_MercuryPaySystem_requestLastRegisteredOperation");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_MercuryPaySystem_requestLastRegisteredOperation'] = function() { kp_MercuryPaySystem_requestLastRegisteredOperation(); };
}

// iBeacon API:
if (typeof(kp_iBeaconAPI_startMonitoringWithPath2SchemeFile) !== "function")
{
	function kp_iBeaconAPI_startMonitoringWithPath2SchemeFile(path)
	{
		___kp_executeURL("kioskpro://kp_iBeaconAPI_startMonitoringWithPath2SchemeFile?" + encodeURIComponent(path));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_iBeaconAPI_startMonitoringWithPath2SchemeFile'] = function(path) { kp_iBeaconAPI_startMonitoringWithPath2SchemeFile(path); };
}

if (typeof(kp_iBeaconAPI_stopMonitoring) !== "function")
{
	function kp_iBeaconAPI_stopMonitoring(schemeStr)
	{
		___kp_executeURL("kioskpro://kp_iBeaconAPI_stopMonitoring?" + encodeURIComponent(schemeStr));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_iBeaconAPI_stopMonitoring'] = function(schemeStr) { kp_iBeaconAPI_stopMonitoring(schemeStr); };
}

if (typeof(kp_iBeaconAPI_startAdvertising) !== "function")
{
	function kp_iBeaconAPI_startAdvertising()
	{
		___kp_executeURL("kioskpro://kp_iBeaconAPI_startAdvertising");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_iBeaconAPI_startAdvertising'] = function() { kp_iBeaconAPI_startAdvertising(); };
}

if (typeof(kp_iBeaconAPI_stopAdvertising) !== "function")
{
	function kp_iBeaconAPI_stopAdvertising()
	{
		___kp_executeURL("kioskpro://kp_iBeaconAPI_stopAdvertising");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_iBeaconAPI_stopAdvertising'] = function() { kp_iBeaconAPI_stopAdvertising(); };
}

// Bluetooth BarCode Scanner API:
if (typeof(kp_BluetoothBarcodeScanner_requestAcceptingData) !== "function")
{
	function kp_BluetoothBarcodeScanner_requestAcceptingData(alert_title,alert_message,wait_in_seconds)
	{
		___kp_executeURL("kioskpro://kp_BluetoothBarcodeScanner_requestAcceptingData?" + encodeURIComponent(alert_title) + "&" + encodeURIComponent(alert_message) + "&" + encodeURIComponent(wait_in_seconds));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_BluetoothBarcodeScanner_requestAcceptingData'] = function(alert_title,alert_message,wait_in_seconds) { kp_BluetoothBarcodeScanner_requestAcceptingData(alert_title,alert_message,wait_in_seconds); };
}

if (typeof(kp_BluetoothBarcodeScanner_requestSilentAcceptingData) !== "function")
{
	function kp_BluetoothBarcodeScanner_requestSilentAcceptingData()
	{
		___kp_executeURL("kioskpro://kp_BluetoothBarcodeScanner_requestSilentAcceptingData");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_BluetoothBarcodeScanner_requestSilentAcceptingData'] = function() { kp_BluetoothBarcodeScanner_requestSilentAcceptingData(); };
}

if (typeof(kp_BluetoothBarcodeScanner_requestStateOfSupporting) !== "function")
{
	function kp_BluetoothBarcodeScanner_requestStateOfSupporting()
	{
		___kp_executeURL("kioskpro://kp_BluetoothBarcodeScanner_requestStateOfSupporting");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_BluetoothBarcodeScanner_requestStateOfSupporting'] = function() { kp_BluetoothBarcodeScanner_requestStateOfSupporting(); };
}

// Dropbox API:
if (typeof(kp_DBXSyncManager_sync) !== "function")
{
	function kp_DBXSyncManager_sync()
	{
		___kp_executeURL("kioskpro://kp_DBXSyncManager_sync");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_DBXSyncManager_sync'] = function() { kp_DBXSyncManager_sync(); };
}

if (typeof(kp_DBXSyncManager_stopObservingChangesOfType) !== "function")
{
	function kp_DBXSyncManager_stopObservingChangesOfType(typeOfChanges)
	{
		___kp_executeURL("kioskpro://kp_DBXSyncManager_stopObservingChangesOfType?" + encodeURIComponent(typeOfChanges));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_DBXSyncManager_stopObservingChangesOfType'] = function(typeOfChanges) { kp_DBXSyncManager_stopObservingChangesOfType(typeOfChanges); };
}

if (typeof(kp_DBXSyncManager_startObservingChangesOfType) !== "function")
{
	function kp_DBXSyncManager_startObservingChangesOfType(typeOfChanges)
	{
		___kp_executeURL("kioskpro://kp_DBXSyncManager_startObservingChangesOfType?" + encodeURIComponent(typeOfChanges));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_DBXSyncManager_startObservingChangesOfType'] = function(typeOfChanges) { kp_DBXSyncManager_startObservingChangesOfType(typeOfChanges); };
}

if (typeof(kp_DBXSyncManager_getTypeOfObservingChanges) !== "function")
{
	function kp_DBXSyncManager_getTypeOfObservingChanges(callback)
	{
		___kp_executeURL("kioskpro://kp_DBXSyncManager_getTypeOfObservingChanges?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_DBXSyncManager_getTypeOfObservingChanges'] = function(callback) { kp_DBXSyncManager_getTypeOfObservingChanges(callback); };
}

// Audio Player API:
if (typeof(kp_AudioPlayer_play) !== "function")
{
	function kp_AudioPlayer_play(filePath,atTime,withVolume,repeat)
	{
		___kp_executeURL("kioskpro://kp_AudioPlayer_play?" + encodeURIComponent(filePath) + "&" + encodeURIComponent(atTime) + "&" + encodeURIComponent(withVolume) + "&" + encodeURIComponent(repeat));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_AudioPlayer_play'] = function(filePath,atTime,withVolume,repeat) { kp_AudioPlayer_play(filePath,atTime,withVolume,repeat); };
}

if (typeof(kp_AudioPlayer_stop) !== "function")
{
	function kp_AudioPlayer_stop()
	{
		___kp_executeURL("kioskpro://kp_AudioPlayer_stop");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_AudioPlayer_stop'] = function() { kp_AudioPlayer_stop(); };
}

if (typeof(kp_AudioPlayer_pause) !== "function")
{
	function kp_AudioPlayer_pause()
	{
		___kp_executeURL("kioskpro://kp_AudioPlayer_pause");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_AudioPlayer_pause'] = function() { kp_AudioPlayer_pause(); };
}

if (typeof(kp_AudioPlayer_resume) !== "function")
{
	function kp_AudioPlayer_resume()
	{
		___kp_executeURL("kioskpro://kp_AudioPlayer_resume");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_AudioPlayer_resume'] = function() { kp_AudioPlayer_resume(); };
}

if (typeof(kp_AudioPlayer_changeVolume) !== "function")
{
	function kp_AudioPlayer_changeVolume(volume)
	{
		___kp_executeURL("kioskpro://kp_AudioPlayer_changeVolume?" + encodeURIComponent(volume));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_AudioPlayer_changeVolume'] = function(volume) { kp_AudioPlayer_changeVolume(volume); };
}

if (typeof(kp_AudioPlayer_changeCurrentTime) !== "function")
{
	function kp_AudioPlayer_changeCurrentTime(currentTime)
	{
		___kp_executeURL("kioskpro://kp_AudioPlayer_changeCurrentTime?" + encodeURIComponent(currentTime));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_AudioPlayer_changeCurrentTime'] = function(currentTime) { kp_AudioPlayer_changeCurrentTime(currentTime); };
}

// AirPrinter API:
if (typeof(kp_AirPrinter_requestStateOfSupporting) !== "function")
{
	function kp_AirPrinter_requestStateOfSupporting()
	{
		___kp_executeURL("kioskpro://kp_AirPrinter_requestStateOfSupporting");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_AirPrinter_requestStateOfSupporting'] = function() { kp_AirPrinter_requestStateOfSupporting(); };
}

if (typeof(kp_AirPrinter_print) !== "function")
{
	function kp_AirPrinter_print()
	{
		___kp_executeURL("kioskpro://kp_AirPrinter_print");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_AirPrinter_print'] = function() { kp_AirPrinter_print(); };
}

if (typeof(kp_AirPrinter_printPdf) !== "function")
{
	function kp_AirPrinter_printPdf(filename)
	{
		___kp_executeURL("kioskpro://kp_AirPrinter_printPdf?" + encodeURIComponent(filename));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_AirPrinter_printPdf'] = function(filename) { kp_AirPrinter_printPdf(filename); };
}

if (typeof(kp_AirPrinter_printHTMLString) !== "function")
{
	function kp_AirPrinter_printHTMLString(htmlString)
	{
		___kp_executeURL("kioskpro://kp_AirPrinter_printHTMLString?" + encodeURIComponent(htmlString));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_AirPrinter_printHTMLString'] = function(htmlString) { kp_AirPrinter_printHTMLString(htmlString); };
}

if (typeof(kp_AirPrinter_checkStatusOfSelectedPrinter) !== "function")
{
	function kp_AirPrinter_checkStatusOfSelectedPrinter(callback)
	{
		___kp_executeURL("kioskpro://kp_AirPrinter_checkStatusOfSelectedPrinter?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_AirPrinter_checkStatusOfSelectedPrinter'] = function(callback) { kp_AirPrinter_checkStatusOfSelectedPrinter(callback); };
}

// Custom America Printer API:
if (typeof(kp_CustomAmericaPrinterAPI_getPageWidth) !== "function")
{
	function kp_CustomAmericaPrinterAPI_getPageWidth(callback)
	{
		___kp_executeURL("kioskpro://kp_CustomAmericaPrinterAPI_getPageWidth?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_CustomAmericaPrinterAPI_getPageWidth'] = function(callback) { kp_CustomAmericaPrinterAPI_getPageWidth(callback); };
}

if (typeof(kp_CustomAmericaPrinterAPI_getFontCharWidth) !== "function")
{
	function kp_CustomAmericaPrinterAPI_getFontCharWidth(callback)
	{
		___kp_executeURL("kioskpro://kp_CustomAmericaPrinterAPI_getFontCharWidth?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_CustomAmericaPrinterAPI_getFontCharWidth'] = function(callback) { kp_CustomAmericaPrinterAPI_getFontCharWidth(callback); };
}

if (typeof(kp_CustomAmericaPrinterAPI_setFontCharWidth) !== "function")
{
	function kp_CustomAmericaPrinterAPI_setFontCharWidth(value,callback)
	{
		___kp_executeURL("kioskpro://kp_CustomAmericaPrinterAPI_setFontCharWidth?" + encodeURIComponent(value) + "&" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_CustomAmericaPrinterAPI_setFontCharWidth'] = function(value,callback) { kp_CustomAmericaPrinterAPI_setFontCharWidth(value,callback); };
}

if (typeof(kp_CustomAmericaPrinterAPI_getFontCharHeight) !== "function")
{
	function kp_CustomAmericaPrinterAPI_getFontCharHeight(callback)
	{
		___kp_executeURL("kioskpro://kp_CustomAmericaPrinterAPI_getFontCharHeight?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_CustomAmericaPrinterAPI_getFontCharHeight'] = function(callback) { kp_CustomAmericaPrinterAPI_getFontCharHeight(callback); };
}

if (typeof(kp_CustomAmericaPrinterAPI_setFontCharHeight) !== "function")
{
	function kp_CustomAmericaPrinterAPI_setFontCharHeight(value,callback)
	{
		___kp_executeURL("kioskpro://kp_CustomAmericaPrinterAPI_setFontCharHeight?" + encodeURIComponent(value) + "&" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_CustomAmericaPrinterAPI_setFontCharHeight'] = function(value,callback) { kp_CustomAmericaPrinterAPI_setFontCharHeight(value,callback); };
}

if (typeof(kp_CustomAmericaPrinterAPI_getFontEmphasizedProperty) !== "function")
{
	function kp_CustomAmericaPrinterAPI_getFontEmphasizedProperty(callback)
	{
		___kp_executeURL("kioskpro://kp_CustomAmericaPrinterAPI_getFontEmphasizedProperty?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_CustomAmericaPrinterAPI_getFontEmphasizedProperty'] = function(callback) { kp_CustomAmericaPrinterAPI_getFontEmphasizedProperty(callback); };
}

if (typeof(kp_CustomAmericaPrinterAPI_setFontEmphasizedProperty) !== "function")
{
	function kp_CustomAmericaPrinterAPI_setFontEmphasizedProperty(value,callback)
	{
		___kp_executeURL("kioskpro://kp_CustomAmericaPrinterAPI_setFontEmphasizedProperty?" + encodeURIComponent(value) + "&" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_CustomAmericaPrinterAPI_setFontEmphasizedProperty'] = function(value,callback) { kp_CustomAmericaPrinterAPI_setFontEmphasizedProperty(value,callback); };
}

if (typeof(kp_CustomAmericaPrinterAPI_getFontItalicProperty) !== "function")
{
	function kp_CustomAmericaPrinterAPI_getFontItalicProperty(callback)
	{
		___kp_executeURL("kioskpro://kp_CustomAmericaPrinterAPI_getFontItalicProperty?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_CustomAmericaPrinterAPI_getFontItalicProperty'] = function(callback) { kp_CustomAmericaPrinterAPI_getFontItalicProperty(callback); };
}

if (typeof(kp_CustomAmericaPrinterAPI_setFontItalicProperty) !== "function")
{
	function kp_CustomAmericaPrinterAPI_setFontItalicProperty(value,callback)
	{
		___kp_executeURL("kioskpro://kp_CustomAmericaPrinterAPI_setFontItalicProperty?" + encodeURIComponent(value) + "&" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_CustomAmericaPrinterAPI_setFontItalicProperty'] = function(value,callback) { kp_CustomAmericaPrinterAPI_setFontItalicProperty(value,callback); };
}

if (typeof(kp_CustomAmericaPrinterAPI_getFontUnderlineProperty) !== "function")
{
	function kp_CustomAmericaPrinterAPI_getFontUnderlineProperty(callback)
	{
		___kp_executeURL("kioskpro://kp_CustomAmericaPrinterAPI_getFontUnderlineProperty?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_CustomAmericaPrinterAPI_getFontUnderlineProperty'] = function(callback) { kp_CustomAmericaPrinterAPI_getFontUnderlineProperty(callback); };
}

if (typeof(kp_CustomAmericaPrinterAPI_setFontUnderlineProperty) !== "function")
{
	function kp_CustomAmericaPrinterAPI_setFontUnderlineProperty(value,callback)
	{
		___kp_executeURL("kioskpro://kp_CustomAmericaPrinterAPI_setFontUnderlineProperty?" + encodeURIComponent(value) + "&" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_CustomAmericaPrinterAPI_setFontUnderlineProperty'] = function(value,callback) { kp_CustomAmericaPrinterAPI_setFontUnderlineProperty(value,callback); };
}

if (typeof(kp_CustomAmericaPrinterAPI_getFontJustificationProperty) !== "function")
{
	function kp_CustomAmericaPrinterAPI_getFontJustificationProperty(callback)
	{
		___kp_executeURL("kioskpro://kp_CustomAmericaPrinterAPI_getFontJustificationProperty?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_CustomAmericaPrinterAPI_getFontJustificationProperty'] = function(callback) { kp_CustomAmericaPrinterAPI_getFontJustificationProperty(callback); };
}

if (typeof(kp_CustomAmericaPrinterAPI_setFontJustificationProperty) !== "function")
{
	function kp_CustomAmericaPrinterAPI_setFontJustificationProperty(value,callback)
	{
		___kp_executeURL("kioskpro://kp_CustomAmericaPrinterAPI_setFontJustificationProperty?" + encodeURIComponent(value) + "&" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_CustomAmericaPrinterAPI_setFontJustificationProperty'] = function(value,callback) { kp_CustomAmericaPrinterAPI_setFontJustificationProperty(value,callback); };
}

if (typeof(kp_CustomAmericaPrinterAPI_getCharFontType) !== "function")
{
	function kp_CustomAmericaPrinterAPI_getCharFontType(callback)
	{
		___kp_executeURL("kioskpro://kp_CustomAmericaPrinterAPI_getCharFontType?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_CustomAmericaPrinterAPI_getCharFontType'] = function(callback) { kp_CustomAmericaPrinterAPI_getCharFontType(callback); };
}

if (typeof(kp_CustomAmericaPrinterAPI_setCharFontType) !== "function")
{
	function kp_CustomAmericaPrinterAPI_setCharFontType(value,callback)
	{
		___kp_executeURL("kioskpro://kp_CustomAmericaPrinterAPI_setCharFontType?" + encodeURIComponent(value) + "&" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_CustomAmericaPrinterAPI_setCharFontType'] = function(value,callback) { kp_CustomAmericaPrinterAPI_setCharFontType(value,callback); };
}

if (typeof(kp_CustomAmericaPrinterAPI_getFontInternationalCharSetType) !== "function")
{
	function kp_CustomAmericaPrinterAPI_getFontInternationalCharSetType(callback)
	{
		___kp_executeURL("kioskpro://kp_CustomAmericaPrinterAPI_getFontInternationalCharSetType?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_CustomAmericaPrinterAPI_getFontInternationalCharSetType'] = function(callback) { kp_CustomAmericaPrinterAPI_getFontInternationalCharSetType(callback); };
}

if (typeof(kp_CustomAmericaPrinterAPI_setFontInternationalCharSetType) !== "function")
{
	function kp_CustomAmericaPrinterAPI_setFontInternationalCharSetType(value,callback)
	{
		___kp_executeURL("kioskpro://kp_CustomAmericaPrinterAPI_setFontInternationalCharSetType?" + encodeURIComponent(value) + "&" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_CustomAmericaPrinterAPI_setFontInternationalCharSetType'] = function(value,callback) { kp_CustomAmericaPrinterAPI_setFontInternationalCharSetType(value,callback); };
}

if (typeof(kp_CustomAmericaPrinterAPI_printText) !== "function")
{
	function kp_CustomAmericaPrinterAPI_printText(text,pixel_la,pixel_w,feed,wordWrap,callback)
	{
		___kp_executeURL("kioskpro://kp_CustomAmericaPrinterAPI_printText?" + encodeURIComponent(text) + "&" + encodeURIComponent(pixel_la) + "&" + encodeURIComponent(pixel_w) + "&" + encodeURIComponent(feed) + "&" + encodeURIComponent(wordWrap) + "&" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_CustomAmericaPrinterAPI_printText'] = function(text,pixel_la,pixel_w,feed,wordWrap,callback) { kp_CustomAmericaPrinterAPI_printText(text,pixel_la,pixel_w,feed,wordWrap,callback); };
}

if (typeof(kp_CustomAmericaPrinterAPI_printHTMLElement) !== "function")
{
	function kp_CustomAmericaPrinterAPI_printHTMLElement(elementId,wordWrap,callback)
	{
		___kp_executeURL("kioskpro://kp_CustomAmericaPrinterAPI_printHTMLElement?" + encodeURIComponent(elementId) + "&" + encodeURIComponent(wordWrap) + "&" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_CustomAmericaPrinterAPI_printHTMLElement'] = function(elementId,wordWrap,callback) { kp_CustomAmericaPrinterAPI_printHTMLElement(elementId,wordWrap,callback); };
}

if (typeof(kp_CustomAmericaPrinterAPI_print2DBarCode) !== "function")
{
	function kp_CustomAmericaPrinterAPI_print2DBarCode(text,type,justification,width,callback)
	{
		___kp_executeURL("kioskpro://kp_CustomAmericaPrinterAPI_print2DBarCode?" + encodeURIComponent(text) + "&" + encodeURIComponent(type) + "&" + encodeURIComponent(justification) + "&" + encodeURIComponent(width) + "&" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_CustomAmericaPrinterAPI_print2DBarCode'] = function(text,type,justification,width,callback) { kp_CustomAmericaPrinterAPI_print2DBarCode(text,type,justification,width,callback); };
}

if (typeof(kp_CustomAmericaPrinterAPI_printBarCode) !== "function")
{
	function kp_CustomAmericaPrinterAPI_printBarCode(text,type,hriType,justification,width,height,callback)
	{
		___kp_executeURL("kioskpro://kp_CustomAmericaPrinterAPI_printBarCode?" + encodeURIComponent(text) + "&" + encodeURIComponent(type) + "&" + encodeURIComponent(hriType) + "&" + encodeURIComponent(justification) + "&" + encodeURIComponent(width) + "&" + encodeURIComponent(height) + "&" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_CustomAmericaPrinterAPI_printBarCode'] = function(text,type,hriType,justification,width,height,callback) { kp_CustomAmericaPrinterAPI_printBarCode(text,type,hriType,justification,width,height,callback); };
}

if (typeof(kp_CustomAmericaPrinterAPI_printImage) !== "function")
{
	function kp_CustomAmericaPrinterAPI_printImage(path,leftAlign,scaleOption,width,callback)
	{
		___kp_executeURL("kioskpro://kp_CustomAmericaPrinterAPI_printImage?" + encodeURIComponent(path) + "&" + encodeURIComponent(leftAlign) + "&" + encodeURIComponent(scaleOption) + "&" + encodeURIComponent(width) + "&" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_CustomAmericaPrinterAPI_printImage'] = function(path,leftAlign,scaleOption,width,callback) { kp_CustomAmericaPrinterAPI_printImage(path,leftAlign,scaleOption,width,callback); };
}

if (typeof(kp_CustomAmericaPrinterAPI_feed) !== "function")
{
	function kp_CustomAmericaPrinterAPI_feed(numberOfLFToSend,callback)
	{
		___kp_executeURL("kioskpro://kp_CustomAmericaPrinterAPI_feed?" + encodeURIComponent(numberOfLFToSend) + "&" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_CustomAmericaPrinterAPI_feed'] = function(numberOfLFToSend,callback) { kp_CustomAmericaPrinterAPI_feed(numberOfLFToSend,callback); };
}

if (typeof(kp_CustomAmericaPrinterAPI_cut) !== "function")
{
	function kp_CustomAmericaPrinterAPI_cut(cutType,callback)
	{
		___kp_executeURL("kioskpro://kp_CustomAmericaPrinterAPI_cut?" + encodeURIComponent(cutType) + "&" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_CustomAmericaPrinterAPI_cut'] = function(cutType,callback) { kp_CustomAmericaPrinterAPI_cut(cutType,callback); };
}

// UniMag2 Card Reader API::
if (typeof(kp_UniMag2CardReader_requestStateOfSupporting) !== "function")
{
	function kp_UniMag2CardReader_requestStateOfSupporting()
	{
		___kp_executeURL("kioskpro://kp_UniMag2CardReader_requestStateOfSupporting");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_UniMag2CardReader_requestStateOfSupporting'] = function() { kp_UniMag2CardReader_requestStateOfSupporting(); };
}

if (typeof(kp_UniMag2CardReader_requestStateOfConnection) !== "function")
{
	function kp_UniMag2CardReader_requestStateOfConnection()
	{
		___kp_executeURL("kioskpro://kp_UniMag2CardReader_requestStateOfConnection");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_UniMag2CardReader_requestStateOfConnection'] = function() { kp_UniMag2CardReader_requestStateOfConnection(); };
}

if (typeof(kp_UniMag2CardReader_requestSwipe) !== "function")
{
	function kp_UniMag2CardReader_requestSwipe(swipeInfo)
	{
		___kp_executeURL("kioskpro://kp_UniMag2CardReader_requestSwipe?" + encodeURIComponent(swipeInfo));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_UniMag2CardReader_requestSwipe'] = function(swipeInfo) { kp_UniMag2CardReader_requestSwipe(swipeInfo); };
}

if (typeof(kp_UniMag2CardReader_cancelSwipe) !== "function")
{
	function kp_UniMag2CardReader_cancelSwipe()
	{
		___kp_executeURL("kioskpro://kp_UniMag2CardReader_cancelSwipe");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_UniMag2CardReader_cancelSwipe'] = function() { kp_UniMag2CardReader_cancelSwipe(); };
}

if (typeof(kp_UniMag2CardReader_mps_doCreditSaleOperation) !== "function")
{
	function kp_UniMag2CardReader_mps_doCreditSaleOperation(amount,invoiceNumber)
	{
		___kp_executeURL("kioskpro://kp_UniMag2CardReader_mps_doCreditSaleOperation?" + encodeURIComponent(amount) + "&" + encodeURIComponent(invoiceNumber));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_UniMag2CardReader_mps_doCreditSaleOperation'] = function(amount,invoiceNumber) { kp_UniMag2CardReader_mps_doCreditSaleOperation(amount,invoiceNumber); };
}

// StarPrinter API:
if (typeof(kp_StarPrinter_requestStateOfSupporting) !== "function")
{
	function kp_StarPrinter_requestStateOfSupporting()
	{
		___kp_executeURL("kioskpro://kp_StarPrinter_requestStateOfSupporting");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_StarPrinter_requestStateOfSupporting'] = function() { kp_StarPrinter_requestStateOfSupporting(); };
}

if (typeof(kp_StarPrinter_requestStatusOfPrinter) !== "function")
{
	function kp_StarPrinter_requestStatusOfPrinter()
	{
		___kp_executeURL("kioskpro://kp_StarPrinter_requestStatusOfPrinter");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_StarPrinter_requestStatusOfPrinter'] = function() { kp_StarPrinter_requestStatusOfPrinter(); };
}

if (typeof(kp_StarPrinter_selectCodePage) !== "function")
{
	function kp_StarPrinter_selectCodePage(codePage)
	{
		___kp_executeURL("kioskpro://kp_StarPrinter_selectCodePage?" + encodeURIComponent(codePage));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_StarPrinter_selectCodePage'] = function(codePage) { kp_StarPrinter_selectCodePage(codePage); };
}

if (typeof(kp_StarPrinter_printCode39) !== "function")
{
	function kp_StarPrinter_printCode39(text,cut)
	{
		___kp_executeURL("kioskpro://kp_StarPrinter_printCode39?" + encodeURIComponent(text) + "&" + encodeURIComponent(cut));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_StarPrinter_printCode39'] = function(text,cut) { kp_StarPrinter_printCode39(text,cut); };
}

if (typeof(kp_StarPrinter_printCode93) !== "function")
{
	function kp_StarPrinter_printCode93(text,cut)
	{
		___kp_executeURL("kioskpro://kp_StarPrinter_printCode93?" + encodeURIComponent(text) + "&" + encodeURIComponent(cut));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_StarPrinter_printCode93'] = function(text,cut) { kp_StarPrinter_printCode93(text,cut); };
}

if (typeof(kp_StarPrinter_printCode128) !== "function")
{
	function kp_StarPrinter_printCode128(text,cut,codeSet)
	{
		___kp_executeURL("kioskpro://kp_StarPrinter_printCode128?" + encodeURIComponent(text) + "&" + encodeURIComponent(cut) + "&" + encodeURIComponent(codeSet));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_StarPrinter_printCode128'] = function(text,cut,codeSet) { kp_StarPrinter_printCode128(text,cut,codeSet); };
}

if (typeof(kp_StarPrinter_printQRCode) !== "function")
{
	function kp_StarPrinter_printQRCode(text,cut)
	{
		___kp_executeURL("kioskpro://kp_StarPrinter_printQRCode?" + encodeURIComponent(text) + "&" + encodeURIComponent(cut));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_StarPrinter_printQRCode'] = function(text,cut) { kp_StarPrinter_printQRCode(text,cut); };
}

if (typeof(kp_StarPrinter_rasterMode_printHTMLString) !== "function")
{
	function kp_StarPrinter_rasterMode_printHTMLString(htmlString,cut)
	{
		___kp_executeURL("kioskpro://kp_StarPrinter_rasterMode_printHTMLString?" + encodeURIComponent(htmlString) + "&" + encodeURIComponent(cut));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_StarPrinter_rasterMode_printHTMLString'] = function(htmlString,cut) { kp_StarPrinter_rasterMode_printHTMLString(htmlString,cut); };
}

if (typeof(kp_StarPrinter_printHTMLString) !== "function")
{
	function kp_StarPrinter_printHTMLString(htmlString,cut)
	{
		___kp_executeURL("kioskpro://kp_StarPrinter_printHTMLString?" + encodeURIComponent(htmlString) + "&" + encodeURIComponent(cut));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_StarPrinter_printHTMLString'] = function(htmlString,cut) { kp_StarPrinter_printHTMLString(htmlString,cut); };
}

if (typeof(kp_StarPrinter_printHtml) !== "function")
{
	function kp_StarPrinter_printHtml(elementId,cut)
	{
		___kp_executeURL("kioskpro://kp_StarPrinter_printHtml?" + encodeURIComponent(elementId) + "&" + encodeURIComponent(cut));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_StarPrinter_printHtml'] = function(elementId,cut) { kp_StarPrinter_printHtml(elementId,cut); };
}

if (typeof(kp_StarPrinter_printHTMLElement) !== "function")
{
	function kp_StarPrinter_printHTMLElement(elementId,cut)
	{
		___kp_executeURL("kioskpro://kp_StarPrinter_printHTMLElement?" + encodeURIComponent(elementId) + "&" + encodeURIComponent(cut));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_StarPrinter_printHTMLElement'] = function(elementId,cut) { kp_StarPrinter_printHTMLElement(elementId,cut); };
}

if (typeof(kp_StarPrinter_rasterMode_printDocumentAtURL) !== "function")
{
	function kp_StarPrinter_rasterMode_printDocumentAtURL(documentURL,cut)
	{
		___kp_executeURL("kioskpro://kp_StarPrinter_rasterMode_printDocumentAtURL?" + encodeURIComponent(documentURL) + "&" + encodeURIComponent(cut));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_StarPrinter_rasterMode_printDocumentAtURL'] = function(documentURL,cut) { kp_StarPrinter_rasterMode_printDocumentAtURL(documentURL,cut); };
}

if (typeof(kp_StarPrinter_printDocumentAtURL) !== "function")
{
	function kp_StarPrinter_printDocumentAtURL(documentURL,cut)
	{
		___kp_executeURL("kioskpro://kp_StarPrinter_printDocumentAtURL?" + encodeURIComponent(documentURL) + "&" + encodeURIComponent(cut));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_StarPrinter_printDocumentAtURL'] = function(documentURL,cut) { kp_StarPrinter_printDocumentAtURL(documentURL,cut); };
}

if (typeof(kp_StarPrinter_startBatchPrinting) !== "function")
{
	function kp_StarPrinter_startBatchPrinting(jsonParams)
	{
		___kp_executeURL("kioskpro://kp_StarPrinter_startBatchPrinting?" + encodeURIComponent(jsonParams));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_StarPrinter_startBatchPrinting'] = function(jsonParams) { kp_StarPrinter_startBatchPrinting(jsonParams); };
}

if (typeof(kp_StarPrinter_openCashDrawer) !== "function")
{
	function kp_StarPrinter_openCashDrawer(numberOfDrawer)
	{
		___kp_executeURL("kioskpro://kp_StarPrinter_openCashDrawer?" + encodeURIComponent(numberOfDrawer));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_StarPrinter_openCashDrawer'] = function(numberOfDrawer) { kp_StarPrinter_openCashDrawer(numberOfDrawer); };
}

if (typeof(kp_StarPrinter_requestCashDrawerStatus) !== "function")
{
	function kp_StarPrinter_requestCashDrawerStatus()
	{
		___kp_executeURL("kioskpro://kp_StarPrinter_requestCashDrawerStatus");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_StarPrinter_requestCashDrawerStatus'] = function() { kp_StarPrinter_requestCashDrawerStatus(); };
}

if (typeof(kp_StarPrinter_startListenToBarcodeScannerEvents) !== "function")
{
	function kp_StarPrinter_startListenToBarcodeScannerEvents()
	{
		___kp_executeURL("kioskpro://kp_StarPrinter_startListenToBarcodeScannerEvents");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_StarPrinter_startListenToBarcodeScannerEvents'] = function() { kp_StarPrinter_startListenToBarcodeScannerEvents(); };
}

if (typeof(kp_StarPrinter_stopListenToBarcodeScannerEvents) !== "function")
{
	function kp_StarPrinter_stopListenToBarcodeScannerEvents()
	{
		___kp_executeURL("kioskpro://kp_StarPrinter_stopListenToBarcodeScannerEvents");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_StarPrinter_stopListenToBarcodeScannerEvents'] = function() { kp_StarPrinter_stopListenToBarcodeScannerEvents(); };
}

// Common Printer API:
if (typeof(print) !== "function")
{
	function print()
	{
		___kp_executeURL("kioskpro://print");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['print'] = function() { print(); };
}

if (typeof(kp_CommonPrintingAPI_requestEnabledPrinterType) !== "function")
{
	function kp_CommonPrintingAPI_requestEnabledPrinterType(callback)
	{
		___kp_executeURL("kioskpro://kp_CommonPrintingAPI_requestEnabledPrinterType?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_CommonPrintingAPI_requestEnabledPrinterType'] = function(callback) { kp_CommonPrintingAPI_requestEnabledPrinterType(callback); };
}

// Idle Timer API:
if (typeof(kp_IdleTimer_fire) !== "function")
{
	function kp_IdleTimer_fire()
	{
		___kp_executeURL("kioskpro://kp_IdleTimer_fire");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_IdleTimer_fire'] = function() { kp_IdleTimer_fire(); };
}

// KioWare API:
if (typeof(kp_KioWare_closeCurrentSession) !== "function")
{
	function kp_KioWare_closeCurrentSession()
	{
		___kp_executeURL("kioskpro://kp_KioWare_closeCurrentSession");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_KioWare_closeCurrentSession'] = function() { kp_KioWare_closeCurrentSession(); };
}

if (typeof(kp_KioWare_registerNavigation) !== "function")
{
	function kp_KioWare_registerNavigation(url,pageTitle,callback)
	{
		___kp_executeURL("kioskpro://kp_KioWare_registerNavigation?" + encodeURIComponent(url) + "&" + encodeURIComponent(pageTitle) + "&" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_KioWare_registerNavigation'] = function(url,pageTitle,callback) { kp_KioWare_registerNavigation(url,pageTitle,callback); };
}

// Device Link Server API:
if (typeof(kp_DeviceLinkServer_start) !== "function")
{
	function kp_DeviceLinkServer_start(serverName,callback)
	{
		___kp_executeURL("kioskpro://kp_DeviceLinkServer_start?" + encodeURIComponent(serverName) + "&" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_DeviceLinkServer_start'] = function(serverName,callback) { kp_DeviceLinkServer_start(serverName,callback); };
}

if (typeof(kp_DeviceLinkServer_stop) !== "function")
{
	function kp_DeviceLinkServer_stop(serverName,callback)
	{
		___kp_executeURL("kioskpro://kp_DeviceLinkServer_stop?" + encodeURIComponent(serverName) + "&" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_DeviceLinkServer_stop'] = function(serverName,callback) { kp_DeviceLinkServer_stop(serverName,callback); };
}

if (typeof(kp_DeviceLinkServer_getState) !== "function")
{
	function kp_DeviceLinkServer_getState(serverName,callback)
	{
		___kp_executeURL("kioskpro://kp_DeviceLinkServer_getState?" + encodeURIComponent(serverName) + "&" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_DeviceLinkServer_getState'] = function(serverName,callback) { kp_DeviceLinkServer_getState(serverName,callback); };
}

// Device Link Connection API:
if (typeof(kp_DeviceLinkConnection_connectToServer) !== "function")
{
	function kp_DeviceLinkConnection_connectToServer(serverName,connectionName,callback)
	{
		___kp_executeURL("kioskpro://kp_DeviceLinkConnection_connectToServer?" + encodeURIComponent(serverName) + "&" + encodeURIComponent(connectionName) + "&" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_DeviceLinkConnection_connectToServer'] = function(serverName,connectionName,callback) { kp_DeviceLinkConnection_connectToServer(serverName,connectionName,callback); };
}

if (typeof(kp_DeviceLinkConnection_close) !== "function")
{
	function kp_DeviceLinkConnection_close(serverName,callback)
	{
		___kp_executeURL("kioskpro://kp_DeviceLinkConnection_close?" + encodeURIComponent(serverName) + "&" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_DeviceLinkConnection_close'] = function(serverName,callback) { kp_DeviceLinkConnection_close(serverName,callback); };
}

if (typeof(kp_DeviceLinkConnection_sendPacketToServer) !== "function")
{
	function kp_DeviceLinkConnection_sendPacketToServer(serverName,packet,callback)
	{
		___kp_executeURL("kioskpro://kp_DeviceLinkConnection_sendPacketToServer?" + encodeURIComponent(serverName) + "&" + encodeURIComponent(packet) + "&" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_DeviceLinkConnection_sendPacketToServer'] = function(serverName,packet,callback) { kp_DeviceLinkConnection_sendPacketToServer(serverName,packet,callback); };
}

if (typeof(kp_DeviceLinkConnection_getListOfAliveConnections) !== "function")
{
	function kp_DeviceLinkConnection_getListOfAliveConnections(callback)
	{
		___kp_executeURL("kioskpro://kp_DeviceLinkConnection_getListOfAliveConnections?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_DeviceLinkConnection_getListOfAliveConnections'] = function(callback) { kp_DeviceLinkConnection_getListOfAliveConnections(callback); };
}

// Device Link Browser API:
if (typeof(kp_DeviceLinkBrowser_start) !== "function")
{
	function kp_DeviceLinkBrowser_start(callback)
	{
		___kp_executeURL("kioskpro://kp_DeviceLinkBrowser_start?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_DeviceLinkBrowser_start'] = function(callback) { kp_DeviceLinkBrowser_start(callback); };
}

if (typeof(kp_DeviceLinkBrowser_stop) !== "function")
{
	function kp_DeviceLinkBrowser_stop()
	{
		___kp_executeURL("kioskpro://kp_DeviceLinkBrowser_stop");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_DeviceLinkBrowser_stop'] = function() { kp_DeviceLinkBrowser_stop(); };
}

if (typeof(kp_DeviceLinkBrowser_getListOfServers) !== "function")
{
	function kp_DeviceLinkBrowser_getListOfServers(callback)
	{
		___kp_executeURL("kioskpro://kp_DeviceLinkBrowser_getListOfServers?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_DeviceLinkBrowser_getListOfServers'] = function(callback) { kp_DeviceLinkBrowser_getListOfServers(callback); };
}

// Zapier API:
if (typeof(kp_Zapier_sendNotificationToZap) !== "function")
{
	function kp_Zapier_sendNotificationToZap(urlOfZap,data,callback)
	{
		___kp_executeURL("kioskpro://kp_Zapier_sendNotificationToZap?" + encodeURIComponent(urlOfZap) + "&" + encodeURIComponent(data) + "&" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_Zapier_sendNotificationToZap'] = function(urlOfZap,data,callback) { kp_Zapier_sendNotificationToZap(urlOfZap,data,callback); };
}

// Padlock Scan API:
if (typeof(kp_padlockScan_start) !== "function")
{
	function kp_padlockScan_start()
	{
		___kp_executeURL("kioskpro://kp_padlockScan_start");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_padlockScan_start'] = function() { kp_padlockScan_start(); };
}

if (typeof(kp_padlockScan_stop) !== "function")
{
	function kp_padlockScan_stop()
	{
		___kp_executeURL("kioskpro://kp_padlockScan_stop");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_padlockScan_stop'] = function() { kp_padlockScan_stop(); };
}

if (typeof(kp_padlockScan_enableCamera) !== "function")
{
	function kp_padlockScan_enableCamera(callback)
	{
		___kp_executeURL("kioskpro://kp_padlockScan_enableCamera?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_padlockScan_enableCamera'] = function(callback) { kp_padlockScan_enableCamera(callback); };
}

if (typeof(kp_padlockScan_enableSpeaker) !== "function")
{
	function kp_padlockScan_enableSpeaker(callback)
	{
		___kp_executeURL("kioskpro://kp_padlockScan_enableSpeaker?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_padlockScan_enableSpeaker'] = function(callback) { kp_padlockScan_enableSpeaker(callback); };
}

if (typeof(kp_padlockScan_getSpeakerState) !== "function")
{
	function kp_padlockScan_getSpeakerState(callback)
	{
		___kp_executeURL("kioskpro://kp_padlockScan_getSpeakerState?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_padlockScan_getSpeakerState'] = function(callback) { kp_padlockScan_getSpeakerState(callback); };
}

if (typeof(kp_padlockScan_beep) !== "function")
{
	function kp_padlockScan_beep()
	{
		___kp_executeURL("kioskpro://kp_padlockScan_beep");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_padlockScan_beep'] = function() { kp_padlockScan_beep(); };
}

if (typeof(kp_padlockScan_getHardwareClass) !== "function")
{
	function kp_padlockScan_getHardwareClass()
	{
		___kp_executeURL("kioskpro://kp_padlockScan_getHardwareClass");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_padlockScan_getHardwareClass'] = function() { kp_padlockScan_getHardwareClass(); };
}

if (typeof(kp_padlockScan_getScanningState) !== "function")
{
	function kp_padlockScan_getScanningState()
	{
		___kp_executeURL("kioskpro://kp_padlockScan_getScanningState");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_padlockScan_getScanningState'] = function() { kp_padlockScan_getScanningState(); };
}

if (typeof(kp_padlockScan_getFirmwareVersion) !== "function")
{
	function kp_padlockScan_getFirmwareVersion(callback)
	{
		___kp_executeURL("kioskpro://kp_padlockScan_getFirmwareVersion?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_padlockScan_getFirmwareVersion'] = function(callback) { kp_padlockScan_getFirmwareVersion(callback); };
}

if (typeof(kp_padlockScan_getSDKVersion) !== "function")
{
	function kp_padlockScan_getSDKVersion(callback)
	{
		___kp_executeURL("kioskpro://kp_padlockScan_getSDKVersion?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_padlockScan_getSDKVersion'] = function(callback) { kp_padlockScan_getSDKVersion(callback); };
}

// External Keyboard API:
if (typeof(kp_ExternalKeyboard_startListenToEvents) !== "function")
{
	function kp_ExternalKeyboard_startListenToEvents()
	{
		___kp_executeURL("kioskpro://kp_ExternalKeyboard_startListenToEvents");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_ExternalKeyboard_startListenToEvents'] = function() { kp_ExternalKeyboard_startListenToEvents(); };
}

if (typeof(kp_ExternalKeyboard_stopListenToEvents) !== "function")
{
	function kp_ExternalKeyboard_stopListenToEvents()
	{
		___kp_executeURL("kioskpro://kp_ExternalKeyboard_stopListenToEvents");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_ExternalKeyboard_stopListenToEvents'] = function() { kp_ExternalKeyboard_stopListenToEvents(); };
}

// Kiosk Audio Session API:
if (typeof(kp_AudioSessionAPI_getCurrentAudioOutputPortType) !== "function")
{
	function kp_AudioSessionAPI_getCurrentAudioOutputPortType(callback)
	{
		___kp_executeURL("kioskpro://kp_AudioSessionAPI_getCurrentAudioOutputPortType?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_AudioSessionAPI_getCurrentAudioOutputPortType'] = function(callback) { kp_AudioSessionAPI_getCurrentAudioOutputPortType(callback); };
}

// Autonomous Single App Mode API:
if (typeof(kp_AutonomousSingleAppModeAPI_startSession) !== "function")
{
	function kp_AutonomousSingleAppModeAPI_startSession(silently)
	{
		___kp_executeURL("kioskpro://kp_AutonomousSingleAppModeAPI_startSession?" + encodeURIComponent(silently));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_AutonomousSingleAppModeAPI_startSession'] = function(silently) { kp_AutonomousSingleAppModeAPI_startSession(silently); };
}

if (typeof(kp_AutonomousSingleAppModeAPI_endSession) !== "function")
{
	function kp_AutonomousSingleAppModeAPI_endSession(silently)
	{
		___kp_executeURL("kioskpro://kp_AutonomousSingleAppModeAPI_endSession?" + encodeURIComponent(silently));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_AutonomousSingleAppModeAPI_endSession'] = function(silently) { kp_AutonomousSingleAppModeAPI_endSession(silently); };
}

// Geolocation API:
if (typeof(kp_Geolocation_requestLocation) !== "function")
{
	function kp_Geolocation_requestLocation(callback)
	{
		___kp_executeURL("kioskpro://kp_Geolocation_requestLocation?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_Geolocation_requestLocation'] = function(callback) { kp_Geolocation_requestLocation(callback); };
}

// Battery State API:
if (typeof(kp_Battery_requestInfo) !== "function")
{
	function kp_Battery_requestInfo(callback)
	{
		___kp_executeURL("kioskpro://kp_Battery_requestInfo?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_Battery_requestInfo'] = function(callback) { kp_Battery_requestInfo(callback); };
}

// Guided Access API:
if (typeof(kp_GuidedAccess_requestStatus) !== "function")
{
	function kp_GuidedAccess_requestStatus()
	{
		___kp_executeURL("kioskpro://kp_GuidedAccess_requestStatus");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_GuidedAccess_requestStatus'] = function() { kp_GuidedAccess_requestStatus(); };
}

// Synthesized Speech API:
if (typeof(kp_Speech_speak) !== "function")
{
	function kp_Speech_speak(speechString,speechUtteranceConfig)
	{
		___kp_executeURL("kioskpro://kp_Speech_speak?" + encodeURIComponent(speechString) + "&" + encodeURIComponent(speechUtteranceConfig));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_Speech_speak'] = function(speechString,speechUtteranceConfig) { kp_Speech_speak(speechString,speechUtteranceConfig); };
}

if (typeof(kp_Speech_stop) !== "function")
{
	function kp_Speech_stop()
	{
		___kp_executeURL("kioskpro://kp_Speech_stop");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_Speech_stop'] = function() { kp_Speech_stop(); };
}

if (typeof(kp_Speech_pause) !== "function")
{
	function kp_Speech_pause()
	{
		___kp_executeURL("kioskpro://kp_Speech_pause");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_Speech_pause'] = function() { kp_Speech_pause(); };
}

if (typeof(kp_Speech_continue) !== "function")
{
	function kp_Speech_continue()
	{
		___kp_executeURL("kioskpro://kp_Speech_continue");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_Speech_continue'] = function() { kp_Speech_continue(); };
}

if (typeof(kp_Speech_requestCurrentLanguageCode) !== "function")
{
	function kp_Speech_requestCurrentLanguageCode(callback)
	{
		___kp_executeURL("kioskpro://kp_Speech_requestCurrentLanguageCode?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_Speech_requestCurrentLanguageCode'] = function(callback) { kp_Speech_requestCurrentLanguageCode(callback); };
}

if (typeof(kp_Speech_requestListOfLanguageCodes) !== "function")
{
	function kp_Speech_requestListOfLanguageCodes(callback)
	{
		___kp_executeURL("kioskpro://kp_Speech_requestListOfLanguageCodes?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_Speech_requestListOfLanguageCodes'] = function(callback) { kp_Speech_requestListOfLanguageCodes(callback); };
}

if (typeof(kp_Speech_requestListOfVoiceIdentifiers) !== "function")
{
	function kp_Speech_requestListOfVoiceIdentifiers(callback)
	{
		___kp_executeURL("kioskpro://kp_Speech_requestListOfVoiceIdentifiers?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_Speech_requestListOfVoiceIdentifiers'] = function(callback) { kp_Speech_requestListOfVoiceIdentifiers(callback); };
}

// Socket Barcode/NFC Scanner API:
if (typeof(kp_SocketScannerAPI_requestStateOfSupporting) !== "function")
{
	function kp_SocketScannerAPI_requestStateOfSupporting(callback)
	{
		___kp_executeURL("kioskpro://kp_SocketScannerAPI_requestStateOfSupporting?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_SocketScannerAPI_requestStateOfSupporting'] = function(callback) { kp_SocketScannerAPI_requestStateOfSupporting(callback); };
}

if (typeof(kp_SocketScannerAPI_requestBatteryLevel) !== "function")
{
	function kp_SocketScannerAPI_requestBatteryLevel(callback)
	{
		___kp_executeURL("kioskpro://kp_SocketScannerAPI_requestBatteryLevel?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_SocketScannerAPI_requestBatteryLevel'] = function(callback) { kp_SocketScannerAPI_requestBatteryLevel(callback); };
}

// Navigation Bar Visibility API:
if (typeof(kp_navigationBarVisibility_show) !== "function")
{
	function kp_navigationBarVisibility_show()
	{
		___kp_executeURL("kioskpro://kp_navigationBarVisibility_show");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_navigationBarVisibility_show'] = function() { kp_navigationBarVisibility_show(); };
}

if (typeof(kp_navigationBarVisibility_hide) !== "function")
{
	function kp_navigationBarVisibility_hide()
	{
		___kp_executeURL("kioskpro://kp_navigationBarVisibility_hide");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_navigationBarVisibility_hide'] = function() { kp_navigationBarVisibility_hide(); };
}

if (typeof(kp_navigationBarVisibility_reset) !== "function")
{
	function kp_navigationBarVisibility_reset()
	{
		___kp_executeURL("kioskpro://kp_navigationBarVisibility_reset");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_navigationBarVisibility_reset'] = function() { kp_navigationBarVisibility_reset(); };
}

// Flic2 Button API:
if (typeof(kp_Flic2ButtonAPI_init) !== "function")
{
	function kp_Flic2ButtonAPI_init()
	{
		___kp_executeURL("kioskpro://kp_Flic2ButtonAPI_init");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_Flic2ButtonAPI_init'] = function() { kp_Flic2ButtonAPI_init(); };
}

if (typeof(kp_Flic2ButtonAPI_startScan) !== "function")
{
	function kp_Flic2ButtonAPI_startScan()
	{
		___kp_executeURL("kioskpro://kp_Flic2ButtonAPI_startScan");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_Flic2ButtonAPI_startScan'] = function() { kp_Flic2ButtonAPI_startScan(); };
}

if (typeof(kp_Flic2ButtonAPI_stopScan) !== "function")
{
	function kp_Flic2ButtonAPI_stopScan()
	{
		___kp_executeURL("kioskpro://kp_Flic2ButtonAPI_stopScan");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_Flic2ButtonAPI_stopScan'] = function() { kp_Flic2ButtonAPI_stopScan(); };
}

if (typeof(kp_Flic2ButtonAPI_forgetButton) !== "function")
{
	function kp_Flic2ButtonAPI_forgetButton(uuid)
	{
		___kp_executeURL("kioskpro://kp_Flic2ButtonAPI_forgetButton?" + encodeURIComponent(uuid));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_Flic2ButtonAPI_forgetButton'] = function(uuid) { kp_Flic2ButtonAPI_forgetButton(uuid); };
}

if (typeof(kp_Flic2ButtonAPI_updateNickname) !== "function")
{
	function kp_Flic2ButtonAPI_updateNickname(nickname,uuid)
	{
		___kp_executeURL("kioskpro://kp_Flic2ButtonAPI_updateNickname?" + encodeURIComponent(nickname) + "&" + encodeURIComponent(uuid));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_Flic2ButtonAPI_updateNickname'] = function(nickname,uuid) { kp_Flic2ButtonAPI_updateNickname(nickname,uuid); };
}

// Fingerbot API:
if (typeof(kp_FingerbotAPI_startScan) !== "function")
{
	function kp_FingerbotAPI_startScan()
	{
		___kp_executeURL("kioskpro://kp_FingerbotAPI_startScan");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_FingerbotAPI_startScan'] = function() { kp_FingerbotAPI_startScan(); };
}

if (typeof(kp_FingerbotAPI_stopScan) !== "function")
{
	function kp_FingerbotAPI_stopScan()
	{
		___kp_executeURL("kioskpro://kp_FingerbotAPI_stopScan");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_FingerbotAPI_stopScan'] = function() { kp_FingerbotAPI_stopScan(); };
}

if (typeof(kp_FingerbotAPI_isDeviceConnected) !== "function")
{
	function kp_FingerbotAPI_isDeviceConnected(deviceId)
	{
		___kp_executeURL("kioskpro://kp_FingerbotAPI_isDeviceConnected?" + encodeURIComponent(deviceId));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_FingerbotAPI_isDeviceConnected'] = function(deviceId) { kp_FingerbotAPI_isDeviceConnected(deviceId); };
}

if (typeof(kp_FingerbotAPI_connectToDevice) !== "function")
{
	function kp_FingerbotAPI_connectToDevice(deviceId)
	{
		___kp_executeURL("kioskpro://kp_FingerbotAPI_connectToDevice?" + encodeURIComponent(deviceId));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_FingerbotAPI_connectToDevice'] = function(deviceId) { kp_FingerbotAPI_connectToDevice(deviceId); };
}

if (typeof(kp_FingerbotAPI_disconnectFromDevice) !== "function")
{
	function kp_FingerbotAPI_disconnectFromDevice(deviceId)
	{
		___kp_executeURL("kioskpro://kp_FingerbotAPI_disconnectFromDevice?" + encodeURIComponent(deviceId));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_FingerbotAPI_disconnectFromDevice'] = function(deviceId) { kp_FingerbotAPI_disconnectFromDevice(deviceId); };
}

if (typeof(kp_FingerbotAPI_clickOnDevice) !== "function")
{
	function kp_FingerbotAPI_clickOnDevice(deviceId)
	{
		___kp_executeURL("kioskpro://kp_FingerbotAPI_clickOnDevice?" + encodeURIComponent(deviceId));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_FingerbotAPI_clickOnDevice'] = function(deviceId) { kp_FingerbotAPI_clickOnDevice(deviceId); };
}

if (typeof(kp_FingerbotAPI_refreshBatteryOnDevice) !== "function")
{
	function kp_FingerbotAPI_refreshBatteryOnDevice(deviceId)
	{
		___kp_executeURL("kioskpro://kp_FingerbotAPI_refreshBatteryOnDevice?" + encodeURIComponent(deviceId));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_FingerbotAPI_refreshBatteryOnDevice'] = function(deviceId) { kp_FingerbotAPI_refreshBatteryOnDevice(deviceId); };
}

if (typeof(kp_FingerbotAPI_setSustainTimeOnDevice) !== "function")
{
	function kp_FingerbotAPI_setSustainTimeOnDevice(deviceId,time)
	{
		___kp_executeURL("kioskpro://kp_FingerbotAPI_setSustainTimeOnDevice?" + encodeURIComponent(deviceId) + "&" + encodeURIComponent(time));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_FingerbotAPI_setSustainTimeOnDevice'] = function(deviceId,time) { kp_FingerbotAPI_setSustainTimeOnDevice(deviceId,time); };
}

if (typeof(kp_FingerbotAPI_setDownMovementOnDevice) !== "function")
{
	function kp_FingerbotAPI_setDownMovementOnDevice(deviceId,percent)
	{
		___kp_executeURL("kioskpro://kp_FingerbotAPI_setDownMovementOnDevice?" + encodeURIComponent(deviceId) + "&" + encodeURIComponent(percent));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_FingerbotAPI_setDownMovementOnDevice'] = function(deviceId,percent) { kp_FingerbotAPI_setDownMovementOnDevice(deviceId,percent); };
}

if (typeof(kp_FingerbotAPI_updateFirmwareVersionOnDevice) !== "function")
{
	function kp_FingerbotAPI_updateFirmwareVersionOnDevice(deviceId)
	{
		___kp_executeURL("kioskpro://kp_FingerbotAPI_updateFirmwareVersionOnDevice?" + encodeURIComponent(deviceId));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_FingerbotAPI_updateFirmwareVersionOnDevice'] = function(deviceId) { kp_FingerbotAPI_updateFirmwareVersionOnDevice(deviceId); };
}

if (typeof(kp_FingerbotAPI_getAllConnectedDevices) !== "function")
{
	function kp_FingerbotAPI_getAllConnectedDevices()
	{
		___kp_executeURL("kioskpro://kp_FingerbotAPI_getAllConnectedDevices");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_FingerbotAPI_getAllConnectedDevices'] = function() { kp_FingerbotAPI_getAllConnectedDevices(); };
}

// Bixolon Printer API:
if (typeof(kp_BixolonPrinter_requestStateOfSupporting) !== "function")
{
	function kp_BixolonPrinter_requestStateOfSupporting()
	{
		___kp_executeURL("kioskpro://kp_BixolonPrinter_requestStateOfSupporting");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_BixolonPrinter_requestStateOfSupporting'] = function() { kp_BixolonPrinter_requestStateOfSupporting(); };
}

if (typeof(kp_BixolonPrinter_printHTMLString) !== "function")
{
	function kp_BixolonPrinter_printHTMLString(htmlString,cut)
	{
		___kp_executeURL("kioskpro://kp_BixolonPrinter_printHTMLString?" + encodeURIComponent(htmlString) + "&" + encodeURIComponent(cut));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_BixolonPrinter_printHTMLString'] = function(htmlString,cut) { kp_BixolonPrinter_printHTMLString(htmlString,cut); };
}

if (typeof(kp_BixolonPrinter_printHTMLElement) !== "function")
{
	function kp_BixolonPrinter_printHTMLElement(elementId,cut)
	{
		___kp_executeURL("kioskpro://kp_BixolonPrinter_printHTMLElement?" + encodeURIComponent(elementId) + "&" + encodeURIComponent(cut));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_BixolonPrinter_printHTMLElement'] = function(elementId,cut) { kp_BixolonPrinter_printHTMLElement(elementId,cut); };
}

if (typeof(kp_BixolonPrinter_printDocumentAtURL) !== "function")
{
	function kp_BixolonPrinter_printDocumentAtURL(documentURL,cut)
	{
		___kp_executeURL("kioskpro://kp_BixolonPrinter_printDocumentAtURL?" + encodeURIComponent(documentURL) + "&" + encodeURIComponent(cut));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_BixolonPrinter_printDocumentAtURL'] = function(documentURL,cut) { kp_BixolonPrinter_printDocumentAtURL(documentURL,cut); };
}

// Brother Printer API:
if (typeof(kp_BrotherPrinter_requestStateOfSupporting) !== "function")
{
	function kp_BrotherPrinter_requestStateOfSupporting()
	{
		___kp_executeURL("kioskpro://kp_BrotherPrinter_requestStateOfSupporting");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_BrotherPrinter_requestStateOfSupporting'] = function() { kp_BrotherPrinter_requestStateOfSupporting(); };
}

if (typeof(kp_BrotherPrinter_printHTMLString) !== "function")
{
	function kp_BrotherPrinter_printHTMLString(htmlString,cut,preview)
	{
		___kp_executeURL("kioskpro://kp_BrotherPrinter_printHTMLString?" + encodeURIComponent(htmlString) + "&" + encodeURIComponent(cut) + "&" + encodeURIComponent(preview));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_BrotherPrinter_printHTMLString'] = function(htmlString,cut,preview) { kp_BrotherPrinter_printHTMLString(htmlString,cut,preview); };
}

if (typeof(kp_BrotherPrinter_printHTMLStringEx) !== "function")
{
	function kp_BrotherPrinter_printHTMLStringEx(htmlString,cut,preview,scaleFactor,heightCorrector)
	{
		___kp_executeURL("kioskpro://kp_BrotherPrinter_printHTMLStringEx?" + encodeURIComponent(htmlString) + "&" + encodeURIComponent(cut) + "&" + encodeURIComponent(preview) + "&" + encodeURIComponent(scaleFactor) + "&" + encodeURIComponent(heightCorrector));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_BrotherPrinter_printHTMLStringEx'] = function(htmlString,cut,preview,scaleFactor,heightCorrector) { kp_BrotherPrinter_printHTMLStringEx(htmlString,cut,preview,scaleFactor,heightCorrector); };
}

if (typeof(kp_BrotherPrinter_printDocumentAtURL) !== "function")
{
	function kp_BrotherPrinter_printDocumentAtURL(documentURL,cut,preview)
	{
		___kp_executeURL("kioskpro://kp_BrotherPrinter_printDocumentAtURL?" + encodeURIComponent(documentURL) + "&" + encodeURIComponent(cut) + "&" + encodeURIComponent(preview));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_BrotherPrinter_printDocumentAtURL'] = function(documentURL,cut,preview) { kp_BrotherPrinter_printDocumentAtURL(documentURL,cut,preview); };
}

// Wand Blue Thermometer API:
if (typeof(kp_WBThermometerAPI_scanner_startDiscoveringThermometers) !== "function")
{
	function kp_WBThermometerAPI_scanner_startDiscoveringThermometers(duration)
	{
		___kp_executeURL("kioskpro://kp_WBThermometerAPI_scanner_startDiscoveringThermometers?" + encodeURIComponent(duration));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_WBThermometerAPI_scanner_startDiscoveringThermometers'] = function(duration) { kp_WBThermometerAPI_scanner_startDiscoveringThermometers(duration); };
}

if (typeof(kp_WBThermometerAPI_scanner_stopDiscoveringThermometers) !== "function")
{
	function kp_WBThermometerAPI_scanner_stopDiscoveringThermometers()
	{
		___kp_executeURL("kioskpro://kp_WBThermometerAPI_scanner_stopDiscoveringThermometers");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_WBThermometerAPI_scanner_stopDiscoveringThermometers'] = function() { kp_WBThermometerAPI_scanner_stopDiscoveringThermometers(); };
}

if (typeof(kp_WBThermometerAPI_scanner_isDiscovering) !== "function")
{
	function kp_WBThermometerAPI_scanner_isDiscovering(callback)
	{
		___kp_executeURL("kioskpro://kp_WBThermometerAPI_scanner_isDiscovering?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_WBThermometerAPI_scanner_isDiscovering'] = function(callback) { kp_WBThermometerAPI_scanner_isDiscovering(callback); };
}

if (typeof(kp_WBThermometerAPI_scanner_getDiscoveredThermometers) !== "function")
{
	function kp_WBThermometerAPI_scanner_getDiscoveredThermometers(callback)
	{
		___kp_executeURL("kioskpro://kp_WBThermometerAPI_scanner_getDiscoveredThermometers?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_WBThermometerAPI_scanner_getDiscoveredThermometers'] = function(callback) { kp_WBThermometerAPI_scanner_getDiscoveredThermometers(callback); };
}

if (typeof(kp_WBThermometerAPI_scanner_getRejectedThermometers) !== "function")
{
	function kp_WBThermometerAPI_scanner_getRejectedThermometers(callback)
	{
		___kp_executeURL("kioskpro://kp_WBThermometerAPI_scanner_getRejectedThermometers?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_WBThermometerAPI_scanner_getRejectedThermometers'] = function(callback) { kp_WBThermometerAPI_scanner_getRejectedThermometers(callback); };
}

if (typeof(kp_WBThermometerAPI_device_attachWithId) !== "function")
{
	function kp_WBThermometerAPI_device_attachWithId(identifier,callback)
	{
		___kp_executeURL("kioskpro://kp_WBThermometerAPI_device_attachWithId?" + encodeURIComponent(identifier) + "&" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_WBThermometerAPI_device_attachWithId'] = function(identifier,callback) { kp_WBThermometerAPI_device_attachWithId(identifier,callback); };
}

if (typeof(kp_WBThermometerAPI_device_detach) !== "function")
{
	function kp_WBThermometerAPI_device_detach()
	{
		___kp_executeURL("kioskpro://kp_WBThermometerAPI_device_detach");
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_WBThermometerAPI_device_detach'] = function() { kp_WBThermometerAPI_device_detach(); };
}

if (typeof(kp_WBThermometerAPI_device_getAttached) !== "function")
{
	function kp_WBThermometerAPI_device_getAttached(callback)
	{
		___kp_executeURL("kioskpro://kp_WBThermometerAPI_device_getAttached?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_WBThermometerAPI_device_getAttached'] = function(callback) { kp_WBThermometerAPI_device_getAttached(callback); };
}

if (typeof(kp_WBThermometerAPI_device_connect) !== "function")
{
	function kp_WBThermometerAPI_device_connect(duration,callback)
	{
		___kp_executeURL("kioskpro://kp_WBThermometerAPI_device_connect?" + encodeURIComponent(duration) + "&" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_WBThermometerAPI_device_connect'] = function(duration,callback) { kp_WBThermometerAPI_device_connect(duration,callback); };
}

if (typeof(kp_WBThermometerAPI_device_disconnect) !== "function")
{
	function kp_WBThermometerAPI_device_disconnect(callback)
	{
		___kp_executeURL("kioskpro://kp_WBThermometerAPI_device_disconnect?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_WBThermometerAPI_device_disconnect'] = function(callback) { kp_WBThermometerAPI_device_disconnect(callback); };
}

if (typeof(kp_WBThermometerAPI_device_subscribeForGettingTemperature) !== "function")
{
	function kp_WBThermometerAPI_device_subscribeForGettingTemperature(callback)
	{
		___kp_executeURL("kioskpro://kp_WBThermometerAPI_device_subscribeForGettingTemperature?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_WBThermometerAPI_device_subscribeForGettingTemperature'] = function(callback) { kp_WBThermometerAPI_device_subscribeForGettingTemperature(callback); };
}

if (typeof(kp_WBThermometerAPI_device_readRSSI) !== "function")
{
	function kp_WBThermometerAPI_device_readRSSI(callback)
	{
		___kp_executeURL("kioskpro://kp_WBThermometerAPI_device_readRSSI?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_WBThermometerAPI_device_readRSSI'] = function(callback) { kp_WBThermometerAPI_device_readRSSI(callback); };
}

// Accelerometer API:
if (typeof(kp_AccelerometerAPI_startListenToEvents) !== "function")
{
	function kp_AccelerometerAPI_startListenToEvents(callback)
	{
		___kp_executeURL("kioskpro://kp_AccelerometerAPI_startListenToEvents?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_AccelerometerAPI_startListenToEvents'] = function(callback) { kp_AccelerometerAPI_startListenToEvents(callback); };
}

if (typeof(kp_AccelerometerAPI_stopListenToEvents) !== "function")
{
	function kp_AccelerometerAPI_stopListenToEvents(callback)
	{
		___kp_executeURL("kioskpro://kp_AccelerometerAPI_stopListenToEvents?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_AccelerometerAPI_stopListenToEvents'] = function(callback) { kp_AccelerometerAPI_stopListenToEvents(callback); };
}

if (typeof(kp_AccelerometerAPI_getState) !== "function")
{
	function kp_AccelerometerAPI_getState(callback)
	{
		___kp_executeURL("kioskpro://kp_AccelerometerAPI_getState?" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_AccelerometerAPI_getState'] = function(callback) { kp_AccelerometerAPI_getState(callback); };
}

// InApp-Settings API:
if (typeof(kp_InAppSettings_triggerInAppSettings) !== "function")
{
	function kp_InAppSettings_triggerInAppSettings(requirePasscode,callback)
	{
		___kp_executeURL("kioskpro://kp_InAppSettings_triggerInAppSettings?" + encodeURIComponent(requirePasscode) + "&" + encodeURIComponent(callback));
	}
}

for (_kp_i_ = 0; _kp_i_ < _kp_frames_special_.length; ++_kp_i_)
{
	_kp_frames_special_[_kp_i_].contentWindow['kp_InAppSettings_triggerInAppSettings'] = function(requirePasscode,callback) { kp_InAppSettings_triggerInAppSettings(requirePasscode,callback); };
}


// Set hooks are available:
window.kioskpro_hooks_available = 1;
`;

var SIGNIN_HTML = `
<!-- CIMS — the merged consignor kiosk. One home screen with two entry
     tiles (Sign In / Check In, Print More Labels), matching the original
     kiosk design Brad approved -- but both tiles now resolve through the
     exact same real backend (getConsignorHome / submitCheckIn / printLabels),
     so neither one can ever reach label printing without the review screen
     happening first (unless it already happened earlier today). Embedded as
     a string in Code.gs and served via HtmlService.createHtmlOutput(). -->
<!DOCTYPE html>
<html>
<head>
  <base target="_top">
  <meta charset="utf-8">
  <!-- Kiosk Pro Enterprise's JS-API bridge (see KIOSK_FUNCTIONS_JS/doGet() in Code.gs). Loaded first,
       via an absolute URL per Kiosk Pro's own "by import" instructions, and harmless when this page is
       opened in a plain browser (e.g. testing in Safari) -- it just defines a pile of kp_* functions
       that nothing calls outside Kiosk Pro. -->
  <script src="https://script.google.com/macros/s/AKfycbzH3z9dVoUreUST72ISKBbxNBabhJOrrhmNyJGwZ72Rqs4laoQem15f2cCnPMG0NXCaRA/exec?asset=kiosk_functions"></script>
  <script src="https://script.google.com/macros/s/AKfycbzH3z9dVoUreUST72ISKBbxNBabhJOrrhmNyJGwZ72Rqs4laoQem15f2cCnPMG0NXCaRA/exec?asset=jsbarcode"></script>
  <style>
    :root {
      --ink: #2b2320;
      --muted: #79716b;
      --line: #e7e0d8;
      --accent: #1F3864;
      --accent-ink: #F4B942;
      --bg: #faf6f1;
      --card: #ffffff;
      --good: #3f7d5c;
      --warn: #b8863b;
      --bad: #b5433a;
      --fw: #a8552b;
      --fw-bg: #f5e5da;
      --ss: #2c7a80;
      --ss-bg: #dbedec;
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0; padding: 0; min-height: 100%;
      background: var(--bg);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: var(--ink);
    }
    .wrap { min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 28px 16px 60px; }
    .stage { width: 100%; max-width: 480px; }
    .kiosk-label {
      text-align: center; font-size: 0.78rem; letter-spacing: 0.08em;
      text-transform: uppercase; color: var(--muted); margin-bottom: 10px;
    }
    .card {
      width: 100%;
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 20px;
      padding: 40px 36px;
      box-shadow: 0 8px 30px rgba(43,35,32,0.06);
    }
    .logo { display: block; width: 70%; max-width: 280px; height: auto; margin: 0 auto 20px; }
    h1 { font-size: 1.6rem; margin: 0 0 4px; text-align: center; text-wrap: balance; }
    .sub { color: var(--muted); text-align: center; margin: 0 0 28px; font-size: 1.05rem; }
    input[type="tel"], input[type="text"], input[type="email"] {
      width: 100%; font-size: 1.8rem; padding: 18px 20px;
      border: 2px solid var(--line); border-radius: 14px;
      text-align: center; letter-spacing: 1px;
      background: var(--bg); color: var(--ink);
      font-variant-numeric: tabular-nums;
    }
    input:focus { outline: none; border-color: var(--accent); }
    button {
      width: 100%; font-size: 1.3rem; font-weight: 600;
      padding: 20px; margin-top: 14px;
      border: none; border-radius: 14px;
      background: var(--accent); color: var(--accent-ink);
      cursor: pointer; font-family: inherit;
    }
    button:active { opacity: 0.85; }
    button.secondary { background: transparent; color: var(--accent); border: 2px solid var(--accent); }
    button.ghost { background: transparent; color: var(--muted); border: none; font-weight: 500; font-size: 1rem; padding: 10px; }
    button:disabled { opacity: 0.45; cursor: default; }
    .error { color: var(--bad); text-align: center; margin-top: 14px; font-size: 1.05rem; min-height: 1.4em; }
    .brand { text-align: center; color: var(--muted); font-size: 0.85rem; margin-top: 22px; }
    .hidden { display: none !important; }

    .name-list button {
      background: var(--bg); color: var(--ink);
      border: 2px solid var(--line);
      text-align: left; font-weight: 500;
      margin-top: 10px;
    }

    /* home screen tiles */
    .home-btn {
      display: block; width: 100%; padding: 26px 20px; margin-top: 16px;
      border-radius: 16px; border: 2px solid var(--line); background: var(--bg);
      text-align: left; cursor: pointer; font-family: inherit;
    }
    .home-btn .emoji { font-size: 1.8rem; }
    .home-btn .t { display: block; font-size: 1.2rem; font-weight: 700; margin-top: 6px; color: var(--ink); }
    .home-btn .d { display: block; font-size: 0.92rem; color: var(--muted); margin-top: 3px; }
    .home-btn.primary { background: var(--accent); border-color: var(--accent); cursor: default; }
    .home-btn.primary .t { color: var(--accent-ink); }
    .home-btn.primary .d { color: #cdd7e6; }
    .home-btn.primary.expanded { background: var(--bg); }
    .home-btn.primary.expanded .t { color: var(--ink); }
    .home-btn.primary.expanded .d { color: var(--muted); }
    #printLabelsCollapsed, #signInCollapsed { cursor: pointer; }
    #printLabelsExpanded input, #printLabelsExpanded button,
    #signInExpanded input, #signInExpanded button { margin-top: 12px; }
    #printLabelsExpanded button.ghost, #signInExpanded button.ghost { margin-top: 4px; }

    .field { text-align: left; margin-bottom: 16px; }
    .field label { display: block; font-size: 0.85rem; color: var(--muted); margin-bottom: 6px; }
    .field input { font-size: 1.15rem; padding: 14px 16px; text-align: left; letter-spacing: normal; font-family: inherit; }

    .season-check {
      display: flex; align-items: center; gap: 14px;
      width: 100%; padding: 18px 18px; margin-top: 12px;
      border: 2px solid var(--line); border-radius: 14px;
      background: var(--bg); cursor: pointer; text-align: left;
    }
    .season-check input[type="checkbox"] { width: 26px; height: 26px; flex: none; accent-color: var(--accent); }
    .season-check .cb-label { font-size: 1.1rem; font-weight: 600; }
    .season-check.checked { border-color: var(--accent); background: #eef1f7; }
    .category-sub { margin: 26px 0 0; padding-top: 20px; border-top: 1px solid var(--line); }
    .optional-tag { font-size: 0.85rem; font-weight: 400; }
    .consent-label { font-size: 0.92rem; font-weight: 400; line-height: 1.45; }
    .consent-label a { color: var(--accent); font-weight: 700; }

    .notfound-icon, .status-box .icon { font-size: 2.6rem; text-align: center; margin-bottom: 8px; }
    .status-box { text-align: center; padding: 20px 8px 8px; }
    .status-box p { font-size: 1.1rem; line-height: 1.5; margin: 0 0 4px; }
    .status-box.open .icon { color: var(--good); }
    .status-box.capped .icon { color: var(--warn); }
    .status-box.closed .icon { color: var(--bad); }

    .today-card {
      background: var(--bg); border: 1px solid var(--line); border-radius: 14px;
      padding: 16px 18px; margin-bottom: 22px;
    }
    .today-card .label { font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin-bottom: 10px; }
    .today-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
    .today-row + .today-row { margin-top: 8px; }
    .season-chip { display: inline-flex; align-items: center; gap: 7px; font-size: 0.95rem; font-weight: 600; }
    .dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
    .dot.fw { background: var(--fw); }
    .dot.ss { background: var(--ss); }
    .today-row b { font-variant-numeric: tabular-nums; font-size: 1.05rem; }

    .season-block { margin-bottom: 22px; }
    .season-head { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; font-weight: 700; }
    .stepper { display: flex; align-items: center; justify-content: center; gap: 22px; }
    .stepper button {
      width: 58px; height: 58px; border-radius: 50%;
      font-size: 1.8rem; margin: 0; padding: 0;
      display: flex; align-items: center; justify-content: center; line-height: 1;
    }
    .stepper .count { font-size: 2.4rem; font-weight: 700; min-width: 70px; text-align: center; font-variant-numeric: tabular-nums; }
    .total-line { text-align: center; color: var(--muted); font-size: 0.95rem; margin: 4px 0 4px; }
    .total-line b { color: var(--ink); }

    /* label preview -- scaled to a real Brother DK-1202 shipping label,
       100mm x 62mm, printed landscape */
    .preview-row { display: flex; flex-wrap: wrap; justify-content: center; align-items: flex-start; gap: 26px; margin-bottom: 4px; }
    .label-preview { position: relative; flex: none; }
    .label-art {
      position: relative; z-index: 1; overflow: hidden;
      width: 158px; height: 97px; background: #fff;
      border: 1px solid var(--line); border-radius: 4px;
      // Was 8px 12px / gap:4px. At the old values, 97px on-screen height
      // * the 2.3696 print scale = 229.85px against a HARD 230.4px (2.4in)
      // physical ceiling -- about half a pixel of real margin, total. Any
      // real content (actual name/phone/category badge, rendered on an
      // actual iPad instead of however this was last verified) landing
      // even 1px taller than assumed silently clipped off whatever was
      // last in the layout -- the barcode + Tote ID row -- with no error,
      // producing an unscannable physical label. Trimmed padding/gap here
      // instead of any font-size, so nothing visually shrinks or
      // truncates; it just reclaims ~10px of on-screen headroom (~24px /
      // ~0.25in of real print-time slack) as an actual safety margin
      // instead of an theoretical exact fit that broke on first real use.
      padding: 6px 12px; display: flex; flex-direction: column; gap: 2px;
      box-shadow: 0 2px 8px rgba(43,35,32,0.08);
    }
    .label-art .season-word {
      display: flex; align-items: center; gap: 3px;
      font-size: 0.58rem; font-weight: 800; text-transform: uppercase;
      letter-spacing: 0.01em; line-height: 1.1; color: var(--ink);
      /* Bleeds to the label's edges by default (cancels .label-art's own
         padding) so the fw bar below can span edge-to-edge; ss's plain
         variant below adds the padding back since it doesn't need to.
         Side padding trimmed from 12px to 9px -- freed-up width that
         matters once 3 category badges are on the same line (see below);
         font-size/letter-spacing/gap also nudged down slightly for the
         same reason, so "Spring/Summer" + all three badges fits without
         truncating -- verified against a real-scale render, not just
         eyeballed on the enlarged kiosk preview. */
      // Top margin matches .label-art's padding above (now 6px, was 8px)
      // so the fw black bar still bleeds exactly to the label's top edge.
      margin: -6px -12px 0; padding: 5px 9px;
    }
    .label-art .season-icon { font-size: 0.74rem; line-height: 1; }
    /* The season text itself can still shrink/ellipsize as a last resort
       (e.g. an unexpectedly long name pushing things), but with the sizing
       below it now fits in full for every real combination, including all
       three category badges at once. */
    .label-art .season-text { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    /* Childrens/Womens/Mens badges -- see categoryBadgesHtml_() above.
       Small monogram-style circles, one per selected category, pinned to
       the right end of the season line. Flush against the row's right
       edge because .season-text (flex:1) already pushes them there --
       no margin-left:auto needed. Sized to NOT exceed the season-icon's
       own box -- align-items:center sizes this whole row to its tallest
       child, so a badge taller than the icon would silently grow the row
       (and push everything below it down toward the label's
       overflow:hidden bottom edge, clipping descenders on the name
       below). 11px stays at/under that ceiling. */
    .label-art .category-badges { display: flex; gap: 1.5px; flex: none; margin-left: 2px; }
    .label-art .category-badge {
      width: 11px; height: 11px; border-radius: 50%; flex: none;
      display: flex; align-items: center; justify-content: center;
      font-family: Georgia, "Times New Roman", serif; font-weight: 700;
      font-size: 0.4rem; line-height: 1;
    }
    /* Black ink only -- see seasonWordHtml_() above. Fall/Winter: solid
       black bar, white knockout text. Everything else (Spring/Summer):
       plain, no bar -- just the label's normal white background showing
       through, with room restored above it since it's not bleeding.
       No margin-bottom here anymore (used to add its own 4px on top of
       the shared .label-art gap:4px, eating extra vertical room this
       label doesn't have to spare) -- the shared gap alone now matches
       ss's spacing exactly. */
    .label-art.fw .season-word { background: #000; color: #fff; }
    /* fw's badges punch through the black bar as solid white "coins";
       ss's are a plain black-outlined ring on the white label background --
       same monogram-stamp feel, inverted to match each variant's ink. */
    .label-art.fw .category-badge { background: #fff; color: #000; }
    .label-art.ss .category-badge { background: none; color: #000; border: 1.1px solid #000; }
    /* Spring/Summer has no bar to fill, but gets a full-width black rule
       positioned so its line lands exactly where the fw bar's black
       background ends (5px padding-top + 1 line of text + 5px padding-
       bottom = the "T+10" point) -- same 2px bottom-padding offset lines
       it up. Keeps a consistent "something black ends here" landmark on
       both label variants even though only one of them is filled. */
    .label-art.ss .season-word { margin: 0 -12px 0; padding: 0 9px 2px; border-bottom: 2px solid #000; }
    .label-art .date-word, .label-art .tagid-name {
      font-size: 0.85rem; font-weight: 800; color: var(--ink); line-height: 1.15;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    .label-art .date-word { font-variant-numeric: tabular-nums; }
    .label-art .contact-line {
      font-size: 0.5rem; font-weight: 600; color: var(--muted); line-height: 1.15;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    }
    /* Barcode + Tote ID sit side by side in their own row rather than the
       number floating on top of the barcode -- a full-width barcode with
       an absolutely-positioned number in the bottom-right corner meant the
       number sat right inside the barcode's own drawn area (the bars fill
       that whole rectangle top-to-bottom), so it read as the barcode
       covering the number. Giving the barcode flex:1 (it shrinks to
       whatever width is left) and the number flex:none (it always keeps
       its full width) guarantees they never overlap, at any label size. */
    .label-art .label-bottom-row { margin-top: auto; display: flex; align-items: flex-end; gap: 6px; }
    .label-art .barcode-wrap { flex: 1 1 auto; min-width: 0; height: 26px; }
    /* No CSS width/height here on purpose -- see fitBarcodeSvg_() below.
       This used to be a CSS width:100%/height:100% rule (stretch the
       barcode's own <svg> to fill this flex box), which worked fine on screen and
       in every render we tested here, but on a real iPad print it came
       out the opposite of "fit": the barcode printed enormous, filling
       most of the label. Percentage sizing on an element nested inside a
       transform:scale() ancestor (see #printArea .label-art's print-time
       transform above) is a known-flaky combination specifically in
       WebKit's print layout path, separate from how the same page
       renders on screen -- which is exactly why it looked right in every
       preview and screenshot taken here but not on the printer itself.
       fitBarcodeSvg_() sizes the SVG with explicit width/height + viewBox
       attributes instead, the same mechanism an <img> uses to scale --
       no percentages, no dependency on the flex/transform context above
       it resolving correctly. */
    .label-art .tagid-num {
      flex: none;
      font-size: 0.5rem; color: var(--muted); font-variant-numeric: tabular-nums;
    }
    .qty-badge {
      position: absolute; top: -10px; right: -10px; z-index: 2;
      background: var(--accent); color: var(--accent-ink);
      font-size: 0.85rem; font-weight: 800;
      padding: 4px 10px; border-radius: 999px;
      box-shadow: 0 2px 6px rgba(43,35,32,0.2);
    }
    .label-scale-note { text-align: center; color: var(--muted); font-size: 0.78rem; margin: 12px 0 0; }

    /* Real print output for the Brother QL-810W (DK-1202, 3.9in x 2.4in
       landscape shipping label). Printing clones the exact same .label-art
       markup used in the on-screen preview/success cards above into
       #printArea (invisible on screen), then blows it up to true physical
       size with one CSS transform -- so whatever the preview already shows
       is exactly what comes out of the printer, with no separate print
       stylesheet to hand-maintain and let drift out of sync. The scale
       factor (2.3696) is target-width-in-px / on-screen .label-art width:
       (3.9in * 96px/in) / 158px -- if .label-art's width/height above ever
       change, this needs to change with it.

       Isolating #printArea at print time used to be done with the classic
       "visibility:hidden on everything, visibility:visible on the one
       thing you want" trick. That silently broke on real hardware: it
       leaves every hidden element's layout box in place (visibility never
       removes an element from flow the way display:none does), and .wrap
       below carries a 100vh min-height for its on-screen centering -- so
       print saw one still-100vh-tall invisible box sitting in the flow
       above a 62mm-tall label page, and paginated it into a stack of
       blank pages. Simpler and more robust: collapse the entire on-screen
       kiosk with display:none (which #printArea now lives outside of, see
       its own comment by the HTML below) instead of trying to hide it
       piece by piece. */
    #printArea { position: absolute; left: -9999px; top: 0; width: 0; height: 0; overflow: hidden; }
    @media print {
      @page { size: 100mm 62mm; margin: 0; }
      html, body { margin: 0; padding: 0; }
      .wrap { display: none !important; }
      #printArea { position: absolute; left: 0; top: 0; width: auto; height: auto; overflow: visible; }
      #printArea .print-label {
        width: 3.9in; height: 2.4in; position: relative; overflow: hidden;
        page-break-after: always;
      }
      #printArea .print-label:last-child { page-break-after: auto; }
      #printArea .label-art {
        position: absolute; top: 0; left: 0; transform-origin: top left;
        transform: scale(2.3696);
        box-shadow: none !important; border: none !important; border-radius: 0 !important;
      }
    }

    .printer-anim {
      width: 64px; height: 64px; margin: 4px auto 14px; border-radius: 50%;
      border: 5px solid var(--line); border-top-color: var(--accent);
      animation: spin 0.9s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    @media (prefers-reduced-motion: reduce) { .printer-anim { animation-duration: 2.4s; } }
    .reset-note { text-align: center; color: var(--muted); font-size: 0.85rem; margin-top: 16px; }

    /* Persistent escape hatch -- shown on every screen except Home (already
       the start) and the brief auto-advancing Printing animation. Exists
       specifically so a stuck/confused consignor always has one predictable
       way out, regardless of whether that screen also has its own more
       specific "Back" control. */
    .global-start-over { text-align: center; margin-top: 24px; padding-top: 18px; border-top: 1px solid var(--line); }
    .global-start-over button.ghost { font-size: 0.95rem; padding: 12px 18px; }

    .id-range { text-align: center; font-variant-numeric: tabular-nums; color: var(--muted); font-size: 0.92rem; margin: -6px 0 18px; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="stage">
      <div class="kiosk-label">Consignor Desk Kiosk</div>
      <div class="card">
              <img class="logo" id="logoImg" src="data:image/png;base64,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" alt="The Adorable Child &amp; NextYZ Consignment Marketplace">

        <!-- HOME -->
        <div id="screen-home">
          <h1>Welcome</h1>
          <p class="sub">What are you here to do?</p>

          <div class="home-btn" id="signInCard">
            <div id="signInCollapsed" role="button" tabindex="0"
                 onclick="expandSignIn()" onkeydown="if(event.key==='Enter')expandSignIn()">
              <span class="emoji">✅</span>
              <span class="t">Sign In / Check In</span>
              <span class="d">First stop when you arrive with your totes</span>
            </div>
            <div id="signInExpanded" class="hidden">
              <span class="emoji">✅</span>
              <span class="t">Sign In / Check In</span>
              <span class="d">Enter your phone number to get started.</span>
              <input type="tel" id="phoneInputSignin" placeholder="(555) 555-5555" inputmode="numeric">
              <button onclick="doSignInLookup()">Continue</button>
              <button class="ghost" onclick="collapseSignIn()">Cancel</button>
              <div class="error" id="phoneErrorSignin"></div>
            </div>
          </div>

          <div class="home-btn primary" id="printLabelsCard">
            <div id="printLabelsCollapsed" role="button" tabindex="0"
                 onclick="expandPrintLabels()" onkeydown="if(event.key==='Enter')expandPrintLabels()">
              <span class="emoji">🏷️</span>
              <span class="t">Print More Labels</span>
              <span class="d">Already checked in and need more labels?</span>
            </div>
            <div id="printLabelsExpanded" class="hidden">
              <span class="emoji">🏷️</span>
              <span class="t">Print More Labels</span>
              <span class="d">Enter your phone number to pick up where you left off.</span>
              <input type="tel" id="phoneInput" placeholder="(555) 555-5555" inputmode="numeric">
              <button onclick="doLookup()">Continue</button>
              <button class="ghost" onclick="collapsePrintLabels()">Cancel</button>
              <div class="error" id="phoneError"></div>
            </div>
          </div>
        </div>

        <!-- MULTIPLE MATCHES -->
        <div id="screen-pick" class="hidden">
          <h1>Which account is yours?</h1>
          <p class="sub">This phone number matches more than one account.</p>
          <div class="name-list" id="nameList"></div>
          <button class="secondary" onclick="goto('screen-home')">Back</button>
        </div>

        <!-- NOT FOUND -->
        <div id="screen-notfound" class="hidden">
          <div class="notfound-icon">🔍</div>
          <h1>No Account Found</h1>
          <p class="sub" id="notFoundText">We couldn't find an account with that phone number.</p>
          <button onclick="showSignup()">I'm New — Sign Me Up</button>
          <button onclick="showStaffAssist()">I've Consigned Before</button>
          <button class="secondary" onclick="retryLookup()">Try a Different Number</button>
        </div>

        <!-- EXISTING CONSIGNOR, PHONE NOT ON FILE -->
        <div id="screen-staffassist" class="hidden">
          <div class="notfound-icon">🙋</div>
          <h1>Let's Get You Sorted</h1>
          <p class="sub">We couldn't match that number to an account on file. A team member can look up your account or add your new number for you — just let someone at the front know.</p>
          <button onclick="goto('screen-home')">Back to Start</button>
        </div>

        <!-- ALREADY CHECKED IN TODAY (arrived via Sign In / Check In) -->
        <div id="screen-already-checkedin" class="hidden">
          <div class="status-box">
            <div class="icon">✅</div>
            <h1>Hi again, <span id="alreadyName"></span></h1>
            <p class="sub">You're already checked in for today. Need more labels for the totes you're still filling?</p>
          </div>
          <button onclick="enterCounts()">Print More Labels</button>
          <button class="secondary" onclick="goto('screen-home')">Done</button>
        </div>

        <!-- NO SESSION TODAY (arrived via Print More Labels) -->
        <div id="screen-nosession" class="hidden">
          <div class="status-box">
            <div class="icon">👋</div>
            <h1>Hi, <span id="noSessionName"></span></h1>
            <p class="sub">We don't see a check-in for you today yet — let's get you Signed In and Checked In first. Then you can come back here anytime for more labels. 🙂</p>
          </div>
          <button onclick="goto('screen-checkin-review')">Sign In / Check In</button>
        </div>

        <!-- REVIEW INFO (first check-in of the day, new or existing) -->
        <div id="screen-checkin-review" class="hidden">
          <h1>Review Your Information</h1>
          <p class="sub">Please confirm your details, or make changes if anything's out of date.</p>
          <div class="field">
            <label for="reviewName">Full Name</label>
            <input type="text" id="reviewName" placeholder="Jane Smith">
          </div>
          <div class="field">
            <label for="reviewPhone">Phone Number</label>
            <input type="tel" id="reviewPhone" inputmode="numeric" placeholder="(555) 555-5555">
          </div>
          <div class="field">
            <label for="reviewEmail">Email</label>
            <input type="email" id="reviewEmail" placeholder="jane@example.com">
          </div>
          <div class="field">
            <label for="reviewZip">Zip Code</label>
            <input type="text" id="reviewZip" inputmode="numeric" placeholder="37918">
          </div>
          <label class="season-check" id="consentRow">
            <input type="checkbox" id="cbConsent" onchange="toggleConsent()">
            <span class="cb-label consent-label">I have read and agree to the
              <a href="https://www.adorableonline.co/pages/how-to-consign-rev-october-2021" target="_blank" rel="noopener" onclick="event.stopPropagation()">Consignment Guidelines</a>.</span>
          </label>
          <button id="reviewContinueBtn" onclick="doReviewContinue()" disabled>Looks Good, Continue</button>
          <button class="ghost" onclick="goto('screen-home')">&larr; Back to start</button>
          <div class="error" id="reviewError"></div>
        </div>

        <!-- SEASON -->
        <div id="screen-checkin-season" class="hidden">
          <h1>What are you dropping off?</h1>
          <p class="sub">Check all that apply — most consignors bring some of each.</p>
          <label class="season-check" id="checkFW">
            <input type="checkbox" id="cbFW" onchange="toggleSeasonCheck('FW')">
            <span class="cb-label">Fall / Winter</span>
          </label>
          <label class="season-check" id="checkSS">
            <input type="checkbox" id="cbSS" onchange="toggleSeasonCheck('SS')">
            <span class="cb-label">Spring / Summer</span>
          </label>

          <!-- Childrens/Womens/Mens used to be asked right here, once, at
               sign-in. Moved to the counts screen (below) instead -- it's
               asked fresh before every print request now (reprints, "Need
               Even More?", etc. included), not just the very first one of
               the day, since what's in someone's hands at 9am may not be
               what's in their hands at 2pm. See toggleCategoryCheck() and
               prepareCounts() for the rest of this. -->

          <button id="checkInBtn" onclick="doCheckIn()" disabled>Check In</button>
          <button class="ghost" onclick="goto('screen-checkin-review')">&larr; Back</button>
          <div class="error" id="seasonError"></div>
        </div>

        <!-- POST-CHECK-IN STATUS (welcome / heads-up / hard block) -->
        <div id="screen-status" class="hidden">
          <div class="status-box" id="statusBox">
            <div class="icon" id="statusIcon"></div>
            <p id="statusMessage"></p>
          </div>
          <button id="statusContinueBtn" onclick="enterCounts()" class="hidden">Print Some Labels Now</button>
          <button id="statusDoneBtn" class="hidden secondary" onclick="goto('screen-home')">Done</button>
        </div>

        <!-- SEASON COUNTS (both first-visit-continuing and repeat visits land here) -->
        <div id="screen-counts" class="hidden">
          <h1>Hi, <span id="countsName"></span>!</h1>
          <p class="sub">How many labels do you need?</p>

          <div class="today-card">
            <div class="label">Printed so far today</div>
            <div class="today-row">
              <span class="season-chip"><span class="dot fw"></span>Fall/Winter</span>
              <b id="todayFW">0</b>
            </div>
            <div class="today-row">
              <span class="season-chip"><span class="dot ss"></span>Spring/Summer</span>
              <b id="todaySS">0</b>
            </div>
          </div>

          <div class="season-block">
            <div class="season-head"><span class="dot fw"></span>Fall/Winter labels</div>
            <div class="stepper">
              <button onclick="changeCount('fw', -1)">&minus;</button>
              <div class="count" id="addFW">0</div>
              <button onclick="changeCount('fw', 1)">+</button>
            </div>
          </div>

          <div class="season-block">
            <div class="season-head"><span class="dot ss"></span>Spring/Summer labels</div>
            <div class="stepper">
              <button onclick="changeCount('ss', -1)">&minus;</button>
              <div class="count" id="addSS">0</div>
              <button onclick="changeCount('ss', 1)">+</button>
            </div>
          </div>

          <p class="sub category-sub">What kind of items? <span class="optional-tag">(optional, check all that apply)</span></p>
          <label class="season-check" id="checkCatC">
            <input type="checkbox" id="cbCatC" onchange="toggleCategoryCheck('C')">
            <span class="cb-label">Childrens</span>
          </label>
          <label class="season-check" id="checkCatW">
            <input type="checkbox" id="cbCatW" onchange="toggleCategoryCheck('W')">
            <span class="cb-label">Womens</span>
          </label>
          <label class="season-check" id="checkCatM">
            <input type="checkbox" id="cbCatM" onchange="toggleCategoryCheck('M')">
            <span class="cb-label">Mens</span>
          </label>

          <p class="total-line">Requesting <b id="addTotal">0</b> label<span id="addPlural">s</span> this visit</p>
          <button id="previewBtn" onclick="goToPreview()" disabled>Review &amp; Print</button>
          <button class="ghost" onclick="goto('screen-home')">&larr; Back to start</button>
        </div>

        <!-- LABEL PREVIEW -->
        <div id="screen-preview" class="hidden">
          <h1>Confirm Your Labels</h1>
          <p class="sub">Here's what will print.</p>
          <div id="previewList"></div>
          <button id="printBtn" onclick="doPrint()">🖨️ Print Labels</button>
          <button class="ghost" onclick="goto('screen-counts')">&larr; Edit counts</button>
          <div class="error" id="printError"></div>
        </div>

        <!-- PRINTING -->
        <div id="screen-printing" class="hidden">
          <div class="status-box">
            <div class="printer-anim"></div>
            <p>Printing your labels&hellip;</p>
          </div>
        </div>

        <!-- SUCCESS -->
        <div id="screen-success" class="hidden">
          <div class="status-box">
            <div class="icon">🎉</div>
            <p><b id="successCount"></b> printed. Peel each label and stick one to its tote.</p>
          </div>
          <div class="id-range" id="successRange"></div>
          <div id="successList"></div>
          <button onclick="enterCounts()">Need Even More?</button>
          <button class="secondary" onclick="goto('screen-home')">Done</button>
          <div class="reset-note">This screen returns to Welcome automatically in a bit.</div>
        </div>

        <!-- Persistent "Start Over" -- always in the DOM (not part of SCREENS),
             shown/hidden by goto() below. A guaranteed way out of any screen
             if something hangs or a call fails, on top of whatever
             screen-specific Back control already exists there. -->
        <div id="globalStartOver" class="global-start-over hidden">
          <button class="ghost" onclick="goto('screen-home')">&larr; Start Over</button>
        </div>

        <div class="brand">The Adorable Child &middot; CIMS</div>
      </div>
    </div>
  </div>

  <!-- Populated right before window.print() in triggerPrint_() below;
       invisible on screen (see #printArea CSS). Deliberately a direct
       child of <body>, OUTSIDE .wrap -- not nested inside it like it used
       to be. At print time we hide the whole kiosk by collapsing .wrap
       (see @media print above), and .wrap carries a 100vh min-height
       for its on-screen centering. A merely-invisible (visibility:hidden)
       100vh box still occupies that full height in the page's print flow,
       and against a label-sized @page (62mm tall) that alone was enough
       to paginate into a stack of blank pages -- which is what was
       actually happening on real hardware. Keeping #printArea outside
       .wrap means collapsing .wrap with display:none removes all of that
       height instantly, with nothing left in the print flow but the one
       label (or N labels) we actually want. -->
  <div id="printArea"></div>

  <script>
    var currentId = null;      // real AccountID, or a NEW... tempId
    var currentMode = null;    // 'account' | 'pending' | 'new'
    var currentName = '';
    var currentPhone = '';     // on-file/just-confirmed phone -- printed on labels for pricers
    var currentEmail = '';     // on-file/just-confirmed email -- printed on labels for pricers
    var checkinSeason = { FW: false, SS: false };
    var checkinCategory = { C: false, W: false, M: false }; // Childrens/Womens/Mens -- optional, whole-visit tag
    var currentCategoryNote = ''; // e.g. "C", "CW", "CWM" -- printed as badges on every label this visit
    var add = { fw: 0, ss: 0 };
    var lastTotesMade = [];
    var autoResetTimer = null;
    var lastLookupSource = 'labels'; // 'signin' | 'labels' -- which home tile started the current lookup
    var lastTypedPhone = '';         // so "I'm New" can prefill the number they just typed

    var SCREENS = [
      'screen-home', 'screen-pick', 'screen-notfound', 'screen-staffassist',
      'screen-already-checkedin', 'screen-nosession',
      'screen-checkin-review', 'screen-checkin-season', 'screen-status',
      'screen-counts', 'screen-preview', 'screen-printing', 'screen-success'
    ];

    function goto(id) {
      if (autoResetTimer) { clearTimeout(autoResetTimer); autoResetTimer = null; }
      SCREENS.forEach(function (s) { document.getElementById(s).classList.toggle('hidden', s !== id); });
      // Home is already the start (nothing to escape to), and Printing is a
      // ~1.1s auto-advancing animation -- every other screen gets the
      // persistent Start Over link.
      var startOverEl = document.getElementById('globalStartOver');
      if (startOverEl) startOverEl.classList.toggle('hidden', id === 'screen-home' || id === 'screen-printing');
      if (id === 'screen-home') {
        currentId = null; currentMode = null; currentName = '';
        checkinSeason = { FW: false, SS: false };
        checkinCategory = { C: false, W: false, M: false };
        currentCategoryNote = '';
        add = { fw: 0, ss: 0 };
        // Un-check and un-highlight the season/category boxes themselves --
        // this is a single-page app, so the checkbox elements otherwise
        // stay visually checked from the last visit even though the JS
        // state above has already been cleared (the next consignor would
        // see the previous person's boxes still ticked).
        ['FW', 'SS'].forEach(function (s) {
          document.getElementById('cb' + s).checked = false;
          document.getElementById('check' + s).classList.remove('checked');
        });
        ['C', 'W', 'M'].forEach(function (c) {
          document.getElementById('cbCat' + c).checked = false;
          document.getElementById('checkCat' + c).classList.remove('checked');
        });
        collapseSignIn();
        collapsePrintLabels();
      }
      if (id === 'screen-preview') renderPreview();
    }

    function retryLookup() {
      goto('screen-home');
      if (lastLookupSource === 'signin') { expandSignIn(); } else { expandPrintLabels(); }
    }

    function expandSignIn() {
      document.getElementById('signInCollapsed').classList.add('hidden');
      document.getElementById('signInExpanded').classList.remove('hidden');
      document.getElementById('signInCard').classList.add('expanded');
      document.getElementById('phoneInputSignin').focus();
    }

    function collapseSignIn() {
      document.getElementById('signInCollapsed').classList.remove('hidden');
      document.getElementById('signInExpanded').classList.add('hidden');
      document.getElementById('signInCard').classList.remove('expanded');
      document.getElementById('phoneInputSignin').value = '';
      document.getElementById('phoneErrorSignin').textContent = '';
    }

    function expandPrintLabels() {
      document.getElementById('printLabelsCollapsed').classList.add('hidden');
      document.getElementById('printLabelsExpanded').classList.remove('hidden');
      document.getElementById('printLabelsCard').classList.add('expanded');
      document.getElementById('phoneInput').focus();
    }

    function collapsePrintLabels() {
      document.getElementById('printLabelsCollapsed').classList.remove('hidden');
      document.getElementById('printLabelsExpanded').classList.add('hidden');
      document.getElementById('printLabelsCard').classList.remove('expanded');
      document.getElementById('phoneInput').value = '';
      document.getElementById('phoneError').textContent = '';
    }

    function normalizePhone(v) { return (v || '').replace(/\D/g, ''); }

    function formatPhone(digits) {
      digits = (digits || '').replace(/\D/g, '');
      if (digits.length !== 10) return digits;
      return '(' + digits.slice(0, 3) + ') ' + digits.slice(3, 6) + '-' + digits.slice(6);
    }

    function doSignInLookup() {
      lastLookupSource = 'signin';
      runLookup(document.getElementById('phoneInputSignin').value, document.getElementById('phoneErrorSignin'));
    }

    function doLookup() {
      lastLookupSource = 'labels';
      runLookup(document.getElementById('phoneInput').value, document.getElementById('phoneError'));
    }

    function runLookup(raw, errEl) {
      errEl.textContent = '';
      lastTypedPhone = raw;
      if (normalizePhone(raw).length < 7) {
        errEl.textContent = 'Please enter a valid phone number.';
        return;
      }
      // lookupAndResolve does the phone match AND (for the normal one-match
      // case) the home-state check in a single round trip -- two separate
      // google.script.run calls back-to-back is most of where the multi-
      // second delay was coming from, since each call carries its own fixed
      // Apps Script overhead on top of however long the work itself takes.
      google.script.run
        .withSuccessHandler(function (res) {
          if (!res.ok) { errEl.textContent = res.error; return; }
          if (res.matches.length === 0) {
            document.getElementById('notFoundText').textContent =
              res.notFoundMessage || "We couldn't find an account with that phone number.";
            goto('screen-notfound');
            return;
          }
          if (res.matches.length === 1 && res.single) {
            applyHome(res.single.id, res.single.mode, res.single.home, errEl);
          } else {
            renderNameList(res.matches);
            goto('screen-pick');
          }
        })
        .withFailureHandler(function () {
          errEl.textContent = 'Something went wrong. Please try again or see a staff member.';
        })
        .lookupAndResolve(raw);
    }

    function renderNameList(matches) {
      var list = document.getElementById('nameList');
      list.innerHTML = '';
      matches.forEach(function (m) {
        var b = document.createElement('button');
        b.textContent = m.name;
        b.onclick = function () { resolveMatch(m); };
        list.appendChild(b);
      });
    }

    // The single gate everything routes through, no matter which home tile
    // started the lookup, and whether it came from the fast single-round-trip
    // path (runLookup) or the multi-match picker (resolveMatch below):
    // hasSessionToday decides review-first vs. straight to labels, and which
    // nudge screen explains the difference.
    function applyHome(id, mode, home, errEl) {
      if (!home || !home.ok) {
        errEl.textContent = (home && home.error) || 'Something went wrong. Please see a staff member.';
        return;
      }
      currentId = id; currentMode = mode; currentName = home.name;
      currentPhone = home.phone || ''; currentEmail = home.email || '';
      if (home.hasSessionToday) {
        if (lastLookupSource === 'signin') {
          document.getElementById('alreadyName').textContent = home.name;
          goto('screen-already-checkedin');
        } else {
          prepareCounts(home.name, home.todayCounts);
          goto('screen-counts');
        }
      } else {
        if (lastLookupSource === 'labels') {
          document.getElementById('noSessionName').textContent = home.name;
          goto('screen-nosession');
        } else {
          fillReview(home.name, home.phone, home.email, home.zip);
          goto('screen-checkin-review');
        }
      }
    }

    // Only reached from the multi-match "which account is yours" picker --
    // there's no way to resolve home-state until the person picks one, so
    // this is still a second round trip (rare: only shared phone numbers).
    function resolveMatch(match) {
      var mode = match.type === 'pending' ? 'pending' : 'account';
      var id = match.type === 'pending' ? match.tempId : match.accountId;
      var errEl = lastLookupSource === 'signin'
        ? document.getElementById('phoneErrorSignin')
        : document.getElementById('phoneError');
      google.script.run
        .withSuccessHandler(function (res) { applyHome(id, mode, res, errEl); })
        // Surface the real error instead of silently collapsing back to the
        // tiles -- that silent reset is exactly what looked like "goes
        // nowhere, then back to home" when a required sheet was missing.
        .withFailureHandler(function (err) {
          errEl.textContent = 'Something went wrong: ' + (err && err.message ? err.message : 'please see a staff member.');
        })
        .getConsignorHome(id, mode);
    }

    function fillReview(name, phone, email, zip) {
      document.getElementById('reviewName').value = name || '';
      document.getElementById('reviewPhone').value = formatPhone(normalizePhone(phone || ''));
      document.getElementById('reviewEmail').value = email || '';
      document.getElementById('reviewZip').value = zip || '';
      resetConsent();
    }

    function showSignup() {
      currentId = null; currentMode = 'new'; currentName = '';
      fillReview('', lastTypedPhone, '', '');
      goto('screen-checkin-review');
    }

    function showStaffAssist() {
      goto('screen-staffassist');
    }

    function toggleConsent() {
      var checked = document.getElementById('cbConsent').checked;
      document.getElementById('consentRow').classList.toggle('checked', checked);
      document.getElementById('reviewContinueBtn').disabled = !checked;
    }

    function resetConsent() {
      document.getElementById('cbConsent').checked = false;
      document.getElementById('consentRow').classList.remove('checked');
      document.getElementById('reviewContinueBtn').disabled = true;
    }

    function doReviewContinue() {
      var errEl = document.getElementById('reviewError');
      errEl.textContent = '';
      var name = document.getElementById('reviewName').value.trim();
      var phone = document.getElementById('reviewPhone').value.trim();
      var email = document.getElementById('reviewEmail').value.trim();
      var zip = document.getElementById('reviewZip').value.trim();
      if (!name) { errEl.textContent = 'Please enter your name.'; return; }
      if (normalizePhone(phone).length < 7) { errEl.textContent = 'Please enter a valid phone number.'; return; }
      if (!email) { errEl.textContent = 'Please enter an email address.'; return; }
      if (!zip) { errEl.textContent = 'Please enter a zip code.'; return; }
      goto('screen-checkin-season');
    }

    function toggleSeasonCheck(season) {
      checkinSeason[season] = document.getElementById('cb' + season).checked;
      document.getElementById('check' + season).classList.toggle('checked', checkinSeason[season]);
      document.getElementById('checkInBtn').disabled = !(checkinSeason.FW || checkinSeason.SS);
    }

    // Childrens/Womens/Mens -- optional (doesn't gate any button the way
    // season does), so a consignor who skips it just gets a label with no
    // category badges. checkinCategory/currentCategoryNote are shared by
    // whichever PRINT REQUEST is in progress (see prepareCounts() and
    // goToPreview()), not the visit as a whole -- a reprint later the same
    // day asks fresh, since what's on the counter may have changed since
    // the last batch. categoryBadgesHtml_() is where it prints.
    function toggleCategoryCheck(cat) {
      checkinCategory[cat] = document.getElementById('cbCat' + cat).checked;
      document.getElementById('checkCat' + cat).classList.toggle('checked', checkinCategory[cat]);
    }

    function doCheckIn() {
      var btn = document.getElementById('checkInBtn');
      var errEl = document.getElementById('seasonError');
      errEl.textContent = '';
      btn.disabled = true;
      var data = {
        name: document.getElementById('reviewName').value.trim(),
        phone: document.getElementById('reviewPhone').value.trim(),
        email: document.getElementById('reviewEmail').value.trim(),
        zip: document.getElementById('reviewZip').value.trim(),
        seasons: checkinSeason
      };
      google.script.run
        .withSuccessHandler(function (res) {
          btn.disabled = false;
          if (!res.ok) { errEl.textContent = res.error || 'Something went wrong. Please see a staff member.'; return; }
          currentId = res.id; currentMode = res.mode; currentName = res.name;
          // Use what they just confirmed on the review screen, not the
          // (possibly stale) on-file values -- if they corrected a typo,
          // the label printed today should reflect the correction.
          currentPhone = data.phone || ''; currentEmail = data.email || '';
          showStatus(res);
        })
        .withFailureHandler(function () {
          btn.disabled = false;
          errEl.textContent = 'Something went wrong. Please see a staff member.';
        })
        .submitCheckIn(currentId, currentMode, data);
    }

    function showStatus(res) {
      var box = document.getElementById('statusBox');
      var icon = document.getElementById('statusIcon');
      var msg = document.getElementById('statusMessage');
      var contBtn = document.getElementById('statusContinueBtn');
      var doneBtn = document.getElementById('statusDoneBtn');
      box.className = 'status-box';
      msg.textContent = res.message || "You're checked in! Head over and start filling your totes — come back anytime for more labels.";
      if (res.status === 'closed') {
        box.classList.add('closed'); icon.textContent = '⛔';
        contBtn.classList.add('hidden'); doneBtn.classList.remove('hidden');
      } else if (res.status === 'capped') {
        box.classList.add('capped'); icon.textContent = '📦';
        contBtn.classList.remove('hidden'); doneBtn.classList.add('hidden');
      } else if (res.status === 'new') {
        box.classList.add('open'); icon.textContent = '🎉';
        contBtn.classList.remove('hidden'); doneBtn.classList.add('hidden');
      } else {
        box.classList.add('open'); icon.textContent = '✅';
        contBtn.classList.remove('hidden'); doneBtn.classList.add('hidden');
      }
      goto('screen-status');
    }

    // Always re-reads today's counts from the server -- used whether we got
    // here from "already checked in," the post-check-in status screen, or
    // "Need Even More?" on the success screen, so the numbers are never stale.
    function enterCounts() {
      google.script.run
        .withSuccessHandler(function (res) {
          if (res && res.ok) {
            prepareCounts(res.name || currentName, res.todayCounts);
          } else {
            prepareCounts(currentName, { fw: 0, ss: 0 });
          }
          goto('screen-counts');
        })
        .withFailureHandler(function () {
          prepareCounts(currentName, { fw: 0, ss: 0 });
          goto('screen-counts');
        })
        .getConsignorHome(currentId, currentMode === 'new' ? 'pending' : currentMode);
    }

    function prepareCounts(name, todayCounts) {
      document.getElementById('countsName').textContent = name;
      document.getElementById('todayFW').textContent = (todayCounts && todayCounts.fw) || 0;
      document.getElementById('todaySS').textContent = (todayCounts && todayCounts.ss) || 0;
      add = { fw: 0, ss: 0 };
      // Childrens/Womens/Mens starts unchecked every time this screen is
      // reached -- a reprint later the same day (or a different batch this
      // same visit) isn't assumed to carry the same items as last time, so
      // nothing here should still show checked from a previous print
      // request in this same browser session.
      checkinCategory = { C: false, W: false, M: false };
      ['C', 'W', 'M'].forEach(function (c) {
        document.getElementById('cbCat' + c).checked = false;
        document.getElementById('checkCat' + c).classList.remove('checked');
      });
      renderCounts();
    }

    function changeCount(season, delta) {
      add[season] = Math.max(0, Math.min(20, add[season] + delta));
      renderCounts();
    }

    function renderCounts() {
      document.getElementById('addFW').textContent = add.fw;
      document.getElementById('addSS').textContent = add.ss;
      var total = add.fw + add.ss;
      document.getElementById('addTotal').textContent = total;
      document.getElementById('addPlural').textContent = total === 1 ? '' : 's';
      document.getElementById('previewBtn').disabled = total === 0;
    }

    // "Review & Print" on the counts screen -- locks in whatever's checked
    // for Childrens/Womens/Mens at this moment as the tag for THIS print
    // request, then moves on to the preview (which reads currentCategoryNote,
    // same as the real print output does). Deliberately a small wrapper
    // around goto('screen-preview') rather than folding this into
    // toggleCategoryCheck() itself, so the note is captured exactly once,
    // right when someone commits to printing -- not recomputed continuously
    // while they're still clicking checkboxes.
    function goToPreview() {
      currentCategoryNote = (checkinCategory.C ? 'C' : '') + (checkinCategory.W ? 'W' : '') + (checkinCategory.M ? 'M' : '');
      goto('screen-preview');
    }

    // Phone line for the label -- pricers wanted a phone number on the
    // printed tag alongside everything already there. Email was tried too
    // but pulled back out (kept off the physical label on purpose -- it's
    // still captured and shown on the review screen and in the drop-off
    // notification email, just not printed here).
    function labelContactLines_() {
      if (!currentPhone) return '';
      return '<div class="contact-line">' + formatPhone(normalizePhone(currentPhone)) + '</div>';
    }

    // Season header for the printed/previewed label. Black ink only (see
    // the .label-art.fw CSS above this) -- Fall/Winter is a solid black bar
    // with white knockout text (reads as a bold dark shape even at a
    // glance, without anyone having to actually read the words), Spring/
    // Summer stays plain black-on-white. Each also gets a matching icon as
    // a second, redundant cue. One shared function so the preview, the
    // post-print success list, and the real AirPrint output can't drift
    // out of sync with each other.
    function seasonWordHtml_(cls, categoryNote) {
      // ︎ forces plain monochrome "text" presentation instead of
      // each symbol's default full-color emoji glyph. The thermal printer
      // can only print black/white, so a color emoji gets dithered down
      // and comes out jagged/distorted (this bit the sun icon specifically
      // -- the snowflake happened to default to text style already, which
      // is why only Spring/Summer's icon looked broken on the printed
      // label). Forcing both keeps them both safe from a future iOS
      // default-presentation change too.
      var icon = cls === 'fw' ? '❄︎' : '☀︎';
      // No spaces around the slash (was "Fall / Winter") -- a few pixels
      // narrower, which matters on a line that may also need to fit three
      // category badges without truncating.
      var word = cls === 'fw' ? 'Fall/Winter' : 'Spring/Summer';
      return '<div class="season-word"><span class="season-icon">' + icon + '</span>' +
        '<span class="season-text">' + word + '</span>' +
        categoryBadgesHtml_(categoryNote) +
        '</div>';
    }

    // Small monogram-style badges for Childrens/Womens/Mens, tucked onto the
    // right end of the season line (see .category-badge CSS above). One
    // badge per selected category, e.g. checking "Childrens" and "Womens"
    // both prints "C" and "W" side by side -- this is a whole-PRINT-REQUEST
    // tag (checkinCategory, asked fresh on the counts screen every time
    // labels are printed -- see prepareCounts()/goToPreview()), not tracked
    // per individual tote, so every label from one print request shows the
    // same badges, but a reprint later the same day can show different ones.
    function categoryBadgesHtml_(categoryNote) {
      var letters = (categoryNote || '').split('');
      if (!letters.length) return '';
      return '<div class="category-badges">' + letters.map(function (l) {
        return '<span class="category-badge">' + l + '</span>';
      }).join('') + '</div>';
    }

    // Decorative-only preview (no real Tote ID exists yet -- those are
    // assigned atomically at the moment of printing, see doPrint()). Mirrors
    // the real label in showSuccess() below, field for field, so what staff
    // see here is what actually prints.
    function labelArtPreview_(season, count) {
      var cls = season === 'fw' ? 'fw' : 'ss';
      var barId = 'previewbars-' + season;
      return '' +
        '<div class="label-preview">' +
          (count > 1 ? '<div class="qty-badge">&times;' + count + '</div>' : '') +
          '<div class="label-art ' + cls + '">' +
            seasonWordHtml_(cls, currentCategoryNote) +
            '<div class="tagid-name">' + currentName + '</div>' +
            labelContactLines_() +
            '<div class="label-bottom-row">' +
              '<div class="barcode-wrap"><svg id="' + barId + '"></svg></div>' +
              '<div class="tagid-num">assigned at print</div>' +
            '</div>' +
          '</div>' +
        '</div>';
    }

    function renderPreview() {
      var html = '<div class="preview-row">';
      if (add.fw > 0) html += labelArtPreview_('fw', add.fw);
      if (add.ss > 0) html += labelArtPreview_('ss', add.ss);
      html += '</div>';
      html += '<p class="label-scale-note">Drawn to scale, landscape, for a 3.9&Prime; &times; 2.4&Prime; shipping label (Brother DK-1202) &mdash; final size still pending a real print test.</p>';
      document.getElementById('previewList').innerHTML = html;
      // Placeholder barcodes for preview only, not real Tote IDs.
      if (window.JsBarcode) {
        // lineColor pinned to black on purpose, regardless of season -- a
        // red barcode risks going unreadable to a scanner using a red laser.
        // fitBarcodeSvg_ added here to match buildPrintArea_ below -- without
        // it, JsBarcode renders at its natural (often much wider than the
        // box) size, which is why the preview was overflowing the label
        // edge even though the real print output (which already called
        // fitBarcodeSvg_) was sized correctly.
        if (add.fw > 0) try { JsBarcode('#previewbars-fw', 'PREVIEW', { format: 'CODE128', displayValue: false, margin: 0, height: 26, lineColor: '#000000' }); fitBarcodeSvg_('previewbars-fw', 90, 26); } catch (e) {}
        if (add.ss > 0) try { JsBarcode('#previewbars-ss', 'PREVIEW', { format: 'CODE128', displayValue: false, margin: 0, height: 26, lineColor: '#000000' }); fitBarcodeSvg_('previewbars-ss', 90, 26); } catch (e) {}
      }
    }

    function doPrint() {
      var btn = document.getElementById('printBtn');
      var errEl = document.getElementById('printError');
      errEl.textContent = '';
      btn.disabled = true;
      google.script.run
        .withSuccessHandler(function (res) {
          btn.disabled = false;
          if (!res.ok) { errEl.textContent = res.error || 'Something went wrong.'; return; }
          lastTotesMade = res.totes;
          goto('screen-printing');
          buildPrintArea_(res);
          triggerPrint_(res);
        })
        .withFailureHandler(function () {
          btn.disabled = false;
          errEl.textContent = 'Something went wrong. Please see a staff member.';
        })
        .printLabels(currentId, currentMode, currentName, { fw: add.fw, ss: add.ss }, currentCategoryNote);
    }

    // Fills #printArea with one true-physical-size label per tote -- same
    // markup/data as showSuccess() below, just a separate set of element
    // ids (printbar-N) so its barcodes don't collide with the on-screen
    // success list's (realbar-N) if both exist in the DOM at once.
    function buildPrintArea_(res) {
      var contactHtml = labelContactLines_();
      var html = '';
      res.totes.forEach(function (t, i) {
        var cls = t.season === 'FW' ? 'fw' : 'ss';
        html += '' +
          '<div class="print-label">' +
            '<div class="label-art ' + cls + '">' +
              seasonWordHtml_(cls, t.category) +
              '<div class="tagid-name">' + currentName + '</div>' +
              contactHtml +
              '<div class="label-bottom-row">' +
                '<div class="barcode-wrap"><svg id="printbar-' + i + '"></svg></div>' +
                '<div class="tagid-num">' + t.toteId + '</div>' +
              '</div>' +
            '</div>' +
          '</div>';
      });
      document.getElementById('printArea').innerHTML = html;
      if (window.JsBarcode) {
        res.totes.forEach(function (t, i) {
          var svgId = 'printbar-' + i;
          try {
            JsBarcode('#' + svgId, t.toteId, { format: 'CODE128', displayValue: false, margin: 0, height: 26, lineColor: '#000000' });
            fitBarcodeSvg_(svgId, 90, 26);
          } catch (e) {}
        });
      }
    }

    // Pins a freshly-drawn JsBarcode <svg> to an exact pixel box (90x26,
    // comfortably inside the ~92px the barcode actually has to share with
    // the Tote ID number in the print-only .barcode-wrap -- see its CSS
    // comment above for why this replaced a CSS width:100%/height:100%
    // stretch). JsBarcode already stamps the SVG's width/height attributes
    // with its own natural (usually much wider) size; giving it a viewBox
    // matching that natural size, THEN overwriting width/height with the
    // smaller target, scales the artwork uniformly the same way an <img>
    // does when you shrink it -- CODE128's bar-width ratios (which is what
    // makes it scannable) are preserved either way, unlike a non-uniform
    // CSS stretch. maxW/maxH are separate params (not hardcoded into the
    // function) in case a future caller needs a different box.
    function fitBarcodeSvg_(svgId, maxW, maxH) {
      var svg = document.getElementById(svgId);
      if (!svg) return;
      var nativeW = parseFloat(svg.getAttribute('width'));
      var nativeH = parseFloat(svg.getAttribute('height'));
      if (!nativeW || !nativeH) return;
      svg.setAttribute('viewBox', '0 0 ' + nativeW + ' ' + nativeH);
      var scale = Math.min(maxW / nativeW, maxH / nativeH, 1);
      svg.setAttribute('width', Math.round(nativeW * scale));
      svg.setAttribute('height', Math.round(nativeH * scale));
      svg.setAttribute('preserveAspectRatio', 'xMinYMid meet');
    }

    // Opens the iPad's native AirPrint sheet with the real label(s), sized
    // to true physical scale by the #printArea print CSS above. On iOS
    // Safari, window.print() doesn't block script execution -- the sheet
    // opens and the script keeps running -- so we move on to the success
    // screen when the sheet closes (the 'afterprint' event), whether they
    // actually printed or backed out of the dialog; there's nothing left
    // for the kiosk itself to wait on either way. The fallback timeout
    // covers the rare case afterprint doesn't fire (some older iOS Safari
    // versions were inconsistent about it) so the kiosk never gets stuck
    // waiting on a dialog that already closed.
    function triggerPrint_(res) {
      var proceeded = false;
      function proceed() {
        if (proceeded) return;
        proceeded = true;
        window.onafterprint = null;
        showSuccess(res);
      }
      window.onafterprint = proceed;
      setTimeout(proceed, 15000);
      // Tiny delay so the freshly-built #printArea (labels + barcodes) is
      // fully painted before the dialog captures the page.
      setTimeout(function () { window.print(); }, 150);
    }

    function showSuccess(res) {
      document.getElementById('successCount').textContent = res.count + ' label' + (res.count === 1 ? '' : 's');
      document.getElementById('successRange').textContent =
        res.count === 1 ? res.firstId : res.firstId + ' – ' + res.lastId;
      var html = '<div class="preview-row">';
      var contactHtml = labelContactLines_();
      res.totes.forEach(function (t, i) {
        var cls = t.season === 'FW' ? 'fw' : 'ss';
        html += '' +
          '<div class="label-preview">' +
            '<div class="label-art ' + cls + '">' +
              seasonWordHtml_(cls, t.category) +
              '<div class="tagid-name">' + currentName + '</div>' +
              contactHtml +
              '<div class="label-bottom-row">' +
                '<div class="barcode-wrap"><svg id="realbar-' + i + '"></svg></div>' +
                '<div class="tagid-num">' + t.toteId + '</div>' +
              '</div>' +
            '</div>' +
          '</div>';
      });
      html += '</div>';
      document.getElementById('successList').innerHTML = html;
      if (window.JsBarcode) {
        res.totes.forEach(function (t, i) {
          // Same fitBarcodeSvg_ fix as renderPreview() above -- this success
          // list had the identical missing-fit bug.
          try { JsBarcode('#realbar-' + i, t.toteId, { format: 'CODE128', displayValue: false, margin: 0, height: 26, lineColor: '#000000' }); fitBarcodeSvg_('realbar-' + i, 90, 26); } catch (e) {}
        });
      }
      goto('screen-success');
      autoResetTimer = setTimeout(function () { goto('screen-home'); }, 20000);
    }

    // Enter key submits either phone lookup
    document.getElementById('phoneInputSignin').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') doSignInLookup();
    });
    document.getElementById('phoneInput').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') doLookup();
    });
  </script>
</body>
</html>

`;

var ADMIN_HTML = `
<!-- CIMS — the back-office dashboard: roster with computed tier/status and
     an editor for the SNAP thresholds. Embedded here as a string, served
     via HtmlService.createHtmlOutput() in doGet() below — no separate
     Admin.html file in this project anymore. Reachable at the web app URL
     with "?page=admin" appended. -->
<!DOCTYPE html>
<html>
<head>
  <base target="_top">
  <meta charset="utf-8">
  <style>
    :root {
      --ink: #2b2320; --muted: #79716b; --line: #e7e0d8;
      --accent: #1F3864; --accent-ink: #F4B942; --bg: #faf6f1; --card: #ffffff;
      --good: #3f7d5c; --warn: #b8863b; --bad: #b5433a;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0; background: var(--bg); color: var(--ink);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      padding: 28px;
    }
    h1 { font-size: 1.5rem; margin: 0 0 4px; }
    .sub { color: var(--muted); margin: 0 0 24px; }
    .grid { display: grid; grid-template-columns: 320px 1fr; gap: 24px; align-items: start; }
    @media (max-width: 900px) { .grid { grid-template-columns: 1fr; } }
    .card {
      background: var(--card); border: 1px solid var(--line); border-radius: 14px;
      padding: 20px 22px; margin-bottom: 20px;
    }
    .card h2 { font-size: 1.05rem; margin: 0 0 14px; }
    .field { margin-bottom: 14px; }
    .field label { display: block; font-size: 0.85rem; color: var(--muted); margin-bottom: 4px; }
    .field input {
      width: 100%; padding: 9px 10px; font-size: 1rem;
      border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--ink);
    }
    .field .hint { font-size: 0.78rem; color: var(--muted); margin-top: 4px; }
    button.save {
      width: 100%; padding: 12px; font-size: 1rem; font-weight: 600;
      background: var(--accent); color: var(--accent-ink); border: none; border-radius: 10px; cursor: pointer;
    }
    button.save:disabled { opacity: 0.5; }
    .save-status { text-align: center; margin-top: 8px; font-size: 0.85rem; min-height: 1.2em; }
    .stat-row { display: flex; flex-wrap: wrap; gap: 10px; margin-bottom: 20px; }
    .stat {
      flex: 1; min-width: 110px; background: var(--card); border: 1px solid var(--line);
      border-radius: 12px; padding: 14px 16px;
    }
    .stat .n { font-size: 1.5rem; font-weight: 700; }
    .stat .l { font-size: 0.78rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
    table { width: 100%; border-collapse: collapse; font-size: 0.92rem; }
    th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid var(--line); }
    th { color: var(--muted); font-weight: 600; font-size: 0.78rem; text-transform: uppercase; letter-spacing: 0.03em; }
    tr:hover td { background: #faf3ec; }
    .badge { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 0.78rem; font-weight: 600; }
    .badge.open { background: #e4f1ea; color: var(--good); }
    .badge.capped { background: #f7ecd9; color: var(--warn); }
    .badge.closed { background: #f8e5e2; color: var(--bad); }
    .badge.tier { background: #eee7dc; color: var(--ink); }
    .badge.pending { background: #f7ecd9; color: var(--warn); }
    .badge.linked { background: #e4f1ea; color: var(--good); }
    .search { width: 100%; padding: 10px 12px; margin-bottom: 12px; border: 1px solid var(--line); border-radius: 8px; }
    .table-wrap { max-height: 560px; overflow: auto; }
    .loading { color: var(--muted); padding: 20px; text-align: center; }
    .link-row { display: flex; gap: 6px; }
    .link-row input {
      width: 110px; padding: 6px 8px; font-size: 0.85rem;
      border: 1px solid var(--line); border-radius: 6px; background: var(--bg); color: var(--ink);
    }
    .link-row button {
      padding: 6px 10px; font-size: 0.8rem; font-weight: 600;
      background: var(--accent); color: var(--accent-ink); border: none; border-radius: 6px; cursor: pointer;
    }
    .link-row button:disabled { opacity: 0.5; }
    .small-btn {
      padding: 6px 10px; font-size: 0.8rem; font-weight: 600;
      background: var(--accent); color: var(--accent-ink); border: none; border-radius: 6px; cursor: pointer;
    }
  </style>
</head>
<body>
  <h1>CIMS Admin — The Adorable Child</h1>
  <p class="sub">Consignor roster, tiers, and threshold configuration.</p>

  <div class="stat-row" id="statRow"></div>

  <div class="grid">
    <div>
      <div class="card">
        <h2>Thresholds (store spend bands)</h2>
        <div id="configForm">
          <div class="loading">Loading…</div>
        </div>
      </div>
      <div class="card">
        <h2>Medians (auto-computed unless overridden)</h2>
        <div id="medianInfo" class="loading">Loading…</div>
      </div>
    </div>

    <div>
      <div class="card">
        <h2>New Consignor Signups</h2>
        <p class="sub" style="margin-bottom:10px;">People who signed up on the sign-in screen but aren't in the Accounts tab yet. Once you create their real account in your POS/APR system, link it here so future phone lookups find the real account.</p>
        <div class="table-wrap" style="max-height:320px;">
          <table>
            <thead>
              <tr><th>Name</th><th>Phone</th><th>Email</th><th>Status</th><th>Link to Account</th></tr>
            </thead>
            <tbody id="newSignupsBody">
              <tr><td colspan="5" class="loading">Loading…</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <h2>Account Change Requests</h2>
        <p class="sub" style="margin-bottom:10px;">Corrections consignors made to their info at the kiosk. CIMS's own Accounts tab already has these — this list is what still needs to be keyed into Liberty REACT so the next data import doesn't overwrite them. Mark a row Applied once you've made the same edit there.</p>
        <label style="display:flex; align-items:center; gap:6px; font-size:0.85rem; color:var(--muted); margin-bottom:10px; cursor:pointer;">
          <input type="checkbox" id="showAppliedChanges" onchange="renderAccountChanges()">
          Show applied changes
        </label>
        <div class="table-wrap" style="max-height:320px;">
          <table>
            <thead>
              <tr><th>Consignor</th><th>Field</th><th>Old</th><th>New</th><th>Applied?</th></tr>
            </thead>
            <tbody id="accountChangesBody">
              <tr><td colspan="5" class="loading">Loading…</td></tr>
            </tbody>
          </table>
        </div>
      </div>

      <div class="card">
        <h2>Roster</h2>
        <input class="search" id="searchBox" placeholder="Search by name or account #…" oninput="renderTable()">
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>Account</th><th>Name</th><th>Phone</th><th>Checked In</th><th>Sold</th><th>Sell-Through</th><th>Spend</th><th>Tier</th><th>Status</th></tr>
            </thead>
            <tbody id="rosterBody">
              <tr><td colspan="9" class="loading">Loading…</td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>

  <script>
    var rosterData = null;
    var newSignupsData = null;
    var accountChangesData = null;

    var FIELD_DEFS = [
      { key: 'margClose', label: 'Marginal — Closed below', hint: 'Store spend below this = Closed' },
      { key: 'margOpen', label: 'Marginal — Open at/above', hint: 'Store spend at/above this = fully Open' },
      { key: 'margCap', label: 'Marginal — item cap shown', hint: 'Backstop cap, not the real volume lever' },
      { key: 'bulkClose', label: 'Bulk mover — Closed below', hint: 'Normally 0 (never triggers; spend can’t be negative)' },
      { key: 'bulkOpen', label: 'Bulk mover — Open at/above', hint: 'Store spend at/above this = fully Open' },
      { key: 'bulkCap', label: 'Bulk mover — item cap shown', hint: 'The real volume lever' }
    ];

    // Every load call below has a failure handler -- without one, a server-
    // side error just leaves the "Loading..." placeholder sitting there
    // forever with no clue anything went wrong. This shows the actual error
    // message in place of the spinner instead.
    function showLoadError_(ids, err) {
      var msg = "Couldn't load this: " + (err && err.message ? err.message : err);
      ids.forEach(function (id) {
        var el = document.getElementById(id);
        if (!el) return;
        var isRow = el.tagName === 'TBODY';
        el.innerHTML = isRow
          ? '<tr><td colspan="8" class="loading" style="color:#b5433a;">' + msg + '</td></tr>'
          : '<div class="loading" style="color:#b5433a;">' + msg + '</div>';
      });
    }

    // Shows a clickable "Still loading -- click to retry" message in place of
    // the spinner if a section hasn't come back yet after a while. Covers the
    // case where the request itself never got a response at all (neither
    // success nor failure ever fires -- seen in the wild when a network
    // security/monitoring browser extension silently drops the very first
    // request a page makes) so there's always a way to recover without
    // needing to open DevTools or reload the whole page.
    function showRetryLink_(ids, retryFn) {
      ids.forEach(function (id) {
        var el = document.getElementById(id);
        if (!el) return;
        var isRow = el.tagName === 'TBODY';
        var link = '<a href="#" class="retry-link" style="color:#1F3864; font-weight:600;">Still loading — click to retry</a>';
        el.innerHTML = isRow
          ? '<tr><td colspan="8" class="loading">' + link + '</td></tr>'
          : '<div class="loading">' + link + '</div>';
        var a = el.querySelector('.retry-link');
        if (a) a.addEventListener('click', function (evt) {
          evt.preventDefault();
          retryFn();
        });
      });
    }

    // Watches a single load call: fires it, and if neither success nor
    // failure has come back within timeoutMs, swaps the placeholder for a
    // manual retry link (clicking it calls this same function again, so it
    // keeps retrying as many times as needed).
    function loadWithWatchdog_(ids, timeoutMs, run) {
      var done = false;
      var timer = setTimeout(function () {
        if (!done) {
          showRetryLink_(ids, function () { loadWithWatchdog_(ids, timeoutMs, run); });
        }
      }, timeoutMs);
      run(function () { done = true; clearTimeout(timer); });
    }

    // These three run one at a time, not all at once. Firing three
    // google.script.run calls in the same instant (as the very first thing
    // the page does) can jam up Apps Script's sandboxed messaging channel --
    // seen as every section hanging on "Loading..." forever with no error --
    // while a single call by itself goes through fine. Running them in a
    // short chain sidesteps that instead of racing them.
    function loadRoster_(next) {
      loadWithWatchdog_(['configForm', 'medianInfo', 'rosterBody'], 6000, function (markDone) {
        google.script.run.withSuccessHandler(function (data) {
          markDone();
          try {
            rosterData = data;
            renderStats();
            renderConfigForm();
            renderMedians();
            renderTable();
          } catch (e) {
            showLoadError_(['configForm', 'medianInfo', 'rosterBody'], e);
          }
          next();
        }).withFailureHandler(function (err) {
          markDone();
          showLoadError_(['configForm', 'medianInfo', 'rosterBody'], err);
          next();
        }).getRosterData();
      });
    }

    function loadSignups_(next) {
      loadWithWatchdog_(['newSignupsBody'], 6000, function (markDone) {
        google.script.run.withSuccessHandler(function (data) {
          markDone();
          try {
            newSignupsData = data;
            renderStats();
            renderNewSignups();
          } catch (e) {
            showLoadError_(['newSignupsBody'], e);
          }
          next();
        }).withFailureHandler(function (err) {
          markDone();
          showLoadError_(['newSignupsBody'], err);
          next();
        }).getNewSignupsData();
      });
    }

    function loadChanges_(next) {
      loadWithWatchdog_(['accountChangesBody'], 6000, function (markDone) {
        google.script.run.withSuccessHandler(function (data) {
          markDone();
          try {
            accountChangesData = data;
            renderStats();
            renderAccountChanges();
          } catch (e) {
            showLoadError_(['accountChangesBody'], e);
          }
          next();
        }).withFailureHandler(function (err) {
          markDone();
          showLoadError_(['accountChangesBody'], err);
          next();
        }).getAccountChangesData();
      });
    }

    function loadAll() {
      loadRoster_(function () {
        loadSignups_(function () {
          loadChanges_(function () {});
        });
      });
    }

    function renderStats() {
      if (!rosterData) return;
      var s = rosterData.summary;
      var pendingCount = newSignupsData
        ? newSignupsData.signups.filter(function (x) { return x.status === 'Pending'; }).length
        : null;
      var pendingChangesCount = accountChangesData
        ? accountChangesData.changes.filter(function (x) { return !x.applied; }).length
        : null;
      var items = [
        ['Stars', s.star], ['Bulk movers', s.bulk], ['Efficient', s.efficient], ['Marginal', s.marginal],
        ['Open', s.open], ['Capped', s.capped], ['Closed', s.closed]
      ];
      if (pendingCount !== null) items.push(['New Signups', pendingCount]);
      if (pendingChangesCount !== null) items.push(['Changes to Apply', pendingChangesCount]);
      document.getElementById('statRow').innerHTML = items.map(function (it) {
        return '<div class="stat"><div class="n">' + it[1] + '</div><div class="l">' + it[0] + '</div></div>';
      }).join('');
    }

    function renderNewSignups() {
      var body = document.getElementById('newSignupsBody');
      if (newSignupsData.error) {
        body.innerHTML = '<tr><td colspan="5" class="loading" style="color:#b5433a;">' + newSignupsData.error + '</td></tr>';
        return;
      }
      var rows = newSignupsData.signups;
      if (rows.length === 0) {
        body.innerHTML = '<tr><td colspan="5" class="loading">No signups yet.</td></tr>';
        return;
      }
      body.innerHTML = rows.map(function (s) {
        var actionCell;
        if (s.status === 'Linked') {
          actionCell = '<span class="badge linked">Linked to ' + s.linkedAccountId + '</span>';
        } else {
          actionCell =
            '<div class="link-row">' +
            '<input type="text" placeholder="Account #" id="linkInput_' + s.tempId + '">' +
            '<button onclick="linkSignup(' + String.fromCharCode(39) + s.tempId + String.fromCharCode(39) + ')">Link</button>' +
            '</div>';
        }
        return '<tr>' +
          '<td>' + (s.name || '') + '</td>' +
          '<td>' + (s.phone || '') + '</td>' +
          '<td>' + (s.email || '') + '</td>' +
          '<td><span class="badge ' + (s.status === 'Linked' ? 'linked' : 'pending') + '">' + s.status + '</span></td>' +
          '<td>' + actionCell + '</td>' +
          '</tr>';
      }).join('');
    }

    function linkSignup(tempId) {
      var input = document.getElementById('linkInput_' + tempId);
      var accountId = input.value.trim();
      if (!accountId) { input.focus(); return; }
      google.script.run.withSuccessHandler(function () {
        loadAll();
      }).linkNewSignup(tempId, accountId);
    }

    function renderAccountChanges() {
      var body = document.getElementById('accountChangesBody');
      if (accountChangesData.error) {
        body.innerHTML = '<tr><td colspan="5" class="loading" style="color:#b5433a;">' + accountChangesData.error + '</td></tr>';
        return;
      }
      var showAppliedEl = document.getElementById('showAppliedChanges');
      var showApplied = showAppliedEl && showAppliedEl.checked;
      var pending = accountChangesData.changes.filter(function (c) { return !c.applied; });
      var applied = showApplied
        ? accountChangesData.changes.filter(function (c) { return c.applied; })
            .sort(function (a, b) { return new Date(b.timestamp) - new Date(a.timestamp); })
        : [];

      if (pending.length === 0 && applied.length === 0) {
        body.innerHTML = '<tr><td colspan="5" class="loading">Nothing pending — all caught up.</td></tr>';
        return;
      }

      var pendingHtml = pending.length
        ? pending.map(function (c) {
            return '<tr>' +
              '<td>' + (c.consignor || '') + '</td>' +
              '<td>' + (c.field || '') + '</td>' +
              '<td>' + (c.oldValue || '<span class="sub">(blank)</span>') + '</td>' +
              '<td>' + (c.newValue || '') + '</td>' +
              '<td><button class="small-btn" onclick="markApplied(' + c.row + ')">Mark Applied</button></td>' +
              '</tr>';
          }).join('')
        : '<tr><td colspan="5" class="loading">Nothing pending — all caught up.</td></tr>';

      var appliedHtml = applied.map(function (c) {
        return '<tr style="opacity:0.6;">' +
          '<td>' + (c.consignor || '') + '</td>' +
          '<td>' + (c.field || '') + '</td>' +
          '<td>' + (c.oldValue || '<span class="sub">(blank)</span>') + '</td>' +
          '<td>' + (c.newValue || '') + '</td>' +
          '<td><span class="badge linked">Applied</span></td>' +
          '</tr>';
      }).join('');

      body.innerHTML = pendingHtml + appliedHtml;
    }

    function markApplied(rowNum) {
      google.script.run.withSuccessHandler(function () {
        loadAll();
      }).markAccountChangeApplied(rowNum);
    }

    function renderConfigForm() {
      var c = rosterData.config;
      var html = FIELD_DEFS.map(function (f) {
        return '<div class="field"><label>' + f.label + '</label>' +
          '<input type="number" step="any" id="cfg_' + f.key + '" value="' + c[f.key] + '">' +
          '<div class="hint">' + f.hint + '</div></div>';
      }).join('');
      html += '<button class="save" id="saveBtn" onclick="saveConfigForm()">Save thresholds</button>' +
        '<div class="save-status" id="saveStatus"></div>';
      document.getElementById('configForm').innerHTML = html;
    }

    function renderMedians() {
      var m = rosterData.medians;
      document.getElementById('medianInfo').innerHTML =
        '<div class="field"><label>Volume median (checked-in)</label><div>' + m.medCi.toFixed(1) + '</div></div>' +
        '<div class="field"><label>Sell-through median</label><div>' + (m.medSt * 100).toFixed(2) + '%</div></div>' +
        '<div class="field"><label>Active20 accounts</label><div>' + m.activeCount + '</div></div>' +
        '<div class="hint">To freeze these instead of auto-computing, set medCiOverride / medStOverride directly in the Config sheet.</div>';
    }

    function saveConfigForm() {
      var btn = document.getElementById('saveBtn');
      var status = document.getElementById('saveStatus');
      btn.disabled = true;
      status.textContent = 'Saving…';
      var newConfig = {};
      FIELD_DEFS.forEach(function (f) {
        newConfig[f.key] = Number(document.getElementById('cfg_' + f.key).value);
      });
      google.script.run.withSuccessHandler(function () {
        btn.disabled = false;
        status.textContent = 'Saved. Reloading roster…';
        loadAll();
      }).withFailureHandler(function () {
        btn.disabled = false;
        status.textContent = 'Save failed — please try again.';
      }).saveConfig(newConfig);
    }

    function renderTable() {
      var q = (document.getElementById('searchBox').value || '').toLowerCase();
      var rows = rosterData.roster.filter(function (r) {
        return !q || (r.name || '').toLowerCase().indexOf(q) !== -1 || String(r.accountId).toLowerCase().indexOf(q) !== -1;
      });
      var body = document.getElementById('rosterBody');
      if (rows.length === 0) {
        body.innerHTML = '<tr><td colspan="9" class="loading">No matches.</td></tr>';
        return;
      }
      body.innerHTML = rows.map(function (r) {
        return '<tr>' +
          '<td>' + r.accountId + '</td>' +
          '<td>' + (r.name || '') + '</td>' +
          '<td>' + (r.phone || '') + '</td>' +
          '<td>' + r.checkedIn + '</td>' +
          '<td>' + r.sold + '</td>' +
          '<td>' + (r.sellThrough * 100).toFixed(1) + '%</td>' +
          '<td>$' + r.spend.toFixed(2) + '</td>' +
          '<td><span class="badge tier">' + (r.tier || 'untiered') + '</span></td>' +
          '<td><span class="badge ' + r.status + '">' + r.status + '</span></td>' +
          '</tr>';
      }).join('');
    }

    // Fire the initial load after a short delay rather than the instant this
    // script runs -- on some machines a network-security/monitoring browser
    // extension briefly holds outgoing requests during its own startup, and a
    // google.script.run call made in that exact window can get silently
    // dropped with no success or failure callback ever firing. Each section
    // also has its own watchdog (see loadWithWatchdog_ above) that swaps in a
    // manual "click to retry" link if it's still not back after 6 seconds, so
    // there's always a way to recover even if this initial delay isn't quite
    // enough on a particular machine.
    setTimeout(loadAll, 400);
  </script>
</body>
</html>
`;

// ---------------------------------------------------------------------------
// WEB APP ENTRY POINT
// ---------------------------------------------------------------------------
// JsBarcode 3.11.5 (JsBarcode.all.min.js), self-hosted for the exact same reason
// KIOSK_FUNCTIONS_JS above is self-hosted: Kiosk Pro's locked-down kiosk network couldn't
// reliably reach cdnjs.cloudflare.com (the barcode <script src> was silently failing to load
// -- every JsBarcode(...) call is wrapped in `if (window.JsBarcode)` + an empty catch, written
// to fail gracefully, which meant it failed COMPLETELY SILENTLY: no error anywhere, barcodes
// and Tote ID rows just never drew, in the on-screen preview AND on real printed labels alike).
// Serving this from our own deployment removes the external dependency entirely -- it no longer
// matters whether any given network/kiosk allows cdnjs.cloudflare.com or not.
// Source: https://cdnjs.cloudflare.com/ajax/libs/JsBarcode/3.11.5/JsBarcode.all.min.js (MIT
// license, Johan Lindell). Only update this by replacing the whole block with a newer official
// build if JsBarcode itself is ever upgraded -- don't hand-edit the minified contents.
var JSBARCODE_LIB_JS = `
/*! JsBarcode v3.11.5 | (c) Johan Lindell | MIT license */
!function(t){var e={};function n(r){if(e[r])return e[r].exports;var o=e[r]={i:r,l:!1,exports:{}};return t[r].call(o.exports,o,o.exports,n),o.l=!0,o.exports}n.m=t,n.c=e,n.d=function(t,e,r){n.o(t,e)||Object.defineProperty(t,e,{enumerable:!0,get:r})},n.r=function(t){"undefined"!=typeof Symbol&&Symbol.toStringTag&&Object.defineProperty(t,Symbol.toStringTag,{value:"Module"}),Object.defineProperty(t,"__esModule",{value:!0})},n.t=function(t,e){if(1&e&&(t=n(t)),8&e)return t;if(4&e&&"object"==typeof t&&t&&t.__esModule)return t;var r=Object.create(null);if(n.r(r),Object.defineProperty(r,"default",{enumerable:!0,value:t}),2&e&&"string"!=typeof t)for(var o in t)n.d(r,o,function(e){return t[e]}.bind(null,o));return r},n.n=function(t){var e=t&&t.__esModule?function(){return t.default}:function(){return t};return n.d(e,"a",e),e},n.o=function(t,e){return Object.prototype.hasOwnProperty.call(t,e)},n.p="",n(n.s=15)}([function(t,e,n){"use strict";Object.defineProperty(e,"__esModule",{value:!0});e.default=function t(e,n){!function(t,e){if(!(t instanceof e))throw new TypeError("Cannot call a class as a function")}(this,t),this.data=e,this.text=n.text||e,this.options=n}},function(t,e,n){"use strict";var r;function o(t,e,n){return e in t?Object.defineProperty(t,e,{value:n,enumerable:!0,configurable:!0,writable:!0}):t[e]=n,t}Object.defineProperty(e,"__esModule",{value:!0});var i=e.SET_A=0,a=e.SET_B=1,u=e.SET_C=2,f=(e.SHIFT=98,e.START_A=103),c=e.START_B=104,s=e.START_C=105;e.MODULO=103,e.STOP=106,e.FNC1=207,e.SET_BY_CODE=(o(r={},f,i),o(r,c,a),o(r,s,u),r),e.SWAP={101:i,100:a,99:u},e.A_START_CHAR=String.fromCharCode(208),e.B_START_CHAR=String.fromCharCode(209),e.C_START_CHAR=String.fromCharCode(210),e.A_CHARS="[\0-_È-Ï]",e.B_CHARS="[ -È-Ï]",e.C_CHARS="(Ï*[0-9]{2}Ï*)",e.BARS=[11011001100,11001101100,11001100110,10010011e3,10010001100,10001001100,10011001e3,10011000100,10001100100,11001001e3,11001000100,11000100100,10110011100,10011011100,10011001110,10111001100,10011101100,10011100110,11001110010,11001011100,11001001110,11011100100,11001110100,11101101110,11101001100,11100101100,11100100110,11101100100,11100110100,11100110010,11011011e3,11011000110,11000110110,10100011e3,10001011e3,10001000110,10110001e3,10001101e3,10001100010,11010001e3,11000101e3,11000100010,10110111e3,10110001110,10001101110,10111011e3,10111000110,10001110110,11101110110,11010001110,11000101110,11011101e3,11011100010,11011101110,11101011e3,11101000110,11100010110,11101101e3,11101100010,11100011010,11101111010,11001000010,11110001010,1010011e4,10100001100,1001011e4,10010000110,10000101100,10000100110,1011001e4,10110000100,1001101e4,10011000010,10000110100,10000110010,11000010010,1100101e4,11110111010,11000010100,10001111010,10100111100,10010111100,10010011110,10111100100,10011110100,10011110010,11110100100,11110010100,11110010010,11011011110,11011110110,11110110110,10101111e3,10100011110,10001011110,10111101e3,10111100010,11110101e3,11110100010,10111011110,10111101110,11101011110,11110101110,11010000100,1101001e4,11010011100,1100011101011]},function(t,e,n){"use strict";Object.defineProperty(e,"__esModule",{value:!0});e.SIDE_BIN="101",e.MIDDLE_BIN="01010",e.BINARIES={L:["0001101","0011001","0010011","0111101","0100011","0110001","0101111","0111011","0110111","0001011"],G:["0100111","0110011","0011011","0100001","0011101","0111001","0000101","0010001","0001001","0010111"],R:["1110010","1100110","1101100","1000010","1011100","1001110","1010000","1000100","1001000","1110100"],O:["0001101","0011001","0010011","0111101","0100011","0110001","0101111","0111011","0110111","0001011"],E:["0100111","0110011","0011011","0100001","0011101","0111001","0000101","0010001","0001001","0010111"]},e.EAN2_STRUCTURE=["LL","LG","GL","GG"],e.EAN5_STRUCTURE=["GGLLL","GLGLL","GLLGL","GLLLG","LGGLL","LLGGL","LLLGG","LGLGL","LGLLG","LLGLG"],e.EAN13_STRUCTURE=["LLLLLL","LLGLGG","LLGGLG","LLGGGL","LGLLGG","LGGLLG","LGGGLL","LGLGLG","LGLGGL","LGGLGL"]},function(t,e,n){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var r=n(2);e.default=function(t,e,n){var o=t.split("").map((function(t,n){return r.BINARIES[e[n]]})).map((function(e,n){return e?e[t[n]]:""}));if(n){var i=t.length-1;o=o.map((function(t,e){return e<i?t+n:t}))}return o.join("")}},function(t,e,n){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var r,o=function(){function t(t,e){for(var n=0;n<e.length;n++){var r=e[n];r.enumerable=r.enumerable||!1,r.configurable=!0,"value"in r&&(r.writable=!0),Object.defineProperty(t,r.key,r)}}return function(e,n,r){return n&&t(e.prototype,n),r&&t(e,r),e}}(),i=n(0);var a=function(t){function e(t,n){return function(t,e){if(!(t instanceof e))throw new TypeError("Cannot call a class as a function")}(this,e),function(t,e){if(!t)throw new ReferenceError("this hasn't been initialised - super() hasn't been called");return!e||"object"!=typeof e&&"function"!=typeof e?t:e}(this,(e.__proto__||Object.getPrototypeOf(e)).call(this,t,n))}return function(t,e){if("function"!=typeof e&&null!==e)throw new TypeError("Super expression must either be null or a function, not "+typeof e);t.prototype=Object.create(e&&e.prototype,{constructor:{value:t,enumerable:!1,writable:!0,configurable:!0}}),e&&(Object.setPrototypeOf?Object.setPrototypeOf(t,e):t.__proto__=e)}(e,t),o(e,[{key:"encode",value:function(){for(var t="110",e=0;e<this.data.length;e++){var n=parseInt(this.data[e]).toString(2);n=u(n,4-n.length);for(var r=0;r<n.length;r++)t+="0"==n[r]?"100":"110"}return{data:t+="1001",text:this.text}}},{key:"valid",value:function(){return-1!==this.data.search(/^[0-9]+$/)}}]),e}(((r=i)&&r.__esModule?r:{default:r}).default);function u(t,e){for(var n=0;n<e;n++)t="0"+t;return t}e.default=a},function(t,e,n){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var r,o=function(){function t(t,e){for(var n=0;n<e.length;n++){var r=e[n];r.enumerable=r.enumerable||!1,r.configurable=!0,"value"in r&&(r.writable=!0),Object.defineProperty(t,r.key,r)}}return function(e,n,r){return n&&t(e.prototype,n),r&&t(e,r),e}}(),i=n(0),a=(r=i)&&r.__esModule?r:{default:r},u=n(1);var f=function(t){function e(t,n){!function(t,e){if(!(t instanceof e))throw new TypeError("Cannot call a class as a function")}(this,e);var r=function(t,e){if(!t)throw new ReferenceError("this hasn't been initialised - super() hasn't been called");return!e||"object"!=typeof e&&"function"!=typeof e?t:e}(this,(e.__proto__||Object.getPrototypeOf(e)).call(this,t.substring(1),n));return r.bytes=t.split("").map((function(t){return t.charCodeAt(0)})),r}return function(t,e){if("function"!=typeof e&&null!==e)throw new TypeError("Super expression must either be null or a function, not "+typeof e);t.prototype=Object.create(e&&e.prototype,{constructor:{value:t,enumerable:!1,writable:!0,configurable:!0}}),e&&(Object.setPrototypeOf?Object.setPrototypeOf(t,e):t.__proto__=e)}(e,t),o(e,[{key:"valid",value:function(){return/^[\x00-\x7F\xC8-\xD3]+$/.test(this.data)}},{key:"encode",value:function(){var t=this.bytes,n=t.shift()-105,r=u.SET_BY_CODE[n];if(void 0===r)throw new RangeError("The encoding does not start with a start character.");!0===this.shouldEncodeAsEan128()&&t.unshift(u.FNC1);var o=e.next(t,1,r);return{text:this.text===this.data?this.text.replace(/[^\x20-\x7E]/g,""):this.text,data:e.getBar(n)+o.result+e.getBar((o.checksum+n)%u.MODULO)+e.getBar(u.STOP)}}},{key:"shouldEncodeAsEan128",value:function(){var t=this.options.ean128||!1;return"string"==typeof t&&(t="true"===t.toLowerCase()),t}}],[{key:"getBar",value:function(t){return u.BARS[t]?u.BARS[t].toString():""}},{key:"correctIndex",value:function(t,e){if(e===u.SET_A){var n=t.shift();return n<32?n+64:n-32}return e===u.SET_B?t.shift()-32:10*(t.shift()-48)+t.shift()-48}},{key:"next",value:function(t,n,r){if(!t.length)return{result:"",checksum:0};var o=void 0,i=void 0;if(t[0]>=200){i=t.shift()-105;var a=u.SWAP[i];void 0!==a?o=e.next(t,n+1,a):(r!==u.SET_A&&r!==u.SET_B||i!==u.SHIFT||(t[0]=r===u.SET_A?t[0]>95?t[0]-96:t[0]:t[0]<32?t[0]+96:t[0]),o=e.next(t,n+1,r))}else i=e.correctIndex(t,r),o=e.next(t,n+1,r);var f=i*n;return{result:e.getBar(i)+o.result,checksum:f+o.checksum}}}]),e}(a.default);e.default=f},function(t,e,n){"use strict";Object.defineProperty(e,"__esModule",{value:!0}),e.mod10=function(t){for(var e=0,n=0;n<t.length;n++){var r=parseInt(t[n]);(n+t.length)%2==0?e+=r:e+=2*r%10+Math.floor(2*r/10)}return(10-e%10)%10},e.mod11=function(t){for(var e=0,n=[2,3,4,5,6,7],r=0;r<t.length;r++){var o=parseInt(t[t.length-1-r]);e+=n[r%n.length]*o}return(11-e%11)%11}},function(t,e,n){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var r=Object.assign||function(t){for(var e=1;e<arguments.length;e++){var n=arguments[e];for(var r in n)Object.prototype.hasOwnProperty.call(n,r)&&(t[r]=n[r])}return t};e.default=function(t,e){return r({},t,e)}},function(t,e,n){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var r=function(){function t(t,e){for(var n=0;n<e.length;n++){var r=e[n];r.enumerable=r.enumerable||!1,r.configurable=!0,"value"in r&&(r.writable=!0),Object.defineProperty(t,r.key,r)}}return function(e,n,r){return n&&t(e.prototype,n),r&&t(e,r),e}}(),o=n(2),i=a(n(3));function a(t){return t&&t.__esModule?t:{default:t}}var u=function(t){function e(t,n){!function(t,e){if(!(t instanceof e))throw new TypeError("Cannot call a class as a function")}(this,e);var r=function(t,e){if(!t)throw new ReferenceError("this hasn't been initialised - super() hasn't been called");return!e||"object"!=typeof e&&"function"!=typeof e?t:e}(this,(e.__proto__||Object.getPrototypeOf(e)).call(this,t,n));return r.fontSize=!n.flat&&n.fontSize>10*n.width?10*n.width:n.fontSize,r.guardHeight=n.height+r.fontSize/2+n.textMargin,r}return function(t,e){if("function"!=typeof e&&null!==e)throw new TypeError("Super expression must either be null or a function, not "+typeof e);t.prototype=Object.create(e&&e.prototype,{constructor:{value:t,enumerable:!1,writable:!0,configurable:!0}}),e&&(Object.setPrototypeOf?Object.setPrototypeOf(t,e):t.__proto__=e)}(e,t),r(e,[{key:"encode",value:function(){return this.options.flat?this.encodeFlat():this.encodeGuarded()}},{key:"leftText",value:function(t,e){return this.text.substr(t,e)}},{key:"leftEncode",value:function(t,e){return(0,i.default)(t,e)}},{key:"rightText",value:function(t,e){return this.text.substr(t,e)}},{key:"rightEncode",value:function(t,e){return(0,i.default)(t,e)}},{key:"encodeGuarded",value:function(){var t={fontSize:this.fontSize},e={height:this.guardHeight};return[{data:o.SIDE_BIN,options:e},{data:this.leftEncode(),text:this.leftText(),options:t},{data:o.MIDDLE_BIN,options:e},{data:this.rightEncode(),text:this.rightText(),options:t},{data:o.SIDE_BIN,options:e}]}},{key:"encodeFlat",value:function(){return{data:[o.SIDE_BIN,this.leftEncode(),o.MIDDLE_BIN,this.rightEncode(),o.SIDE_BIN].join(""),text:this.text}}}]),e}(a(n(0)).default);e.default=u},function(t,e,n){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var r=function(){function t(t,e){for(var n=0;n<e.length;n++){var r=e[n];r.enumerable=r.enumerable||!1,r.configurable=!0,"value"in r&&(r.writable=!0),Object.defineProperty(t,r.key,r)}}return function(e,n,r){return n&&t(e.prototype,n),r&&t(e,r),e}}();e.checksum=u;var o=i(n(3));function i(t){return t&&t.__esModule?t:{default:t}}var a=function(t){function e(t,n){!function(t,e){if(!(t instanceof e))throw new TypeError("Cannot call a class as a function")}(this,e),-1!==t.search(/^[0-9]{11}$/)&&(t+=u(t));var r=function(t,e){if(!t)throw new ReferenceError("this hasn't been initialised - super() hasn't been called");return!e||"object"!=typeof e&&"function"!=typeof e?t:e}(this,(e.__proto__||Object.getPrototypeOf(e)).call(this,t,n));return r.displayValue=n.displayValue,n.fontSize>10*n.width?r.fontSize=10*n.width:r.fontSize=n.fontSize,r.guardHeight=n.height+r.fontSize/2+n.textMargin,r}return function(t,e){if("function"!=typeof e&&null!==e)throw new TypeError("Super expression must either be null or a function, not "+typeof e);t.prototype=Object.create(e&&e.prototype,{constructor:{value:t,enumerable:!1,writable:!0,configurable:!0}}),e&&(Object.setPrototypeOf?Object.setPrototypeOf(t,e):t.__proto__=e)}(e,t),r(e,[{key:"valid",value:function(){return-1!==this.data.search(/^[0-9]{12}$/)&&this.data[11]==u(this.data)}},{key:"encode",value:function(){return this.options.flat?this.flatEncoding():this.guardedEncoding()}},{key:"flatEncoding",value:function(){var t="";return t+="101",t+=(0,o.default)(this.data.substr(0,6),"LLLLLL"),t+="01010",t+=(0,o.default)(this.data.substr(6,6),"RRRRRR"),{data:t+="101",text:this.text}}},{key:"guardedEncoding",value:function(){var t=[];return this.displayValue&&t.push({data:"00000000",text:this.text.substr(0,1),options:{textAlign:"left",fontSize:this.fontSize}}),t.push({data:"101"+(0,o.default)(this.data[0],"L"),options:{height:this.guardHeight}}),t.push({data:(0,o.default)(this.data.substr(1,5),"LLLLL"),text:this.text.substr(1,5),options:{fontSize:this.fontSize}}),t.push({data:"01010",options:{height:this.guardHeight}}),t.push({data:(0,o.default)(this.data.substr(6,5),"RRRRR"),text:this.text.substr(6,5),options:{fontSize:this.fontSize}}),t.push({data:(0,o.default)(this.data[11],"R")+"101",options:{height:this.guardHeight}}),this.displayValue&&t.push({data:"00000000",text:this.text.substr(11,1),options:{textAlign:"right",fontSize:this.fontSize}}),t}}]),e}(i(n(0)).default);function u(t){var e,n=0;for(e=1;e<11;e+=2)n+=parseInt(t[e]);for(e=0;e<11;e+=2)n+=3*parseInt(t[e]);return(10-n%10)%10}e.default=a},function(t,e,n){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var r,o=function(){function t(t,e){for(var n=0;n<e.length;n++){var r=e[n];r.enumerable=r.enumerable||!1,r.configurable=!0,"value"in r&&(r.writable=!0),Object.defineProperty(t,r.key,r)}}return function(e,n,r){return n&&t(e.prototype,n),r&&t(e,r),e}}(),i=n(31),a=n(0);function u(t,e){if(!(t instanceof e))throw new TypeError("Cannot call a class as a function")}function f(t,e){if(!t)throw new ReferenceError("this hasn't been initialised - super() hasn't been called");return!e||"object"!=typeof e&&"function"!=typeof e?t:e}var c=function(t){function e(){return u(this,e),f(this,(e.__proto__||Object.getPrototypeOf(e)).apply(this,arguments))}return function(t,e){if("function"!=typeof e&&null!==e)throw new TypeError("Super expression must either be null or a function, not "+typeof e);t.prototype=Object.create(e&&e.prototype,{constructor:{value:t,enumerable:!1,writable:!0,configurable:!0}}),e&&(Object.setPrototypeOf?Object.setPrototypeOf(t,e):t.__proto__=e)}(e,t),o(e,[{key:"valid",value:function(){return-1!==this.data.search(/^([0-9]{2})+$/)}},{key:"encode",value:function(){var t=this,e=this.data.match(/.{2}/g).map((function(e){return t.encodePair(e)})).join("");return{data:i.START_BIN+e+i.END_BIN,text:this.text}}},{key:"encodePair",value:function(t){var e=i.BINARIES[t[1]];return i.BINARIES[t[0]].split("").map((function(t,n){return("1"===t?"111":"1")+("1"===e[n]?"000":"0")})).join("")}}]),e}(((r=a)&&r.__esModule?r:{default:r}).default);e.default=c},function(t,e,n){"use strict";Object.defineProperty(e,"__esModule",{value:!0}),e.default=function(t){var e=["width","height","textMargin","fontSize","margin","marginTop","marginBottom","marginLeft","marginRight"];for(var n in e)e.hasOwnProperty(n)&&(n=e[n],"string"==typeof t[n]&&(t[n]=parseInt(t[n],10)));"string"==typeof t.displayValue&&(t.displayValue="false"!=t.displayValue);return t}},function(t,e,n){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var r={width:2,height:100,format:"auto",displayValue:!0,fontOptions:"",font:"monospace",text:void 0,textAlign:"center",textPosition:"bottom",textMargin:2,fontSize:20,background:"#ffffff",lineColor:"#000000",margin:10,marginTop:void 0,marginBottom:void 0,marginLeft:void 0,marginRight:void 0,valid:function(){}};e.default=r},function(t,e,n){"use strict";Object.defineProperty(e,"__esModule",{value:!0}),e.getTotalWidthOfEncodings=e.calculateEncodingAttributes=e.getBarcodePadding=e.getEncodingHeight=e.getMaximumHeightOfEncodings=void 0;var r,o=n(7),i=(r=o)&&r.__esModule?r:{default:r};function a(t,e){return e.height+(e.displayValue&&t.text.length>0?e.fontSize+e.textMargin:0)+e.marginTop+e.marginBottom}function u(t,e,n){if(n.displayValue&&e<t){if("center"==n.textAlign)return Math.floor((t-e)/2);if("left"==n.textAlign)return 0;if("right"==n.textAlign)return Math.floor(t-e)}return 0}function f(t,e,n){var r;if(n)r=n;else{if("undefined"==typeof document)return 0;r=document.createElement("canvas").getContext("2d")}r.font=e.fontOptions+" "+e.fontSize+"px "+e.font;var o=r.measureText(t);return o?o.width:0}e.getMaximumHeightOfEncodings=function(t){for(var e=0,n=0;n<t.length;n++)t[n].height>e&&(e=t[n].height);return e},e.getEncodingHeight=a,e.getBarcodePadding=u,e.calculateEncodingAttributes=function(t,e,n){for(var r=0;r<t.length;r++){var o,c=t[r],s=(0,i.default)(e,c.options);o=s.displayValue?f(c.text,s,n):0;var l=c.data.length*s.width;c.width=Math.ceil(Math.max(o,l)),c.height=a(c,s),c.barcodePadding=u(o,l,s)}},e.getTotalWidthOfEncodings=function(t){for(var e=0,n=0;n<t.length;n++)e+=t[n].width;return e}},function(t,e,n){"use strict";function r(t,e){if(!(t instanceof e))throw new TypeError("Cannot call a class as a function")}function o(t,e){if(!t)throw new ReferenceError("this hasn't been initialised - super() hasn't been called");return!e||"object"!=typeof e&&"function"!=typeof e?t:e}function i(t,e){if("function"!=typeof e&&null!==e)throw new TypeError("Super expression must either be null or a function, not "+typeof e);t.prototype=Object.create(e&&e.prototype,{constructor:{value:t,enumerable:!1,writable:!0,configurable:!0}}),e&&(Object.setPrototypeOf?Object.setPrototypeOf(t,e):t.__proto__=e)}Object.defineProperty(e,"__esModule",{value:!0});var a=function(t){function e(t,n){r(this,e);var i=o(this,(e.__proto__||Object.getPrototypeOf(e)).call(this));return i.name="InvalidInputException",i.symbology=t,i.input=n,i.message='"'+i.input+'" is not a valid input for '+i.symbology,i}return i(e,Error),e}(),u=function(t){function e(){r(this,e);var t=o(this,(e.__proto__||Object.getPrototypeOf(e)).call(this));return t.name="InvalidElementException",t.message="Not supported type to render on",t}return i(e,Error),e}(),f=function(t){function e(){r(this,e);var t=o(this,(e.__proto__||Object.getPrototypeOf(e)).call(this));return t.name="NoElementException",t.message="No element to render on.",t}return i(e,Error),e}();e.InvalidInputException=a,e.InvalidElementException=u,e.NoElementException=f},function(t,e,n){"use strict";var r=p(n(16)),o=p(n(7)),i=p(n(41)),a=p(n(42)),u=p(n(43)),f=p(n(11)),c=p(n(49)),s=n(14),l=p(n(12));function p(t){return t&&t.__esModule?t:{default:t}}var d=function(){},h=function(t,e,n){var r=new d;if(void 0===t)throw Error("No element to render on was provided.");return r._renderProperties=(0,u.default)(t),r._encodings=[],r._options=l.default,r._errorHandler=new c.default(r),void 0!==e&&((n=n||{}).format||(n.format=_()),r.options(n)[n.format](e,n).render()),r};for(var y in h.getModule=function(t){return r.default[t]},r.default)r.default.hasOwnProperty(y)&&b(r.default,y);function b(t,e){d.prototype[e]=d.prototype[e.toUpperCase()]=d.prototype[e.toLowerCase()]=function(n,r){var i=this;return i._errorHandler.wrapBarcodeCall((function(){r.text=void 0===r.text?void 0:""+r.text;var a=(0,o.default)(i._options,r);a=(0,f.default)(a);var u=t[e],c=v(n,u,a);return i._encodings.push(c),i}))}}function v(t,e,n){var r=new e(t=""+t,n);if(!r.valid())throw new s.InvalidInputException(r.constructor.name,t);var a=r.encode();a=(0,i.default)(a);for(var u=0;u<a.length;u++)a[u].options=(0,o.default)(n,a[u].options);return a}function _(){return r.default.CODE128?"CODE128":Object.keys(r.default)[0]}function g(t,e,n){e=(0,i.default)(e);for(var r=0;r<e.length;r++)e[r].options=(0,o.default)(n,e[r].options),(0,a.default)(e[r].options);(0,a.default)(n),new(0,t.renderer)(t.element,e,n).render(),t.afterRender&&t.afterRender()}d.prototype.options=function(t){return this._options=(0,o.default)(this._options,t),this},d.prototype.blank=function(t){var e=new Array(t+1).join("0");return this._encodings.push({data:e}),this},d.prototype.init=function(){var t;if(this._renderProperties)for(var e in Array.isArray(this._renderProperties)||(this._renderProperties=[this._renderProperties]),this._renderProperties){t=this._renderProperties[e];var n=(0,o.default)(this._options,t.options);"auto"==n.format&&(n.format=_()),this._errorHandler.wrapBarcodeCall((function(){var e=v(n.value,r.default[n.format.toUpperCase()],n);g(t,e,n)}))}},d.prototype.render=function(){if(!this._renderProperties)throw new s.NoElementException;if(Array.isArray(this._renderProperties))for(var t=0;t<this._renderProperties.length;t++)g(this._renderProperties[t],this._encodings,this._options);else g(this._renderProperties,this._encodings,this._options);return this},d.prototype._defaults=l.default,"undefined"!=typeof window&&(window.JsBarcode=h),"undefined"!=typeof jQuery&&(jQuery.fn.JsBarcode=function(t,e){var n=[];return jQuery(this).each((function(){n.push(this)})),h(n,t,e)}),t.exports=h},function(t,e,n){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var r=n(17),o=n(18),i=n(24),a=n(30),u=n(33),f=n(38),c=n(39),s=n(40);e.default={CODE39:r.CODE39,CODE128:o.CODE128,CODE128A:o.CODE128A,CODE128B:o.CODE128B,CODE128C:o.CODE128C,EAN13:i.EAN13,EAN8:i.EAN8,EAN5:i.EAN5,EAN2:i.EAN2,UPC:i.UPC,UPCE:i.UPCE,ITF14:a.ITF14,ITF:a.ITF,MSI:u.MSI,MSI10:u.MSI10,MSI11:u.MSI11,MSI1010:u.MSI1010,MSI1110:u.MSI1110,pharmacode:f.pharmacode,codabar:c.codabar,GenericBarcode:s.GenericBarcode}},function(t,e,n){"use strict";Object.defineProperty(e,"__esModule",{value:!0}),e.CODE39=void 0;var r,o=function(){function t(t,e){for(var n=0;n<e.length;n++){var r=e[n];r.enumerable=r.enumerable||!1,r.configurable=!0,"value"in r&&(r.writable=!0),Object.defineProperty(t,r.key,r)}}return function(e,n,r){return n&&t(e.prototype,n),r&&t(e,r),e}}(),i=n(0);var a=function(t){function e(t,n){return function(t,e){if(!(t instanceof e))throw new TypeError("Cannot call a class as a function")}(this,e),t=t.toUpperCase(),n.mod43&&(t+=function(t){return u[t]}(function(t){for(var e=0,n=0;n<t.length;n++)e+=s(t[n]);return e%=43}(t))),function(t,e){if(!t)throw new ReferenceError("this hasn't been initialised - super() hasn't been called");return!e||"object"!=typeof e&&"function"!=typeof e?t:e}(this,(e.__proto__||Object.getPrototypeOf(e)).call(this,t,n))}return function(t,e){if("function"!=typeof e&&null!==e)throw new TypeError("Super expression must either be null or a function, not "+typeof e);t.prototype=Object.create(e&&e.prototype,{constructor:{value:t,enumerable:!1,writable:!0,configurable:!0}}),e&&(Object.setPrototypeOf?Object.setPrototypeOf(t,e):t.__proto__=e)}(e,t),o(e,[{key:"encode",value:function(){for(var t=c("*"),e=0;e<this.data.length;e++)t+=c(this.data[e])+"0";return{data:t+=c("*"),text:this.text}}},{key:"valid",value:function(){return-1!==this.data.search(/^[0-9A-Z\-\.\ \$\/\+\%]+$/)}}]),e}(((r=i)&&r.__esModule?r:{default:r}).default),u=["0","1","2","3","4","5","6","7","8","9","A","B","C","D","E","F","G","H","I","J","K","L","M","N","O","P","Q","R","S","T","U","V","W","X","Y","Z","-","."," ","$","/","+","%","*"],f=[20957,29783,23639,30485,20951,29813,23669,20855,29789,23645,29975,23831,30533,22295,30149,24005,21623,29981,23837,22301,30023,23879,30545,22343,30161,24017,21959,30065,23921,22385,29015,18263,29141,17879,29045,18293,17783,29021,18269,17477,17489,17681,20753,35770];function c(t){return function(t){return f[t].toString(2)}(s(t))}function s(t){return u.indexOf(t)}e.CODE39=a},function(t,e,n){"use strict";Object.defineProperty(e,"__esModule",{value:!0}),e.CODE128C=e.CODE128B=e.CODE128A=e.CODE128=void 0;var r=u(n(19)),o=u(n(21)),i=u(n(22)),a=u(n(23));function u(t){return t&&t.__esModule?t:{default:t}}e.CODE128=r.default,e.CODE128A=o.default,e.CODE128B=i.default,e.CODE128C=a.default},function(t,e,n){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var r=i(n(5)),o=i(n(20));function i(t){return t&&t.__esModule?t:{default:t}}function a(t,e){if(!t)throw new ReferenceError("this hasn't been initialised - super() hasn't been called");return!e||"object"!=typeof e&&"function"!=typeof e?t:e}var u=function(t){function e(t,n){if(function(t,e){if(!(t instanceof e))throw new TypeError("Cannot call a class as a function")}(this,e),/^[\x00-\x7F\xC8-\xD3]+$/.test(t))var r=a(this,(e.__proto__||Object.getPrototypeOf(e)).call(this,(0,o.default)(t),n));else r=a(this,(e.__proto__||Object.getPrototypeOf(e)).call(this,t,n));return a(r)}return function(t,e){if("function"!=typeof e&&null!==e)throw new TypeError("Super expression must either be null or a function, not "+typeof e);t.prototype=Object.create(e&&e.prototype,{constructor:{value:t,enumerable:!1,writable:!0,configurable:!0}}),e&&(Object.setPrototypeOf?Object.setPrototypeOf(t,e):t.__proto__=e)}(e,t),e}(r.default);e.default=u},function(t,e,n){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var r=n(1),o=function(t){return t.match(new RegExp("^"+r.A_CHARS+"*"))[0].length},i=function(t){return t.match(new RegExp("^"+r.B_CHARS+"*"))[0].length},a=function(t){return t.match(new RegExp("^"+r.C_CHARS+"*"))[0]};function u(t,e){var n=e?r.A_CHARS:r.B_CHARS,o=t.match(new RegExp("^("+n+"+?)(([0-9]{2}){2,})([^0-9]|$)"));if(o)return o[1]+String.fromCharCode(204)+f(t.substring(o[1].length));var i=t.match(new RegExp("^"+n+"+"))[0];return i.length===t.length?t:i+String.fromCharCode(e?205:206)+u(t.substring(i.length),!e)}function f(t){var e=a(t),n=e.length;if(n===t.length)return t;t=t.substring(n);var r=o(t)>=i(t);return e+String.fromCharCode(r?206:205)+u(t,r)}e.default=function(t){var e=void 0;if(a(t).length>=2)e=r.C_START_CHAR+f(t);else{var n=o(t)>i(t);e=(n?r.A_START_CHAR:r.B_START_CHAR)+u(t,n)}return e.replace(/[\xCD\xCE]([^])[\xCD\xCE]/,(function(t,e){return String.fromCharCode(203)+e}))}},function(t,e,n){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var r,o=function(){function t(t,e){for(var n=0;n<e.length;n++){var r=e[n];r.enumerable=r.enumerable||!1,r.configurable=!0,"value"in r&&(r.writable=!0),Object.defineProperty(t,r.key,r)}}return function(e,n,r){return n&&t(e.prototype,n),r&&t(e,r),e}}(),i=n(5),a=(r=i)&&r.__esModule?r:{default:r},u=n(1);var f=function(t){function e(t,n){return function(t,e){if(!(t instanceof e))throw new TypeError("Cannot call a class as a function")}(this,e),function(t,e){if(!t)throw new ReferenceError("this hasn't been initialised - super() hasn't been called");return!e||"object"!=typeof e&&"function"!=typeof e?t:e}(this,(e.__proto__||Object.getPrototypeOf(e)).call(this,u.A_START_CHAR+t,n))}return function(t,e){if("function"!=typeof e&&null!==e)throw new TypeError("Super expression must either be null or a function, not "+typeof e);t.prototype=Object.create(e&&e.prototype,{constructor:{value:t,enumerable:!1,writable:!0,configurable:!0}}),e&&(Object.setPrototypeOf?Object.setPrototypeOf(t,e):t.__proto__=e)}(e,t),o(e,[{key:"valid",value:function(){return new RegExp("^"+u.A_CHARS+"+$").test(this.data)}}]),e}(a.default);e.default=f},function(t,e,n){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var r,o=function(){function t(t,e){for(var n=0;n<e.length;n++){var r=e[n];r.enumerable=r.enumerable||!1,r.configurable=!0,"value"in r&&(r.writable=!0),Object.defineProperty(t,r.key,r)}}return function(e,n,r){return n&&t(e.prototype,n),r&&t(e,r),e}}(),i=n(5),a=(r=i)&&r.__esModule?r:{default:r},u=n(1);var f=function(t){function e(t,n){return function(t,e){if(!(t instanceof e))throw new TypeError("Cannot call a class as a function")}(this,e),function(t,e){if(!t)throw new ReferenceError("this hasn't been initialised - super() hasn't been called");return!e||"object"!=typeof e&&"function"!=typeof e?t:e}(this,(e.__proto__||Object.getPrototypeOf(e)).call(this,u.B_START_CHAR+t,n))}return function(t,e){if("function"!=typeof e&&null!==e)throw new TypeError("Super expression must either be null or a function, not "+typeof e);t.prototype=Object.create(e&&e.prototype,{constructor:{value:t,enumerable:!1,writable:!0,configurable:!0}}),e&&(Object.setPrototypeOf?Object.setPrototypeOf(t,e):t.__proto__=e)}(e,t),o(e,[{key:"valid",value:function(){return new RegExp("^"+u.B_CHARS+"+$").test(this.data)}}]),e}(a.default);e.default=f},function(t,e,n){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var r,o=function(){function t(t,e){for(var n=0;n<e.length;n++){var r=e[n];r.enumerable=r.enumerable||!1,r.configurable=!0,"value"in r&&(r.writable=!0),Object.defineProperty(t,r.key,r)}}return function(e,n,r){return n&&t(e.prototype,n),r&&t(e,r),e}}(),i=n(5),a=(r=i)&&r.__esModule?r:{default:r},u=n(1);var f=function(t){function e(t,n){return function(t,e){if(!(t instanceof e))throw new TypeError("Cannot call a class as a function")}(this,e),function(t,e){if(!t)throw new ReferenceError("this hasn't been initialised - super() hasn't been called");return!e||"object"!=typeof e&&"function"!=typeof e?t:e}(this,(e.__proto__||Object.getPrototypeOf(e)).call(this,u.C_START_CHAR+t,n))}return function(t,e){if("function"!=typeof e&&null!==e)throw new TypeError("Super expression must either be null or a function, not "+typeof e);t.prototype=Object.create(e&&e.prototype,{constructor:{value:t,enumerable:!1,writable:!0,configurable:!0}}),e&&(Object.setPrototypeOf?Object.setPrototypeOf(t,e):t.__proto__=e)}(e,t),o(e,[{key:"valid",value:function(){return new RegExp("^"+u.C_CHARS+"+$").test(this.data)}}]),e}(a.default);e.default=f},function(t,e,n){"use strict";Object.defineProperty(e,"__esModule",{value:!0}),e.UPCE=e.UPC=e.EAN2=e.EAN5=e.EAN8=e.EAN13=void 0;var r=c(n(25)),o=c(n(26)),i=c(n(27)),a=c(n(28)),u=c(n(9)),f=c(n(29));function c(t){return t&&t.__esModule?t:{default:t}}e.EAN13=r.default,e.EAN8=o.default,e.EAN5=i.default,e.EAN2=a.default,e.UPC=u.default,e.UPCE=f.default},function(t,e,n){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var r,o=function(){function t(t,e){for(var n=0;n<e.length;n++){var r=e[n];r.enumerable=r.enumerable||!1,r.configurable=!0,"value"in r&&(r.writable=!0),Object.defineProperty(t,r.key,r)}}return function(e,n,r){return n&&t(e.prototype,n),r&&t(e,r),e}}(),i=function t(e,n,r){null===e&&(e=Function.prototype);var o=Object.getOwnPropertyDescriptor(e,n);if(void 0===o){var i=Object.getPrototypeOf(e);return null===i?void 0:t(i,n,r)}if("value"in o)return o.value;var a=o.get;return void 0!==a?a.call(r):void 0},a=n(2),u=n(8),f=(r=u)&&r.__esModule?r:{default:r};var c=function(t){return(10-t.substr(0,12).split("").map((function(t){return+t})).reduce((function(t,e,n){return n%2?t+3*e:t+e}),0)%10)%10},s=function(t){function e(t,n){!function(t,e){if(!(t instanceof e))throw new TypeError("Cannot call a class as a function")}(this,e),-1!==t.search(/^[0-9]{12}$/)&&(t+=c(t));var r=function(t,e){if(!t)throw new ReferenceError("this hasn't been initialised - super() hasn't been called");return!e||"object"!=typeof e&&"function"!=typeof e?t:e}(this,(e.__proto__||Object.getPrototypeOf(e)).call(this,t,n));return r.lastChar=n.lastChar,r}return function(t,e){if("function"!=typeof e&&null!==e)throw new TypeError("Super expression must either be null or a function, not "+typeof e);t.prototype=Object.create(e&&e.prototype,{constructor:{value:t,enumerable:!1,writable:!0,configurable:!0}}),e&&(Object.setPrototypeOf?Object.setPrototypeOf(t,e):t.__proto__=e)}(e,t),o(e,[{key:"valid",value:function(){return-1!==this.data.search(/^[0-9]{13}$/)&&+this.data[12]===c(this.data)}},{key:"leftText",value:function(){return i(e.prototype.__proto__||Object.getPrototypeOf(e.prototype),"leftText",this).call(this,1,6)}},{key:"leftEncode",value:function(){var t=this.data.substr(1,6),n=a.EAN13_STRUCTURE[this.data[0]];return i(e.prototype.__proto__||Object.getPrototypeOf(e.prototype),"leftEncode",this).call(this,t,n)}},{key:"rightText",value:function(){return i(e.prototype.__proto__||Object.getPrototypeOf(e.prototype),"rightText",this).call(this,7,6)}},{key:"rightEncode",value:function(){var t=this.data.substr(7,6);return i(e.prototype.__proto__||Object.getPrototypeOf(e.prototype),"rightEncode",this).call(this,t,"RRRRRR")}},{key:"encodeGuarded",value:function(){var t=i(e.prototype.__proto__||Object.getPrototypeOf(e.prototype),"encodeGuarded",this).call(this);return this.options.displayValue&&(t.unshift({data:"000000000000",text:this.text.substr(0,1),options:{textAlign:"left",fontSize:this.fontSize}}),this.options.lastChar&&(t.push({data:"00"}),t.push({data:"00000",text:this.options.lastChar,options:{fontSize:this.fontSize}}))),t}}]),e}(f.default);e.default=s},function(t,e,n){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var r,o=function(){function t(t,e){for(var n=0;n<e.length;n++){var r=e[n];r.enumerable=r.enumerable||!1,r.configurable=!0,"value"in r&&(r.writable=!0),Object.defineProperty(t,r.key,r)}}return function(e,n,r){return n&&t(e.prototype,n),r&&t(e,r),e}}(),i=function t(e,n,r){null===e&&(e=Function.prototype);var o=Object.getOwnPropertyDescriptor(e,n);if(void 0===o){var i=Object.getPrototypeOf(e);return null===i?void 0:t(i,n,r)}if("value"in o)return o.value;var a=o.get;return void 0!==a?a.call(r):void 0},a=n(8),u=(r=a)&&r.__esModule?r:{default:r};var f=function(t){return(10-t.substr(0,7).split("").map((function(t){return+t})).reduce((function(t,e,n){return n%2?t+e:t+3*e}),0)%10)%10},c=function(t){function e(t,n){return function(t,e){if(!(t instanceof e))throw new TypeError("Cannot call a class as a function")}(this,e),-1!==t.search(/^[0-9]{7}$/)&&(t+=f(t)),function(t,e){if(!t)throw new ReferenceError("this hasn't been initialised - super() hasn't been called");return!e||"object"!=typeof e&&"function"!=typeof e?t:e}(this,(e.__proto__||Object.getPrototypeOf(e)).call(this,t,n))}return function(t,e){if("function"!=typeof e&&null!==e)throw new TypeError("Super expression must either be null or a function, not "+typeof e);t.prototype=Object.create(e&&e.prototype,{constructor:{value:t,enumerable:!1,writable:!0,configurable:!0}}),e&&(Object.setPrototypeOf?Object.setPrototypeOf(t,e):t.__proto__=e)}(e,t),o(e,[{key:"valid",value:function(){return-1!==this.data.search(/^[0-9]{8}$/)&&+this.data[7]===f(this.data)}},{key:"leftText",value:function(){return i(e.prototype.__proto__||Object.getPrototypeOf(e.prototype),"leftText",this).call(this,0,4)}},{key:"leftEncode",value:function(){var t=this.data.substr(0,4);return i(e.prototype.__proto__||Object.getPrototypeOf(e.prototype),"leftEncode",this).call(this,t,"LLLL")}},{key:"rightText",value:function(){return i(e.prototype.__proto__||Object.getPrototypeOf(e.prototype),"rightText",this).call(this,4,4)}},{key:"rightEncode",value:function(){var t=this.data.substr(4,4);return i(e.prototype.__proto__||Object.getPrototypeOf(e.prototype),"rightEncode",this).call(this,t,"RRRR")}}]),e}(u.default);e.default=c},function(t,e,n){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var r=function(){function t(t,e){for(var n=0;n<e.length;n++){var r=e[n];r.enumerable=r.enumerable||!1,r.configurable=!0,"value"in r&&(r.writable=!0),Object.defineProperty(t,r.key,r)}}return function(e,n,r){return n&&t(e.prototype,n),r&&t(e,r),e}}(),o=n(2),i=u(n(3)),a=u(n(0));function u(t){return t&&t.__esModule?t:{default:t}}var f=function(t){function e(t,n){return function(t,e){if(!(t instanceof e))throw new TypeError("Cannot call a class as a function")}(this,e),function(t,e){if(!t)throw new ReferenceError("this hasn't been initialised - super() hasn't been called");return!e||"object"!=typeof e&&"function"!=typeof e?t:e}(this,(e.__proto__||Object.getPrototypeOf(e)).call(this,t,n))}return function(t,e){if("function"!=typeof e&&null!==e)throw new TypeError("Super expression must either be null or a function, not "+typeof e);t.prototype=Object.create(e&&e.prototype,{constructor:{value:t,enumerable:!1,writable:!0,configurable:!0}}),e&&(Object.setPrototypeOf?Object.setPrototypeOf(t,e):t.__proto__=e)}(e,t),r(e,[{key:"valid",value:function(){return-1!==this.data.search(/^[0-9]{5}$/)}},{key:"encode",value:function(){var t,e=o.EAN5_STRUCTURE[(t=this.data,t.split("").map((function(t){return+t})).reduce((function(t,e,n){return n%2?t+9*e:t+3*e}),0)%10)];return{data:"1011"+(0,i.default)(this.data,e,"01"),text:this.text}}}]),e}(a.default);e.default=f},function(t,e,n){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var r=function(){function t(t,e){for(var n=0;n<e.length;n++){var r=e[n];r.enumerable=r.enumerable||!1,r.configurable=!0,"value"in r&&(r.writable=!0),Object.defineProperty(t,r.key,r)}}return function(e,n,r){return n&&t(e.prototype,n),r&&t(e,r),e}}(),o=n(2),i=a(n(3));function a(t){return t&&t.__esModule?t:{default:t}}var u=function(t){function e(t,n){return function(t,e){if(!(t instanceof e))throw new TypeError("Cannot call a class as a function")}(this,e),function(t,e){if(!t)throw new ReferenceError("this hasn't been initialised - super() hasn't been called");return!e||"object"!=typeof e&&"function"!=typeof e?t:e}(this,(e.__proto__||Object.getPrototypeOf(e)).call(this,t,n))}return function(t,e){if("function"!=typeof e&&null!==e)throw new TypeError("Super expression must either be null or a function, not "+typeof e);t.prototype=Object.create(e&&e.prototype,{constructor:{value:t,enumerable:!1,writable:!0,configurable:!0}}),e&&(Object.setPrototypeOf?Object.setPrototypeOf(t,e):t.__proto__=e)}(e,t),r(e,[{key:"valid",value:function(){return-1!==this.data.search(/^[0-9]{2}$/)}},{key:"encode",value:function(){var t=o.EAN2_STRUCTURE[parseInt(this.data)%4];return{data:"1011"+(0,i.default)(this.data,t,"01"),text:this.text}}}]),e}(a(n(0)).default);e.default=u},function(t,e,n){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var r=function(){function t(t,e){for(var n=0;n<e.length;n++){var r=e[n];r.enumerable=r.enumerable||!1,r.configurable=!0,"value"in r&&(r.writable=!0),Object.defineProperty(t,r.key,r)}}return function(e,n,r){return n&&t(e.prototype,n),r&&t(e,r),e}}(),o=u(n(3)),i=u(n(0)),a=n(9);function u(t){return t&&t.__esModule?t:{default:t}}function f(t,e){if(!t)throw new ReferenceError("this hasn't been initialised - super() hasn't been called");return!e||"object"!=typeof e&&"function"!=typeof e?t:e}var c=["XX00000XXX","XX10000XXX","XX20000XXX","XXX00000XX","XXXX00000X","XXXXX00005","XXXXX00006","XXXXX00007","XXXXX00008","XXXXX00009"],s=[["EEEOOO","OOOEEE"],["EEOEOO","OOEOEE"],["EEOOEO","OOEEOE"],["EEOOOE","OOEEEO"],["EOEEOO","OEOOEE"],["EOOEEO","OEEOOE"],["EOOOEE","OEEEOO"],["EOEOEO","OEOEOE"],["EOEOOE","OEOEEO"],["EOOEOE","OEEOEO"]],l=function(t){function e(t,n){!function(t,e){if(!(t instanceof e))throw new TypeError("Cannot call a class as a function")}(this,e);var r=f(this,(e.__proto__||Object.getPrototypeOf(e)).call(this,t,n));if(r.isValid=!1,-1!==t.search(/^[0-9]{6}$/))r.middleDigits=t,r.upcA=p(t,"0"),r.text=n.text||""+r.upcA[0]+t+r.upcA[r.upcA.length-1],r.isValid=!0;else{if(-1===t.search(/^[01][0-9]{7}$/))return f(r);if(r.middleDigits=t.substring(1,t.length-1),r.upcA=p(r.middleDigits,t[0]),r.upcA[r.upcA.length-1]!==t[t.length-1])return f(r);r.isValid=!0}return r.displayValue=n.displayValue,n.fontSize>10*n.width?r.fontSize=10*n.width:r.fontSize=n.fontSize,r.guardHeight=n.height+r.fontSize/2+n.textMargin,r}return function(t,e){if("function"!=typeof e&&null!==e)throw new TypeError("Super expression must either be null or a function, not "+typeof e);t.prototype=Object.create(e&&e.prototype,{constructor:{value:t,enumerable:!1,writable:!0,configurable:!0}}),e&&(Object.setPrototypeOf?Object.setPrototypeOf(t,e):t.__proto__=e)}(e,t),r(e,[{key:"valid",value:function(){return this.isValid}},{key:"encode",value:function(){return this.options.flat?this.flatEncoding():this.guardedEncoding()}},{key:"flatEncoding",value:function(){var t="";return t+="101",t+=this.encodeMiddleDigits(),{data:t+="010101",text:this.text}}},{key:"guardedEncoding",value:function(){var t=[];return this.displayValue&&t.push({data:"00000000",text:this.text[0],options:{textAlign:"left",fontSize:this.fontSize}}),t.push({data:"101",options:{height:this.guardHeight}}),t.push({data:this.encodeMiddleDigits(),text:this.text.substring(1,7),options:{fontSize:this.fontSize}}),t.push({data:"010101",options:{height:this.guardHeight}}),this.displayValue&&t.push({data:"00000000",text:this.text[7],options:{textAlign:"right",fontSize:this.fontSize}}),t}},{key:"encodeMiddleDigits",value:function(){var t=this.upcA[0],e=this.upcA[this.upcA.length-1],n=s[parseInt(e)][parseInt(t)];return(0,o.default)(this.middleDigits,n)}}]),e}(i.default);function p(t,e){for(var n=parseInt(t[t.length-1]),r=c[n],o="",i=0,u=0;u<r.length;u++){var f=r[u];o+="X"===f?t[i++]:f}return""+(o=""+e+o)+(0,a.checksum)(o)}e.default=l},function(t,e,n){"use strict";Object.defineProperty(e,"__esModule",{value:!0}),e.ITF14=e.ITF=void 0;var r=i(n(10)),o=i(n(32));function i(t){return t&&t.__esModule?t:{default:t}}e.ITF=r.default,e.ITF14=o.default},function(t,e,n){"use strict";Object.defineProperty(e,"__esModule",{value:!0});e.START_BIN="1010",e.END_BIN="11101",e.BINARIES=["00110","10001","01001","11000","00101","10100","01100","00011","10010","01010"]},function(t,e,n){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var r,o=function(){function t(t,e){for(var n=0;n<e.length;n++){var r=e[n];r.enumerable=r.enumerable||!1,r.configurable=!0,"value"in r&&(r.writable=!0),Object.defineProperty(t,r.key,r)}}return function(e,n,r){return n&&t(e.prototype,n),r&&t(e,r),e}}(),i=n(10),a=(r=i)&&r.__esModule?r:{default:r};var u=function(t){var e=t.substr(0,13).split("").map((function(t){return parseInt(t,10)})).reduce((function(t,e,n){return t+e*(3-n%2*2)}),0);return 10*Math.ceil(e/10)-e},f=function(t){function e(t,n){return function(t,e){if(!(t instanceof e))throw new TypeError("Cannot call a class as a function")}(this,e),-1!==t.search(/^[0-9]{13}$/)&&(t+=u(t)),function(t,e){if(!t)throw new ReferenceError("this hasn't been initialised - super() hasn't been called");return!e||"object"!=typeof e&&"function"!=typeof e?t:e}(this,(e.__proto__||Object.getPrototypeOf(e)).call(this,t,n))}return function(t,e){if("function"!=typeof e&&null!==e)throw new TypeError("Super expression must either be null or a function, not "+typeof e);t.prototype=Object.create(e&&e.prototype,{constructor:{value:t,enumerable:!1,writable:!0,configurable:!0}}),e&&(Object.setPrototypeOf?Object.setPrototypeOf(t,e):t.__proto__=e)}(e,t),o(e,[{key:"valid",value:function(){return-1!==this.data.search(/^[0-9]{14}$/)&&+this.data[13]===u(this.data)}}]),e}(a.default);e.default=f},function(t,e,n){"use strict";Object.defineProperty(e,"__esModule",{value:!0}),e.MSI1110=e.MSI1010=e.MSI11=e.MSI10=e.MSI=void 0;var r=f(n(4)),o=f(n(34)),i=f(n(35)),a=f(n(36)),u=f(n(37));function f(t){return t&&t.__esModule?t:{default:t}}e.MSI=r.default,e.MSI10=o.default,e.MSI11=i.default,e.MSI1010=a.default,e.MSI1110=u.default},function(t,e,n){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var r,o=n(4),i=(r=o)&&r.__esModule?r:{default:r},a=n(6);var u=function(t){function e(t,n){return function(t,e){if(!(t instanceof e))throw new TypeError("Cannot call a class as a function")}(this,e),function(t,e){if(!t)throw new ReferenceError("this hasn't been initialised - super() hasn't been called");return!e||"object"!=typeof e&&"function"!=typeof e?t:e}(this,(e.__proto__||Object.getPrototypeOf(e)).call(this,t+(0,a.mod10)(t),n))}return function(t,e){if("function"!=typeof e&&null!==e)throw new TypeError("Super expression must either be null or a function, not "+typeof e);t.prototype=Object.create(e&&e.prototype,{constructor:{value:t,enumerable:!1,writable:!0,configurable:!0}}),e&&(Object.setPrototypeOf?Object.setPrototypeOf(t,e):t.__proto__=e)}(e,t),e}(i.default);e.default=u},function(t,e,n){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var r,o=n(4),i=(r=o)&&r.__esModule?r:{default:r},a=n(6);var u=function(t){function e(t,n){return function(t,e){if(!(t instanceof e))throw new TypeError("Cannot call a class as a function")}(this,e),function(t,e){if(!t)throw new ReferenceError("this hasn't been initialised - super() hasn't been called");return!e||"object"!=typeof e&&"function"!=typeof e?t:e}(this,(e.__proto__||Object.getPrototypeOf(e)).call(this,t+(0,a.mod11)(t),n))}return function(t,e){if("function"!=typeof e&&null!==e)throw new TypeError("Super expression must either be null or a function, not "+typeof e);t.prototype=Object.create(e&&e.prototype,{constructor:{value:t,enumerable:!1,writable:!0,configurable:!0}}),e&&(Object.setPrototypeOf?Object.setPrototypeOf(t,e):t.__proto__=e)}(e,t),e}(i.default);e.default=u},function(t,e,n){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var r,o=n(4),i=(r=o)&&r.__esModule?r:{default:r},a=n(6);var u=function(t){function e(t,n){return function(t,e){if(!(t instanceof e))throw new TypeError("Cannot call a class as a function")}(this,e),t+=(0,a.mod10)(t),t+=(0,a.mod10)(t),function(t,e){if(!t)throw new ReferenceError("this hasn't been initialised - super() hasn't been called");return!e||"object"!=typeof e&&"function"!=typeof e?t:e}(this,(e.__proto__||Object.getPrototypeOf(e)).call(this,t,n))}return function(t,e){if("function"!=typeof e&&null!==e)throw new TypeError("Super expression must either be null or a function, not "+typeof e);t.prototype=Object.create(e&&e.prototype,{constructor:{value:t,enumerable:!1,writable:!0,configurable:!0}}),e&&(Object.setPrototypeOf?Object.setPrototypeOf(t,e):t.__proto__=e)}(e,t),e}(i.default);e.default=u},function(t,e,n){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var r,o=n(4),i=(r=o)&&r.__esModule?r:{default:r},a=n(6);var u=function(t){function e(t,n){return function(t,e){if(!(t instanceof e))throw new TypeError("Cannot call a class as a function")}(this,e),t+=(0,a.mod11)(t),t+=(0,a.mod10)(t),function(t,e){if(!t)throw new ReferenceError("this hasn't been initialised - super() hasn't been called");return!e||"object"!=typeof e&&"function"!=typeof e?t:e}(this,(e.__proto__||Object.getPrototypeOf(e)).call(this,t,n))}return function(t,e){if("function"!=typeof e&&null!==e)throw new TypeError("Super expression must either be null or a function, not "+typeof e);t.prototype=Object.create(e&&e.prototype,{constructor:{value:t,enumerable:!1,writable:!0,configurable:!0}}),e&&(Object.setPrototypeOf?Object.setPrototypeOf(t,e):t.__proto__=e)}(e,t),e}(i.default);e.default=u},function(t,e,n){"use strict";Object.defineProperty(e,"__esModule",{value:!0}),e.pharmacode=void 0;var r,o=function(){function t(t,e){for(var n=0;n<e.length;n++){var r=e[n];r.enumerable=r.enumerable||!1,r.configurable=!0,"value"in r&&(r.writable=!0),Object.defineProperty(t,r.key,r)}}return function(e,n,r){return n&&t(e.prototype,n),r&&t(e,r),e}}(),i=n(0);var a=function(t){function e(t,n){!function(t,e){if(!(t instanceof e))throw new TypeError("Cannot call a class as a function")}(this,e);var r=function(t,e){if(!t)throw new ReferenceError("this hasn't been initialised - super() hasn't been called");return!e||"object"!=typeof e&&"function"!=typeof e?t:e}(this,(e.__proto__||Object.getPrototypeOf(e)).call(this,t,n));return r.number=parseInt(t,10),r}return function(t,e){if("function"!=typeof e&&null!==e)throw new TypeError("Super expression must either be null or a function, not "+typeof e);t.prototype=Object.create(e&&e.prototype,{constructor:{value:t,enumerable:!1,writable:!0,configurable:!0}}),e&&(Object.setPrototypeOf?Object.setPrototypeOf(t,e):t.__proto__=e)}(e,t),o(e,[{key:"encode",value:function(){for(var t=this.number,e="";!isNaN(t)&&0!=t;)t%2==0?(e="11100"+e,t=(t-2)/2):(e="100"+e,t=(t-1)/2);return{data:e=e.slice(0,-2),text:this.text}}},{key:"valid",value:function(){return this.number>=3&&this.number<=131070}}]),e}(((r=i)&&r.__esModule?r:{default:r}).default);e.pharmacode=a},function(t,e,n){"use strict";Object.defineProperty(e,"__esModule",{value:!0}),e.codabar=void 0;var r,o=function(){function t(t,e){for(var n=0;n<e.length;n++){var r=e[n];r.enumerable=r.enumerable||!1,r.configurable=!0,"value"in r&&(r.writable=!0),Object.defineProperty(t,r.key,r)}}return function(e,n,r){return n&&t(e.prototype,n),r&&t(e,r),e}}(),i=n(0);var a=function(t){function e(t,n){!function(t,e){if(!(t instanceof e))throw new TypeError("Cannot call a class as a function")}(this,e),0===t.search(/^[0-9\-\$\:\.\+\/]+$/)&&(t="A"+t+"A");var r=function(t,e){if(!t)throw new ReferenceError("this hasn't been initialised - super() hasn't been called");return!e||"object"!=typeof e&&"function"!=typeof e?t:e}(this,(e.__proto__||Object.getPrototypeOf(e)).call(this,t.toUpperCase(),n));return r.text=r.options.text||r.text.replace(/[A-D]/g,""),r}return function(t,e){if("function"!=typeof e&&null!==e)throw new TypeError("Super expression must either be null or a function, not "+typeof e);t.prototype=Object.create(e&&e.prototype,{constructor:{value:t,enumerable:!1,writable:!0,configurable:!0}}),e&&(Object.setPrototypeOf?Object.setPrototypeOf(t,e):t.__proto__=e)}(e,t),o(e,[{key:"valid",value:function(){return-1!==this.data.search(/^[A-D][0-9\-\$\:\.\+\/]+[A-D]$/)}},{key:"encode",value:function(){for(var t=[],e=this.getEncodings(),n=0;n<this.data.length;n++)t.push(e[this.data.charAt(n)]),n!==this.data.length-1&&t.push("0");return{text:this.text,data:t.join("")}}},{key:"getEncodings",value:function(){return{0:"101010011",1:"101011001",2:"101001011",3:"110010101",4:"101101001",5:"110101001",6:"100101011",7:"100101101",8:"100110101",9:"110100101","-":"101001101",$:"101100101",":":"1101011011","/":"1101101011",".":"1101101101","+":"1011011011",A:"1011001001",B:"1001001011",C:"1010010011",D:"1010011001"}}}]),e}(((r=i)&&r.__esModule?r:{default:r}).default);e.codabar=a},function(t,e,n){"use strict";Object.defineProperty(e,"__esModule",{value:!0}),e.GenericBarcode=void 0;var r,o=function(){function t(t,e){for(var n=0;n<e.length;n++){var r=e[n];r.enumerable=r.enumerable||!1,r.configurable=!0,"value"in r&&(r.writable=!0),Object.defineProperty(t,r.key,r)}}return function(e,n,r){return n&&t(e.prototype,n),r&&t(e,r),e}}(),i=n(0);var a=function(t){function e(t,n){return function(t,e){if(!(t instanceof e))throw new TypeError("Cannot call a class as a function")}(this,e),function(t,e){if(!t)throw new ReferenceError("this hasn't been initialised - super() hasn't been called");return!e||"object"!=typeof e&&"function"!=typeof e?t:e}(this,(e.__proto__||Object.getPrototypeOf(e)).call(this,t,n))}return function(t,e){if("function"!=typeof e&&null!==e)throw new TypeError("Super expression must either be null or a function, not "+typeof e);t.prototype=Object.create(e&&e.prototype,{constructor:{value:t,enumerable:!1,writable:!0,configurable:!0}}),e&&(Object.setPrototypeOf?Object.setPrototypeOf(t,e):t.__proto__=e)}(e,t),o(e,[{key:"encode",value:function(){return{data:"10101010101010101010101010101010101010101",text:this.text}}},{key:"valid",value:function(){return!0}}]),e}(((r=i)&&r.__esModule?r:{default:r}).default);e.GenericBarcode=a},function(t,e,n){"use strict";Object.defineProperty(e,"__esModule",{value:!0}),e.default=function(t){var e=[];return function t(n){if(Array.isArray(n))for(var r=0;r<n.length;r++)t(n[r]);else n.text=n.text||"",n.data=n.data||"",e.push(n)}(t),e}},function(t,e,n){"use strict";Object.defineProperty(e,"__esModule",{value:!0}),e.default=function(t){return t.marginTop=t.marginTop||t.margin,t.marginBottom=t.marginBottom||t.margin,t.marginRight=t.marginRight||t.margin,t.marginLeft=t.marginLeft||t.margin,t}},function(t,e,n){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var r="function"==typeof Symbol&&"symbol"==typeof Symbol.iterator?function(t){return typeof t}:function(t){return t&&"function"==typeof Symbol&&t.constructor===Symbol&&t!==Symbol.prototype?"symbol":typeof t},o=u(n(44)),i=u(n(45)),a=n(14);function u(t){return t&&t.__esModule?t:{default:t}}function f(t){if("string"==typeof t)return function(t){var e=document.querySelectorAll(t);if(0===e.length)return;for(var n=[],r=0;r<e.length;r++)n.push(f(e[r]));return n}(t);if(Array.isArray(t)){for(var e=[],n=0;n<t.length;n++)e.push(f(t[n]));return e}if("undefined"!=typeof HTMLCanvasElement&&t instanceof HTMLImageElement)return u=t,{element:c=document.createElement("canvas"),options:(0,o.default)(u),renderer:i.default.CanvasRenderer,afterRender:function(){u.setAttribute("src",c.toDataURL())}};if(t&&t.nodeName&&"svg"===t.nodeName.toLowerCase()||"undefined"!=typeof SVGElement&&t instanceof SVGElement)return{element:t,options:(0,o.default)(t),renderer:i.default.SVGRenderer};if("undefined"!=typeof HTMLCanvasElement&&t instanceof HTMLCanvasElement)return{element:t,options:(0,o.default)(t),renderer:i.default.CanvasRenderer};if(t&&t.getContext)return{element:t,renderer:i.default.CanvasRenderer};if(t&&"object"===(void 0===t?"undefined":r(t))&&!t.nodeName)return{element:t,renderer:i.default.ObjectRenderer};throw new a.InvalidElementException;var u,c}e.default=f},function(t,e,n){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var r=i(n(11)),o=i(n(12));function i(t){return t&&t.__esModule?t:{default:t}}e.default=function(t){var e={};for(var n in o.default)o.default.hasOwnProperty(n)&&(t.hasAttribute("jsbarcode-"+n.toLowerCase())&&(e[n]=t.getAttribute("jsbarcode-"+n.toLowerCase())),t.hasAttribute("data-"+n.toLowerCase())&&(e[n]=t.getAttribute("data-"+n.toLowerCase())));return e.value=t.getAttribute("jsbarcode-value")||t.getAttribute("data-value"),e=(0,r.default)(e)}},function(t,e,n){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var r=a(n(46)),o=a(n(47)),i=a(n(48));function a(t){return t&&t.__esModule?t:{default:t}}e.default={CanvasRenderer:r.default,SVGRenderer:o.default,ObjectRenderer:i.default}},function(t,e,n){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var r,o=function(){function t(t,e){for(var n=0;n<e.length;n++){var r=e[n];r.enumerable=r.enumerable||!1,r.configurable=!0,"value"in r&&(r.writable=!0),Object.defineProperty(t,r.key,r)}}return function(e,n,r){return n&&t(e.prototype,n),r&&t(e,r),e}}(),i=n(7),a=(r=i)&&r.__esModule?r:{default:r},u=n(13);var f=function(){function t(e,n,r){!function(t,e){if(!(t instanceof e))throw new TypeError("Cannot call a class as a function")}(this,t),this.canvas=e,this.encodings=n,this.options=r}return o(t,[{key:"render",value:function(){if(!this.canvas.getContext)throw new Error("The browser does not support canvas.");this.prepareCanvas();for(var t=0;t<this.encodings.length;t++){var e=(0,a.default)(this.options,this.encodings[t].options);this.drawCanvasBarcode(e,this.encodings[t]),this.drawCanvasText(e,this.encodings[t]),this.moveCanvasDrawing(this.encodings[t])}this.restoreCanvas()}},{key:"prepareCanvas",value:function(){var t=this.canvas.getContext("2d");t.save(),(0,u.calculateEncodingAttributes)(this.encodings,this.options,t);var e=(0,u.getTotalWidthOfEncodings)(this.encodings),n=(0,u.getMaximumHeightOfEncodings)(this.encodings);this.canvas.width=e+this.options.marginLeft+this.options.marginRight,this.canvas.height=n,t.clearRect(0,0,this.canvas.width,this.canvas.height),this.options.background&&(t.fillStyle=this.options.background,t.fillRect(0,0,this.canvas.width,this.canvas.height)),t.translate(this.options.marginLeft,0)}},{key:"drawCanvasBarcode",value:function(t,e){var n,r=this.canvas.getContext("2d"),o=e.data;n="top"==t.textPosition?t.marginTop+t.fontSize+t.textMargin:t.marginTop,r.fillStyle=t.lineColor;for(var i=0;i<o.length;i++){var a=i*t.width+e.barcodePadding;"1"===o[i]?r.fillRect(a,n,t.width,t.height):o[i]&&r.fillRect(a,n,t.width,t.height*o[i])}}},{key:"drawCanvasText",value:function(t,e){var n,r,o=this.canvas.getContext("2d"),i=t.fontOptions+" "+t.fontSize+"px "+t.font;t.displayValue&&(r="top"==t.textPosition?t.marginTop+t.fontSize-t.textMargin:t.height+t.textMargin+t.marginTop+t.fontSize,o.font=i,"left"==t.textAlign||e.barcodePadding>0?(n=0,o.textAlign="left"):"right"==t.textAlign?(n=e.width-1,o.textAlign="right"):(n=e.width/2,o.textAlign="center"),o.fillText(e.text,n,r))}},{key:"moveCanvasDrawing",value:function(t){this.canvas.getContext("2d").translate(t.width,0)}},{key:"restoreCanvas",value:function(){this.canvas.getContext("2d").restore()}}]),t}();e.default=f},function(t,e,n){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var r,o=function(){function t(t,e){for(var n=0;n<e.length;n++){var r=e[n];r.enumerable=r.enumerable||!1,r.configurable=!0,"value"in r&&(r.writable=!0),Object.defineProperty(t,r.key,r)}}return function(e,n,r){return n&&t(e.prototype,n),r&&t(e,r),e}}(),i=n(7),a=(r=i)&&r.__esModule?r:{default:r},u=n(13);var f="http://www.w3.org/2000/svg",c=function(){function t(e,n,r){!function(t,e){if(!(t instanceof e))throw new TypeError("Cannot call a class as a function")}(this,t),this.svg=e,this.encodings=n,this.options=r,this.document=r.xmlDocument||document}return o(t,[{key:"render",value:function(){var t=this.options.marginLeft;this.prepareSVG();for(var e=0;e<this.encodings.length;e++){var n=this.encodings[e],r=(0,a.default)(this.options,n.options),o=this.createGroup(t,r.marginTop,this.svg);this.setGroupOptions(o,r),this.drawSvgBarcode(o,r,n),this.drawSVGText(o,r,n),t+=n.width}}},{key:"prepareSVG",value:function(){for(;this.svg.firstChild;)this.svg.removeChild(this.svg.firstChild);(0,u.calculateEncodingAttributes)(this.encodings,this.options);var t=(0,u.getTotalWidthOfEncodings)(this.encodings),e=(0,u.getMaximumHeightOfEncodings)(this.encodings),n=t+this.options.marginLeft+this.options.marginRight;this.setSvgAttributes(n,e),this.options.background&&this.drawRect(0,0,n,e,this.svg).setAttribute("style","fill:"+this.options.background+";")}},{key:"drawSvgBarcode",value:function(t,e,n){var r,o=n.data;r="top"==e.textPosition?e.fontSize+e.textMargin:0;for(var i=0,a=0,u=0;u<o.length;u++)a=u*e.width+n.barcodePadding,"1"===o[u]?i++:i>0&&(this.drawRect(a-e.width*i,r,e.width*i,e.height,t),i=0);i>0&&this.drawRect(a-e.width*(i-1),r,e.width*i,e.height,t)}},{key:"drawSVGText",value:function(t,e,n){var r,o,i=this.document.createElementNS(f,"text");e.displayValue&&(i.setAttribute("style","font:"+e.fontOptions+" "+e.fontSize+"px "+e.font),o="top"==e.textPosition?e.fontSize-e.textMargin:e.height+e.textMargin+e.fontSize,"left"==e.textAlign||n.barcodePadding>0?(r=0,i.setAttribute("text-anchor","start")):"right"==e.textAlign?(r=n.width-1,i.setAttribute("text-anchor","end")):(r=n.width/2,i.setAttribute("text-anchor","middle")),i.setAttribute("x",r),i.setAttribute("y",o),i.appendChild(this.document.createTextNode(n.text)),t.appendChild(i))}},{key:"setSvgAttributes",value:function(t,e){var n=this.svg;n.setAttribute("width",t+"px"),n.setAttribute("height",e+"px"),n.setAttribute("x","0px"),n.setAttribute("y","0px"),n.setAttribute("viewBox","0 0 "+t+" "+e),n.setAttribute("xmlns",f),n.setAttribute("version","1.1"),n.setAttribute("style","transform: translate(0,0)")}},{key:"createGroup",value:function(t,e,n){var r=this.document.createElementNS(f,"g");return r.setAttribute("transform","translate("+t+", "+e+")"),n.appendChild(r),r}},{key:"setGroupOptions",value:function(t,e){t.setAttribute("style","fill:"+e.lineColor+";")}},{key:"drawRect",value:function(t,e,n,r,o){var i=this.document.createElementNS(f,"rect");return i.setAttribute("x",t),i.setAttribute("y",e),i.setAttribute("width",n),i.setAttribute("height",r),o.appendChild(i),i}}]),t}();e.default=c},function(t,e,n){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var r=function(){function t(t,e){for(var n=0;n<e.length;n++){var r=e[n];r.enumerable=r.enumerable||!1,r.configurable=!0,"value"in r&&(r.writable=!0),Object.defineProperty(t,r.key,r)}}return function(e,n,r){return n&&t(e.prototype,n),r&&t(e,r),e}}();var o=function(){function t(e,n,r){!function(t,e){if(!(t instanceof e))throw new TypeError("Cannot call a class as a function")}(this,t),this.object=e,this.encodings=n,this.options=r}return r(t,[{key:"render",value:function(){this.object.encodings=this.encodings}}]),t}();e.default=o},function(t,e,n){"use strict";Object.defineProperty(e,"__esModule",{value:!0});var r=function(){function t(t,e){for(var n=0;n<e.length;n++){var r=e[n];r.enumerable=r.enumerable||!1,r.configurable=!0,"value"in r&&(r.writable=!0),Object.defineProperty(t,r.key,r)}}return function(e,n,r){return n&&t(e.prototype,n),r&&t(e,r),e}}();var o=function(){function t(e){!function(t,e){if(!(t instanceof e))throw new TypeError("Cannot call a class as a function")}(this,t),this.api=e}return r(t,[{key:"handleCatch",value:function(t){if("InvalidInputException"!==t.name)throw t;if(this.api._options.valid===this.api._defaults.valid)throw t.message;this.api._options.valid(!1),this.api.render=function(){}}},{key:"wrapBarcodeCall",value:function(t){try{var e=t.apply(void 0,arguments);return this.api._options.valid(!0),e}catch(t){return this.handleCatch(t),this.api}}}]),t}();e.default=o}]);`;

function doGet(e) {
  // Self-hosted JsBarcode build (see JSBARCODE_LIB_JS above) -- same pattern as
  // kiosk_functions below, for the same reason (don't depend on an external CDN
  // being reachable from inside a locked-down kiosk network).
  if (e && e.parameter && e.parameter.asset === 'jsbarcode') {
    return ContentService.createTextOutput(JSBARCODE_LIB_JS)
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }

  // Kiosk Pro Enterprise's generated bridge file, served as a plain JS asset from this same
  // deployment so SIGNIN_HTML can <script src> it with an absolute URL (see KIOSK_FUNCTIONS_JS
  // above for why it has to be a real importable file rather than inlined JS).
  if (e && e.parameter && e.parameter.asset === 'kiosk_functions') {
    return ContentService.createTextOutput(KIOSK_FUNCTIONS_JS)
      .setMimeType(ContentService.MimeType.JAVASCRIPT);
  }
  var page = (e && e.parameter && e.parameter.page) || 'signin';
  var html = (page === 'admin') ? ADMIN_HTML : SIGNIN_HTML;
  return HtmlService.createHtmlOutput(html)
    .setTitle('CIMS - The Adorable Child')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}
