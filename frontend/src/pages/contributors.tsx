import { useState } from "react";
import { useWords } from "../providers";
import { useMarketQuery } from "../lib/query";
import {
  Stall,
  Loading,
  ErrorState,
  usePageReady,
  num,
} from "../components/shared";
import { SiteLink } from "../components/shell";
import { Tabs, TabsList, TabsTrigger } from "../components/ui/tabs";
interface Contributor {
  nickname: string;
  shops: number;
  quotes: number;
  days: number;
}
export default function Contributors() {
  usePageReady();
  const words = useWords();
  const [period, setPeriod] = useState("week");
  const query = useMarketQuery<{ contributors: Contributor[] }>(
    "/api/v1/contributors?period=" + period,
  );
  return (
    <Stall
      title={words("采集贡献榜", "Contributors")}
      className="contributors"
      h1
      action={
        <SiteLink className="bar-more" href="/account">
          {words("我的贡献", "My profile")} →
        </SiteLink>
      }
    >
      <div className="account-body">
        <h2>
          {words(
            "谢谢每一位逛市场的人",
            "Thanks to everyone exploring the market",
          )}
        </h2>
        <div className="contributor-tools">
          <Tabs value={period} onValueChange={setPeriod}>
            <TabsList aria-label={words("排行范围", "Ranking period")}>
              {[
                ["week", "近 7 天", "7 days"],
                ["month", "近 30 天", "30 days"],
                ["all", "累计", "All time"],
              ].map(([key, zh, en]) => (
                <TabsTrigger key={key} value={key} data-board={key}>
                  {words(zh, en)}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
          <SiteLink className="btn" href="/account">
            {words("设置昵称 · 加入榜单", "Choose a nickname · Join")} →
          </SiteLink>
        </div>
        <div data-board-results aria-live="polite">
          {query.isError ? (
            <ErrorState retry={() => void query.refetch()} />
          ) : !query.data ? (
            <Loading />
          ) : !query.data.contributors.length ? (
            <div className="contributor-empty">
              <h3>
                {words("这张榜单，等你上榜", "Be the first on the board")}
              </h3>
              <p>
                {words(
                  "设置昵称并公开贡献后，已有的有效采集记录也会计入。",
                  "Choose a nickname and opt in. Your earlier contributions count too.",
                )}
              </p>
            </div>
          ) : (
            <>
              <div className="board-head">
                <span>#</span>
                <span>{words("采集者", "Contributor")}</span>
                <span>{words("摊位", "Shops")}</span>
                <span>{words("报价条目", "Offers")}</span>
              </div>
              <ol className="board-list">
                {query.data.contributors.map((row, index) => (
                  <li className="board-row" key={`${row.nickname}-${index}`}>
                    <span
                      className={"board-rank " + (index < 3 ? "podium" : "")}
                    >
                      {index + 1}
                    </span>
                    <span className="board-person">
                      <b>{row.nickname}</b>
                      <small>
                        {words(
                          `活跃 ${row.days} 天`,
                          `${row.days} active days`,
                        )}
                      </small>
                    </span>
                    <strong>{num(row.shops)}</strong>
                    <span>{num(row.quotes)}</span>
                  </li>
                ))}
              </ol>
            </>
          )}
        </div>
      </div>
    </Stall>
  );
}
