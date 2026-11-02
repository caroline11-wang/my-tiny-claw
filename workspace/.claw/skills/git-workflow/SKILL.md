---
name: git-workflow
description: 用户要求提交代码、保存变更或执行 Git 相关操作时使用。
---

# 提交流程

1. 使用 bash 执行 `git status --short` 和 `git diff`，检查变更。
2. 确认 `git rev-parse --show-toplevel` 指向当前工作区，不是父目录。
3. 只暂存明确的任务文件，不使用 `git add .` 纳入无关变更；提交前检查 `git diff --cached`。
4. 提交消息必须以 Emoji 和类型开头，例如 `🚀 feat: 添加 HTTP ping 接口`；禁止使用 `git commit -am "update"`。
5. Copilot 协助生成代码时，在提交消息末尾添加 `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>`。
6. 用 `git log -1` 和 `git status --short` 检查结果。没有实际变更时不创建空提交；身份缺失时报告错误，不擅自修改全局设置。
7. 只执行本地提交，不推送远端，不改写历史。
