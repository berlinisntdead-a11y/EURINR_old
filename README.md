# EURINR: EUR → INR rate tracker

A Google Sheet that collects EUR → INR transfer quotes by itself every Monday and Thursday.
The collector is a Google Apps Script (`apps-script/Code.gs`) attached to the sheet. It needs
no servers or keys.

## What gets filled in

Every quote comes live from the provider's own website calculator, using the same request the
provider's page makes. Nothing comes from comparison sites.

| Provider | Payment methods | Notes |
|---|---|---|
| Wise | bank transfer, debit card, credit card | |
| XE | bank transfer (from €1,000), debit card, credit card | XE adds its fee on top; rows count it inside the amount sent, like the manual rows |
| Instarem | each pay-in method Instarem offers | First-transfer promo rate goes in column K |
| Remitly | calculator default | New-customer rate goes in column K. Remitly sometimes refuses automated requests; then the run says so and you fill it in manually |
| Skrill, Revolut, ScopeX | — | No public quote endpoint found. Always listed as "fill manually" |

Columns filled per row: Provider, Capture date, Payment method, Amount, **Mid rate** (Wise's
live mid-market rate), **Google Rate** (`GOOGLEFINANCE("CURRENCY:EURINR")`, about 15 minutes
delayed), Timestamp (Paris time), Recipient gets, Fee, Their rate, Promotional rate, FX Margin
(formula), and Notes.

After each run, the **Run log** sheet lists every provider as `ok`, `FAILED — fill manually`
(with the provider's error), or `not automated — fill manually`. If a scheduled run couldn't
fetch a provider, Google emails you.

## One-time setup (about 5 minutes)

1. **Make the Google Sheet.** In Google Drive, choose New → File upload, and upload
   `data/EURINR_data.xlsx` from this repo. Open it, then File → *Save as Google Sheets*. Work
   in that Google Sheets copy from now on. You can also use an existing sheet, as long as its
   tab is named `Rates` and its columns are in the same order.
2. **Add the script.** In the sheet, go to Extensions → Apps Script. Delete what's in `Code.gs`,
   paste in the whole of [`apps-script/Code.gs`](apps-script/Code.gs), and click 💾 Save.
3. **Set the time zone.** In the Apps Script editor, open ⚙️ Project Settings and set
   *Time zone* to `(GMT+01:00) Paris` (or your own). The schedule runs in this time zone.
   There's no need to press **Deploy**; saving is enough.
4. **Authorize and test.** Reload the sheet. A **Rates** menu appears. Choose Rates →
   *Fetch quotes now*. Google asks for permission once: it wants to edit this spreadsheet and
   connect to external services, meaning the providers' calculators. Choose your account, then
   Advanced → *Go to … (unsafe)* → Allow. The warning appears because the script is your own
   and hasn't been reviewed by Google. After about 1–2 minutes, new rows appear at the bottom
   of `Rates`.
5. **Turn on the schedule.** Choose Rates → *Schedule: Mondays & Thursdays*. The script then
   runs by itself around 09:45 on those days, even with the sheet closed.

To stop the schedule, choose Rates → *Remove schedule*.

## Changing things

The settings are at the top of `Code.gs`, under `CONFIG`:

- `amounts`: the amounts quoted (default €100 / 500 / 1,000 / 2,000 / 5,000)
- `sendCountry`: the sending country (default France); prices can differ by eurozone country
- `maxDeviation`: a quote more than 10% away from the mid rate is dropped as a reading error

The provider endpoints are undocumented and can change without notice. If a provider starts
showing `FAILED` in the Run log, copy its error message and send it to Claude to update the
matching `fetch…_` function.
