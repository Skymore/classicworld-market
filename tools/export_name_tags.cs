// Read-only export of the client's special name tags, for drawing store owners
// on the shop map:
//   export_name_tags.exe <client Data dir> <out file>
// Writes {"rings": {ring id: tag}, "tags": {tag: {"w","c","e": {"o": origin,
// "p": PNG data URI}, "clr": text ARGB}}}. A name tag ring (Character/Ring,
// info/nameTag) picks one of UI/NameTag.img's tags: a left cap (w), a middle
// piece tiled under the name (c) and a right cap (e).
// Build (WzComparerR2 netfx, see tools/render_client_scenes.ps1):
//   csc -r:<WcR2>\Lib\WzComparerR2.WzLib.dll tools\export_name_tags.cs
using System;
using System.Collections.Generic;
using System.Drawing.Imaging;
using System.IO;
using System.Text;
using WzComparerR2.WzLib;

static class ExportNameTags {
  static Wz_Node Img(Wz_Node n) {
    if (n == null) return null;
    var img = n.Value as Wz_Image; if (img == null) return n;
    return img.TryExtract() ? img.Node : null;
  }
  static Wz_Node Load(string data, string folder) {
    var s = new Wz_Structure(); Wz_Node root = null;
    s.LoadWzFolder(Path.Combine(data, folder), ref root, false); s.WzNode = root;
    return root;
  }
  // The picture of a part, following _outlink ("UI/_Canvas/NameTag.img/3/w").
  static Wz_Png Png(Wz_Node root, Wz_Node n) {
    var link = n.Nodes["_outlink"];
    if (link != null) {
      var path = ((string)link.Value).Split('/');
      Wz_Node t = root;
      for (int i = 1; i < path.Length && t != null; i++) t = Img(t).Nodes[path[i]];
      if (t != null && t.Value is Wz_Png) return (Wz_Png)t.Value;
    }
    return n.Value as Wz_Png;
  }
  static string Part(Wz_Node root, Wz_Node n) {
    var png = n == null ? null : Png(root, n);
    if (png == null) return null;
    string data;
    using (var bmp = png.ExtractPng()) using (var ms = new MemoryStream()) {
      bmp.Save(ms, ImageFormat.Png);
      data = Convert.ToBase64String(ms.ToArray());
    }
    var o = n.Nodes["origin"] == null ? null : n.Nodes["origin"].Value as Wz_Vector;
    return "{\"o\":[" + (o == null ? 0 : o.X) + "," + (o == null ? 0 : o.Y) + "],\"w\":" + png.Width + ",\"h\":" + png.Height +
      ",\"p\":\"data:image/png;base64," + data + "\"}";
  }
  static void Main(string[] a) {
    var character = Load(a[0], "Character");
    var rings = new List<string>();
    var used = new HashSet<string>();
    foreach (Wz_Node n in character.Nodes["Ring"].Nodes) {
      if (!n.Text.EndsWith(".img")) continue;
      int id; if (!int.TryParse(n.Text.Substring(0, n.Text.Length - 4), out id)) continue;
      var info = Img(n) == null ? null : Img(n).Nodes["info"];
      var tag = info == null ? null : info.Nodes["nameTag"];
      if (tag == null) continue;
      rings.Add("\"" + id + "\":" + tag.Value);
      used.Add(tag.Value.ToString());
    }
    var ui = Load(a[0], "UI");
    var tags = new List<string>();
    var names = Img(ui.FindNodeByPath("NameTag.img", true));
    foreach (Wz_Node t in names.Nodes) {
      if (!used.Contains(t.Text)) continue;
      var parts = new List<string>();
      foreach (var key in new[] { "w", "c", "e" }) {
        var p = Part(ui, t.Nodes[key]);
        if (p != null) parts.Add("\"" + key + "\":" + p);
      }
      var clr = t.Nodes["clr"];
      parts.Add("\"clr\":" + (clr == null ? "-1" : clr.Value.ToString()));
      tags.Add("\"" + t.Text + "\":{" + string.Join(",", parts) + "}");
    }
    File.WriteAllText(a[1], "{\"rings\":{" + string.Join(",", rings) + "},\"tags\":{" + string.Join(",", tags) + "}}", new UTF8Encoding(false));
    Console.WriteLine(rings.Count + " rings, " + tags.Count + " tags");
  }
}
