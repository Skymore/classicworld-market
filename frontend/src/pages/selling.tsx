import { useWords } from "../providers";
import { usePageReady } from "../components/shared";
import { SiteLink } from "../components/shell";
export default function Selling() {
  usePageReady();
  const words = useWords();
  return (
    <section className="stall">
      <div className="stall-bar">
        <h1>{words("背包／摆摊", "Bag & shop")}</h1>
      </div>
      <div className="selling-body">
        <p>
          {words(
            "此功能尚未完成，已暂时停用。已保存的背包数据未删除。",
            "This unfinished feature is temporarily disabled. Your saved inventory has not been deleted.",
          )}
        </p>
        <SiteLink className="btn" href="/">
          {words("返回价格表", "Back to prices")}
        </SiteLink>
      </div>
    </section>
  );
}
