"""
Quote collectors for EUR -> INR transfers.

Each collector calls the same public JSON endpoint the provider's own website calculator
uses (no login), so the numbers match what a logged-out visitor sees on the site.
Providers without such an endpoint fall back to Wise's published comparison data,
which is an estimate and is labelled as such in the notes column.
"""
from __future__ import annotations

import time
from dataclasses import dataclass, field

import requests

SOURCE = "EUR"
TARGET = "INR"
SEND_COUNTRY = "FR"  # ISO2 of the sending country; prices can differ by eurozone country
SEND_COUNTRY_ISO3 = "FRA"

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
)

DEBUG = False


@dataclass
class Quote:
    provider: str
    method: str  # "bank transfer" | "debit card" | "credit card"
    amount: float  # EUR sent
    recipient_gets: float  # INR received, as the calculator shows it
    fee: float  # EUR
    rate: float  # provider's standard EUR->INR rate
    mid_rate: float | None = None
    promo_rate: float | None = None  # new-customer rate, when one was applied to recipient_gets
    notes: list[str] = field(default_factory=list)


class Http:
    def __init__(self):
        self.s = requests.Session()
        self.s.headers.update({
            "User-Agent": UA,
            "Accept": "application/json, text/plain, */*",
            "Accept-Language": "en-GB,en;q=0.9",
        })

    def request(self, method: str, url: str, **kw):
        for attempt in range(3):
            r = self.s.request(method, url, timeout=25, **kw)
            if r.status_code == 429 or r.status_code >= 500:
                time.sleep(10 * (attempt + 1))
                continue
            break
        if DEBUG:
            print(f"--- {method} {url} -> {r.status_code}\n{r.text[:3000]}\n")
        r.raise_for_status()
        return r.json()

    def get(self, url, **kw):
        return self.request("GET", url, **kw)

    def post(self, url, body, **kw):
        return self.request("POST", url, json=body, **kw)


def num(v) -> float:
    if isinstance(v, str):
        v = v.replace(",", "")
    n = float(v)
    if n != n:  # NaN
        raise ValueError(f"not a number: {v!r}")
    return n


# ---------------------------------------------------------------- mid-market reference

def mid_market(http: Http) -> tuple[float, str]:
    """Live mid-market rate (Wise), falling back to the ECB daily reference rate."""
    try:
        d = http.get(f"https://wise.com/rates/live?source={SOURCE}&target={TARGET}")
        return num(d["value"]), "Wise live mid"
    except Exception:
        d = http.get(f"https://api.frankfurter.dev/v1/latest?from={SOURCE}&to={TARGET}")
        return num(d["rates"][TARGET]), f"ECB reference {d.get('date')}"


# ---------------------------------------------------------------- Wise

WISE_PAY_IN = {"BANK_TRANSFER": "bank transfer", "DEBIT": "debit card", "CREDIT": "credit card"}


def wise(http: Http, amounts):
    out = []
    for amount in amounts:
        prices = http.get(
            f"https://wise.com/gateway/v1/price?sourceAmount={amount}"
            f"&sourceCurrency={SOURCE}&targetCurrency={TARGET}"
        )
        seen = set()
        for p in prices:
            method = WISE_PAY_IN.get(p.get("payInMethod"))
            if not method or p.get("payOutMethod") != "BANK_TRANSFER" or method in seen:
                continue
            seen.add(method)
            fee = num(p["total"])
            rate = num(p["midRate"])
            got = num(p["targetAmount"]) if p.get("targetAmount") is not None else (amount - fee) * rate
            out.append(Quote("Wise", method, amount, round(got, 2), fee, rate, mid_rate=rate))
    return out


# ---------------------------------------------------------------- XE

def _xe_method(settlement: str) -> str | None:
    s = settlement.lower().replace("_", "")
    if "card" in s:
        return "credit card" if "credit" in s else "debit card"
    if "bank" in s or "transfer" in s or s in ("eft", "wire", "directdebit", "sepa"):
        return "bank transfer"
    return None


def xe(http: Http, amounts):
    out = []
    for amount in amounts:
        res = http.post("https://launchpad-api.xe.com/v2/quotes", {
            "sellCcy": SOURCE, "buyCcy": TARGET, "userCountry": SEND_COUNTRY,
            "amount": amount, "fixedCcy": SOURCE, "countryTo": "IN",
        })
        best: dict[str, Quote] = {}
        for q in res["quote"]["individualQuotes"]:
            if q.get("deliveryMethod") != "BankAccount" or q.get("isEnabled") is False:
                continue
            method = _xe_method(str(q.get("settlementMethod", "")))
            if not method:
                continue
            fee = num(q.get("totalFees") or q.get("transferFee") or 0)
            rate = num(q["rate"])
            # XE adds its fee on top of the amount. To compare like for like with the other
            # providers, treat `amount` as the total paid, so the fee comes out of it.
            got = (amount - fee) * rate
            quote = Quote("XE", method, amount, round(got, 2), fee, rate, notes=[
                f"XE settlement: {q.get('settlementMethod')}; XE charges the fee on top, "
                f"row shows €{amount:g} total paid"])
            if method not in best or quote.recipient_gets > best[method].recipient_gets:
                best[method] = quote
        out.extend(best.values())
        time.sleep(1)
    return out


# ---------------------------------------------------------------- Instarem

def _instarem_method(name: str) -> str | None:
    n = name.lower()
    if "credit" in n:
        return "credit card"
    if "debit" in n or "card" in n:
        return "debit card"
    if "bank" in n or "transfer" in n or "sepa" in n:
        return "bank transfer"
    return None


def instarem(http: Http, amounts):
    base = "https://www.instarem.com/api/v1/public"
    route = f"source_currency={SOURCE}&destination_currency={TARGET}&country_code={SEND_COUNTRY}"
    pay_ins = http.get(f"{base}/payment-method/fee?{route}&source_amount=1000")["data"]
    out = []
    for m in pay_ins:
        method = _instarem_method(str(m.get("text") or m.get("value", "")))
        if not method:
            continue
        for amount in amounts:
            d = http.get(f"{base}/transaction/computed-value?{route}"
                         f"&instarem_bank_account_id={m['key']}&source_amount={amount}")["data"]
            other = num(d.get("payment_method_fee_amount") or 0) + num(d.get("payout_method_fee_amount") or 0)
            shown_rate = num(d["instarem_fx_rate"])  # headline rate (first-transfer promo when one runs)
            regular_rate = num(d.get("regular_instarem_fx_rate") or shown_rate)
            fee = num(d.get("transaction_fee_amount") or 0) + other
            got = next((num(d[k]) for k in ("destination_amount", "target_amount") if d.get(k) is not None),
                       (amount - fee) * shown_rate)
            q = Quote("Instarem", method, amount, round(got, 2), fee, regular_rate)
            if shown_rate > regular_rate:
                q.promo_rate = shown_rate
                q.notes.append(f"First-transfer rate {shown_rate} shown; regular rate {regular_rate} "
                               f"(fee {num(d.get('regular_transaction_fee_amount') or 0) + other:.2f})")
            out.append(q)
            time.sleep(1)
    return out


# ---------------------------------------------------------------- Remitly

def remitly(http: Http, amounts):
    out = []
    conduit = f"{SEND_COUNTRY_ISO3}:{SOURCE}-IND:{TARGET}"
    for i, amount in enumerate(amounts):
        if i:
            time.sleep(8)  # Remitly returns 429 after a few quick calls
        res = http.get(
            "https://api.remitly.io/v3/calculator/estimate"
            f"?conduit={requests.utils.quote(conduit)}&anchor=SEND&amount={amount}"
            "&purpose=OTHER&customer_segment=UNRECOGNIZED&strict_promo=false"
        )
        e = res["estimate"]
        fx = e["exchange_rate"]
        rate = num(fx["base_rate"])
        fee = num(e["fee"]["total_fee_amount"])
        promo = num(fx["promotional_exchange_rate"]) if fx.get("promotional_exchange_rate") else None
        cap = num(fx["capped_promotional_exchange_rate_amount"]) if fx.get("capped_promotional_exchange_rate_amount") else None
        applies = promo is not None and (cap is None or amount <= cap)
        got = next((num(e[k]) for k in ("receive_amount", "receive_amount_with_promo") if e.get(k) is not None),
                   None)
        if got is None:
            got = (amount - fee) * (promo if applies else rate)
        q = Quote("Remitly", "bank transfer", amount, round(got, 2), fee, rate,
                  promo_rate=promo if applies else None)
        if promo is not None:
            q.notes.append(f"New-customer rate {promo} up to €{cap:g}" if cap else f"New-customer rate {promo}")
        out.append(q)
    return out


# ---------------------------------------------------------------- Wise comparison (estimate)

_comparison_cache: dict[tuple, dict] = {}


def _comparison(http: Http, amount, country):
    key = (amount, country)
    if key not in _comparison_cache:
        where = f"&sourceCountry={country}" if country else ""
        _comparison_cache[key] = http.get(
            f"https://wise.com/gateway/v3/comparisons?sourceCurrency={SOURCE}&targetCurrency={TARGET}"
            f"{where}&sendAmount={amount}"
        )
    return _comparison_cache[key]


def _comparison_provider(http: Http, amount, alias):
    """The provider's entry, from the sending country's data or, failing that, any eurozone country's."""
    listed = set()
    for country in (SEND_COUNTRY, None):
        providers = _comparison(http, amount, country)["providers"]
        listed |= {p.get("alias") for p in providers}
        p = next((p for p in providers if p.get("alias") == alias and p.get("quotes")), None)
        if p:
            return p
    raise LookupError(f"{alias} not in Wise comparison data (listed: {', '.join(sorted(filter(None, listed)))})")


def via_wise_comparison(name: str, alias: str):
    """Bank-transfer price for providers whose calculator needs a login, from Wise's comparison data.

    Wise collects each provider's advertised rate and fee, stores the markup on the mid-market
    rate at collection time, and re-applies it to the current mid rate. It is an estimate.
    """
    def collect(http: Http, amounts):
        out = []
        for amount in amounts:
            q = _comparison_provider(http, amount, alias)["quotes"][0]
            fee = num(q["fee"])
            rate = num(q["rate"])
            got = num(q["receivedAmount"]) if q.get("receivedAmount") is not None else (amount - fee) * rate
            out.append(Quote(name, "bank transfer", amount, round(got, 2), fee, rate, notes=[
                f"Estimate from Wise comparison data (collected {q.get('dateCollected', '?')[:10]}"
                f"{', ' + q['sourceCountry'] if q.get('sourceCountry') else ''}), not a live quote"]))
        return out
    return collect


def with_wise_fallback(collector, name: str, alias: str):
    """Try the provider's own calculator; if it refuses (e.g. Remitly blocks cloud IPs), use Wise's data."""
    fallback = via_wise_comparison(name, alias)

    def collect(http: Http, amounts):
        try:
            return collector(http, amounts)
        except Exception as e:
            print(f"  {name} direct quote failed ({type(e).__name__}: {e}); using Wise comparison data")
            return fallback(http, amounts)
    return collect


# Order = order rows are written in. Not collected, so keep entering by hand: Revolut (no public
# calculator, and not in Wise's comparison data), ScopeX (app only), and Skrill card prices.
PROVIDERS = {
    "wise": wise,
    "xe": xe,
    "instarem": instarem,
    "remitly": with_wise_fallback(remitly, "Remitly", "remitly"),
    "skrill": via_wise_comparison("Skrill", "skrill"),
}
