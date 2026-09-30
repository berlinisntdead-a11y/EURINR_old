# EURINR — EUR → INR rate scraper

Appends fresh quotes to `data/EURINR_data.xlsx` (sheet **Rates**, same columns as the manual
entries) and to `data/eurinr_quotes.csv` (the same rows as plain text, easy to diff and chart).
Runs on GitHub Actions every Monday and Thursday. You can also start it by hand from
**Actions → Scrape EUR→INR rates → Run workflow**.

## Where each number comes from

| Provider | Source | Payment methods | Accuracy |
|---|---|---|---|
| Wise | `wise.com/gateway/v1/price`, the endpoint behind Wise's own calculator | bank, debit card, credit card | Live quote, exact |
| XE | `launchpad-api.xe.com/v2/quotes`, behind xe.com/send-money | every settlement method XE offers | Live quote, exact |
| Instarem | `instarem.com/api/v1/public/transaction/computed-value` | each pay-in method Instarem lists | Live quote; first-transfer promo goes in column K |
| Remitly | `api.remitly.io/v3/calculator/estimate` (FRA→IND); Wise comparison data if Remitly refuses the request | the calculator's default pay-in | Live quote; new-customer rate goes in column K |
| Skrill | Wise's published comparison data | bank transfer only | **Estimate**: Wise collects the markup periodically and re-applies it to today's mid rate |
| Revolut | not automated | — | No public calculator, and Wise's comparison data doesn't list Revolut. Keep entering it by hand |
| ScopeX | not automated | — | ScopeX publishes no calculator without the app. Keep entering it by hand |

**Mid rate at capture** (column E) is Wise's live mid-market rate, taken just before each
provider is queried. If that fails, the ECB daily rate is used instead, and the Notes column
says which one was used. **Google Rate** (column F) stays blank because Google offers no API for it.

Card prices for Skrill are shown only after you log in, so they can't be scraped
reliably. Keep adding those rows by hand; the scraper only appends below the last filled row.

## Safety checks

- A quote whose rate is more than 10% away from the mid rate is dropped as a parsing error.
- If a provider fails (its site changed, it rate-limited the request, etc.), the other providers
  are still saved. The run is then marked failed, so GitHub emails you, and the run page shows
  which provider broke and why.

## Running locally

```bash
pip install -r scraper/requirements.txt
python scraper/scrape_rates.py --dry-run                   # print quotes, write nothing
python scraper/scrape_rates.py --providers wise,xe --debug # raw API responses
python scraper/scrape_rates.py                             # append to the workbook + CSV
```

These endpoints are undocumented and can change without notice. When one breaks, run with
`--debug` to see the new response shape and update the matching function in `providers.py`.
