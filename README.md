# planning-app

个人规划系统的 Web 前端（PWA）：GitHub 仓库即数据层，无服务器、无后端、零第三方 JS。

## 功能

- **仪表盘**：渲染引擎每晚生成的 `仪表盘.md`
- **报告**：`tomorrow.md` / 周报，checkbox 可点选翻转（直接提交到仓库）
- **日历**：解析 `reports/deadlines.ics`，死线倒计时（今天/明天/N 天后）
- **文件**：vault 浏览 + 整文件编辑（textarea，sha 乐观并发）
- **随手记**：FAB 快速捕获 → `inbox.md`（周日引擎自动分拣）
- **聊天**：GLM 直连（bigmodel 官方支持 CORS），vault 全量上下文；模型可选 glm-5.3 / glm-5.3-flash，5.3 默认开启思考；聊天记录只存本浏览器，可一键把回答写进 inbox

## 自己部署

1. Fork/复制本仓到你的 GitHub，开 GitHub Pages（Settings → Pages → main / root）
2. 建一个 **fine-grained PAT**（Settings → Developer settings → Fine-grained tokens）：
   - 只授权你的数据仓，权限 Contents: Read and write
3. 打开 app → 设置 → 粘贴 PAT → 保存并连接
4. 想用聊天：粘贴 bigmodel 的 GLM key；用付费模型（如 glm-5.3）需账户有余额，预算帽在设置里调

## 安全模型

- PAT 与 GLM key 只存你自己浏览器的 localStorage，app 本体零机密、可公开
- 无第三方运行时脚本（CSP 限定 script-src 'self'）；API 仅连 api.github.com 与 open.bigmodel.cn
- token 授权范围最小化：单仓、仅 Contents

## 数据契约

前端不解析规划语法（解析只活在 planning-engine 的 Python 里）。前端只做三类写回：
1. checkbox 行级翻转 2. inbox 末尾追加 3. 整文件显式保存
