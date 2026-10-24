import { useWords } from "../providers";
import { Slot, ItemNames, Price, RelativeTime } from "./shared";
import { t } from "/web/js/lib/i18n.js";
import { equipmentSummary } from "/web/js/lib/equipment-summary.js?v=20261022-1";
import { priceUnit } from "/web/js/lib/market-source.js?v=20261022-external-1";
export function Location({ value }: { value?: any }) {
  const words = useWords();
  return (
    <span className="loc">
      {value?.channel
        ? words(`${value.channel}频道`, `CH ${value.channel}`)
        : words("位置未知", "Unknown location")}
      {value?.room != null &&
        words(`／${value.room}洞`, ` / Room ${value.room}`)}
      {value?.text && ` · ${value.text}`}
    </span>
  );
}
export function OfferRow({
  row,
  item,
  sale = false,
}: {
  row: any;
  item?: any;
  sale?: boolean;
}) {
  const words = useWords();
  const equip = equipmentSummary(row, document.documentElement.lang === "en");
  return (
    <a
      className={"ware srow" + (sale ? "" : " wrow")}
      href={"/item/" + Number(row.item_id)}
      data-item-row
      data-id={row.id}
    >
      <Slot url={row.icon_url || item?.icon_url} />
      <span className="w-main">
        <span className="ware-name">
          <ItemNames row={{ ...item, ...row }} />
          {equip && <span className="offer-equipment">{equip}</span>}
        </span>
        <span className="w-sub">
          {sale ? (
            <span className={"evi " + row.kind}>
              {t("evidence." + row.kind)}
            </span>
          ) : (
            <span className="ss">{row.shop}</span>
          )}
          <Location value={row.location} />
        </span>
      </span>
      <span className="s-right">
        <span className="ware-price">
          <Price value={sale ? row.sale_unit_price : row.unit_price} />
          {sale && (
            <span dangerouslySetInnerHTML={{ __html: priceUnit(row) }} />
          )}
          <span className="sq">
            {sale
              ? row.quantity != null && `×${row.quantity}`
              : [
                  row.bundle > 1
                    ? words(`${row.bundle} 件一组`, `${row.bundle} per bundle`)
                    : "",
                  words(`库存 ${row.stock}`, `stock ${row.stock}`),
                ]
                  .filter(Boolean)
                  .join(" · ")}
          </span>
        </span>
        <RelativeTime at={sale ? row.time : row.observed} />
      </span>
    </a>
  );
}
