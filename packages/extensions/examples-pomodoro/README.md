# Pomodoro · 番茄钟

默认在助手面板的宠物下方显示独立计时卡片，保留宠物自己的空间。可切换为桌面浮窗，拖动标题栏自由摆放；切回宠物区再打开桌面时保留本次运行的位置。

默认 25 分钟专注、5 分钟短休息、每 4 次专注后 15 分钟长休息。通过「规则」或 Settings → Pomodoro 自定义；默认手动开始下一阶段，也可自动开始。更改规则时正在运行的阶段保留原来的结束时间，新规则用于下一阶段。应用退出后重新从待开始的专注阶段起步，时间规则保存在本机。

电脑休眠后至多结算一个实际开始的阶段，避免把离开期间算作多个已完成番茄。浮窗和宠物区共享同一个主进程计时器。

Requires the Tomrade SDK `contributions.assistantWidget` API. No network, filesystem or process access. Uses settings, commands, a declarative assistant widget and local desktop surface documents. Source in `src/`, surface documents in `static/`; Plugin Studio builds, checks and requests confirmation of the exact build before loading.
