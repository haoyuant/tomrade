# Pomodoro · 番茄钟

Ships with Tomrade and is on by default (row `pomodoro` in `apps/desktop/tomrade.yml`; switch it off in Settings → Manage plugins).

计时显示在状态栏右端：番茄图标、阶段与倒计时。点击打开快捷菜单——开始 / 暂停 / 继续、跳过、重置、打开或收起桌面浮窗、完整设置。完整设置就是 Settings 里的「番茄钟」一页。同样的操作也在 ⌘K 命令面板（「番茄钟：…」）。

桌面浮窗默认打开，收起后保持收起。它没有卡片背景，只有衬线数字、阶段与一条细进度线，用与系统外观相反的一圈紧贴笔画的淡光保证在任何壁纸上可读——光晕不外扩，小字和按钮才不会发糊；阶段与轮次用无衬线粗体小字。鼠标移入时才淡入控制按钮，空白处点击会穿透到下面的窗口。第一次打开时停在侧边栏「项目设置」上方（侧边栏收起时在屏幕右下角）；拖动任意非按钮处移动，之后在本次运行内保留位置，并限制在屏幕工作区内。浮窗上的设置按钮会把主窗口带到前面并打开完整设置。状态栏与浮窗共享同一个主进程计时器。

默认 25 分钟专注、5 分钟短休息、每 4 次专注后 15 分钟长休息，默认手动开始下一阶段，也可自动开始。更改规则时正在运行的阶段保留原来的结束时间，新规则用于下一阶段。应用退出后重新从待开始的专注阶段起步，时间规则保存在本机。

一个阶段自然结束时（跳过不算）发系统通知，并播放提示音。提示音可选「无」、本机的系统音效（默认是系统自己的提示音，如 macOS 的 Glass），或用设置里的「音频文件」选的本机音频；选中或改音量时立即试听一次，选了文件会自动切到它。这些都经宿主的 `alerts` 服务完成，插件本身不读文件。本机没有已保存的系统音效时（换了电脑）回落到第一个系统音效。

电脑休眠后至多结算一个实际开始的阶段，避免把离开期间算作多个已完成番茄。

跟随应用的界面语言（Settings → 语言）：中文时全部显示中文，英文时全部显示英文，切换后立即生效。

Written against the plugin SDK (0.2.4: `alerts`; 0.2.3: status item `command` / `until` / `menu`, `contributions.refresh`, `settings.show` / `locale`, section `words`, `Localized` titles, surface `anchor`) and loaded as a built-in row. Source in `src/`, the surface document in `static/`. The `pomodoro` namespace is reserved, so a copy loaded from Plugin Studio is refused rather than running beside it.
