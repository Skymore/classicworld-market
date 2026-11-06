// Read-only export of the game tooltip data of non-equipment items (use, etc,
// set-up and cash) from the Classic World client:
//   export_item_tips.exe <client Data dir> <out.json>
// Writes server/crates/market-web/src/bestiary/item-tips.json: per item the
// English name and description (String.wz) and the scalar fields of
// Item.wz `info` and `spec` (success rate, stats, recovery, duration, stack
// size, trade flags...). Pictures, scripts and layout fields are left out.
// Build (WzComparerR2 netfx, see tools/render_client_scenes.ps1):
//   csc -r:<WcR2>\Lib\WzComparerR2.WzLib.dll tools\export_item_tips.cs
using System;
using System.Collections.Generic;
using System.IO;
using System.Text;
using WzComparerR2.WzLib;

static class ExportItemTips {
  static readonly HashSet<string> Skip = new HashSet<string> {
    "icon", "iconRaw", "width", "height", "path", "script", "npc", "npcID", "z",
    "floatType", "stateChangeItem", "BuffSkillID", "mobID", "tamingMob", "bagType",
  };
  static Wz_Node Open(string root, string folder) {
    var s = new Wz_Structure(); Wz_Node n = null;
    s.LoadWzFolder(Path.Combine(root, folder), ref n, false); s.WzNode = n; return n;
  }
  static Wz_Node Img(Wz_Node n) {
    var img = n.Value as Wz_Image; if (img == null) return n;
    return img.TryExtract() ? img.Node : null;
  }
  static string Esc(string s) {
    // WZ strings write line breaks as a literal backslash-n.
    s = s.Replace("\\n", "\n").Replace("\\r", "");
    var b = new StringBuilder("\"");
    foreach (var c in s) {
      if (c == '"' || c == '\\') b.Append('\\').Append(c);
      else if (c == '\n') b.Append("\\n");
      else if (c == '\r') { }
      else if (c < ' ') b.Append(' ');
      else b.Append(c);
    }
    return b.Append('"').ToString();
  }
  static string Scalar(object v) {
    if (v is int || v is long || v is short) return v.ToString();
    if (v is float || v is double) return Convert.ToDouble(v).ToString(System.Globalization.CultureInfo.InvariantCulture);
    if (v is string) { long l; return long.TryParse((string)v, out l) ? l.ToString() : Esc((string)v); }
    return null;
  }
  // Scalars of a node (one level): no pictures, nested nodes or skipped keys.
  static string Fields(Wz_Node n) {
    var parts = new List<string>();
    foreach (Wz_Node c in n.Nodes) {
      int numeric; if (Skip.Contains(c.Text) || int.TryParse(c.Text, out numeric)) continue;
      var s = Scalar(c.Value);
      if (s != null) parts.Add(Esc(c.Text) + ":" + s);
    }
    return parts.Count == 0 ? null : "{" + string.Join(",", parts) + "}";
  }
  static void Main(string[] a) {
    var strings = Open(a[0], "String");
    var names = new Dictionary<int, string[]>();
    foreach (var file in new[] { "Consume.img", "Etc.img", "Ins.img", "Cash.img" }) {
      var img = Img(strings.FindNodeByPath(file, true)); if (img == null) continue;
      var nodes = new List<Wz_Node>();
      // Etc.img nests its items one level down (Etc/<id>).
      foreach (Wz_Node c in img.Nodes) { int t; if (int.TryParse(c.Text, out t)) nodes.Add(c); else foreach (Wz_Node d in c.Nodes) nodes.Add(d); }
      foreach (var c in nodes) {
        int id; if (!int.TryParse(c.Text, out id)) continue;
        var name = c.Nodes["name"]; var desc = c.Nodes["desc"];
        names[id] = new[] { name == null ? null : name.Value as string, desc == null ? null : desc.Value as string };
      }
    }
    var items = Open(a[0], "Item");
    var output = new List<string>();
    foreach (var folder in new[] { "Consume", "Etc", "Install", "Cash" }) {
      var f = items.Nodes[folder]; if (f == null) continue;
      foreach (Wz_Node imgNode in f.Nodes) {
        if (!imgNode.Text.EndsWith(".img")) continue;
        var img = Img(imgNode); if (img == null) continue;
        foreach (Wz_Node item in img.Nodes) {
          int id; if (!int.TryParse(item.Text, out id)) continue;
          var parts = new List<string> { "\"id\":" + id };
          string[] s; if (names.TryGetValue(id, out s)) {
            if (!string.IsNullOrEmpty(s[0])) parts.Add("\"name\":" + Esc(s[0]));
            if (!string.IsNullOrEmpty(s[1])) parts.Add("\"desc\":" + Esc(s[1]));
          }
          var info = item.Nodes["info"] == null ? null : Fields(item.Nodes["info"]);
          if (info != null) parts.Add("\"info\":" + info);
          var spec = item.Nodes["spec"] == null ? null : Fields(item.Nodes["spec"]);
          if (spec != null) parts.Add("\"spec\":" + spec);
          output.Add("{" + string.Join(",", parts) + "}");
        }
      }
    }
    output.Sort(string.CompareOrdinal);
    File.WriteAllText(a[1], "[\n" + string.Join(",\n", output) + "\n]\n", new UTF8Encoding(false));
    Console.WriteLine(output.Count + " items");
  }
}
