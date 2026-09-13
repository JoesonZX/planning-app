#!/usr/bin/env python3
"""生成 .mock-data/（前端 ?mock 冒烟 fixtures）。

从本地 vault 克隆拷贝**非敏感子集**到 planning-app/.mock-data/（已 gitignore——
app 仓公开，vault 内容绝不入库；情绪/感情/计划文档/报告全不拷）。
用法：python tools/mock_gen.py [--vault E:/planning-data]
"""

from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

APP = Path(__file__).resolve().parents[1]
OUT = APP / ".mock-data"

# 白名单：只拷冒烟需要的文件（其余一律不碰——尤其 情绪与社交规划.md / 感情规划.md / 计划文档）
COPY = [
    "inbox.md",
    "人生规划.md",
    "规划.md",
    "profile.md",
    "决策/2026-09-13 执行层外包给 todo 应用.md",
    "规划/26fall 9月执行清单.md",
    "规划/26 fall.md",
    "规划/26fall 旅行攻略（SD-JT-LA）.md",
    "规划/UCSD研究生阶段规划.md",
    "reports/state.json",
    "reports/stats.json",
    "reports/tomorrow.md",
]


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--vault", default="E:/planning-data")
    args = ap.parse_args()
    vault = Path(args.vault)

    shutil.rmtree(OUT, ignore_errors=True)
    OUT.mkdir()
    copied = []
    for rel in COPY:
        src = vault / rel
        if not src.exists():
            print(f"[skip] {rel}（不存在）")
            continue
        dest = OUT / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(src, dest)
        copied.append(rel)
    (OUT / "tree.json").write_text(
        json.dumps({"files": copied}, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"[ok] .mock-data/：{len(copied)} 个文件 + tree.json")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
