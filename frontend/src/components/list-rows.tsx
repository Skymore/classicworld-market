import { useWords } from "../providers";
import { Slot, ItemNames, Price, RelativeTime } from "./shared";
import { SiteLink } from "./shell";
import { t } from "/web/js/lib/i18n.js";
import { equipmentSummary } from "/web/js/lib/equipment-summary.js?v=20261024-records-3";
import { priceUnit } from "/web/js/lib/market-source.js?v=20261022-external-1";

export function Location({
  value,
  shop,
}: {
  value?: any;
  shop?: string | null;
}) {
  const words = useWords();
  const channel = value?.channel;
  const room = value?.room;
  const label =
    room != null
      ? `FM${room}`
      : value?.text ||
        (document.documentElement.lang === "en"
          ? value?.map_name_en
          : value?.map_name_zh) ||
        words("FM 未记录", "FM not recorded");
  if (shop !== undefined)
    return (
      <span
        className="loc loc-shop"
        title={[
          channel == null ? "CH —" : "CH " + channel,
          room == null ? label : "FM" + room,
          shop || "—",
        ].join(" · ")}
      >
        <b>{channel == null ? "CH —" : "CH " + channel}</b>
        <span className="loc-room">{room == null ? "FM —" : "FM" + room}</span>
        <span className="record-shop" title={shop || undefined}>
          {shop || "—"}
        </span>
      </span>
    );
  return channel == null ? (
    <span className="loc unk">
      {room != null || value?.text
        ? label
        : words("位置未知", "Unknown location")}
    </span>
  ) : (
    <span className="loc" title={label}>
      <b>CH {channel}</b>
      <span className="loc-room">{label}</span>
    </span>
  );
}

/** One observation per row: location, time, price and stock share the same source. */
export function OfferRow({
  row,
  item,
  sale = false,
  href,
  hideIdentity = false,
  plain = false,
}: {
  row: any;
  item?: any;
  sale?: boolean;
  href?: string;
  hideIdentity?: boolean;
  plain?: boolean;
}) {
  const words = useWords();
  const equip = equipmentSummary(row, document.documentElement.lang === "en");
  const status =
    row.kind === "sold_out"
      ? words("卖光", "Sold out")
      : row.kind === "drop"
        ? words("卖出", "Sold")
        : words("已售", "Sold");
  const content = (
    <>
      {!hideIdentity && <Slot url={row.icon_url || item?.icon_url} />}
      <span className="w-main">
        {!hideIdentity && (
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
        )}
        <span className="record-meta">
          <Location value={row.location} shop={row.shop || null} />
          {row.bundle > 1 && (
            <span className="record-bundle">
              {words(`每组 ${row.bundle} 件`, `${row.bundle} per bundle`)}
            </span>
          )}
        </span>
        {hideIdentity ? (
          <span className="record-detail">
            <span className="record-time">
              <RelativeTime at={sale ? row.time : row.observed} />
            </span>
            {equip && (
              <span className="offer-equipment" title={equip}>
                {equip}
              </span>
            )}
          </span>
        ) : (
          equip && (
            <span className="offer-equipment" title={equip}>
              {equip}
            </span>
          )
        )}
      </span>
      <span className="record-value">
        {!hideIdentity && (
          <span className="record-time">
            <RelativeTime at={sale ? row.time : row.observed} />
          </span>
        )}
        <span className="ware-price">
          <Price value={sale ? row.sale_unit_price : row.unit_price} />
          <span dangerouslySetInnerHTML={{ __html: priceUnit(row) }} />
        </span>
        <span className="record-stock">
          {words("库存", "Stock")} {row.stock ?? "—"}
        </span>
      </span>
    </>
  );
  const props = {
    className: "ware market-record" + (hideIdentity ? " variant-record" : ""),
    "data-item-row": "",
    "data-id": row.id,
    "data-record-kind": sale ? "sale" : "quote",
    title: row.shop || undefined,
  };
  return plain ? (
    <span {...props}>{content}</span>
  ) : (
    <SiteLink {...props} href={href || "/item/" + Number(row.item_id)}>
      {content}
    </SiteLink>
  );
}
