from __future__ import annotations

import csv
import json
from pathlib import Path


FIELDS = ["品名", "店铺名", "价格", "销量", "分享链接"]


def read_rows(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        return [{k: row.get(k, "") for k in FIELDS} for row in csv.DictReader(f)]


def main() -> int:
    inputs = [
        Path("output/golden-goose-final-products-fixed-sales.csv"),
        Path("output/golden-goose-search-shops-products.csv"),
    ]
    out = Path("output/golden-goose-final-with-search-shops.csv")
    rows: list[dict[str, str]] = []
    seen: set[str] = set()
    counts: dict[str, int] = {}
    for path in inputs:
        added = 0
        for row in read_rows(path):
            key = row.get("分享链接") or "|".join(row.get(k, "") for k in ("品名", "店铺名", "价格"))
            if key in seen:
                continue
            seen.add(key)
            rows.append(row)
            added += 1
        counts[str(path)] = added

    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=FIELDS)
        writer.writeheader()
        writer.writerows(rows)

    summary = {
        "inputs_added": counts,
        "rows": len(rows),
        "blank_sales": sum(1 for r in rows if not r.get("销量")),
        "output": str(out),
    }
    Path("output/golden-goose-final-with-search-shops.summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    print(json.dumps(summary, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
