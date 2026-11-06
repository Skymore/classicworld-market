// Read-only export of the standing frame of every character part from the
// Classic World client, for drawing store owners on the shop map:
//   export_avatar_parts.exe <client Data dir> <out dir>
// Writes <out>/<item id>.json per equip, hair and face, body-<skin>.json per
// skin, and zmap.json (layer order front to back, layer -> slot codes).
// Each part: z layer, origin, map anchors (navel, neck, brow, hand...) and the
// picture as a PNG data URI. Frames: stand1/0 and stand2/0 (equips, body),
// default (hair, face, and caps that only have it). Cash weapons keep one
// look per weapon type ("t": {type: frames}).
// Build (WzComparerR2 netfx, see tools/render_client_scenes.ps1):
//   csc -r:<WcR2>\Lib\WzComparerR2.WzLib.dll tools\export_avatar_parts.cs
using System;
using System.Collections.Generic;
using System.Drawing.Imaging;
using System.IO;
using System.Text;
using WzComparerR2.WzLib;

static class ExportAvatarParts {
  static Wz_Node character;

  static Wz_Node Img(Wz_Node n) {
    if (n == null) return null;
    var img = n.Value as Wz_Image; if (img == null) return n;
    return img.TryExtract() ? img.Node : null;
  }
  static string Esc(string s) {
    var b = new StringBuilder("\"");
    foreach (var c in s) { if (c == '"' || c == '\\') b.Append('\\'); b.Append(c); }
    return b.Append('"').ToString();
  }
  // Follows UOL nodes ("../../front/head") inside an image.
  static Wz_Node Resolve(Wz_Node n) {
    for (int i = 0; i < 8 && n != null && n.Value is Wz_Uol; i++) {
      var target = n.ParentNode;
      foreach (var part in ((Wz_Uol)n.Value).Uol.Split('/')) {
        if (target == null) break;
        target = part == ".." ? target.ParentNode : target.Nodes[part];
      }
      n = target;
    }
    return n;
  }
  // The picture of a part, following _outlink into Character/_Canvas.
  static Wz_Png Png(Wz_Node n) {
    var link = n.Nodes["_outlink"];
    if (link != null) {
      var path = ((string)link.Value).Split('/');
      Wz_Node t = character;
      for (int i = 1; i < path.Length && t != null; i++) { t = Img(t).Nodes[path[i]]; }
      if (t != null && t.Value is Wz_Png) return (Wz_Png)t.Value;
    }
    return n.Value as Wz_Png;
  }
  static string Vec(Wz_Node n) {
    var v = n == null ? null : n.Value as Wz_Vector;
    return v == null ? "[0,0]" : "[" + v.X + "," + v.Y + "]";
  }
  static string Part(Wz_Node n) {
    n = Resolve(n);
    if (n == null) return null;
    var png = Png(n);
    var z = n.Nodes["z"];
    if (png == null || png.Width <= 1 || z == null) return null;
    string data;
    using (var bmp = png.ExtractPng()) using (var ms = new MemoryStream()) {
      bmp.Save(ms, ImageFormat.Png);
      data = Convert.ToBase64String(ms.ToArray());
    }
    var maps = new List<string>();
    var map = n.Nodes["map"];
    if (map != null) foreach (Wz_Node m in map.Nodes) maps.Add(Esc(m.Text) + ":" + Vec(m));
    return "{\"z\":" + Esc(z.Value.ToString()) + ",\"o\":" + Vec(n.Nodes["origin"]) +
      ",\"m\":{" + string.Join(",", maps) + "},\"p\":\"data:image/png;base64," + data + "\"}";
  }
  static readonly HashSet<string> SkipParts = new HashSet<string> { "hairShade", "ear", "lefEar", "highlefEar", "humanEar" };
  // The parts of one frame node (e.g. stand1/0 or default).
  static string Frame(Wz_Node frame) {
    frame = Resolve(frame);
    if (frame == null) return null;
    var parts = new List<string>();
    foreach (Wz_Node c in frame.Nodes) {
      if (SkipParts.Contains(c.Text) || c.Text == "delay" || c.Text == "face" && c.Value is int) continue;
      var p = Part(c);
      if (p != null) parts.Add(p);
    }
    return parts.Count == 0 ? null : "[" + string.Join(",", parts) + "]";
  }
  static string Frames(Wz_Node root) {
    var frames = new List<string>();
    // Hair, faces and caps look the same in every stance: keep default only.
    if (root.Nodes["default"] != null) {
      var d = Frame(root.Nodes["default"]);
      if (d != null) return "{\"default\":" + d + "}";
    }
    foreach (var name in new[] { "stand1", "stand2" }) {
      var f = root.Nodes[name] == null ? null : Frame(root.Nodes[name].Nodes["0"]);
      if (f != null) frames.Add(Esc(name) + ":" + f);
    }
    return frames.Count == 0 ? null : "{" + string.Join(",", frames) + "}";
  }
  static void Main(string[] a) {
    var s = new Wz_Structure(); Wz_Node root = null;
    s.LoadWzFolder(Path.Combine(a[0], "Character"), ref root, false); s.WzNode = root;
    character = root;
    Directory.CreateDirectory(a[1]);
    int count = 0;
    // Body and head per skin.
    foreach (Wz_Node n in root.Nodes) {
      if (!n.Text.StartsWith("0000200") || !n.Text.EndsWith(".img")) continue;
      var skin = int.Parse(n.Text.Substring(0, 8)) - 2000;
      var body = Img(n); var head = Img(root.Nodes[(12000 + skin).ToString("D8") + ".img"]);
      if (body == null || head == null) continue;
      var frames = new List<string>();
      foreach (var name in new[] { "stand1", "stand2" }) {
        var b = Frame(body.Nodes[name].Nodes["0"]); var h = Frame(head.Nodes[name].Nodes["0"]);
        if (b != null && h != null) frames.Add(Esc(name) + ":" + b.TrimEnd(']') + "," + h.TrimStart('['));
      }
      File.WriteAllText(Path.Combine(a[1], "body-" + skin + ".json"), "{\"f\":{" + string.Join(",", frames) + "}}", new UTF8Encoding(false));
      count++;
    }
    foreach (var folder in new[] { "Hair", "Face", "Cap", "Accessory", "Cape", "Coat", "Longcoat", "Pants", "Shoes", "Glove", "Shield", "Weapon" }) {
      var f = root.Nodes[folder]; if (f == null) continue;
      foreach (Wz_Node n in f.Nodes) {
        if (!n.Text.EndsWith(".img")) continue;
        int id; if (!int.TryParse(n.Text.Substring(0, n.Text.Length - 4), out id)) continue;
        var img = Img(n); if (img == null) continue;
        var info = img.Nodes["info"];
        var head = new List<string>();
        if (info != null) {
          if (info.Nodes["islot"] != null) head.Add("\"i\":" + Esc(info.Nodes["islot"].Value.ToString()));
          if (info.Nodes["vslot"] != null) head.Add("\"v\":" + Esc(info.Nodes["vslot"].Value.ToString()));
        }
        var frames = Frames(img);
        if (frames != null) head.Add("\"f\":" + frames);
        // Cash weapons: one look per weapon type, under nodes named by type.
        var types = new List<string>();
        foreach (Wz_Node t in img.Nodes) {
          int type; if (!int.TryParse(t.Text, out type)) continue;
          var tf = Frames(t); if (tf != null) types.Add(Esc(t.Text) + ":" + tf);
        }
        if (types.Count > 0) head.Add("\"t\":{" + string.Join(",", types) + "}");
        if (frames == null && types.Count == 0) continue;
        File.WriteAllText(Path.Combine(a[1], id + ".json"), "{" + string.Join(",", head) + "}", new UTF8Encoding(false));
        count++;
      }
    }
    // Layer order and slot codes.
    var bs = new Wz_Structure(); Wz_Node broot = null;
    bs.LoadWzFolder(Path.Combine(a[0], "Base"), ref broot, false); bs.WzNode = broot;
    var zmap = Img(broot.FindNodeByPath("zmap.img", true)); var smap = Img(broot.FindNodeByPath("smap.img", true));
    var order = new List<string>(); foreach (Wz_Node z in zmap.Nodes) order.Add(Esc(z.Text));
    var slots = new List<string>(); foreach (Wz_Node z in smap.Nodes) if (z.Value != null) slots.Add(Esc(z.Text) + ":" + Esc(z.Value.ToString()));
    File.WriteAllText(Path.Combine(a[1], "zmap.json"), "{\"order\":[" + string.Join(",", order) + "],\"slots\":{" + string.Join(",", slots) + "}}", new UTF8Encoding(false));
    Console.WriteLine(count + " parts files");
  }
}
