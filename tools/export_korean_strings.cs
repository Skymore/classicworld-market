// Read-only export of the Korean game names from the Classic World client:
//   export_korean_strings.exe <client Data dir> <out.json>
// The client ships Korean as a language pack, Data\Etc\Language\ko (ko.wz:
// String.img mirrors Data\String). Writes
// server/crates/market-web/src/i18n/ko-game.json:
//   items:     item id -> Korean name
//   item_desc: item id -> Korean description
//   names:     English name -> Korean name (items, monsters, maps, streets,
//              NPCs, skills), pairing the English and Korean value at the same
//              String path. CW monster ids in String.wz are its own short ids,
//              so the site matches monsters by English name.
// Entries the pack leaves in English (no Hangul) are skipped; the site falls
// back to English for them.
// Build (WzComparerR2 netfx, see tools/render_client_scenes.ps1):
//   csc -r:<WcR2>\Lib\WzComparerR2.WzLib.dll tools\export_korean_strings.cs
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using WzComparerR2.WzLib;

static class ExportKoreanStrings {
  static Wz_Node Open(string folder) {
    var s = new Wz_Structure(); Wz_Node n = null;
    s.LoadWzFolder(folder, ref n, false); s.WzNode = n; return n;
  }
  static Wz_Node Img(Wz_Node n) {
    var img = n.Value as Wz_Image; if (img == null) return n;
    return img.TryExtract() ? img.Node : n;
  }
  /// Every string value under a node, by its path ("Consume.img/2000000/name").
  static void Walk(Wz_Node n, string path, Dictionary<string, string> into) {
    n = Img(n);
    var s = n.Value as string;
    if (s != null) into[path] = s.Replace("\\r", "").Replace("\r", "").Trim();
    foreach (Wz_Node c in n.Nodes) Walk(c, path == "" ? c.Text : path + "/" + c.Text, into);
  }
  static bool Hangul(string s) { foreach (var c in s) if (c >= 0xAC00 && c <= 0xD7A3) return true; return false; }
  static string Esc(string s) {
    s = s.Replace("\\n", "\n");
    var b = new StringBuilder("\"");
    foreach (var c in s) {
      if (c == '"' || c == '\\') b.Append('\\').Append(c);
      else if (c == '\n') b.Append("\\n");
      else if (c < ' ') b.Append(' ');
      else b.Append(c);
    }
    return b.Append('"').ToString();
  }
  static readonly string[] ItemFiles = { "Cash.img", "Consume.img", "Eqp.img", "Etc.img", "Ins.img", "Pet.img" };
  static readonly string[] NameFields = { "name", "mapName", "streetName" };

  static void Main(string[] a) {
    var english = new Dictionary<string, string>(); var korean = new Dictionary<string, string>();
    Walk(Open(Path.Combine(a[0], "String")), "", english);
    var pack = Open(Path.Combine(a[0], "Etc", "Language", "ko"));
    var strings = pack.FindNodeByPath("String.img", true) ?? pack;
    Walk(strings, "", korean);
    var items = new SortedDictionary<int, string>(); var desc = new SortedDictionary<int, string>();
    var names = new SortedDictionary<string, string>(StringComparer.Ordinal);
    foreach (var kv in korean) {
      var parts = kv.Key.Split('/');
      if (parts.Length < 3 || !Hangul(kv.Value)) continue;
      var field = parts[parts.Length - 1]; int id;
      // Hair and faces (ids under 1000000) are not tradable items.
      if (ItemFiles.Contains(parts[0]) && int.TryParse(parts[parts.Length - 2], out id) && id >= 1000000) {
        if (field == "name") items[id] = kv.Value;
        else if (field == "desc") desc[id] = kv.Value;
      }
      if (parts[0] == "Skill.img" && field != "name") continue;
      if (!NameFields.Contains(field)) continue;
      string en;
      if (english.TryGetValue(kv.Key, out en) && en != "" && !Hangul(en) && !names.ContainsKey(en)) names[en] = kv.Value;
    }
    var o = new StringBuilder("{\n \"items\": {");
    o.Append(string.Join(",", items.Select(p => "\n  \"" + p.Key + "\": " + Esc(p.Value))));
    o.Append("\n },\n \"item_desc\": {");
    o.Append(string.Join(",", desc.Select(p => "\n  \"" + p.Key + "\": " + Esc(p.Value))));
    o.Append("\n },\n \"names\": {");
    o.Append(string.Join(",", names.Select(p => "\n  " + Esc(p.Key) + ": " + Esc(p.Value))));
    o.Append("\n }\n}\n");
    File.WriteAllText(a[1], o.ToString(), new UTF8Encoding(false));
    Console.WriteLine("items " + items.Count + ", descriptions " + desc.Count + ", names " + names.Count);
  }
}
