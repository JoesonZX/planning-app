#!/usr/bin/env python3
"""flash 视觉评审器：截图 + 组件规范 → glm-5.3-flash vision 打分提意见（v8 V1）。

用法：
  python tools/flash_review.py shot1.png shot2.png --spec tasks/v2_spec.md
输出 JSON：{pass, score, issues:[{severity, where, what, fix}]}；失败返回 unknown（不阻塞）。
规范默认 Things 六条：留白即材质／粗体层级／单一强调色／零边框阴影／字号节奏／组件一致。
"""

import argparse
import base64
import json
import pathlib
import re
import sys
import urllib.request

URL = "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions"
ROOT = pathlib.Path(__file__).resolve().parents[1]

SPEC = """你是严苛的 UI 视觉评审。对照以下六条规范逐条检查截图（Things 式极简白 / 深灰暗色）：
1. 留白即材质：内容不拥挤，分组间距 > 条目间距 > 行内间距
2. 粗体层级：标题粗而黑、正文常规、元数据小而灰——三级分明
3. 单一强调色：蓝色只出现在交互态（按钮/active/链接），标题正文一律中性色
4. 零边框零阴影零渐变：卡片靠表面明度差区分，不描边不发光
5. 字号节奏：22/17/15/13/12 五档，不得出现相近字号混排
6. 组件一致：同类元素圆角/内边距/高度完全一致
输出严格 JSON（不要其他文字）：
{"pass": true/false, "score": 0-10, "issues": [{"severity": "major|minor", "where": "位置", "what": "问题", "fix": "具体修改建议"}]}
major = 违反 1-4 任一条或明显丑；minor = 细节打磨。没有问题就给空数组。"""


def review(key, shots, spec):
    content = []
    for p in shots:
        img = base64.b64encode(pathlib.Path(p).read_bytes()).decode()
        content.append({"type": "image_url", "image_url": {"url": f"data:image/png;base64,{img}"}})
    content.append({"type": "text", "text": spec})
    body = json.dumps({
        "model": "glm-5.3-flash",
        "messages": [{"role": "user", "content": [{"type": "text", "text": SPEC}] + content}],
        "max_tokens": 2000, "temperature": 0.2, "thinking": {"type": "disabled"},
    }).encode("utf-8")
    req = urllib.request.Request(URL, data=body, method="POST",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=150) as r:
        out = json.loads(r.read().decode("utf-8"))["choices"][0]["message"]["content"].strip()
    m = re.search(r"\{[\s\S]*\}", out)
    return json.loads(m.group(0)) if m else {"pass": False, "score": -1, "issues": [{"severity": "major", "what": "无法解析评审输出", "fix": out[:200]}]}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("shots", nargs="+", help="截图 png 路径")
    ap.add_argument("--spec", default=None, help="附加规范文本（可省）")
    args = ap.parse_args()
    key = (ROOT / ".glmkey").read_text(encoding="utf-8").splitlines()[0].strip()
    spec = SPEC + (f"\n附加要求：\n{pathlib.Path(args.spec).read_text(encoding='utf-8')}" if args.spec else "")
    try:
        result = review(key, args.shots, spec)
    except Exception as exc:  # noqa: BLE001 —— 评审失败不阻塞施工
        print(json.dumps({"pass": None, "score": None, "issues": [], "error": str(exc)},
                         ensure_ascii=False))
        return 0
    print(json.dumps(result, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
