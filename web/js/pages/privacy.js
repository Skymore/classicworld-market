import {lang} from '../lib/i18n.js';
export function mount(main){
 const en=lang==='en';
 main.innerHTML=`<section class="stall account-stall"><div class="stall-bar"><h1>${en?'Account privacy':'账号隐私说明'}</h1></div><div class="account-body">
 <h2>${en?'Google sign-in':'Google 登录'}</h2><p>${en?'We use the unique account identifier returned by Google to recognize your account. We do not request access to Gmail, contacts, Drive files or your password. Your email and Google profile are not displayed on the contributor board.':'我们使用 Google 返回的唯一账号标识识别你的账号，不申请读取 Gmail、通讯录、网盘文件或密码。贡献榜不展示你的邮箱或 Google 个人资料。'}</p>
 <h2>${en?'Your nickname and contributions':'昵称与采集贡献'}</h2><p>${en?'Collectors without a chosen name receive a random adjective-and-monster nickname for the contributor board. Your Google identity is not used in that nickname. You can hide your profile by unchecking the leaderboard option in My profile and saving. Linking a collector combines its past and future contributions with your account.':'未设置昵称的采集者会获得「形容词＋怪物名」的随机临时昵称，用于贡献榜。临时昵称与 Google 身份无关。进入「我的」取消勾选并保存，即可退出榜单。绑定采集器会把它的历史及后续贡献合并到你的账号。'}</p>
 <h2>${en?'Staying signed in':'保持登录'}</h2><p>${en?'A secure browser cookie keeps you signed in for up to 90 days. Sign out under My profile to end that browser session. Collector credentials stay in the collector and are not copied into the browser.':'网站使用安全 Cookie 保持登录，最长 90 天。在「我的」退出登录即可结束当前浏览器会话。采集器的私人凭据保留在采集器中，不会复制到浏览器。'}</p>
 <h2>${en?'Market data and watch lists':'市场数据与关注清单'}</h2><p>${en?'Uploaded shop quotes contribute to shared market comparisons. Your watch list remains in the current browser; signing in does not currently sync it to other devices. Raw network captures stay on the collector PC.':'上传的摊位报价用于共享市场比价。关注清单仍保存在当前浏览器，登录目前不会将清单同步到其他设备。原始网络记录保留在采集电脑上。'}</p>
 <a href="/account">${en?'Back to My profile':'返回我的账号'} →</a></div></section>`;
}
