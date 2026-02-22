import os
import csv
import json
import time
import zipfile
import urllib.request
from pathlib import Path

SUPABASE_URL = os.environ["SUPABASE_URL"].rstrip("/")
SUPABASE_SERVICE_ROLE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]
TABLE = "dpd_drug_product_all"

OUT_DIR = Path("dpd_extract")
OUT_DIR.mkdir(parents=True, exist_ok=True)

# Health Canada DPD extract ZIPs (drug product file)
URLS = [
    ("MARKETED", "drug.txt",    "https://www.canada.ca/content/dam/hc-sc/documents/services/drug-product-database/drug.zip"),
    ("APPROVED", "drug_ap.txt", "https://www.canada.ca/content/dam/hc-sc/documents/services/drug-product-database/drug_ap.zip"),
    ("CANCELLED","drug_ia.txt", "https://www.canada.ca/content/dam/hc-sc/documents/services/drug-product-database/drug_ia.zip"),
    ("DORMANT",  "drug_dr.txt", "https://www.canada.ca/content/dam/hc-sc/documents/services/drug-product-database/drug_dr.zip"),
]

# Column order for QRYM_DRUG_PRODUCT from Health Canada ReadMe
COLUMNS = [
    "DRUG_CODE",
    "PRODUCT_CATEGORIZATION",
    "CLASS",
    "DRUG_IDENTIFICATION_NUMBER",
    "BRAND_NAME",
    "DESCRIPTOR",
    "PEDIATRIC_FLAG",
    "ACCESSION_NUMBER",
    "NUMBER_OF_AIS",
    "LAST_UPDATE_DATE",
    "AI_GROUP_NO",
    "CLASS_F",
    "BRAND_NAME_F",
    "DESCRIPTOR_F",
]

def download_file(url: str, dest: Path):
    if dest.exists() and dest.stat().st_size > 0:
        print(f"[skip] {dest.name} already exists")
        return
    print(f"[dl] {url}")
    urllib.request.urlretrieve(url, dest)
    print(f"[ok] saved {dest}")

def extract_txt(zip_path: Path, expected_txt: str) -> Path:
    with zipfile.ZipFile(zip_path, "r") as z:
        names = z.namelist()
        # Find the .txt file inside (sometimes name differs slightly; match suffix)
        candidates = [n for n in names if n.lower().endswith(expected_txt.lower())]
        if not candidates:
            # fallback: any file that starts with 'drug' and ends with .txt
            candidates = [n for n in names if n.lower().startswith("drug") and n.lower().endswith(".txt")]
        if not candidates:
            raise RuntimeError(f"Could not find {expected_txt} in {zip_path.name}. Contents: {names[:10]}...")
        member = candidates[0]
        out_path = zip_path.with_suffix("").with_name(expected_txt)
        if out_path.exists() and out_path.stat().st_size > 0:
            print(f"[skip] {out_path.name} already extracted")
            return out_path
        print(f"[unzip] {zip_path.name} -> {member} -> {out_path.name}")
        with z.open(member) as src, open(out_path, "wb") as dst:
            dst.write(src.read())
        return out_path

def post_batch(rows):
    import urllib.request

    url = f"{SUPABASE_URL}/rest/v1/{TABLE}"
    data = json.dumps(rows).encode("utf-8")
    req = urllib.request.Request(url, data=data, method="POST")
    req.add_header("apikey", SUPABASE_SERVICE_ROLE_KEY)
    req.add_header("Authorization", f"Bearer {SUPABASE_SERVICE_ROLE_KEY}")
    req.add_header("Content-Type", "application/json")
    req.add_header("Prefer", "resolution=merge-duplicates,return=minimal")

    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status
    except Exception as e:
        raise RuntimeError(f"Supabase insert failed: {e}")

def parse_and_upload(status_set: str, source_file: str, txt_path: Path, batch_size=500):
    print(f"[parse] {status_set} {txt_path.name}")

    # The extract is CSV, values quoted, comma-separated
    inserted = 0
    batch = []

    with open(txt_path, "r", encoding="utf-8", newline="") as f:
        reader = csv.reader(f, delimiter=",", quotechar='"')
        for row in reader:
            if not row:
                continue

            # Map fixed columns safely
            padded = row + [""] * (len(COLUMNS) - len(row))
            obj = {COLUMNS[i]: padded[i] for i in range(len(COLUMNS))}

            drug_code = obj.get("DRUG_CODE") or None
            din = obj.get("DRUG_IDENTIFICATION_NUMBER") or None
            brand = obj.get("BRAND_NAME") or None

            unique_key = f"{status_set}:{drug_code or ''}:{din or ''}:{brand or ''}"

            record = {
                "status_set": status_set,
                "source_file": source_file,
                "drug_code": drug_code,
                "din": din,
                "brand_name": brand,
                "pediatric_flag": obj.get("PEDIATRIC_FLAG") or None,
                "last_update_date": obj.get("LAST_UPDATE_DATE") or None,
                "raw": obj,
                "unique_key": unique_key,
            }

            batch.append(record)
            if len(batch) >= batch_size:
                post_batch(batch)
                inserted += len(batch)
                print(f"[upsert] total={inserted}")
                batch = []
                time.sleep(0.2)  # be polite

    if batch:
        post_batch(batch)
        inserted += len(batch)

    print(f"[done] {status_set} inserted/upserted {inserted}")

def main():
    for status_set, source_file, url in URLS:
        zip_path = OUT_DIR / Path(url).name
        download_file(url, zip_path)
        txt_path = extract_txt(zip_path, source_file)
        parse_and_upload(status_set, source_file, txt_path)

    print("\n✅ Import completed.")
    print(f"Check Supabase table: public.{TABLE}")

if __name__ == "__main__":
    main()