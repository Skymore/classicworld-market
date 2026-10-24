import { useWords } from "../providers";
import { Slot, ItemNames, Price, RelativeTime } from "./shared";
import { SiteLink } from "./shell";
import { t } from "/web/js/lib/i18n.js";
import { equipmentSummary } from "/web/js/lib/equipment-summary.js?v=20261024-records-2";
import { priceUnit } from "/web/js/lib/market-source.js?v=20261022-external-1";

export function Location({ value }: { value?: any }) {
  const words = useWords();
  const channel = value?.channel;
  const room = value?.room;
  const label =
    room != null
      ? words(`${room}洞`, `Room ${room}`)
      : value?.text ||
        (document.documentElement.lang === "en"
          ? value?.map_name_en
          : value?.map_name_zh) ||
        words("洞号未记录", "Room not recorded");
  return channel == null ? (
    <span className="loc unk">
      {room != null || value?.text
        ? label
        : words("位置未知", "Unknown location")}
    </span>
  ) : (
    <span className="loc" title={label}>
      <b>CH {channel}</b>
      <span>{label}</span>
    </span>
  );
}

/** One observation per row: location, time, price and stock share the same source. */
export function OfferRow({
  row,
  item,
  sale = false,
  href,
}: {
  row: any;
  item?: any;
  sale?: boolean;
  href?: string;
}) {
  const words = useWords();
  const equip = equipmentSummary(row, document.documentElement.lang === "en");
  const status =
    row.kind === "sold_out"
      ? words("卖光", "Sold out")
      : row.kind === "drop"
        ? words("卖出", "Sold")
        : words("已售", "Sold");
  return (
    <SiteLink
      className="ware market-record"
      href={href || "/item/" + Number(row.item_id)}
      data-item-row
      data-id={row.id}
      data-record-kind={sale ? "sale" : "quote"}
      title={row.shop || undefined}
    >
      <Slot url={row.icon_url || item?.icon_url} />
      <span className="w-main">
        <span className="ware-name">
          <ItemNames
            row={{ ...item, ...row }}
            suffix={
              sale ? (
                <span
                  className={"evi " + (row.kind || "")}
                  title={row.kind ? t("evidence." + row.kind) : undefined}
                >
                  {status}
                  {row.quantity != null && ` ×${row.quantity}`}
                </span>
              ) : undefined
            }
          />
        </span>
        <span className="record-meta">
          <Location value={row.location} />
          {row.shop && (
            <span className="record-shop" title={row.shop}>
              {row.shop}
            </span>
          )}
          {row.bundle > 1 && (
            <span className="record-bundle">
              {words(`每组 ${row.bundle} 件`, `${row.bundle} per bundle`)}
            </span>
          )}
        </span>
        {equip && <span className="offer-equipment">{equip}</span>}
      </span>
      <span className="record-value">
        <span className="record-time">
          <RelativeTime at={sale ? row.time : row.observed} />
        </span>
        <span className="ware-price">
          <Price value={sale ? row.sale_unit_price : row.unit_price} />
          <span dangerouslySetInnerHTML={{ __html: priceUnit(row) }} />
        </span>
        <span className="record-stock">
          {words("库存", "Stock")} {row.stock ?? "—"}
        </span>
      </span>
    </SiteLink>
  );
}
