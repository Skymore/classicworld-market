import { usePreferences } from "../providers";
import { usePageReady } from "../components/shared";
function ZH() {
  return (
    <>
      <section className={"stall"}>
        <div className={"stall-bar"}>
          <h1>{"下载采集器"}</h1>
        </div>
        <div className={"download-body"}>
          {"\n "}
          <h2>{"边逛市场，边记录价格"}</h2>
          {"\n "}
          <p>
            {
              "启动采集器后照常逛摊，新报价会自动更新到网页，方便比价、关注想买的物品和发现低价。无需注册账号。"
            }
          </p>
          {"\n "}
          <div className={"download-actions"}>
            <a
              className={"btn primary"}
              href={
                "https://download.ruit.me/collector/v0.5.12/ClassicWorldCollector-windows-x64-v0.5.12.zip"
              }
            >
              {"下载 Windows 版"}
            </a>
            <a href={"/collect/"}>{"不想安装？使用浏览器采集"}</a>
          </div>
          {"\n "}
          <p className={"download-meta"}>
            {"v0.5.12 · Windows 10 / 11 64 位 · 约 16 MB"}
          </p>
          {"\n "}
        </div>
      </section>
      {"\n "}
      <section className={"stall"}>
        <div className={"stall-bar"}>
          <h2>{"三步开始使用"}</h2>
        </div>
        <div className={"download-body"}>
          <ol className={"download-steps"}>
            <li>
              <b>{"下载并解压"}</b>
              {"把压缩包完整解压到一个文件夹，保留解压出来的所有文件。"}
            </li>
            <li>
              <b>{"启动采集器"}</b>
              {
                "双击 ClassicWorldCollector.exe，Windows 询问管理员权限时选择“是”。玩游戏时保持采集器运行。"
              }
            </li>
            <li>
              <b>{"切一次频道，开始逛摊"}</b>
              {
                "照常打开摊位，程序会自动记录价格。保持自动打开的个人提醒网页，即可查看新报价和低价提醒。"
              }
            </li>
          </ol>
          {"\n "}
          <p>
            {
              "结束逛摊后关闭采集器即可。采集的价格会参与市场比价，个人提醒各自独立。"
            }
          </p>
        </div>
      </section>
      {"\n "}
      <section className={"stall"}>
        <div className={"stall-bar"}>
          <h2>{"给你的采集贡献留个名字"}</h2>
        </div>
        <div className={"download-body"}>
          <p>
            {
              "在采集器打开的网页右上角点头像图标进入「我的」，填写昵称并保存。勾选公开贡献后，以前上传的记录也会计入榜单。不登录也能照常采集。"
            }
          </p>
          <p>
            <a className={"btn"} href={"/contributors"}>
              {"查看采集贡献榜 →"}
            </a>
          </p>
        </div>
      </section>
      {"\n "}
      <section className={"stall"}>
        <div className={"stall-bar"}>
          <h2>{"常见问题"}</h2>
        </div>
        <div className={"download-body"}>
          {"\n "}
          <details>
            <summary>{"已经装过，怎么更新？"}</summary>
            <p>
              {
                "新版会在后台自动准备。正在游戏时继续采集，退出游戏后自动完成更新，配置和记录会保留。这次 v0.5.11 及以前版本需手动安装一次：关闭旧采集器，完整解压新版到新文件夹后运行，再切一次频道。保留原有本机数据目录。"
              }
            </p>
          </details>
          {"\n "}
          <details>
            <summary>{"启动了，为什么没有新报价？"}</summary>
            <p>
              {
                "先确认采集器保持运行，再切一次频道或重新登录，然后打开摊位。个人提醒页顶部会显示当前采集状态。用过旧版游戏代理的，请先关闭旧代理。暂时无法上传时，已记录的价格会留在本机，恢复连接后继续上传。"
              }
            </p>
          </details>
          {"\n "}
          <details>
            <summary>{"在哪里看自己的提醒？"}</summary>
            <p>
              {
                "采集器启动后会自动打开个人提醒网页，逛摊时保持网页打开即可。误关后，先确认采集器正在运行，再点击下面的按钮。"
              }
            </p>
            <p>
              <a className={"btn"} href={"http://127.0.0.1:8780/alerts"}>
                {"打开本机个人提醒"}
              </a>
            </p>
          </details>
          {"\n "}
          <details>
            <summary>{"Windows 提示无法启动？"}</summary>
            <p>
              {
                "请保留提示内容并反馈给我们，不要关闭系统安全防护。当前下载适用于 Windows 10 / 11 的 64 位电脑。"
              }
            </p>
          </details>
          {"\n "}
          <details>
            <summary>{"故障排查与技术说明"}</summary>
            <p>
              {
                "采集器会自动配置仅适用于本程序、TCP 来源端口 8500–8999 的防火墙规则。完整说明包含诊断状态、本机文件和规则清理方法。请勿分享 member.json，它保存你的私人采集身份。"
              }
            </p>
            <p>
              <a href={"https://download.ruit.me/collector/v0.5.12/guide.txt"}>
                {"查看完整技术说明"}
              </a>
              {" · "}
              <a
                href={
                  "https://download.ruit.me/collector/v0.5.12/release-notes.txt"
                }
              >
                {"版本记录"}
              </a>
            </p>
          </details>
          {"\n "}
        </div>
      </section>
    </>
  );
}
function EN() {
  return (
    <>
      <section className={"stall"}>
        <div className={"stall-bar"}>
          <h1>{"Download collector"}</h1>
        </div>
        <div className={"download-body"}>
          {"\n "}
          <h2>{"Keep track of prices as you browse shops"}</h2>
          {"\n "}
          <p>
            {
              "Start the collector and visit shops as usual. New offers appear on the website automatically, helping you compare prices and spot deals. No account registration is needed."
            }
          </p>
          {"\n "}
          <div className={"download-actions"}>
            <a
              className={"btn primary"}
              href={
                "https://download.ruit.me/collector/v0.5.12/ClassicWorldCollector-windows-x64-v0.5.12.zip"
              }
            >
              {"Download for Windows"}
            </a>
            <a href={"/collect/"}>{"Use browser capture instead"}</a>
          </div>
          {"\n "}
          <p className={"download-meta"}>
            {"v0.5.12 · Windows 10 / 11 64-bit · About 16 MB"}
          </p>
          {"\n "}
        </div>
      </section>
      {"\n "}
      <section className={"stall"}>
        <div className={"stall-bar"}>
          <h2>{"Three steps to get started"}</h2>
        </div>
        <div className={"download-body"}>
          <ol className={"download-steps"}>
            <li>
              <b>{"Download and unzip"}</b>
              {
                "Extract the whole ZIP into a folder. Keep all the extracted files together."
              }
            </li>
            <li>
              <b>{"Start the collector"}</b>
              {
                "Double-click ClassicWorldCollector.exe. Choose Yes when Windows asks for administrator permission. Keep the collector running while you play."
              }
            </li>
            <li>
              <b>{"Change channel once, then visit shops"}</b>
              {
                "Open shops as usual. Their prices are recorded automatically. Keep the personal alerts page open to see new offers and deals."
              }
            </li>
          </ol>
          {"\n "}
          <p>
            {
              "You can close the collector when you finish playing. Your collected prices contribute to market comparisons; personal alerts stay separate for each player."
            }
          </p>
        </div>
      </section>
      {"\n "}
      <section className={"stall"}>
        <div className={"stall-bar"}>
          <h2>{"Put your name on the board"}</h2>
        </div>
        <div className={"download-body"}>
          <p>
            {
              "Select the profile icon at the top right of the page opened by your collector, enter a nickname, and save. Opt in to the contributor board to include your earlier uploads too. You can keep collecting without signing in."
            }
          </p>
          <p>
            <a className={"btn"} href={"/contributors"}>
              {"See contributors →"}
            </a>
          </p>
        </div>
      </section>
      {"\n "}
      <section className={"stall"}>
        <div className={"stall-bar"}>
          <h2>{"Need help?"}</h2>
        </div>
        <div className={"download-body"}>
          {"\n "}
          <details>
            <summary>{"How do I update?"}</summary>
            <p>
              {
                "Updates are prepared quietly in the background. While you are playing, collection continues; the update finishes automatically after you close the game. Settings and records are kept. For this release, v0.5.11 and earlier need one manual upgrade: close the old collector, extract the new ZIP into a new folder, run it, and change channel once. Keep your local data folder."
              }
            </p>
          </details>
          {"\n "}
          <details>
            <summary>{"Why are there no new prices?"}</summary>
            <p>
              {
                "Keep the collector running, change channel or log in again, then open a shop. Check the status at the top of your personal alerts page. If you used an old game proxy, close it first. If uploads are temporarily unavailable, collected prices stay on your PC and are retried later."
              }
            </p>
          </details>
          {"\n "}
          <details>
            <summary>{"Where are my personal alerts?"}</summary>
            <p>
              {
                "The collector opens your personal alerts page automatically. Keep it open while browsing shops. If you closed it, start the collector and use the button below."
              }
            </p>
            <p>
              <a className={"btn"} href={"http://127.0.0.1:8780/alerts"}>
                {"Open personal alerts on this PC"}
              </a>
            </p>
          </details>
          {"\n "}
          <details>
            <summary>{"Windows will not let it start?"}</summary>
            <p>
              {
                "Keep the exact message and contact the maintainer. Do not disable security protections. This download supports 64-bit Windows 10 and 11."
              }
            </p>
          </details>
          {"\n "}
          <details>
            <summary>{"Troubleshooting details"}</summary>
            <p>
              {
                "The collector automatically configures a firewall rule limited to its own executable and TCP source ports 8500–8999. The full guide explains diagnostic status, local files and rule removal. Never share member.json, which contains your private collector identity."
              }
            </p>
            <p>
              <a href={"https://download.ruit.me/collector/v0.5.12/guide.txt"}>
                {"Full technical guide"}
              </a>
              {" · "}
              <a
                href={
                  "https://download.ruit.me/collector/v0.5.12/release-notes.txt"
                }
              >
                {"Release notes"}
              </a>
            </p>
          </details>
          {"\n "}
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
