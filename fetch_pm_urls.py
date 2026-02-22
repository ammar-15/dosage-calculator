import os
import re
import httpx
from postgrest.exceptions import APIError
import time
import random
import requests
from bs4 import BeautifulSoup
from supabase import create_client, Client
from concurrent.futures import ThreadPoolExecutor, as_completed

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_SERVICE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]  # backend only

TABLE = "dpd_drug_product_all"
BATCH_SIZE = 500
WORKERS = 4  # bump to 5-6 if stable; keep modest for gov site

PDF_RE = re.compile(r"https?://pdf\.hres\.ca/dpd_pm/\d+\.PDF", re.IGNORECASE)

supabase: Client = create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)

def make_supabase() -> Client:
    return create_client(SUPABASE_URL, SUPABASE_SERVICE_KEY)

supabase: Client = make_supabase()

def safe_update(row_id: str, update_payload: dict, max_retries: int = 6):
    global supabase
    base_sleep = 0.6

    for attempt in range(1, max_retries + 1):
        try:
            supabase.table(TABLE).update(update_payload).eq("id", row_id).execute()
            return True

        except (httpx.RemoteProtocolError, httpx.ReadTimeout, httpx.ConnectTimeout, httpx.ConnectError) as e:
            # network/protocol problems: reconnect client and retry
            sleep_for = base_sleep * (2 ** (attempt - 1)) + random.random() * 0.3
            print(f"⚠️ Supabase network error (attempt {attempt}/{max_retries}): {e} — retrying in {sleep_for:.2f}s")
            time.sleep(sleep_for)
            supabase = make_supabase()

        except APIError as e:
            # PostgREST API error: usually not transient
            print(f"❌ Supabase APIError for id={row_id}: {e}")
            return False

        except Exception as e:
            # Unknown error: try a couple times then give up
            sleep_for = base_sleep * (2 ** (attempt - 1)) + random.random() * 0.3
            print(f"⚠️ Unknown update error (attempt {attempt}/{max_retries}): {e} — retrying in {sleep_for:.2f}s")
            time.sleep(sleep_for)
            supabase = make_supabase()

    print(f"❌ Update permanently failed for id={row_id}")
    return False

def build_session() -> requests.Session:
    s = requests.Session()
    s.headers.update({
        "User-Agent": "DoseValidatorHackathon/1.0 (contact: you@example.com)"
    })
    return s

def fetch_pm_info(drug_code: str, session: requests.Session):
    url = f"https://health-products.canada.ca/dpd-bdpp/info?lang=eng&code={drug_code}"
    r = session.get(url, timeout=20)
    r.raise_for_status()

    soup = BeautifulSoup(r.text, "html.parser")

    pdf_url = None
    for a in soup.select("a[href]"):
        href = (a.get("href") or "").strip()
        if "pdf.hres.ca" in href and "dpd_pm" in href and href.lower().endswith(".pdf"):
            pdf_url = href
            break

    if not pdf_url:
        m = PDF_RE.search(r.text)
        if m:
            pdf_url = m.group(0)

    pm_date = None
    text = soup.get_text(" ", strip=True)
    mdate = re.search(r"Product Monograph.*?Date:\s*(\d{4}-\d{2}-\d{2})", text, re.IGNORECASE)
    if mdate:
        pm_date = mdate.group(1)

    return pdf_url, pm_date

def process_row(row):
    """
    Returns dict: {id, drug_code, status, pdf_url, pm_date, error}
    """
    row_id = row["id"]
    drug_code = row["drug_code"]

    # each worker keeps its own session (requests Session is not guaranteed thread-safe)
    session = build_session()

    try:
        pdf_url, pm_date = fetch_pm_info(drug_code, session)

        if pdf_url:
            return {
                "id": row_id,
                "drug_code": drug_code,
                "status": "ready",
                "pdf_url": pdf_url,
                "pm_date": pm_date,
                "error": None
            }
        else:
            return {
                "id": row_id,
                "drug_code": drug_code,
                "status": "no_pdf",
                "pdf_url": None,
                "pm_date": pm_date,
                "error": "No dpd_pm PDF link on product page"
            }

    except Exception as e:
        return {
            "id": row_id,
            "drug_code": drug_code,
            "status": "failed",
            "pdf_url": None,
            "pm_date": None,
            "error": str(e)
        }

def main():
    checked_total = 0
    found_total = 0
    no_pdf_total = 0
    failed_total = 0

    # log every N processed rows (as you asked: every 500)
    LOG_EVERY = 500

    while True:
        # Only pick rows we haven’t processed yet
        resp = supabase.table(TABLE) \
            .select("id,drug_code") \
            .eq("pm_status", "pending") \
            .limit(BATCH_SIZE) \
            .execute()

        rows = resp.data or []
        if not rows:
            print("\n✅ Done. No more pending rows.")
            break

        print(f"\n🔄 Processing batch of {len(rows)} pending rows...")

        # modest jitter between batches
        time.sleep(0.2 + random.random() * 0.3)

        with ThreadPoolExecutor(max_workers=WORKERS) as ex:
            futures = [ex.submit(process_row, row) for row in rows]

            for fut in as_completed(futures):
                result = fut.result()
                checked_total += 1

                # Update DB (mark status so it won’t be picked again)
                update_payload = {
                    "pm_pdf_url": result["pdf_url"],
                    "pm_date": result["pm_date"],
                    "pm_status": result["status"],
                    "pm_checked_at": "now()",
                    "pm_error": result["error"]
                }

                safe_update(result["id"], update_payload)

                if result["status"] == "ready":
                    found_total += 1
                elif result["status"] == "no_pdf":
                    no_pdf_total += 1
                else:
                    failed_total += 1

                # periodic logging every 500 checked rows
                if checked_total % LOG_EVERY == 0:
                    print(
                        f"\n📊 Progress @ {checked_total} checked | "
                        f"✅ URLs found: {found_total} | "
                        f"🚫 no PDF: {no_pdf_total} | "
                        f"⚠️ failed: {failed_total}\n"
                    )

    print("\n🏁 Final totals")
    print(f"Checked: {checked_total}")
    print(f"URLs found: {found_total}")
    print(f"No PDF: {no_pdf_total}")
    print(f"Failed: {failed_total}")

if __name__ == "__main__":
    main()