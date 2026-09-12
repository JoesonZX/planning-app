#!/usr/bin/env python3
"""flash 施工器：把任务卡 + 当前文件内容发给 glm-5.3-flash，取回整文件重写。

用法（ZCode 会话内由 ZCode 驱动）：
  python tools/flash_coder.py --task tasks/t1.md --file index.html --file js/app.js
产物写入 .flash-out/<原路径>，由 ZCode 验证门（本地 mock + 截图）检查后才覆盖真身。
key 读 E:\planning-app\.glmkey（首行，不进 git 不进对话）。
"""
import argparse, json, pathlib, re, sys, urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
URL = "https://open.bigmodel.cn/api/coding/paas/v4/chat/completions"

def call(key, prompt, max_tokens=12000):
    body = json.dumps({
        "model": "glm-5.3-flash",
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.2, "max_tokens": max_tokens,
    }).encode("utf-8")
    req = urllib.request.Request(URL, data=body, method="POST",
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read().decode("utf-8"))["choices"][0]["message"]["content"].strip()

def strip_fences(t):
    m = re.search(r"```[\w-]*\n(.*)\n```\s*$", t, re.S)
    return (m.group(1) if m else t).strip() + "\n"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--task", required=True, help="任务卡 md 路径")
    ap.add_argument("--file", action="append", required=True, help="要重写的文件（可多次）")
    args = ap.parse_args()
    key = (ROOT / ".glmkey").read_text(encoding="utf-8").splitlines()[0].strip()
    if not key:
        sys.exit("没有 key：把 bigmodel key 粘到 E:\planning-app\.glmkey 第一行")
    task = pathlib.Path(args.task).read_text(encoding="utf-8")
    out_root = ROOT / ".flash-out"
    for f in args.file:
        cur = (ROOT / f).read_text(encoding="utf-8")
        prompt = (f"{task}\n\n---\n以下是文件 `{f}` 的当前完整内容。"
                  f"输出该文件重写后的完整新内容（一个代码围栏包裹，不要解释）：\n\n{cur}")
        new = strip_fences(call(key, prompt))
        dest = out_root / f
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(new, encoding="utf-8", newline="\n")
        print(f"[ok] {f}: {len(cur)} -> {len(new)} chars -> .flash-out/{f}")
    print("[done] 等待验证门（ZCode：mock + 截图 + 回归清单）")

if __name__ == "__main__":
    raise SystemExit(main())
