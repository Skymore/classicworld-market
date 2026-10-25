# 视频与键盘示范采集

本地 Windows 录制器，默认每秒采样 20 次游戏画面。记录选定窗口在前台时的配置按键，供后续模仿学习使用。当前实现负责数据采集，不包含识别模型或策略训练。

## 启动

日常使用双击构建目录中的 **`GameplayRecorder.exe`**，或项目目录中的“游戏操作录制”快捷方式。程序附带 Python 和依赖，不需要启动命令行；移动到其他位置时保留同目录的 `_internal` 文件夹。

开发时也可以在项目目录运行：

```powershell
.\run_gameplay_recorder.ps1
```

首次运行在 `.gameplay-venv/` 中安装独立依赖。Python 查找规则与项目的 `resolve_python.ps1` 相同，也可设置 `MARKET_PYTHON`。

选择游戏窗口、确认录制键位，点击“开始录制”，然后切回游戏。F8 暂停/继续，F9 停止并保存。切出游戏自动停止保存画面和按键；切回时重新同步当前按住的键，开始新的 episode。关闭窗口会等待视频保存。录制按键使用逗号分隔；F8/F9 为保留控制键。

开始后，游戏客户区右上角显示悬浮状态条：**录制状态、实际帧率、累计录制时长**。绿色为录制/保存完成，黄色为暂停，红色为失败。悬浮窗不抢焦点、鼠标穿透；主窗口最小化后仍可见，关闭主窗口时一同关闭。保存完成状态会保留，直到开始下一次录制或关闭程序。

时长从第一帧成功进入写入队列开始累计，暂停、切出游戏和保存收尾期间不计时。帧率使用最近最多 40 个进入队列的帧的时间戳估算；暂停或超过 500ms 没有新帧时显示 0。主窗口另有丢帧计数。

悬浮窗通过 Windows `WDA_EXCLUDEFROMCAPTURE` 排除在 DXGI 截图之外；不能启用时会报错并不开始录制。已提供“先排除、再取消排除、再恢复”的原生像素对照自检。适用于 Windows 10 2004 及以上的桌面合成环境；游戏采用窗口或无边框模式，独占全屏的悬浮显示不作保证。

默认写入 `shared_data/gameplay_recordings/日期时间-随机ID/`，该目录受仓库默认忽略规则保护。视频和按键数据只保存在本机，不进入网站发行包。可在界面选择其他保存位置。

源码启动时路径相对项目目录；直接启动 exe 时相对 exe 所在目录。项目快捷方式通过 `--output` 固定到项目的 `shared_data/gameplay_recordings`，升级程序不会改变录制位置。

## 构建桌面程序

```powershell
.\build_gameplay_recorder.ps1
```

构建脚本使用独立依赖环境和 PyInstaller 6.22.3，在新的 `dist/gameplay-日期时间/GameplayRecorder/` 中生成无控制台 exe，自动验证真实成品的合成视频录制和桌面悬浮窗，并更新项目目录的“游戏操作录制”快捷方式。不会覆盖旧程序或已有录制。需要可交互的 Windows 桌面来执行自检。`build-manifest.json` 记录源码提交、是否有未提交改动、源码与全部发行文件哈希、成品自检结果；发行目录与依赖环境不提交 Git。

命令行方式：

```powershell
.\.gameplay-venv\Scripts\python.exe record_gameplay.py --list-windows
.\.gameplay-venv\Scripts\python.exe record_gameplay.py --hwnd 123456 --keys left,right,space,ctrl,z --duration 60
```

`--window` 支持唯一标题片段；匹配多个窗口时拒绝选择。`--segment-seconds` 默认 60。窗口客户区须完整位于同一显示器；支持窗口移动、调整大小和负坐标显示器。切换显示器或修改窗口位置时重新配置截图区域。

## 数据格式

每次录制创建独立目录，包含：

- `session.json`：格式版本、录制状态、时钟基准、FPS、键位、窗口、视频段及计数。`complete` 表示已正常关闭；`failed` 表示发生错误，错误原因保留在清单中。强制结束进程后可能仍显示 `recording`，不能把它当成完整会话。
- `video-0000.mp4` 等：每段最多 60 秒的 MPEG-4 视频。尺寸变化会开始新视频段。奇数宽高补一个黑色边缘像素，真实尺寸保存在逐帧记录里。
- `frames.jsonl`：每个实际写入的视频帧对应一行，含 `frame_id`、`video`、`video_frame`、`content_size`、`episode`、`held`、`input_seq` 及时间戳。
- `events.jsonl`：逐次按下/松开、录制范围变化、丢帧和调度间隙。短于 50ms 的按键仍以独立事件保存，不能只使用每帧的 `held` 来训练跳跃等短按动作。

时间字段使用同一 Windows QPC 单调时钟，均为相对 `origin_monotonic_ns` 的纳秒：

| 字段 | 含义 |
| --- | --- |
| `t_ns`（帧） | 采样器取得最新可用图像的时间；`held` 为此时已观察到的按键状态 |
| `source_present_ns` | DXGI 原始呈现时间，静止画面可能重复，也可能早于会话开始 |
| `source_received_ns` | 截图接收线程得到该图像的时间 |
| `read_begin_ns` / `read_end_ns` | 采样器读取最新帧的时间范围；不是完整截图延迟 |
| `t_ns`（键盘事件） | 系统低级键盘回调被本进程处理时的时间 |
| `native_time_ms` | Windows 原生键盘消息时间，仅作诊断，不与 QPC 直接相减 |

纳秒是存储精度，不意味着硬件采集有纳秒准确度。键盘回调受系统调度影响。未伪造硬件输入时间或使用编码完成时间作为画面时间。

视频按 20 FPS 紧凑播放，暂停和丢帧期间不会填充伪造样本。**训练应使用 `frames.jsonl` 的真实时间戳**，不要用视频帧序号推算全程时间。输入历史按事件时间查询，避免把晚于画面的按键标到旧画面上；episode 边界不得拼成连续动作序列。按键重复按下被去重，系统注入事件被排除。

## 性能与错误处理

DXcam 在后台按 60 FPS 获取图像及其呈现时间，录制器每 50ms 取最新图像。编码线程有 8 帧的有界队列；赶不上时记录 `frame_dropped`，不阻塞键盘回调。键盘事件队列溢出、截图停止、编码/磁盘错误会结束会话并标记失败。

输入回调、采样、编码相互分离。F9、Ctrl+C、关闭录制器都会卸载键盘监听并关闭视频。已完成的视频段独立可读；强制杀进程或断电可能损坏当前未完成的视频段，以及最近尚未刷盘的记录。

`session.json` 的 `timing.sample_read` 仅统计取最新图像的耗时，`timing.encode` 统计编码写入耗时；它们都不是端到端控制延迟。`writer_delay_ms` 显示存储队列造成的延迟。实际游戏是否达到稳定 20Hz 须在目标机器上试录确认。

## 验证

```powershell
.\run_gameplay_recorder.ps1 -SelfTest
.\.gameplay-venv\Scripts\python.exe -m unittest test_gameplay_recording test_gameplay_windows test_gameplay_status -v
.\.gameplay-venv\Scripts\python.exe record_gameplay.py --validate shared_data/gameplay_recordings/会话目录
.\.gameplay-venv\Scripts\python.exe record_gameplay.py --desktop-self-test --report shared_data/desktop-test.json
```

自检使用生成画面和模拟按键事件，不操作游戏，并标记 `metadata.synthetic=true`。验证器会解码全部视频，检查帧数、尺寸、时间顺序和按键状态重建。正式示范数据应排除 synthetic 会话和 failed/未完成会话，并检查丢帧及暂停边界。

默认测试跳过需要桌面会话的原生检查。设置 `GAMEPLAY_NATIVE_SMOKE=1` 可验证键盘钩子安装/卸载（按键白名单为空）；设置 `GAMEPLAY_SCREEN_SMOKE=1` 可验证真实 DXGI 截图及时间戳（显示一个自动关闭的纯色测试窗口，仅抓取其客户区）。

采集后端接口依据 [DXcam 0.3.0](https://github.com/ra1nty/DXcam/tree/v0.3.0)；本录制器没有复制 MapleStoryAuto 的控制或训练代码。

原生悬浮窗依据微软的 [SetWindowDisplayAffinity](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-setwindowdisplayaffinity) 与 [扩展窗口样式](https://learn.microsoft.com/en-us/windows/win32/winmsg/extended-window-styles)；打包使用 [PyInstaller](https://pyinstaller.org/en/stable/usage.html)。
