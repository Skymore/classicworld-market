import { renderChrome } from './lib/chrome.js?v=20261023-header-icons-2';
import { lang } from './lib/i18n.js';
// Shown until (or unless) the release manifest is read.
let release={version:'v0.6.12',url:'https://download.ruit.me/collector/v0.6.12/ClassicWorldCollector-windows-x64-v0.6.12.zip',size:0};
const official=/^https:\/\/(?:download\.ruit\.me\/collector|mxd\.ruit\.me\/web\/releases)\/(v\d{1,6}\.\d{1,6}\.\d{1,6})\/ClassicWorldCollector-windows-x64-\1\.zip$/;
function render(){
 const en=lang==='en',root=document.getElementById('app');
 const base=release.url.slice(0,release.url.lastIndexOf('/')+1),size=release.size?Math.round(release.size/1048576):70;
 renderChrome(root,'download');
 const title=en?'Scanner & collector':'扫描与采集';
 document.title=title+' · ClassicWorld Market';
 const main=root.querySelector('main');main.classList.add('download-page');
 const steps=en?[
  ['Download and unzip','Extract the whole ZIP. Close the old scanner and collector, run ClassicWorldCollector.exe and allow administrator permission.'],
  ['Choose how to collect','For manual collection, change channel once and browse shops. For automatic scanning, enter Free Market, select the game window and click Start.'],
  ['See prices and alerts','Quotes upload automatically. Use Account & alerts to set your nickname, link Google and view your alerts.']
 ]:[
  ['下载并解压','完整解压 ZIP，关闭旧扫描器和旧采集器，运行 ClassicWorldCollector.exe，允许管理员权限。'],
  ['选择采集方式','手动逛摊：切一次频道后照常开店。自动扫描：进入自由市场，选择游戏窗口，点击「开始扫描」。'],
  ['查看报价和提醒','报价会自动上传。通过「账号与提醒」设置昵称、绑定 Google 账号和查看关注提醒。']
 ];
 main.innerHTML=`<section class="stall"><div class="stall-bar"><h1>${title}</h1></div><div class="download-body">
 <h2>${en?'One app for manual collection and automatic scanning':'手动逛摊、自动扫描，一个程序就够'}</h2>
 <p>${en?'Capture, uploads, alerts and updates are built in. No separate collector is needed. Signing in is optional.':'已内置采集、上传、提醒和自动更新，不需要另开采集器。不登录也能使用。'}</p>
 <div class="download-actions"><a class="btn primary" href="${release.url}">${en?'Download for Windows':'下载 Windows 合并版'}</a><a href="/collect/">${en?'Browser capture':'使用浏览器采集'}</a></div>
 <p class="download-meta">${release.version} · Windows 10 / 11 ${en?`64-bit · about ${size} MB`:`64 位 · 约 ${size} MB`}</p></div></section>
 <section class="stall"><div class="stall-bar"><h2>${en?'Get started':'三步开始使用'}</h2></div><div class="download-body"><ol class="download-steps">${steps.map(([title,body])=>`<li><b>${title}</b>${body}</li>`).join('')}</ol><p>${en?'Keep the game window visible. F9 stops scanning; manual collection stays available.':'自动扫描时保持游戏窗口可见，不要移动或缩放窗口。F9 可停止扫描，手动采集仍可继续使用。'}</p></div></section>
 <section class="stall"><div class="stall-bar"><h2>${en?'Common questions':'常见问题'}</h2></div><div class="download-body">
 <details><summary>${en?'Will people scan the same room?':'多人一起扫，会重复吗？'}</summary><p>${en?'Each scanner gets one room at a time and claims its next room after finishing. Paused or disconnected tasks become available to others.':'每人一次领取一个洞，扫完再领下一个。暂停或断线后，任务会交给其他在线扫描器。'}</p></details>
 <details><summary>${en?'Which channel order?':'频道按什么顺序扫？'}</summary><p>${en?'Start at CH1. Three empty channels switch scanning to CH40 descending. Three more empty channels or meeting the scanned range finishes the room.':'从 1频道往上扫，连续三个空频道后，从 40频道往下扫。倒序再遇到三个空频道，或与已扫范围相遇，就换洞。'}</p></details>
 <details><summary>${en?'Automatic updates?':'以后还要手动下载更新吗？'}</summary><p>${en?'Updates download automatically and install after you close the game, keeping settings and records. Old standalone scanners need this one manual installation; collector v0.5.10 and later can upgrade automatically.':'新版本会自动检查并在后台下载，退出游戏后安装，保留配置和记录。旧独立扫描器需要手动安装这一次；v0.5.10 及以后的采集器可以自动升级。'}</p></details>
 <details><summary>${en?'Blocked by Windows or won\'t start?':'提示被 Windows 阻止，或打不开？'}</summary><p>${en?'Right-click the downloaded ZIP, open Properties, tick Unblock and press OK. Then delete the old folder and extract again.':'右键下载的 ZIP → 属性 → 勾选「解除锁定」→ 确定，删除旧文件夹后重新解压。'}</p></details>
 <details><summary>${en?'No new prices?':'为什么没有新报价？'}</summary><p>${en?'Change channel once, then open a shop. Check status through Account & alerts. Failed uploads are kept locally and retried.':'先切一次频道，再打开摊位，通过「账号与提醒」查看采集状态。暂时无法上传的报价会保存在本机，恢复连接后重试。'}</p></details>
 <p><a href="${base}guide.txt">${en?'Usage guide':'完整使用说明'}</a> · <a href="${base}release-notes.txt">${en?'Release notes':'版本记录'}</a> · <a href="/contributors">${en?'Contributors':'采集贡献榜'}</a></p></div></section>`;
}
render();document.addEventListener('langchange',render);
fetch('/web/releases/stable.json',{cache:'no-cache'}).then(response=>response.ok?response.json():null).then(data=>{
 const asset=data?.windows_x64,match=typeof asset?.url==='string'&&official.exec(asset.url);
 if(match&&match[1]===data.version){release={version:data.version,url:asset.url,size:Number(asset.size)||0};render();}
}).catch(()=>{});
