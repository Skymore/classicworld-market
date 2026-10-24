import { usePreferences } from "../providers";
import { usePageReady } from "../components/shared";
function ZH() {
  return (
    <>
      <section className={"stall account-stall"}>
        <div className={"stall-bar"}>
          <h1>{"账号隐私说明"}</h1>
        </div>
        <div className={"account-body"}>
          {"\n "}
          <h2>{"Google 登录"}</h2>
          <p>
            {
              "我们使用 Google 返回的唯一账号标识识别你的账号，不申请读取 Gmail、通讯录、网盘文件或密码。贡献榜不展示你的邮箱或 Google 个人资料。"
            }
          </p>
          {"\n "}
          <h2>{"账号密码与恢复"}</h2>
          <p>
            {
              "可以使用用户名和密码注册，也可以使用 Google 登录后再设置密码。密码使用 Argon2id 加盐哈希保存。设置密码后会显示一次性恢复码，服务器仅保存恢复码的哈希，请妥善保管。"
            }
          </p>
          {"\n "}
          <h2>{"昵称与采集贡献"}</h2>
          <p>
            {
              "未设置昵称的采集者会获得「形容词＋怪物名」的随机临时昵称，用于贡献榜。临时昵称与 Google 身份无关。进入「我的」取消勾选并保存，即可退出榜单。绑定采集器会把它的历史及后续贡献合并到你的账号。"
            }
          </p>
          {"\n "}
          <h2>{"保持登录"}</h2>
          <p>
            {
              "网站使用安全 Cookie 保持登录，最长 90 天。在「我的」退出登录即可结束当前浏览器会话。采集器的私人凭据保留在采集器中，不会复制到浏览器。"
            }
          </p>
          {"\n "}
          <h2>{"市场数据与关注清单"}</h2>
          <p>
            {
              "上传的摊位报价用于共享市场比价。游客关注清单保存在当前浏览器。登录后，账号关注、目标价、提醒设置和明确选择的偏好会同步到服务器。游客数据由你选择合并；浏览器通知权限需要在各设备单独开启。原始网络记录保留在采集电脑上。"
            }
          </p>
          {"\n "}
          <h2>{"助手对话历史"}</h2>
          <p>
            {
              "登录后的对话会保存到账号，可在其他设备继续。你可以在助手历史中删除会话及其消息。未登录的临时对话仅保留在当前页面。提问、必要的对话上下文及市场查询结果会发送给 OpenRouter 生成回复，网站不会向模型附带账号凭据。联网搜索时，搜索关键词会经 OpenRouter 提交给搜索服务 Exa；搜索请求不会自动附带完整对话或账号凭据。引用网页属于第三方内容。"
            }
          </p>
          {"\n "}
          <h2>网站访问统计</h2>
          <p>网站自行统计页面浏览量、每日访客、来源域名和设备类型。浏览器保存每天更换的随机匿名标识，服务器仅保存当天标识的哈希，记录保留最近 90 天。统计不关联账号，不保存 IP 地址、搜索词、完整来源网址或对话内容，不发送给第三方。开启 Do Not Track 或 Global Privacy Control 后不计入统计。每日访客是浏览器估计数，并非精确人数。</p>
          <a href={"/account"}>{"返回我的账号 →"}</a>
        </div>
      </section>
    </>
  );
}
function EN() {
  return (
    <>
      <section className={"stall account-stall"}>
        <div className={"stall-bar"}>
          <h1>{"Account privacy"}</h1>
        </div>
        <div className={"account-body"}>
          {"\n "}
          <h2>{"Google sign-in"}</h2>
          <p>
            {
              "We use the unique account identifier returned by Google to recognize your account. We do not request access to Gmail, contacts, Drive files or your password. Your email and Google profile are not displayed on the contributor board."
            }
          </p>
          {"\n "}
          <h2>{"Account password and recovery"}</h2>
          <p>
            {
              "You may register a username and password, or use Google sign-in and optionally add a password later. Passwords use salted Argon2id hashes. One-time recovery codes are shown when setting a password; the server stores only their hashes. Keep your recovery code private."
            }
          </p>
          {"\n "}
          <h2>{"Your nickname and contributions"}</h2>
          <p>
            {
              "Collectors without a chosen name receive a random adjective-and-monster nickname for the contributor board. Your Google identity is not used in that nickname. You can hide your profile by unchecking the leaderboard option in My profile and saving. Linking a collector combines its past and future contributions with your account."
            }
          </p>
          {"\n "}
          <h2>{"Staying signed in"}</h2>
          <p>
            {
              "A secure browser cookie keeps you signed in for up to 90 days. Sign out under My profile to end that browser session. Collector credentials stay in the collector and are not copied into the browser."
            }
          </p>
          {"\n "}
          <h2>{"Market data and watch lists"}</h2>
          <p>
            {
              "Uploaded shop quotes contribute to shared market comparisons. Guest watches stay in the current browser. Signed-in watches, target prices, alert settings and chosen preferences sync through your account. Guest data is merged only when you choose to import it. Browser notification permission remains device-specific. Raw network captures stay on the collector PC."
            }
          </p>
          {"\n "}
          <h2>{"Assistant conversations"}</h2>
          <p>
            {
              "When signed in, your conversations are saved to your account so you can continue on another device. You can delete a conversation and its messages from the assistant history. Temporary guest chats stay in the current page. Your question, necessary conversation context and market query results are sent to OpenRouter to generate replies; the site does not attach account credentials to model requests. For web searches, search keywords are sent through OpenRouter to the search service Exa. Search requests do not automatically include your full conversation or account credentials. Cited pages are third-party content."
            }
          </p>
          {"\n "}
          <h2>Website traffic statistics</h2>
          <p>The site measures page views, daily visitors, referring domains and device types itself. Your browser stores a random anonymous identifier that changes each UTC day. The server stores only its daily hash and retains records for 90 days. Statistics are not linked to accounts and do not store IP addresses, search terms, full referring URLs or conversations, or send data to third parties. Do Not Track and Global Privacy Control requests are excluded. Daily visitors estimate browsers, not exact people.</p>
          <a href={"/account"}>{"Back to My profile →"}</a>
        </div>
      </section>
    </>
  );
}
export default function Page() {
  usePageReady();
  const { language } = usePreferences();
  return language === "en" ? <EN /> : <ZH />;
}
