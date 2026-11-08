/* Draws a character the way the game does, from its look (as the map-entry
   packet carries it: gender, skin, face, hair, visible equips by slot, cash
   weapon) and the client's part pictures exported by
   tools/export_avatar_parts.cs into /web/images/avatar/. Each part is placed
   so its anchors (navel, neck, brow, hand) meet the same anchors of the parts
   already placed, starting from the body at the character's feet, and drawn
   in the client's layer order; parts whose slots another item covers (hair
   under a hat, pants under an overall) are left out. */

export type Look = {
  gender?: number;
  skin: number;
  face: number;
  hair: number;
  /** Visible equips by slot (1 cap ... 11 weapon). */
  equips: Record<string, number>;
  cash_weapon?: number;
};

type Part = { z: string; o: [number, number]; m: Record<string, [number, number]>; p: string };
type Frames = Partial<Record<"stand1" | "stand2" | "default", Part[]>>;
type Item = { i?: string; v?: string; f?: Frames; t?: Record<string, Frames> };
type ZMap = { order: string[]; slots: Record<string, string> };

const BASE = "/web/images/avatar/";
const files = new Map<string, Promise<any>>();
const load = (name: string) => {
  if (!files.has(name))
    files.set(
      name,
      fetch(BASE + name + ".json")
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    );
  return files.get(name)!;
};
const images = new Map<string, Promise<HTMLImageElement>>();
const picture = (src: string) => {
  if (!images.has(src))
    images.set(
      src,
      new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
      }),
    );
  return images.get(src)!;
};
const codes = (s?: string) => (s ? s.match(/../g) || [] : []);

export type Drawn = { url: string; left: number; top: number; width: number; height: number };
const drawn = new Map<string, Promise<Drawn | null>>();

/** The character as a picture, with its box relative to the feet (world pixels). */
export function drawLook(look: Look): Promise<Drawn | null> {
  const key = JSON.stringify(look);
  if (!drawn.has(key)) drawn.set(key, compose(look).catch(() => null));
  return drawn.get(key)!;
}

async function compose(look: Look): Promise<Drawn | null> {
  const equips = Object.entries(look.equips || {}).map(([slot, id]) => [Number(slot), Number(id)] as const);
  const weaponId = equips.find(([slot]) => slot === 11)?.[1];
  const [zmap, body, hair, face, ...items] = await Promise.all([
    load("zmap") as Promise<ZMap | null>,
    load("body-" + (look.skin || 0)) as Promise<Item | null>,
    load(String(look.hair)) as Promise<Item | null>,
    load(String(look.face)) as Promise<Item | null>,
    ...equips.filter(([slot]) => slot !== 11).map(([, id]) => load(String(id)) as Promise<Item | null>),
  ]);
  if (!zmap || !body) return null;
  // The weapon decides the stance; a cash weapon lends its look for the real weapon's type.
  let weapon: Frames | undefined;
  let weaponSlots: Item | null = null;
  if (weaponId) {
    weaponSlots = (await load(String(weaponId))) as Item | null;
    weapon = weaponSlots?.f;
    if (look.cash_weapon) {
      const cash = (await load(String(look.cash_weapon))) as Item | null;
      const type = String(Math.floor(weaponId / 10000) % 100);
      if (cash?.t?.[type]) weapon = cash.t[type];
    }
  }
  const stance: "stand1" | "stand2" = weapon && !weapon.stand1 && weapon.stand2 ? "stand2" : "stand1";
  const frame = (f?: Frames) => (f ? f[stance] || f.stand1 || f.stand2 || f.default || [] : []);
  const owners: { item: Item | null; parts: Part[] }[] = [
    { item: body, parts: frame(body.f) },
    { item: face, parts: frame(face?.f) },
    { item: hair, parts: frame(hair?.f) },
    ...items.map((item) => ({ item, parts: frame(item?.f) })),
    ...(weapon ? [{ item: weaponSlots, parts: frame(weapon) }] : []),
  ];
  // A part is hidden when every slot of its layer is claimed by another item.
  const claims = owners.map((o) => new Set(codes(o.item?.v)));
  const visible: Part[] = [];
  owners.forEach((owner, index) =>
    owner.parts.forEach((part) => {
      const need = codes(zmap.slots[part.z]);
      const covered =
        need.length > 0 && need.every((code) => claims.some((claim, other) => other !== index && claim.has(code)));
      if (!covered) visible.push(part);
    }),
  );
  // Place: body first at the feet, then each part by an anchor already known.
  const anchors: Record<string, [number, number]> = {};
  const placed = new Map<Part, [number, number]>();
  let pending = visible.slice();
  for (let round = 0; round < 6 && pending.length; round++) {
    pending = pending.filter((part) => {
      const keys = Object.keys(part.m);
      let at: [number, number] | null = null;
      if (!keys.length || (round === 0 && part === visible[0])) at = [0, 0];
      else {
        const known = keys.find((k) => anchors[k]);
        if (known) at = [anchors[known][0] - part.m[known][0], anchors[known][1] - part.m[known][1]];
      }
      if (!at) return true;
      placed.set(part, at);
      for (const k of keys) anchors[k] ??= [at[0] + part.m[k][0], at[1] + part.m[k][1]];
      return false;
    });
  }
  const rank = (z: string) => {
    const i = zmap.order.indexOf(z);
    return i < 0 ? zmap.order.indexOf("body") : i;
  };
  const list = [...placed.entries()].sort((a, b) => rank(b[0].z) - rank(a[0].z));
  const pics = await Promise.all(list.map(([part]) => picture(part.p)));
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  list.forEach(([part, at], i) => {
    const x = at[0] - part.o[0], y = at[1] - part.o[1];
    minX = Math.min(minX, x); minY = Math.min(minY, y);
    maxX = Math.max(maxX, x + pics[i].width); maxY = Math.max(maxY, y + pics[i].height);
  });
  if (!list.length) return null;
  const canvas = document.createElement("canvas");
  canvas.width = maxX - minX;
  canvas.height = maxY - minY;
  const ctx = canvas.getContext("2d")!;
  list.forEach(([part, at], i) => ctx.drawImage(pics[i], at[0] - part.o[0] - minX, at[1] - part.o[1] - minY));
  return { url: canvas.toDataURL(), left: minX, top: minY, width: canvas.width, height: canvas.height };
}

/* A name tag ring (Character/Ring, info/nameTag) picks one of the client's
   special name tags: a left cap, a middle piece tiled under the name and a
   right cap, each placed by its origin from the name's top-left corner, and
   the text colour. Exported by tools/export_name_tags.cs. Rings whose tag the
   client lacks, and owners without such a ring, keep the plain tag. */
export type TagPart = { o: [number, number]; w: number; h: number; p: string };
export type NameTag = { w: TagPart; c: TagPart; e: TagPart; clr: number };
type NameTags = { rings: Record<string, number>; tags: Record<string, NameTag> };

export async function nameTagOf(look: Look): Promise<NameTag | null> {
  const ring = Object.values(look.equips || {}).find((id) => Math.floor(Number(id) / 10000) === 111);
  if (ring == null) return null;
  const data = (await load("nametag")) as NameTags | null;
  const tag = data?.tags[String(data.rings[String(ring)])];
  return tag?.w && tag.c && tag.e ? tag : null;
}
