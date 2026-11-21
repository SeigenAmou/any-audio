# 发布到 GitHub

这个仓库是 `https://github.com/cloudoyx/any-audio` 的克隆，本地分支 `main` 上有一批上游没有的提交。
上游是别人的仓库，所以不要直接往上推；先 fork，再推自己的 fork，需要时再向原仓库提 PR。

## 一次性设置

1. 在网页上 fork：打开 <https://github.com/cloudoyx/any-audio> → 右上 **Fork** → 得到 `https://github.com/<你的账号>/any-audio`。
2. 在本仓库加一个远端（把 `<你的账号>` 换成实际账号）：

```bash
git remote add fork https://github.com/<你的账号>/any-audio.git
git remote -v          # origin 指上游，fork 指你自己的
```

## 推送

```bash
git push fork main
```

以后每次：

```bash
git fetch origin && git rebase origin/main   # 可选：跟上上游
git push fork main
```

## 向上游提 PR（可选）

```bash
git push fork main
# 然后在网页上 fork → Compare & pull request → 选 cloudoyx/any-audio:main
```

提 PR 前建议把提交整理成一组有意义的变更（现在是逐个小步提交，PR 里可能显得碎）。
分支名比 `main` 更礼貌：`git switch -c feature/vst-and-hw`，推 `git push fork feature/vst-and-hw`。

## 检查清单

- `node test/verify.mjs` → 全绿
- `node test/client-bundle.mjs`、`node test/settings.mjs` → 全绿
- `npm run build` 后 `lib/client.js` 已提交（前端产物在仓库里）
- 没有把本机路径、API Key、`~/.dsh` 下的东西提交进来
- `README.md` 的 Known limitations 与实际一致
