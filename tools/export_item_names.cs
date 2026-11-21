// Read-only String.wz name export for the collector's shop reader.
// export_item_names.exe <client Data directory> <item-names.json>
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using WzComparerR2.WzLib;

static class ExportItemNames {
  static readonly SortedDictionary<int, string> Names = new SortedDictionary<int, string>();
  static Wz_Node Extract(Wz_Node node) {
    var image = node.Value as Wz_Image;
    if (image == null) return node;
    if (!image.TryExtract()) throw new InvalidDataException("Cannot extract " + node.Text);
    return image.Node;
  }
  static void Walk(Wz_Node node) {
    node = Extract(node);
    int id;
    if (int.TryParse(node.Text, out id) && id >= 1000000 && id < 6000000) {
      var nameNode = node.Nodes["name"];
      var name = nameNode == null ? null : nameNode.Value as string;
      if (!string.IsNullOrWhiteSpace(name)) {
        string old;
        if (Names.TryGetValue(id, out old) && old != name) throw new InvalidDataException("Conflicting item " + id);
        Names[id] = name;
      }
    }
    foreach (Wz_Node child in node.Nodes) Walk(child);
  }
  static string Esc(string value) {
    var result = new StringBuilder("\"");
    foreach (char c in value) {
      if (c == '"' || c == '\\') result.Append('\\').Append(c);
      else if (c < ' ') result.Append("\\u").Append(((int)c).ToString("x4"));
      else result.Append(c);
    }
    return result.Append('"').ToString();
  }
  static void Main(string[] args) {
    var client = Path.GetFullPath(args[0]);
    var output = Path.GetFullPath(args[1]);
    if (output.StartsWith(client.TrimEnd('\\') + "\\", StringComparison.OrdinalIgnoreCase))
      throw new ArgumentException("Output must be outside the client resources");
    var structure = new Wz_Structure(); Wz_Node root = null;
    structure.LoadWzFolder(Path.Combine(client, "String"), ref root, false);
    structure.WzNode = root;
    foreach (var file in new[] { "Eqp.img", "Cash.img", "Consume.img", "Etc.img", "Ins.img", "Pet.img" }) {
      var node = root.FindNodeByPath(file, true);
      if (node == null) throw new InvalidDataException("Missing " + file);
      Walk(node);
    }
    if (Names.Count < 1000) throw new InvalidDataException("Incomplete client name export");
    File.WriteAllText(output, "{\n" + string.Join(",\n", Names.Select(p => "  \"" + p.Key + "\": " + Esc(p.Value))) + "\n}\n", new UTF8Encoding(false));
    Console.WriteLine(Names.Count + " item names exported");
  }
}
