# Release notes

One file per version, `<version>.md`, written before the tag is pushed. Its text travels in the update manifests
(`latest*.yml`, `beta*.yml`), and the app shows it where it offers the update: the notice, and Settings → About.

A few lines per language, in the words of someone using Tomrade — what they can now do, what was fixed — not one line
per pull request:

```md
## en
- Worktrees of finished tickets are removed by themselves once nothing in them would be lost.
- Settings → Worktrees shows what they take on this computer.

## zh
- 已结束工单的 worktree 会在不丢东西时自动移除。
- 设置 → Worktree 显示它们在这台电脑上占了多少。
```

`## en` and `## zh` are required by nothing but the reader: the app shows the section for its language, Chinese for
both Chinese scripts, and English when a language has none. A prerelease (`1.2.0-beta.1`) without a file of its own
uses its base version's (`1.2.0.md`). The release workflow stops before any build when a tag has neither.
