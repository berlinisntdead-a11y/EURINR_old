/**
 * EUR → INR rate collector for the "Rates" sheet.
 *
 * Every quote comes live from the provider's own website calculator (the same JSON request
 * the provider's page makes). Nothing is taken from comparison sites. Providers with no
 * public calculator are listed as "fill manually" in the Run log sheet.
 *
 * Setup: see README.md in the EURINR repository.
 */

const CONFIG = {
  amounts: [100, 500, 1000, 2000, 5000],   // EUR sent
  sendCountry: 'FR',                       // ISO2 of the sending country
  sendCountryIso3: 'FRA',
  timeZone: 'Europe/Paris',
  ratesSheet: 'Rates',
  logSheet: 'Run log',
  fxSheet: '_fx',                          // hidden helper holding =GOOGLEFINANCE("CURRENCY:EURINR")
  maxDeviation: 0.10,                      // drop a quote >10% away from mid: almost certainly a parsing error
};

// Providers collected automatically, in the order rows are written.
const PROVIDERS = [
  ['Wise', fetchWise_],
  ['XE', fetchXe_],
  ['Instarem', fetchInstarem_],
  ['Remitly', fetchRemitly_],
];

// Providers with no public calculator: never scraped, always reported for manual entry.
const MANUAL = {
  'Skrill': 'No public quote endpoint found on skrill.com; prices shown after login.',
  'Revolut': 'No public quote endpoint found; prices and fees shown in the logged-in app and depend on your plan.',
  'ScopeX': 'No public quote endpoint found; prices shown in the app.',
};

const METHOD_ORDER = { 'bank transfer': 0, 'debit card': 1, 'credit card': 2 };

// ------------------------------------------------------------------ menu & schedule

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Rates')
    .addItem('Fetch quotes now', 'fetchAllQuotes')
    .addItem('Schedule: Mondays & Thursdays', 'installSchedule')
    .addItem('Remove schedule', 'removeSchedule')
    .addToUi();
}

function installSchedule() {
  removeSchedule();
  [ScriptApp.WeekDay.MONDAY, ScriptApp.WeekDay.THURSDAY].forEach(function (day) {
    ScriptApp.newTrigger('fetchAllQuotes').timeBased().onWeekDay(day).atHour(9).nearMinute(45).create();
  });
  notify_('Scheduled: every Monday and Thursday around 09:45 (' + Session.getScriptTimeZone() + ').');
}

function removeSchedule() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'fetchAllQuotes'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
}

// ------------------------------------------------------------------ main

function fetchAllQuotes() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const rows = [];
  const log = [];
  const failures = [];

  PROVIDERS.forEach(function (p) {
    const name = p[0];
    try {
      const mid = wiseMid_();
      const google = googleRate_(ss);
      const now = new Date();
      const quotes = p[1]().filter(function (q) {
        const off = Math.abs(q.rate - mid) / mid;
        if (off > CONFIG.maxDeviation) {
          log.push([now, name, 'dropped', q.method + ' €' + q.amount + ': rate ' + q.rate + ' is ' + (off * 100).toFixed(1) + '% from mid']);
          return false;
        }
        return true;
      });
      if (!quotes.length) throw new Error('no usable quotes returned');
      quotes.sort(function (a, b) { return (METHOD_ORDER[a.method] - METHOD_ORDER[b.method]) || (a.amount - b.amount); });
      quotes.forEach(function (q) { rows.push(toRow_(q, now, q.mid || mid, google)); });
      log.push([now, name, 'ok', quotes.length + ' quotes']);
    } catch (e) {
      failures.push(name);
      log.push([new Date(), name, 'FAILED — fill manually', String(e && e.message || e).slice(0, 500)]);
    }
  });
  Object.keys(MANUAL).forEach(function (name) {
    log.push([new Date(), name, 'not automated — fill manually', MANUAL[name]]);
  });

  appendRows_(ss, rows);
  appendLog_(ss, log);

  const msg = 'Added ' + rows.length + ' rows.' + (failures.length ? ' Could not fetch: ' + failures.join(', ') + ' — fill manually (details in "' + CONFIG.logSheet + '").' : '');
  notify_(msg);
  // An error makes Apps Script email you about a failed scheduled run.
  if (failures.length) throw new Error(msg);
}

// ------------------------------------------------------------------ providers

function fetchWise_() {
  const payIn = { BANK_TRANSFER: 'bank transfer', DEBIT: 'debit card', CREDIT: 'credit card' };
  const out = [];
  CONFIG.amounts.forEach(function (amount) {
    const prices = getJson_('https://wise.com/gateway/v1/price?sourceAmount=' + amount + '&sourceCurrency=EUR&targetCurrency=INR');
    const seen = {};
    prices.forEach(function (p) {
      const method = payIn[p.payInMethod];
      if (!method || p.payOutMethod !== 'BANK_TRANSFER' || seen[method]) return;
      seen[method] = true;
      const fee = num_(p.total), rate = num_(p.midRate);
      out.push({
        provider: 'Wise', method: method, amount: amount, fee: fee, rate: rate, mid: rate,
        received: p.targetAmount != null ? num_(p.targetAmount) : (amount - fee) * rate, notes: [],
      });
    });
  });
  return out;
}

function fetchXe_() {
  const out = [];
  CONFIG.amounts.forEach(function (amount) {
    const res = postJson_('https://launchpad-api.xe.com/v2/quotes', {
      sellCcy: 'EUR', buyCcy: 'INR', userCountry: CONFIG.sendCountry,
      amount: amount, fixedCcy: 'EUR', countryTo: 'IN',
    });
    const best = {};
    res.quote.individualQuotes.forEach(function (q) {
      if (q.deliveryMethod !== 'BankAccount' || q.isEnabled === false) return;
      const method = xeMethod_(String(q.settlementMethod || ''));
      if (!method) return;
      const fee = num_(q.totalFees || q.transferFee || 0), rate = num_(q.rate);
      // XE adds its fee on top; count it inside the amount sent, as in the manual rows.
      const quote = {
        provider: 'XE', method: method, amount: amount, fee: fee, rate: rate, received: (amount - fee) * rate,
        notes: ['XE settlement: ' + q.settlementMethod + '; XE charges the fee on top, row shows €' + amount + ' total paid'],
      };
      if (!best[method] || quote.received > best[method].received) best[method] = quote;
    });
    Object.keys(best).forEach(function (k) { out.push(best[k]); });
    Utilities.sleep(1000);
  });
  return out;
}

function xeMethod_(s) {
  s = s.toLowerCase();
  if (s.indexOf('card') >= 0) return s.indexOf('credit') >= 0 ? 'credit card' : 'debit card';
  if (/bank|transfer|eft|wire|directdebit|sepa/.test(s)) return 'bank transfer';
  return null;
}

function fetchInstarem_() {
  const base = 'https://www.instarem.com/api/v1/public';
  const route = 'source_currency=EUR&destination_currency=INR&country_code=' + CONFIG.sendCountry;
  const payIns = getJson_(base + '/payment-method/fee?' + route + '&source_amount=1000').data;
  const out = [];
  payIns.forEach(function (m) {
    const name = String(m.text || m.value || '').toLowerCase();
    const method = name.indexOf('credit') >= 0 ? 'credit card'
      : (name.indexOf('debit') >= 0 || name.indexOf('card') >= 0) ? 'debit card'
      : /bank|transfer|sepa/.test(name) ? 'bank transfer' : null;
    if (!method) return;
    CONFIG.amounts.forEach(function (amount) {
      const d = getJson_(base + '/transaction/computed-value?' + route + '&instarem_bank_account_id=' + m.key + '&source_amount=' + amount).data;
      const other = num_(d.payment_method_fee_amount || 0) + num_(d.payout_method_fee_amount || 0);
      const shown = num_(d.instarem_fx_rate);                          // headline rate (first-transfer promo when one runs)
      const regular = num_(d.regular_instarem_fx_rate || shown);
      const fee = num_(d.transaction_fee_amount || 0) + other;
      const received = d.destination_amount != null ? num_(d.destination_amount) : (amount - fee) * shown;
      const q = { provider: 'Instarem', method: method, amount: amount, fee: fee, rate: regular, received: received, notes: [] };
      if (shown > regular) {
        q.promo = shown;
        q.notes.push('First-transfer rate ' + shown + ' shown; regular rate ' + regular +
          ' (fee ' + (num_(d.regular_transaction_fee_amount || 0) + other).toFixed(2) + ')');
      }
      out.push(q);
      Utilities.sleep(1000);
    });
  });
  return out;
}

function fetchRemitly_() {
  const conduit = encodeURIComponent(CONFIG.sendCountryIso3 + ':EUR-IND:INR');
  const out = [];
  CONFIG.amounts.forEach(function (amount, i) {
    if (i) Utilities.sleep(8000);  // Remitly refuses quick successive requests
    const e = getJson_('https://api.remitly.io/v3/calculator/estimate?conduit=' + conduit + '&anchor=SEND&amount=' + amount +
      '&purpose=OTHER&customer_segment=UNRECOGNIZED&strict_promo=false').estimate;
    const fx = e.exchange_rate;
    const rate = num_(fx.base_rate), fee = num_(e.fee.total_fee_amount);
    const promo = fx.promotional_exchange_rate ? num_(fx.promotional_exchange_rate) : null;
    const cap = fx.capped_promotional_exchange_rate_amount ? num_(fx.capped_promotional_exchange_rate_amount) : null;
    const applies = promo != null && (cap == null || amount <= cap);
    const received = e.receive_amount != null ? num_(e.receive_amount) : (amount - fee) * (applies ? promo : rate);
    const q = { provider: 'Remitly', method: 'bank transfer', amount: amount, fee: fee, rate: rate, received: received, notes: [] };
    if (applies) q.promo = promo;
    if (promo != null) q.notes.push('New-customer rate ' + promo + (cap ? ' up to €' + cap : ''));
    out.push(q);
  });
  return out;
}

// ------------------------------------------------------------------ reference rates

/** Wise's live mid-market rate (Wise's own figure, used for the "Mid rate" column). */
function wiseMid_() {
  return num_(getJson_('https://wise.com/rates/live?source=EUR&target=INR').value);
}

/** GOOGLEFINANCE("CURRENCY:EURINR"), read from a hidden helper sheet (about 15 minutes delayed). */
function googleRate_(ss) {
  let sh = ss.getSheetByName(CONFIG.fxSheet);
  if (!sh) {
    sh = ss.insertSheet(CONFIG.fxSheet);
    sh.hideSheet();
  }
  const cell = sh.getRange('A1');
  for (let attempt = 0; attempt < 5; attempt++) {
    cell.setFormula('=GOOGLEFINANCE("CURRENCY:EURINR")');
    SpreadsheetApp.flush();
    const v = cell.getValue();
    if (typeof v === 'number' && v > 0) return v;
    Utilities.sleep(2000);
  }
  return '';  // leave the column blank rather than fail the run
}

// ------------------------------------------------------------------ sheet writing

function toRow_(q, now, mid, google) {
  return [
    q.provider,
    Utilities.formatDate(now, CONFIG.timeZone, 'yyyy-MM-dd'),
    q.method,
    q.amount,
    round_(mid, 5),
    google === '' ? '' : round_(google, 4),
    Utilities.formatDate(now, CONFIG.timeZone, 'HH:mm'),
    round_(q.received, 2),
    round_(q.fee, 2),
    round_(q.rate, 4),
    q.promo ? round_(q.promo, 4) : '',
    null,  // FX Margin formula, set below
    '', '',
    q.notes.concat(['Auto-fetched from ' + q.provider + ' calculator']).join(' | '),
  ];
}

function appendRows_(ss, rows) {
  if (!rows.length) return;
  const sh = ss.getSheetByName(CONFIG.ratesSheet);
  if (!sh) throw new Error('No sheet named "' + CONFIG.ratesSheet + '"');
  const colA = sh.getRange(1, 1, Math.max(sh.getLastRow(), 1), 1).getValues();
  let last = colA.length;
  while (last > 1 && colA[last - 1][0] === '') last--;
  const start = last + 1;
  rows.forEach(function (r, i) {
    const n = start + i;
    r[11] = '=IF(OR(E' + n + '="",J' + n + '=""),"",(E' + n + '-J' + n + ')/E' + n + ')';
  });
  const target = sh.getRange(start, 1, rows.length, 15);
  if (last > 1) sh.getRange(last, 1, 1, 15).copyTo(target, SpreadsheetApp.CopyPasteType.PASTE_FORMAT, false);
  sh.getRange(start, 2, rows.length, 1).setNumberFormat('@');  // keep dates as text, like the manual rows
  sh.getRange(start, 7, rows.length, 1).setNumberFormat('@');
  target.setValues(rows);
}

function appendLog_(ss, log) {
  let sh = ss.getSheetByName(CONFIG.logSheet);
  if (!sh) {
    sh = ss.insertSheet(CONFIG.logSheet);
    sh.appendRow(['When', 'Provider', 'Status', 'Details']);
    sh.getRange(1, 1, 1, 4).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  sh.getRange(sh.getLastRow() + 1, 1, log.length, 4).setValues(log);
}

// ------------------------------------------------------------------ helpers

const HEADERS_ = { 'Accept': 'application/json, text/plain, */*', 'Accept-Language': 'en-GB,en;q=0.9' };

function fetch_(url, options) {
  options = Object.assign({ muteHttpExceptions: true, headers: HEADERS_ }, options || {});
  let res;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = UrlFetchApp.fetch(url, options);
    const code = res.getResponseCode();
    if (code !== 429 && code < 500) break;
    Utilities.sleep(10000 * (attempt + 1));
  }
  const code = res.getResponseCode();
  if (code >= 400) {
    const host = url.split('/')[2];
    throw new Error(host + ' refused the request (HTTP ' + code + '): ' + res.getContentText().slice(0, 200));
  }
  return JSON.parse(res.getContentText());
}

function getJson_(url) { return fetch_(url); }

function postJson_(url, body) {
  return fetch_(url, { method: 'post', contentType: 'application/json', payload: JSON.stringify(body) });
}

function num_(v) {
  const n = typeof v === 'string' ? parseFloat(v.replace(/,/g, '')) : Number(v);
  if (!isFinite(n)) throw new Error('Expected a number, got ' + JSON.stringify(v));
  return n;
}

function round_(n, d) { const f = Math.pow(10, d); return Math.round(n * f) / f; }

function notify_(msg) {
  try { SpreadsheetApp.getActiveSpreadsheet().toast(msg, 'Rates', 10); } catch (e) { /* no UI in scheduled runs */ }
  console.log(msg);
}
