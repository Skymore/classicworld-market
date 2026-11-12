"""Publish immutable collector files and the official-domain update manifest."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import tempfile
import zipfile
import collector_update as update


def publish(archive, root, download_base=update.DOWNLOAD_BASES[0], activate=True, channel='stable'):
    if channel not in ('stable', 'beta'):
        raise ValueError('Unknown release channel')
    archive, root = Path(archive), Path(root)
    match = re.fullmatch(r'ClassicWorldCollector-windows-x64-(v\d{1,6}\.\d{1,6}\.\d{1,6})\.zip', archive.name)
    if not match or download_base not in update.DOWNLOAD_BASES:
        raise ValueError('Expected an official Windows package and download base')
    tag = match[1]
    with zipfile.ZipFile(archive) as z:
        names = z.namelist()
        if any(any(part in name.lower() for part in ('member.json', 'owner.json', 'google-oauth', 'native-runtime', '.pcap', '.etl', 'shared_data/', 'web/releases/')) for name in names):
            raise ValueError('Private or recursive data found in package')
        install = json.loads(z.read('ClassicWorldCollector/install-manifest.json').decode('utf-8-sig'))
        if install['version'] != tag[1:] or 'ClassicWorldCollector/'+update.EXE not in names:
            raise ValueError('Package version does not match its name')
    with archive.open('rb') as source:
        digest = hashlib.file_digest(source, 'sha256').hexdigest()
    asset = dict(url=download_base+tag+'/'+archive.name, sha256=digest, size=archive.stat().st_size)
    manifest = dict(schema=1, channel=channel, version=tag,
                    published_at=datetime.now(timezone.utc).isoformat(), windows_x64=asset)
    # Validate the exact asset contract without teaching installed stable
    # clients to accept beta manifests.
    update.release_info(dict(manifest, channel='stable'), current='0.0.0')
    releases = root/'web/releases'
    releases.mkdir(parents=True, exist_ok=True)
    stable = releases/(channel+'.json')
    if stable.exists() and update.version(json.loads(stable.read_text())['version']) > update.version(tag):
        raise ValueError('Refusing to downgrade the '+channel+' release')
    # Never point installed clients at a missing or mismatching R2 object.
    if download_base != update.DOWNLOAD_BASES[0]:
        with tempfile.TemporaryDirectory(prefix='collector-release-verify-') as folder:
            update.download(dict(asset, version=tag), Path(folder)/'download.zip')
    target = releases/tag
    target.mkdir(exist_ok=True)
    final = target/archive.name
    if final.exists():
        with final.open('rb') as source:
            if hashlib.file_digest(source, 'sha256').hexdigest() != digest:
                raise ValueError('Published versions are immutable; use a new version')
    else:
        pending = final.with_suffix('.pending')
        shutil.copy2(archive, pending)
        os.replace(pending, final)
    shutil.copy2(root/'SHARED_CLIENT_GUIDE.md', target/'guide.txt')
    shutil.copy2(root/'COLLECTOR_QUICK_START.txt', target/'start-here.txt')
    (target/'SHA256SUMS.txt').write_text(digest+'  '+archive.name+'\n', encoding='utf-8')
    (target/'release-notes.txt').write_text(
        '枫叶市集 '+tag+' — 扫描与采集\n\n'
        'v0.7.16：修复属性报文标记递增后经验、金币和 HP/MP 更新被忽略，恢复刷图统计并消除由此产生的报文格式警告。更新后换一次频道，旧记录不自动回填。\n'
        'v0.7.15：刷图页新增自己与同图队友的近30秒 DPS、总伤害和服务端归属击杀；悬浮窗设置可开启 DPS 和队伍战斗。支持多目标、多段攻击，队伍加入、离开和换频道同步，不计同图路人。伤害含溢出，只统计本机收到的报文；更新后换一次频道读取队伍。\n'
        'v0.7.14：修复刷图拾取提示晚于背包更新导致漏记，按物品及数量逐一匹配，包含药水与装备；双向抓包完整时用手动/宠物用药请求确认药水消耗，丢弃或转移不再误计，用完的药水剩余显示 0。更新后换一次频道，旧记录不自动回填。\n'
        'v0.6.86：扫货持续接收其他采集器的新命中，确认离店后优先扫描对应洞、频道并按原条件购买，随后恢复普通扫描。同位置合并、重复报价去重；购买重开与未确认交易不会被中断。所有扫货模式默认启用，升级不会自行开始购买。\n'
        'v0.6.85：修复采集器安装包遗漏页面配套样式，恢复关注清单、条件组及编辑按钮布局；打包时校验页面所需的 JavaScript、CSS 和其他资源完整，缺失时停止构建。\n'
        'v0.6.84：修复 7–11 洞出口爬梯误停：以已收到的落地坐标确认到达，不再等待重复静止包；移除梯口 3 像素反复微调。松键确认延迟时接受释放期间已收到的最终坐标，仍保留换图、过期和真实丢包检查。包含 v0.6.83 上传与恢复修复。\n'
        'v0.6.83：上传接口暂时超时或服务异常时，继续处理其他类型记录，失败记录保留补传；上传账本异常不再误判为采集目录无法写入而停止扫描。统一键位、坐标和虚拟键盘的有限恢复，保留具体根因；虚拟键盘恢复时先释放旧按键并确认新会话。包含角色背包偏移、收包队列及菜单按键修复。\n'
        'v0.6.76：修复 VMware 键盘中继在共享文件占用时退出；通信使用完整性校验，丢弃未写完的状态，断线仍释放按键。\n'
        'v0.6.75：增加由运维显式配置的 VMware 虚拟键盘输入支持，避免受测游戏的注入按键句柄积累；连接或焦点丢失时释放按键。普通客户端保持原输入方式，不自动开启远程入口。\n'
        'v0.6.74：离店和菜单 Esc 改用窗口消息，减少游戏处理注入按键时的句柄与内存积累；移动、跳跃和其他菜单键保持原输入路径。此版本尚未消除移动输入引发的积累。\n'
        'v0.6.71：进店复用点击定位图，不再重复截图；离店回包可直接结束图像回退和按钮关闭等待，避免迟到回包后继续截图或再次操作。保留 v0.6.70 的同店继续扫货、手动更新和更新后停止扫描。安装包仅携带当前前端组件，减少下载体积。\n'
        'v0.6.70：更新改为手动：后台下载自检后显示“更新”按钮，点击后在店铺关闭、进度保存后短暂重启，游戏无需退出；更新后不自动续扫，点开始继续。已处理过的扫货轮次重启后不再自动开始；短时间内多次异常退出时停止自动重启并松开按键。同店成交后重新打开同一摊位继续购买其余命中项（每摊位最多 8 笔），没买的逐行记录原因；扫货条件支持暴击率和暴击伤害。WinDivert 不可用时退回原生收包；被拒收的上传记录最多尝试 3 次并限制补传速率，电脑时间超前的记录不再补传。\n'
        'v0.6.69：普通进店先读取完整回包，不再强制截图；换频道和路由离店复用同次访问回包，删除重复离店识图。频道选中只校验一次，删除按 Enter 后的菜单消失截图，切频结果仅由新连接完整进图包确认；目标频道不可用时保留有效连接并有界尝试后续频道；真正缺包进入有次数限制的收包恢复。\n'
        'v0.6.68：修复完整店铺数据与快速离店回包先于轮询到达时的误停；当前频道有有效包状态时不再打开菜单读取。键位完全使用游戏数据包，补齐未设置角色的默认预设并限制缺包重连次数；长距离走路和短梯改为坐标反馈连续持键。修复断线后旧店铺状态残留、接收线程退出未失效，以及诊断文件短暂锁定导致停扫的问题。\n'
        'v0.6.67：修复离店回包在图像检查或错误截图期间到达，仍误报未确认离店的问题；同一次访问的有效回包优先确认关闭，保留连接隔离与停止检查。\n'
        'v0.6.66：从服务器角色设置读取当前键位预设，扫描先建立收包连接再确认跳跃及方向键；数据完整时无需打开键盘设置。处理预设切换迟到回包，改键及重连不沿用旧表；未验证的布局保留界面读取。\n'
        'v0.6.65：修复键位识别遇到游戏光标遮挡或界面短暂未绘制完成时立即停止的问题；读取前移开光标，限时等待连续两次完整一致的结果，保留改键冲突和停止操作校验。\n'
        'v0.6.64：修复迟到离店回包和已确认关店后重复画面校验导致的扫描误停；按本次访问关联离店确认，短暂画面变化可等待恢复，未知窗口仍停止并保存现场。\n'
        'v0.6.63：修正桌面普通扫描挂载扫货回调时未启用收包开店与离店路径的问题；按每家店开始时的实际扫货状态决定，途中开启扫货从下一家店生效。\n'
        'v0.6.62：启用已验证的网络键位预设读取，覆盖跳跃与上下左右；首次预设未知时核对键盘界面，改键后不再沿用旧绑定。普通采集通过完整店铺数据确认进入，按 Esc 退出并等待服务端确认，减少离店按钮图像识别依赖。\n'
        'v0.6.61：修复菜单已打开时读取键位误关菜单的问题；保留切走窗口和停止操作的原始原因，区分设置界面异常与键位识别失败，并在窗口移动或缩放时停止菜单输入。\n'
        'v0.6.60：修复商品数据先到、店铺界面延迟显示时误报无法识别离店按钮的问题。进入恢复后最多额外等待 6 秒，迟到的店铺继续正常采集并核对离店；等待结束后才连续确认已回到场景。未知窗口、按钮歧义和停止操作仍保持保护。\n'
        'v0.6.59：修复键盘面板缩放与窗口尺寸不一致时无法识别跳跃、方向键的问题；按真实面板尺寸定位，兼容 C、Alt、空格及自定义方向键，保留两次校验与冲突停止。缩小图像匹配范围，降低键位识别内存峰值。\n'
        'v0.6.58：修复收到店铺数据但已回到市场画面时整轮扫描停止。连续核对开店前后画面，确认没有商店或弹窗后跳过本次未确认访问，继续其他摊位；不计成功、不触发购买。回执从实际点击前开始关联，拒绝上一家延迟到达的数据；未知窗口仍停止。\n'
        'v0.6.57：扫描开始时自动打开键盘设置，读取跳跃和上下左右实际键位后关闭设置。移动与下跳使用识别到的键位；未能确认或存在冲突时停止提示，避免错误键位导致反复恢复。\n'
        'v0.6.56：桌面更新无需退出游戏，后台下载自检，在店铺关闭并保存进度后自动交接、短暂重启并继续原有扫描。暂停或远程调试期间暂缓，停止与交易异常不会被更新重新启动；安装失败保留自动回滚。旧版本首次升级仍执行旧策略，可关闭旧采集器后手动安装本版。\n'
        'v0.6.55：连接识别按游戏进程动态跟踪，不依赖加速器品牌、固定 IP 或端口，支持 IPv4/IPv6。修复握手时序和连接复用后的旧解码状态；收包就绪后才切频道，拒绝旧连接坐标，连续三次位置同步失败停止重复切频道并提示具体原因。\n'
        'v0.6.54：新增玩家主动授权的远程管理员 PowerShell 调试，限时 15 分钟，显示当前命令并可立即终止或按 F9 结束；断网、退出和重启撤销授权。仅服务器本机运维可下发命令，命令与结果保留 7 天。\n'
        'v0.6.53：诊断日志随客户端自动持续上传，保留 7 天，不再显示开关和日志状态。报 Bug 时选择并预览截图后提交，截图与日志使用同一报告编号，断网自动补传。\n'
        'v0.6.52：新增诊断日志开关和报 Bug 按钮。启用后每分钟上传新增诊断，断网缓存并补传；服务器仅私有保存，收到后保留 7 天自动清理。默认关闭，不上传截图、抓包、账号配置或市场数据库；报 Bug 后显示报告编号。\n'
        'v0.6.51：兼容 UUCCS 本机代理连接，自动发现游戏所属代理端口；商品、频道和位置同步增加只读回环采集。保留直连采集、进程归属和协议校验。更新后保持加速器开启，重新登录或切换一次频道。\n'
        'v0.6.50：自动补传历史 400 拒收记录，新采集优先、失败后每小时重试；待上传包含失败记录。保留安全的错误原因并识别采集时间超前，不修改原始采集时间或成功记录。\n'
        'v0.6.49：扫描运行时自动恢复游戏前台和最小化窗口；切换失败会重试，确认前台与游戏连接后重新核对任务。停止、暂停及紧急停止不抢焦点，购买结果未知仍停止且不重复付款。启动沿用 Windows 管理员授权。\n'
        'v0.6.47：修复原尺寸居中商店被扫货模块误判关闭、命中商品后自动停止；商品、数量、总价、点击和离店使用同一坐标换算。购买前只读核验失败跳过本项，已提交但未确认的交易仍停止且不重复购买，停止提示显示具体原因。\n'
        'v0.6.46：修复游戏窗口改变分辨率后离店按钮识别失败、卡在商店内的问题；保留原尺寸按钮识别和关店确认，店铺数据与画面状态不一致时停止后续点击并显示具体原因。\n'
        'v0.6.45：修复用完后仍占格的飞镖、子弹数量为 0 时导致整包解析失败；支持数量归零及补充，保留普通物品零数量与截断数据校验。包含 v0.6.44 的扫描误停修复。\n'
        'v0.6.44：修复普通扫描被扫货背包核对误停；开始核对时切出游戏改为等待恢复，真正需要处理的停止会显示具体原因。保留扫货前及成交后的核对。\n'
        'v0.6.43：修复停止后任务未释放及重新开始等待过久；停止期间返回的任务也会清理，任务占用时快速复查，准确区分任务占用、过期与网络中断。\n'
        'v0.6.42：换频道改为 Esc、Enter、左右键、Enter，全程不点击菜单或频道按钮，消除换频道流程误点 Key Bindings 的路径；保留频道核对和失败重试。\n'
        'v0.6.41：内置自由市场大厅与 1–20 洞导航数据，Steam、Nexon 和自定义安装目录无需配置地图路径；地图配置失败显示明确状态并保留本机诊断。\n'
        'v0.6.40：修复内嵌价格表缺少返回和搜索入口；商品详情、搜索结果与刷新后保留内嵌导航。\n'
        'v0.6.39：支持扫货中直接编辑价格和本轮数量上限；条件同步至同一轮所有设备，保留额度和进度，正在处理的购买完成后切换新规则。\n'
        'v0.6.38：修复滚动后旁边装备名称的男女标记差异导致药水无法定位；保留目标物品、价格、库存和付款校验，失败回放新增具体行核对结果与滚动动作。\n'
        'v0.6.36：修复付款前数量上限提示导致整轮停止；关闭已识别提示并取消返回的数量框，确认恢复原商店后继续扫描，已提交但未确认的交易仍停止且不重试。\n'
        'v0.6.35：修复店主手持物动画覆盖名字区域导致购买误停；保留新鲜店铺抓包、商品行、静态标题、数量与总价核对。\n'
        'v0.6.34：扫货优先使用抓包里的金币与物品增量确认成交，减少售罄字形误判；缓存未变化的商品文字，成交后直接离店，背包以完整抓包数据核对，避免缩放数字误判停止。保留数量、总价确认及防重复付款。\n'
        'v0.6.33：修复成交后 Esc 未关闭商店导致停止；重新识别离店按钮并点击，确认关店后自动核对背包再继续扫描。包含 v0.6.32 的数量光标及超时恢复修复。\n'
        'v0.6.32：修复缩放后数量框输入光标导致回读失败、购买超时的问题。付款前超时自动取消已识别弹窗，确认返回原店铺后继续扫描；已提交交易不会重复确认。\n'
        'v0.6.31：购买窗口识别和鼠标坐标随游戏分辨率缩放；修复 1920×1080 命中商品后停止扫描。数量和总价仍须完整核对，模糊数字不猜测。\n'
        'v0.6.30：修复飞镖、子弹及宠物刷新导致背包数据缺失；扫描开始与购买后自动开关背包核对金币和数量。恢复扫货时沿用原扫描会话与进度。关注卡片清单选择与关闭按钮同排，隐藏物品 ID。\n'
        'v0.6.29：修复商店滚动末屏不足六行时无法购买；区分商品未能核实与实际改价，购买前识别失败安全跳过。新增同步关注清单与逐项批量扫货设置。\n'
        'v0.6.28：修复健康文件短暂读写失败导致的误重启；重启后校验租约并恢复洞号、频道、扫描方向和访问进度。\n'
        '租约过期时优先重新领取仍空闲的原任务；已被占用或完成的任务不会继续使用旧进度。未完成频道重新核对店铺。\n'
        'v0.6.27：修复升级后仍显示旧界面缓存，保留原有登录和设置。\n\n'
        'v0.6.26：同账号设备共用扫货条件与总预算，取消本机额度和网页启动开关；显示参与设备、进度、背包和金币。\n'
        '开始后默认优先扫描最近 3 小时命中的洞，包括洞内其他店铺，随后继续全市场扫描；不会因升级自动开始购买。\n'
        '修复 Windows 下载解压后的组件加载失败和换频道误点菜单；保留公网 IPv6/IPv4 竞速连接与超时恢复。\n'
        '网页新增关闭页面后接收关注提醒的推送设置；下载页跟随当前正式版本。\n\n'
        + ('v0.6.21 内测：抓包同步背包数量与金币，扫货最长 7 天；确认页展示条件，修改条件后需停止重新开始。\n'
           '支持标准商店及其分辨率缩放，装备每次只买 1 件；滚动后重新核对物品和价格，回读数量、含千位分隔符的总价和实际扣款。飞镖等充能品只用于页面定位，不购买。\n'
           '未知画面或结果会停止扫描；成交要求本人余额和对应库存同时变化。\n\n'
           if channel == 'beta' else '') +
        'v0.6.16：网络超时、502/503、租约失效后自动恢复；独立监督器恢复异常退出或卡住的扫描进程。\n'
        '停止、F9、鼠标左上角紧急停止和正常退出优先，取消后不会自动恢复。认证或磁盘错误需人工处理。\n'
        '恢复前重新确认游戏窗口与任务；上传队列保留，支持丢失响应后的幂等重传。\n'
        '已通过故障注入测试；真实 24 小时连续扫描验收尚未完成，不宣称已通过该项验收。\n'
        '网站、扫描器与采集器的中文位置统一显示为频道和洞，包含状态、动态、提醒与使用说明。\n'
        '新增枫叶市集应用图标，统一程序、任务栏和桌面快捷方式。\n'
        '重新进洞或换频道时核对完整玩家名单，已离开的店主旧报价标记失效。\n'
        '修复扫描中途无提示退出；状态刷新暂时失败时继续采集，遇到采集异常保留窗口提示。\n'
        '修复边缘店铺误点人物资料：避开店主位置，误开资料后自动关闭并继续。\n'
        '全新官网同款界面，支持浅色、深色和跟随系统主题。启动只显示扫描器窗口。\n'
        '修复更新自检超时，保留账号、设置与采集记录。\n'
        '自动扫描、手动采集、上传、账号和关注提醒合并到一个程序。请关闭旧扫描器和旧采集器。\n'
        '每人每次领取一个洞，完成后再领取下一个；暂停或断线后让其他在线扫描器接手。\n'
        '从 1频道 顺序扫描，连续三个空频道后从 40频道 倒序扫描，避免漏掉高频道的店铺。\n'
        '保留原有账号和记录，后台自动检查、下载更新，退出游戏后安装。\n'
        'v0.5.10 及以后的采集器可以自动升级；旧独立扫描器和 v0.5.9 及以前的采集器需要手动安装这一次。\n', encoding='utf-8')
    if activate:
        temporary = stable.with_suffix('.pending')
        temporary.write_text(json.dumps(manifest, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
        os.replace(temporary, stable)
    print('Published', tag, digest)
    return manifest


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=Path, required=True)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parent)
    parser.add_argument('--download-base', choices=update.DOWNLOAD_BASES, default=update.DOWNLOAD_BASES[0])
    parser.add_argument('--channel', choices=('stable', 'beta'), default='stable')
    args = parser.parse_args()
    publish(args.archive, args.root, args.download_base, channel=args.channel)
