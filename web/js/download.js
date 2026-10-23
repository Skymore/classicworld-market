import { renderChrome } from './lib/chrome.js?v=20261023-header-icons-2';
import { lang } from './lib/i18n.js';
const release='https://download.ruit.me/collector/v0.5.10/release-notes.txt';
const zip='https://download.ruit.me/collector/v0.5.10/ClassicWorldCollector-windows-x64-v0.5.10.zip';
const guide='https://download.ruit.me/collector/v0.5.10/guide.txt';
function render(){
 const en=lang==='en',root=document.getElementById('app');
 renderChrome(root,'download');
 const title=en?'Download collector':'下载采集器';
 document.title=title+' · ClassicWorld Market';
 const main=root.querySelector('main');main.classList.add('download-page');
 const steps=en?[
  ['Download and unzip','Extract the whole ZIP into a folder. Keep all the extracted files together.'],
  ['Start the collector','Double-click ClassicWorldCollector.exe. Choose Yes when Windows asks for administrator permission. Keep the collector running while you play.'],
  ['Change channel once, then visit shops','Open shops as usual. Their prices are recorded automatically. Keep the personal alerts page open to see new offers and deals.']
 ]:[
  ['下载并解压','把压缩包完整解压到一个文件夹，保留解压出来的所有文件。'],
  ['启动采集器','双击 ClassicWorldCollector.exe，Windows 询问管理员权限时选择“是”。玩游戏时保持采集器运行。'],
  ['切一次频道，开始逛摊','照常打开摊位，程序会自动记录价格。保持自动打开的个人提醒网页，即可查看新报价和低价提醒。']
 ];
 main.innerHTML=`<section class="stall"><div class="stall-bar"><h1>${title}</h1></div><div class="download-body">
 <h2>${en?'Keep track of prices as you browse shops':'边逛市场，边记录价格'}</h2>
 <p>${en?'Start the collector and visit shops as usual. New offers appear on the website automatically, helping you compare prices and spot deals. No account registration is needed.':'启动采集器后照常逛摊，新报价会自动更新到网页，方便比价、关注想买的物品和发现低价。无需注册账号。'}</p>
 <div class="download-actions"><a class="btn primary" href="${zip}">${en?'Download for Windows':'下载 Windows 版'}</a><a href="/collect/">${en?'Use browser capture instead':'不想安装？使用浏览器采集'}</a></div>
 <p class="download-meta">v0.5.10 · Windows 10 / 11 ${en?'64-bit':'64 位'} · ${en?'About 16 MB':'约 16 MB'}</p>
 </div></section>
 <section class="stall"><div class="stall-bar"><h2>${en?'Three steps to get started':'三步开始使用'}</h2></div><div class="download-body"><ol class="download-steps">${steps.map(([h,p])=>`<li><b>${h}</b>${p}</li>`).join('')}</ol>
 <p>${en?'You can close the collector when you finish playing. Your collected prices contribute to market comparisons; personal alerts stay separate for each player.':'结束逛摊后关闭采集器即可。采集的价格会参与市场比价，个人提醒各自独立。'}</p></div></section>
 <section class="stall"><div class="stall-bar"><h2>${en?'Put your name on the board':'给你的采集贡献留个名字'}</h2></div><div class="download-body"><p>${en?'Select the profile icon at the top right of the page opened by your collector, enter a nickname, and save. Opt in to the contributor board to include your earlier uploads too. You can keep collecting without signing in.':'在采集器打开的网页右上角点头像图标进入「我的」，填写昵称并保存。勾选公开贡献后，以前上传的记录也会计入榜单。不登录也能照常采集。'}</p><p><a class="btn" href="/contributors">${en?'See contributors':'查看采集贡献榜'} →</a></p></div></section>
 <section class="stall"><div class="stall-bar"><h2>${en?'Need help?':'常见问题'}</h2></div><div class="download-body">
 <details><summary>${en?'How do I update?':'已经装过，怎么更新？'}</summary><p>${en?'Updates are prepared quietly in the background. While you are playing, collection continues; the update finishes automatically after you close the game. Settings and records are kept. For this release, v0.5.9 and earlier need one manual upgrade: close the old collector, extract the new ZIP into a new folder, run it, and change channel once. Keep your local data folder.':'新版会在后台自动准备。正在游戏时继续采集，退出游戏后自动完成更新，配置和记录会保留。这次 v0.5.9 及以前版本需手动安装一次：关闭旧采集器，完整解压新版到新文件夹后运行，再切一次频道。保留原有本机数据目录。'}</p></details>
 <details><summary>${en?'Why are there no new prices?':'启动了，为什么没有新报价？'}</summary><p>${en?'Keep the collector running, change channel or log in again, then open a shop. Check the status at the top of your personal alerts page. If you used an old game proxy, close it first. If uploads are temporarily unavailable, collected prices stay on your PC and are retried later.':'先确认采集器保持运行，再切一次频道或重新登录，然后打开摊位。个人提醒页顶部会显示当前采集状态。用过旧版游戏代理的，请先关闭旧代理。暂时无法上传时，已记录的价格会留在本机，恢复连接后继续上传。'}</p></details>
 <details><summary>${en?'Where are my personal alerts?':'在哪里看自己的提醒？'}</summary><p>${en?'The collector opens your personal alerts page automatically. Keep it open while browsing shops. If you closed it, start the collector and use the button below.':'采集器启动后会自动打开个人提醒网页，逛摊时保持网页打开即可。误关后，先确认采集器正在运行，再点击下面的按钮。'}</p><p><a class="btn" href="http://127.0.0.1:8780/alerts">${en?'Open personal alerts on this PC':'打开本机个人提醒'}</a></p></details>
 <details><summary>${en?'Windows will not let it start?':'Windows 提示无法启动？'}</summary><p>${en?'Keep the exact message and contact the maintainer. Do not disable security protections. This download supports 64-bit Windows 10 and 11.':'请保留提示内容并反馈给我们，不要关闭系统安全防护。当前下载适用于 Windows 10 / 11 的 64 位电脑。'}</p></details>
 <details><summary>${en?'Troubleshooting details':'故障排查与技术说明'}</summary><p>${en?'The collector automatically configures a firewall rule limited to its own executable and TCP source ports 8500–8999. The full guide explains diagnostic status, local files and rule removal. Never share member.json, which contains your private collector identity.':'采集器会自动配置仅适用于本程序、TCP 来源端口 8500–8999 的防火墙规则。完整说明包含诊断状态、本机文件和规则清理方法。请勿分享 member.json，它保存你的私人采集身份。'}</p><p><a href="${guide}">${en?'Full technical guide':'查看完整技术说明'}</a> · <a href="${release}">${en?'Release notes':'版本记录'}</a></p></details>
 </div></section>`;
}
render();document.addEventListener('langchange',render);
