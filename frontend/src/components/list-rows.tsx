import { useState } from "react";
import { Store, UserRound } from "lucide-react";
import { useWords } from "../providers";
import { Slot, ItemNames, Price, RelativeTime } from "./shared";
import { SiteLink } from "./shell";
import { t } from "/web/js/lib/i18n.js";
import { equipmentSummary } from "/web/js/lib/equipment-summary.js?v=20261024-records-3";
import { priceUnit } from "/web/js/lib/market-source.js?v=20261022-external-1";

export function Location({
  value,
  shop,
  owner,
}: {
  value?: any;
  shop?: string | null;
  owner?: string | null;
}) {
  const words = useWords();
  const [showOwner, setShowOwner] = useState(false);
  const channel = value?.channel;
  const room = value?.room;
  const channelLabel = words(
    channel == null ? "频道 —" : `${channel}频道`,
    channel == null ? "CH —" : "CH " + channel,
  );
  const roomLabel = words(
    room == null ? "洞 —" : `${room}洞`,
    room == null ? "FM —" : "FM" + room,
  );
  const label =
    room != null
      ? roomLabel
      : value?.text ||
        (document.documentElement.lang === "en"
          ? value?.map_name_en
          : value?.map_name_zh) ||
        words("洞未记录", "FM not recorded");
  if (shop !== undefined)
    return (
      <span
        className="loc loc-shop"
        title={[
          channelLabel,
          label,
          shop || "—",
        ].join(" · ")}
      >
        <b>{channelLabel}</b>
        <span className="loc-room">{roomLabel}</span>
        {owner ? (
          <button type="button" className="record-shop shop-name-toggle"
            aria-pressed={showOwner}
            aria-label={showOwner ? words("显示店铺名", "Show shop name") : words("显示玩家名", "Show player name")}
            title={showOwner ? words("人物名", "Player name") : words("店铺名", "Shop name")}
            onClick={(event) => { event.preventDefault(); event.stopPropagation(); setShowOwner(!showOwner); }}>
            {showOwner ? <UserRound aria-hidden="true" /> : <Store aria-hidden="true" />}
            <span className="record-shop-text">{showOwner ? owner : shop || "—"}</span>
          </button>
        ) : <span className="record-shop" title={shop || undefined}><Store aria-hidden="true" /><span className="record-shop-text">{shop || "—"}</span></span>}

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
      <b>{channelLabel}</b>
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
                    title={
                      row.kind
                        ? t("evidence." + row.kind) +
                          (row.merged_count > 1
                            ? words(
                                ` · 同店 ${row.merged_count} 格合计`,
                                ` · ${row.merged_count} slots in one shop`,
                              )
                            : "")
                        : undefined
                    }
                    data-merged-sales={row.merged_count > 1 ? row.merged_count : undefined}
                  >
                    {status}
                    {row.quantity != null
                      ? ` ×${row.quantity}`
                      : row.merged_count > 1 &&
                        words(` ${row.merged_count} 格`, ` ${row.merged_count} slots`)}
                  </span>
                ) : undefined
              }
            />
          </span>
        )}
        <span className="record-meta">
          <Location value={row.location} shop={row.shop || null} owner={row.owner_name} />
          {row.invalidated_at && <span className="quote-expired" title={new Date(row.invalidated_at).toLocaleString()}>{words("已失效", "Expired")}</span>}
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
        {!(sale && !Number.isFinite(row.stock)) && (
          <span className="record-stock" title={row.merged_count > 1 ? words(`${row.merged_count} 条同店报价的库存合计`, `Combined stock of ${row.merged_count} offers in this shop`) : undefined}>
            {row.invalidated_at ? words("当时库存", "Previous stock") : words("库存", "Stock")} {row.stock ?? "—"}
          </span>
        )}
      </span>
    </>
  );
  const props = {
    className: "ware market-record" + (hideIdentity ? " variant-record" : "") + (row.invalidated_at ? " expired-record" : ""),
    "data-item-row": "",
    "data-id": row.id,
    "data-record-kind": sale ? "sale" : "quote",
    title: row.shop || undefined,
  };
  return plain ? (
    <span {...props}>{content}</span>
  ) : (
    <span {...props}>
      {content}
      <SiteLink className="record-open" href={href || "/item/" + Number(row.item_id)}>
        <span className="sr">{words("查看物品", "View item")} {row.name_zh || row.name_en || row.item_id}</span>
      </SiteLink>
    </span>
  );
}
