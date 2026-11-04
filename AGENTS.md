# 仓库协作与发布规则

`main` 是网站唯一发布来源。完成的改动合入 `main` 并推送 `gitlab/main`。

## 工作方式

- 大步推进，只做与改动直接相关的验证。不自动备份数据库或 Git 历史，用户要求时才备份（不自行加 `--backup-database`）。
- 常规网站改动验证通过后直接合入、推送、上线，不再询问；用户说只调研或暂不上线时除外。
- 界面简洁，沿用主站设计。功能界面不放说明性长文，详细说明写进文档。

## Git

- 共享目录 `C:\Users\liwin\Documents\MapleStory` 始终停在 `main`、跟随 `gitlab/main`；开发在独立 worktree 里做。推送后同步共享目录和 `scanner` 子模块。
- `gitlab` 远端有两个推送地址（GitLab 与 GitHub 镜像 `Skymore/classicworld-market`），`git push gitlab main` 同时推两处；GitHub 失败要报告并补推。远端只保留 `main`；不要推送 `deploy` 分支，它会触发 GitHub 旧的自动部署（runner 计划任务 `ClassicWorld Market Deploy Runner` 已停用，未删除）。
- 动手前先 `git fetch gitlab`，以最新 `main` 和 `shared_data/deploy/current.json` 里的线上提交为基线。
- 源码、测试、数据文件和前端构建产物一起提交。逐项合并，不整目录覆盖，不带上无关草稿。

## 发布

- 从已推送的 `main` 提交构建发布包，由本机 supervisor 部署（GitLab CI 未配置），细节见 `SHARED_DEPLOYMENT.md`。线上或 `main` 有更新时先合并，不覆盖较新的发布。
- 发布后核对本地 `main`、`gitlab/main`、发布清单和线上版本的提交号一致，并在公网验证。
- 凭据、数据库、日志、备份、临时构建目录和采集器发行包不进仓库，也不进网站包。

## 前端回归

- 重建前端后回归：手机搜索与“查看全部结果”、六条预览、SSE 更新中的交互，以及受影响的报价、排序/筛选、账号、关注、图鉴、制作成本。
- 页面禁止双指和双击缩放，手机输入控件字号不小于 16px。用 `web/tests/mobile-viewport.e2e.mjs` 回归。

遇到未解决的合并、测试或推送问题，如实说明状态，不要声称已完成。
