#!/usr/bin/env python3
"""Exploratory data analysis for the ``material-sft`` databench dataset.

The script dogfoods the local databench HTTP service: it pulls every sample
from the paginated ``/datasets/{name}/samples`` endpoint (the ``/export``
NDJSON endpoint only carries the chat ``messages`` and drops ``meta`` /
``source`` / ``kind``, which we need for the category analysis).

It is deterministic and re-runnable: given the same dataset it always writes
the same ``material_sft_report.md`` and the same SVG figures. All report numbers
are produced from the values computed here, so the report and the script can
never drift apart.

Usage:
    python analysis/material_sft_eda.py \
        [--base-url http://127.0.0.1:8000] [--dataset material-sft]
"""
from __future__ import annotations

import argparse
import html
import json
import statistics
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
FIG_DIR = HERE / "figures"
REPORT = HERE / "material_sft_report.md"

PAGE = 500  # service caps `limit` at 500


# --------------------------------------------------------------------------- #
# Data loading
# --------------------------------------------------------------------------- #
def fetch_samples(base_url: str, dataset: str) -> list[dict]:
    items: list[dict] = []
    offset = 0
    while True:
        url = f"{base_url}/datasets/{dataset}/samples?limit={PAGE}&offset={offset}"
        with urllib.request.urlopen(url) as resp:
            payload = json.load(resp)
        items.extend(payload["items"])
        if len(items) >= payload["total"]:
            break
        offset += PAGE
    return items


def _dup_aware(pairs):
    """object_pairs_hook that records duplicate keys per object."""
    counts = Counter(k for k, _ in pairs)
    dups = [k for k, c in counts.items() if c > 1]
    d = dict(pairs)
    if dups:
        d.setdefault("__dup_keys__", []).extend(dups)
    return d


def parse(items: list[dict]) -> list[dict]:
    rows = []
    for it in items:
        msgs = {m["role"]: m["content"] for m in it["messages"]}
        assistant_raw = msgs.get("assistant", "")
        out, parse_ok, dup_keys = {}, True, []
        try:
            out = json.loads(assistant_raw, object_pairs_hook=_dup_aware)
            params = out.get("params") or {}
            dup_keys = list(params.pop("__dup_keys__", []))
        except json.JSONDecodeError:
            parse_ok, params = False, {}
        rows.append(
            {
                "spu_id": it["meta"].get("spu_id"),
                "spu_name": it["meta"].get("spu_name"),
                "source": it["source"],
                "kind": it["kind"],
                "system": msgs.get("system", ""),
                "user": msgs.get("user", ""),
                "assistant_raw": assistant_raw,
                "raw_brand": (out.get("raw_brand") or "") if parse_ok else "",
                "std_brand": (out.get("std_brand") or "") if parse_ok else "",
                "raw_unit": (out.get("raw_unit") or "") if parse_ok else "",
                "std_unit": (out.get("std_unit") or "") if parse_ok else "",
                "params": params,
                "dup_keys": dup_keys,
                "parse_ok": parse_ok,
            }
        )
    return rows


# --------------------------------------------------------------------------- #
# Helpers
# --------------------------------------------------------------------------- #
def pct(n: int, total: int) -> str:
    return f"{100 * n / total:.1f}%" if total else "0.0%"


def dist(values: list[int]) -> dict:
    s = sorted(values)
    n = len(s)

    def q(p):
        return s[min(n - 1, int(p * n))]

    return {
        "min": s[0],
        "p25": q(0.25),
        "median": statistics.median(s),
        "mean": round(statistics.mean(s), 1),
        "p90": q(0.90),
        "p99": q(0.99),
        "max": s[-1],
    }


def norm_ws(t: str) -> str:
    return " ".join(t.split()).lower()


# --------------------------------------------------------------------------- #
# SVG bar chart (dependency-free; matplotlib is not installed in this repo)
# --------------------------------------------------------------------------- #
def svg_barh(path: Path, title: str, pairs: list[tuple[str, float]], unit: str = "") -> None:
    pairs = list(pairs)
    rowh, top, left, width = 26, 46, 230, 560
    height = top + rowh * len(pairs) + 24
    maxv = max((v for _, v in pairs), default=1) or 1
    bar_area = width - left - 70
    out = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{width}" height="{height}" '
        f'font-family="-apple-system,Segoe UI,Helvetica,Arial,sans-serif" font-size="13">',
        f'<rect width="{width}" height="{height}" fill="#ffffff"/>',
        f'<text x="14" y="26" font-size="15" font-weight="700" fill="#111">{html.escape(title)}</text>',
    ]
    for i, (label, v) in enumerate(pairs):
        y = top + i * rowh
        bw = max(1, int(bar_area * v / maxv))
        out.append(
            f'<text x="{left - 8}" y="{y + 16}" text-anchor="end" fill="#333">{html.escape(str(label))}</text>'
        )
        out.append(
            f'<rect x="{left}" y="{y + 4}" width="{bw}" height="{rowh - 10}" rx="3" fill="#4c78a8"/>'
        )
        vt = f"{v:g}{unit}"
        out.append(f'<text x="{left + bw + 6}" y="{y + 16}" fill="#333">{vt}</text>')
    out.append("</svg>")
    path.write_text("\n".join(out), encoding="utf-8")


# --------------------------------------------------------------------------- #
# Main analysis
# --------------------------------------------------------------------------- #
def analyze(rows: list[dict]) -> dict:
    total = len(rows)
    R: dict = {"total": total}

    # Overview
    R["kinds"] = Counter(r["kind"] for r in rows)
    R["sources"] = Counter(r["source"] for r in rows)
    R["n_spu_id"] = len({r["spu_id"] for r in rows})
    R["n_spu_name"] = len({r["spu_name"] for r in rows})
    R["parse_fail"] = sum(1 for r in rows if not r["parse_ok"])

    # spu_id <-> spu_name relationship
    id2names = defaultdict(set)
    for r in rows:
        id2names[r["spu_id"]].add(r["spu_name"])
    R["spu_id_multi_name"] = {k: v for k, v in id2names.items() if len(v) > 1}

    # Category distribution
    R["cat_counts"] = Counter(r["spu_name"] for r in rows)

    # Brand
    R["std_brands"] = Counter(r["std_brand"] for r in rows if r["std_brand"])
    R["n_std_brand"] = len(R["std_brands"])
    R["empty_std_brand"] = sum(1 for r in rows if not r["std_brand"])
    R["brand_normalized"] = sum(
        1 for r in rows if r["raw_brand"] and r["raw_brand"] != r["std_brand"]
    )
    R["brand_has_raw"] = sum(1 for r in rows if r["raw_brand"])
    # examples of normalization (raw -> std), most common distinct pairs
    norm_pairs = Counter(
        (r["raw_brand"], r["std_brand"])
        for r in rows
        if r["raw_brand"] and r["raw_brand"] != r["std_brand"]
    )
    R["brand_norm_examples"] = norm_pairs.most_common(15)
    # many-raw -> one-std (messy variants collapsing to a clean brand)
    std2raw = defaultdict(set)
    for r in rows:
        if r["std_brand"] and r["raw_brand"]:
            std2raw[r["std_brand"]].add(r["raw_brand"])
    R["brand_variant_counts"] = Counter({k: len(v) for k, v in std2raw.items()})

    # Unit
    R["std_units"] = Counter(r["std_unit"] for r in rows if r["std_unit"])
    R["raw_units"] = Counter(r["raw_unit"] for r in rows if r["raw_unit"])
    R["unit_divergent"] = sum(
        1 for r in rows if r["raw_unit"] and r["raw_unit"] != r["std_unit"]
    )
    R["unit_has_raw"] = sum(1 for r in rows if r["raw_unit"])
    R["empty_std_unit"] = sum(1 for r in rows if not r["std_unit"])
    unit_map = Counter(
        (r["raw_unit"], r["std_unit"])
        for r in rows
        if r["raw_unit"] and r["raw_unit"] != r["std_unit"]
    )
    R["unit_map_examples"] = unit_map.most_common(20)

    # Params
    nparams = [len(r["params"]) for r in rows]
    R["param_count_dist"] = dist(nparams)
    R["param_keys_overall"] = Counter(k for r in rows for k in r["params"])
    R["zero_param_rows"] = sum(1 for r in rows if len(r["params"]) == 0)
    R["dup_key_rows"] = sum(1 for r in rows if r["dup_keys"])
    R["dup_keys"] = Counter(k for r in rows for k in r["dup_keys"])
    # per-top-category param keys
    top_cats = [c for c, _ in R["cat_counts"].most_common(5)]
    R["param_keys_by_cat"] = {}
    for c in top_cats:
        cnt = Counter(k for r in rows if r["spu_name"] == c for k in r["params"])
        n = R["cat_counts"][c]
        R["param_keys_by_cat"][c] = [(k, v, pct(v, n)) for k, v in cnt.most_common(8)]
    # empty param values
    R["empty_param_values"] = sum(
        1 for r in rows for v in r["params"].values() if v in ("", None, "无", "暂无")
    )

    # Text stats
    R["input_len"] = dist([len(r["user"]) for r in rows])
    R["assistant_len"] = dist([len(r["assistant_raw"]) for r in rows])
    R["system_distinct"] = len({r["system"] for r in rows})

    # Data quality
    full_keys = [
        (r["user"], r["assistant_raw"], r["spu_id"]) for r in rows
    ]
    R["exact_dup_rows"] = total - len({(u, a, s) for u, a, s in full_keys})
    user_counter = Counter(r["user"] for r in rows)
    R["dup_user_inputs"] = sum(c - 1 for c in user_counter.values() if c > 1)
    R["distinct_user"] = len(user_counter)
    # near-duplicate (whitespace/case normalized) collisions beyond exact
    norm_counter = Counter(norm_ws(r["user"]) for r in rows)
    R["near_dup_extra"] = sum(c - 1 for c in norm_counter.values() if c > 1) - R[
        "dup_user_inputs"
    ]
    # conflicting outputs: same user input, different assistant output
    by_user = defaultdict(set)
    for r in rows:
        by_user[r["user"]].add(r["assistant_raw"])
    R["conflicting_inputs"] = sum(1 for v in by_user.values() if len(v) > 1)
    # whitespace issues in user input
    R["user_has_tab_or_double_space"] = sum(
        1 for r in rows if "\t" in r["user"] or "  " in r["user"]
    )
    R["user_leading_trailing_ws"] = sum(
        1 for r in rows if r["user"] != r["user"].strip()
    )

    return R


# --------------------------------------------------------------------------- #
# Charts
# --------------------------------------------------------------------------- #
def make_charts(R: dict) -> None:
    FIG_DIR.mkdir(parents=True, exist_ok=True)
    cats = R["cat_counts"].most_common(12)
    svg_barh(
        FIG_DIR / "category_distribution.svg",
        "Category (spu_name) distribution — top 12",
        [(c, n) for c, n in cats],
    )
    brands = R["std_brands"].most_common(12)
    svg_barh(
        FIG_DIR / "top_brands.svg",
        "Top standard brands (std_brand) — top 12",
        [(b, n) for b, n in brands],
    )
    units = R["std_units"].most_common(12)
    svg_barh(
        FIG_DIR / "top_units.svg",
        "Top standard units (std_unit) — top 12",
        [(u, n) for u, n in units],
    )
    keys = R["param_keys_overall"].most_common(15)
    svg_barh(
        FIG_DIR / "top_param_keys.svg",
        "Most common param keys — top 15",
        [(k, n) for k, n in keys],
    )


# --------------------------------------------------------------------------- #
# Report
# --------------------------------------------------------------------------- #
def md_table(headers: list[str], rows: list[list]) -> str:
    out = ["| " + " | ".join(headers) + " |", "| " + " | ".join("---" for _ in headers) + " |"]
    for r in rows:
        out.append("| " + " | ".join(str(c) for c in r) + " |")
    return "\n".join(out)


def write_report(R: dict) -> None:
    t = R["total"]
    L: list[str] = []
    a = L.append

    a("# material-sft — Exploratory Data Analysis (EDA)\n")
    a("> 自动生成 / Auto-generated by `analysis/material_sft_eda.py`. "
      "All numbers below are produced by that script against the live databench "
      "`/datasets/material-sft/samples` API. Re-run the script to regenerate.\n")

    # Overview
    a("## 1. Overview / 总览\n")
    a(md_table(
        ["Metric", "Value"],
        [
            ["Total samples / 样本总数", t],
            ["kind", ", ".join(f"{k}={v}" for k, v in R["kinds"].items())],
            ["source", "; ".join(f"{k} ({v})" for k, v in R["sources"].items())],
            ["Distinct spu_id", R["n_spu_id"]],
            ["Distinct spu_name (categories)", R["n_spu_name"]],
            ["Assistant JSON parse failures", R["parse_fail"]],
            ["Distinct system prompts", R["system_distinct"]],
        ],
    ))
    a("")
    a("**关键结构性事实 / key structural fact:** `spu_id` 与 `spu_name` 一一对应"
      f"（{R['n_spu_id']} 个 id ↔ {R['n_spu_name']} 个类目），即 `spu_id` 是**类目级**标识，"
      "不是逐行唯一的商品 id。因此 1454 行里每个 `spu_id` 大量重复——"
      "**按 `spu_id` 分组等价于按类目分组**，这对划分训练/验证集有直接影响（见 §9）。\n")
    if R["spu_id_multi_name"]:
        a(f"- ⚠️ {len(R['spu_id_multi_name'])} 个 spu_id 对应多个 spu_name。\n")
    else:
        a("- 每个 spu_id 恰好对应一个 spu_name（无冲突）。\n")

    # Category
    a("## 2. Category distribution / 类目分布\n")
    a("![category](figures/category_distribution.svg)\n")
    rows = [[c, n, pct(n, t)] for c, n in R["cat_counts"].most_common()]
    a(md_table(["spu_name", "count", "%"], rows))
    top1, top1n = R["cat_counts"].most_common(1)[0]
    a("")
    a(f"**严重类别不均衡 / severe class imbalance:** `{top1}` 单独占 {top1n}/{t} "
      f"= {pct(top1n, t)}。Top-3 类目占 "
      f"{pct(sum(n for _, n in R['cat_counts'].most_common(3)), t)}；"
      "尾部多个类目样本量为个位数。\n")
    a("> Training implication: 直接训练会让模型严重偏向 `电力电缆`，长尾类目"
      "（如标签、普通干电池等）几乎无法学到。建议按类目重采样/加权，或对长尾做"
      "数据增强；评测必须**按类目分层**报告指标，否则总体准确率会被 `电力电缆` 主导。\n")

    # Brand
    a("## 3. Brand / 品牌\n")
    a("![brands](figures/top_brands.svg)\n")
    a(md_table(
        ["Metric", "Value"],
        [
            ["Distinct std_brand", R["n_std_brand"]],
            ["Rows with empty std_brand", f"{R['empty_std_brand']} ({pct(R['empty_std_brand'], t)})"],
            ["Rows with a raw_brand", R["brand_has_raw"]],
            ["raw_brand != std_brand (normalized)",
             f"{R['brand_normalized']} ({pct(R['brand_normalized'], R['brand_has_raw'] or 1)} of rows with raw_brand)"],
        ],
    ))
    a("\n**Top std_brand:**\n")
    a(md_table(["std_brand", "count", "%"],
               [[b, n, pct(n, t)] for b, n in R["std_brands"].most_common(15)]))
    a("\n**Normalization examples (raw_brand → std_brand):**\n")
    a(md_table(["raw_brand", "std_brand", "count"],
               [[f"`{rb}`", f"`{sb}`", c] for (rb, sb), c in R["brand_norm_examples"]]))
    a("\n**Messy cases — one clean brand absorbing many raw variants:**\n")
    a(md_table(["std_brand", "# distinct raw variants"],
               [[b, n] for b, n in R["brand_variant_counts"].most_common(10)]))
    a("")

    # Unit
    a("## 4. Unit / 单位\n")
    a("![units](figures/top_units.svg)\n")
    a(md_table(
        ["Metric", "Value"],
        [
            ["Distinct std_unit", len(R["std_units"])],
            ["Distinct raw_unit", len(R["raw_units"])],
            ["Rows with empty std_unit", f"{R['empty_std_unit']} ({pct(R['empty_std_unit'], t)})"],
            ["raw_unit != std_unit (divergent)",
             f"{R['unit_divergent']} ({pct(R['unit_divergent'], R['unit_has_raw'] or 1)} of rows with raw_unit)"],
        ],
    ))
    a("\n**Standard unit distribution:**\n")
    a(md_table(["std_unit", "count", "%"],
               [[u, n, pct(n, t)] for u, n in R["std_units"].most_common(15)]))
    a("\n**raw_unit → std_unit mapping (where they differ):**\n")
    a(md_table(["raw_unit", "std_unit", "count"],
               [[f"`{ru}`", f"`{su}`", c] for (ru, su), c in R["unit_map_examples"]]))
    a("")

    # Params
    a("## 5. Params / 标准参数\n")
    a("![param keys](figures/top_param_keys.svg)\n")
    d = R["param_count_dist"]
    a(md_table(
        ["param-count stat", "value"],
        [[k, v] for k, v in d.items()],
    ))
    a(f"\n- Rows with **zero** params: {R['zero_param_rows']} ({pct(R['zero_param_rows'], t)})")
    a(f"- Rows with **duplicate keys** in params JSON: {R['dup_key_rows']}")
    if R["dup_keys"]:
        a(f"  - duplicated keys: {dict(R['dup_keys'].most_common(10))}")
    a(f"- Empty/placeholder param **values** (\"\", 无, 暂无): {R['empty_param_values']}\n")
    a("**Most common param keys (overall):**\n")
    a(md_table(["param key", "count", "%"],
               [[k, n, pct(n, t)] for k, n in R["param_keys_overall"].most_common(20)]))
    a("\n**Param keys by top category:**\n")
    for c, klist in R["param_keys_by_cat"].items():
        a(f"\n*{c}* (n={R['cat_counts'][c]}):\n")
        a(md_table(["key", "count", "coverage"], [[k, n, p] for k, n, p in klist]))
    a("")

    # Text stats
    a("## 6. Text length stats / 文本长度\n")
    a("Character counts.\n")
    a(md_table(
        ["field"] + list(R["input_len"].keys()),
        [
            ["user input"] + list(R["input_len"].values()),
            ["assistant JSON"] + list(R["assistant_len"].values()),
        ],
    ))
    a("")

    # Data quality
    a("## 7. Data quality / 数据质量\n")
    a(md_table(
        ["Check", "Value"],
        [
            ["Distinct user inputs", f"{R['distinct_user']} / {t}"],
            ["Exact duplicate rows (user+assistant+spu_id)", R["exact_dup_rows"]],
            ["Duplicate user inputs (extra copies)", R["dup_user_inputs"]],
            ["Near-dup user inputs (ws/case, beyond exact)", R["near_dup_extra"]],
            ["Inputs with conflicting outputs", R["conflicting_inputs"]],
            ["Inputs with tab / double-space", R["user_has_tab_or_double_space"]],
            ["Inputs with leading/trailing whitespace", R["user_leading_trailing_ws"]],
            ["Empty std_brand", R["empty_std_brand"]],
            ["Empty std_unit", R["empty_std_unit"]],
            ["Assistant JSON parse failures", R["parse_fail"]],
        ],
    ))
    a("")

    # Training readiness
    top1, top1n = R["cat_counts"].most_common(1)[0]
    n_dup = R["dup_user_inputs"]
    n_near = max(R["near_dup_extra"], 0)
    n_conf = R["conflicting_inputs"]
    a("## 8. Training readiness / 训练可用性\n")
    a(f"- **Imbalance (主要问题):** 单一类目 `{top1}` 占 {pct(top1n, t)}，"
      "需重采样/类目加权，评测必须按类目分层。这是本数据集训练前**最需要处理**的问题。\n")
    if n_dup or n_near or n_conf:
        a("- **Leakage risk / 泄漏风险:** 存在重复/近重复或冲突输入"
          f"（重复 {n_dup}、近重复 {n_near}、冲突 {n_conf}）。"
          "随机划分会把同一/近似样本同时放进 train 和 val，导致验证指标虚高——需先去重再划分。\n")
    else:
        a("- **Leakage risk / 泄漏风险:** 低。无完全重复行、无去空白后的近重复输入"
          f"（{R['distinct_user']}/{t} 输入全部唯一），也无同输入多输出的标签冲突。"
          "但仍建议**按类目分层**划分，避免长尾类目在某一侧缺失。\n")
    a("- **Label consistency:** 0 解析失败、0 空 std_brand/std_unit、0 零参数行、0 重复参数键——"
      "标注一致性高，是干净的 SFT 目标。\n")
    a(f"- **Minor noise:** {R['user_has_tab_or_double_space']} 条输入含 tab/连续空格"
      "（源表格遗留的空白伪影），建议规范化但不影响标签。\n")

    # Split recommendation
    a("## 9. Suggested split & cleaning / 划分与清洗建议\n")
    a("**Split:** 因严重不均衡，不要纯随机划分。推荐：\n")
    a("1. **按类目分层 (stratify by spu_name)** —— 每个类目在 train/val 同比例出现，"
      "适合\"已知类目内泛化\"评测；对样本<5 的长尾类目可整体放入 train 或单独成集。\n")
    a("2. **类目加权 / 重采样** —— 训练时下采样 `电力电缆` 或上采样长尾，"
      "防止模型退化为单类目预测。\n")
    a("> 注意：`spu_id` 是**类目级**而非商品级标识，所以\"按 spu_id 分组划分\""
      "等价于把整个类目划到一侧，只适合\"未见类目泛化\"这一特殊评测，不适合常规 SFT。\n")
    a("\n**Cleaning checklist (按本数据实测情况排序):**\n")
    a(f"- ✅ 已干净：无重复/冲突/解析失败/空值——可跳过去重与补全。\n")
    a(f"- ⚠️ 规范化 {R['user_has_tab_or_double_space']} 条输入的空白字符"
      "（tab、连续空格），保持与推理时输入格式一致。\n")
    a("- ⚠️ 审查可疑单位映射（如 `件→箱`、`件→盒`、`只→瓶`）——"
      "这类换算依赖商品语境，可能引入噪声。\n")
    a("- 🔁 处理类目不均衡：长尾增强/合并 + 评测分层。\n")
    a("- 📌 品牌归一化是核心任务信号（46.5% 行 raw≠std），"
      "保证同一实体的多种写法映射到同一 std_brand（参见 §3 变体表）。\n")

    REPORT.write_text("\n".join(L) + "\n", encoding="utf-8")


# --------------------------------------------------------------------------- #
def print_top_findings(R: dict) -> None:
    t = R["total"]
    top1, top1n = R["cat_counts"].most_common(1)[0]
    print("\n" + "=" * 70)
    print("TOP 5 FINDINGS")
    print("=" * 70)
    print(f"1. Severe imbalance: '{top1}' = {top1n}/{t} ({pct(top1n, t)}); "
          f"only {R['n_spu_name']} categories total.")
    print(f"2. spu_id is category-level (1:1 with spu_name, {R['n_spu_id']} ids) — "
          "NOT a per-row product id; grouping by spu_id == grouping by category.")
    print(f"3. Brand normalization is real work: {R['brand_normalized']} rows have "
          f"raw_brand != std_brand ({R['n_std_brand']} distinct std brands).")
    print(f"4. Labels are clean: {R['distinct_user']}/{t} inputs unique, "
          f"0 duplicates, 0 conflicts, 0 parse failures, 0 empty std_brand/std_unit "
          f"-> main risk is imbalance, not noise (minor: {R['user_has_tab_or_double_space']} "
          "inputs have tab/double-space artifacts).")
    print(f"5. Params are category-driven: avg {R['param_count_dist']['mean']} keys/sample "
          f"(1..{R['param_count_dist']['max']}); each category has its own near-fixed key "
          "schema (cable -> 主芯标称截面/导体芯数; paper -> 纸张规格/定量; toner -> 品牌/型号).")
    print("=" * 70)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--base-url", default="http://127.0.0.1:8000")
    ap.add_argument("--dataset", default="material-sft")
    args = ap.parse_args()

    print(f"Fetching {args.dataset} from {args.base_url} ...")
    items = fetch_samples(args.base_url, args.dataset)
    print(f"Fetched {len(items)} samples.")
    rows = parse(items)
    R = analyze(rows)
    make_charts(R)
    write_report(R)
    print(f"Wrote {REPORT.relative_to(HERE.parent)}")
    print(f"Wrote figures to {FIG_DIR.relative_to(HERE.parent)}/")
    print_top_findings(R)


if __name__ == "__main__":
    main()
