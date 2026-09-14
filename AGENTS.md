# AGENTS.md — planning-app（公开 PWA 仓）

## 完成定义（验证门）

- 改动必过冒烟：7 个 js 模块 import 探针 + 三 tab（简报/秘书/日记）+ 改动面手动核验
- CSS 改动做死代码对账：选择器全量比对后再删（v12.1 教训：跳行解析器曾级联吞 13 条无辜规则）
- SW 版本号随发布递增；mock 全链路（?mock + tools/mock_gen.py + devserver no-cache）用于无后端验证

## flash 协议（大改动走廉价模型）

- 整文件重写类任务：tools/flash_coder.py（任务卡+文件 → .flash-out 产物）→ 验证门检查 → 才覆盖真身；flash 两轮超时由主会话接管
- 任务卡在 tasks/，完成后归档 tasks/old/

## 公开安全

- .glmkey、.mock-data 不入 git、不含个人信息
