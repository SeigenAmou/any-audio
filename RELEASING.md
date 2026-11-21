# 发布到 GitHub

这个仓库是 `https://github.com/cloudoyx/any-audio` 的克隆，本地 `main` 上有一批上游没有的提交。
上游是别人的仓库，所以不要直接往上推；推到自己的 fork，需要时再向原仓库提 PR。

## 一个坑：给 fork 改可见性会拆掉 fork 关系

把这仓库当 fork 建出来后改成私有（`gh repo edit --visibility private`），GitHub 会**断开 fork 关系**：
`isFork` 变 `false`、`parent` 变 `null`，而且改回公开也**不会恢复**。之后就不能再向上游提 PR 了。

这次的处理方式（不需要 `delete_repo` 权限）：

```bash
gh repo rename any-audio-pre-fork -R SeigenAmou/any-audio --yes   # 腾出名字，旧仓库留作备份
gh repo fork cloudoyx/any-audio --clone=false                      # 重新 fork，关系正确
git push fork main                                                 # 本地历史完整，快进推上去
```

结论：**要提 PR 就别动可见性**；确实想私有开发，就先在私有仓库里做，最后再 fork 一个公开的
（或者接受失去 PR 能力，改用「打补丁 + 让上游自己合并」的沟通方式）。

## 现状（2026-11-21）

- fork：<https://github.com/SeigenAmou/any-audio>，**公开**（fork 关系正常）
- 远端：`origin` = 上游，`fork` = 自己的
- fork 比上游多 36 个提交，已推送

## 这台机器上的固定动作

```bash
export https_proxy=http://localhost:7881 http_proxy=http://localhost:7881
GH="/c/Program Files/GitHub CLI/gh.exe"   # 装了但不在 MSYS PATH 里
```

- GitHub 要走代理，不带 `https_proxy` 会直接连不上。
- `git` 用的是 `gh auth setup-git` 装的凭据助手（`gh` 登录账号 `SeigenAmou`），所以 remote 用 https 而不是 ssh。

## 以后推送

```bash
git push fork main
```

跟上上游：

```bash
git fetch origin && git rebase origin/main   # 有冲突就解决
git push fork main
```

## 想把 fork 转成公开

```bash
gh repo edit SeigenAmou/any-audio --visibility public --accept-visibility-change-consequences
```

之前先过一遍检查清单，尤其是「没有把本机路径、API Key、`~/.dsh` 下的东西提交进来」。

## 向上游提 PR（可选）

```bash
git switch -c feature/vst-and-hw     # 主题分支比直接推 main 礼貌
git push fork feature/vst-and-hw
# 网页上 fork → Compare & pull request → cloudoyx/any-audio:main
```

提 PR 前建议把提交整理成一组有意义的变更（现在是逐个小步提交，PR 里会显得碎）。

## 检查清单

- `node test/verify.mjs` → 全绿
- `node test/client-bundle.mjs`、`node test/settings.mjs` → 全绿
- `npm run build` 后 `lib/client.js` 已提交（前端产物在仓库里）
- 没有把本机路径、API Key、`~/.dsh` 下的东西提交进来
- `README.md` 的 Known limitations 与实际一致
