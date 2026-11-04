// Batch driver for WzComparerR2's own MapRender2 engine (20261004.1 netfx).
// Obtain WzComparerR2 separately; no renderer binaries are distributed here.
// WzLib opens client files with FileAccess.Read. Capture draws the scene
// without UI; hidden life, portal and reactor layers remain excluded.
using System;
using System.IO;
using System.Reflection;
using System.Collections.Generic;
using System.Threading.Tasks;
using System.Runtime.InteropServices;
using Microsoft.Xna.Framework;
using WzComparerR2;
using WzComparerR2.WzLib;
using WzComparerR2.Common;
using WzComparerR2.PluginBase;
using WzComparerR2.Config;
using WzComparerR2.MapRender;
using WzComparerR2.MapRender.Config;

public class BatchScenes : FrmMapRender2 {
  static readonly BindingFlags Private=BindingFlags.Instance|BindingFlags.NonPublic;
  static string dataRoot,output;
  static Dictionary<string,Wz_Structure> structures=new Dictionary<string,Wz_Structure>();
  readonly Queue<int> ids; int current; bool capturing; DateTime started; Rectangle rect;
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern bool SetDllDirectory(string path);
  object Read(string name){return typeof(FrmMapRender2).GetField(name,Private).GetValue(this);}
  static Wz_Node Root(string name) {
    if(name=="Sound" || name=="Mob" || name=="Npc")return null;
    Wz_Structure s;
    if(!structures.TryGetValue(name,out s)) {
      var folder=Path.Combine(dataRoot,name);if(!Directory.Exists(folder))return null;
      Console.WriteLine("LOAD "+name);
      s=new Wz_Structure();Wz_Node node=null;s.LoadWzFolder(folder,ref node,false);s.WzNode=node;structures[name]=s;
    }
    return s.WzNode;
  }
  static void Find(object sender,FindWzEventArgs e) {
    if(!String.IsNullOrEmpty(e.FullPath)) {
      string path=e.FullPath.Replace('/','\\');int sep=path.IndexOf('\\');
      string name=sep<0?path:path.Substring(0,sep);var root=Root(name);
      e.WzNode=root==null?null:(sep<0?root:root.FindNodeByPath(path.Substring(sep+1),true));
    } else e.WzNode=Root(e.WzType.ToString());
  }
  BatchScenes(Queue<int> queue){
    ids=queue;StringLinker=new StringLinker();
    var v=(PatchVisibility)Read("patchVisibility");
    v.MobVisible=v.NpcVisible=v.PortalVisible=v.ReactorVisible=false;
    v.MobNameVisible=v.NpcNameVisible=v.FootHoldVisible=v.LadderRopeVisible=false;
    var form=(System.Windows.Forms.Form)System.Windows.Forms.Form.FromHandle(Window.Handle);
    form.ShowInTaskbar=false;form.Load+=(s,e)=>{form.Location=new System.Drawing.Point(-20000,-20000);};
    Next();
  }
  void Next(){
    if(ids.Count==0){Exit();return;}
    current=ids.Dequeue();started=DateTime.UtcNow;capturing=false;
    var root=Root("Map");string nine=current.ToString("D9");
    var node=root.FindNodeByPath("Map\\Map"+nine[0]+"\\"+nine+".img");
    var img=node==null?null:node.Value as Wz_Image;
    if(img==null||!img.TryExtract())throw new Exception("Cannot extract map "+current);
    var info=img.Node.Nodes["info"];
    int l=info.Nodes["VRLeft"].GetValueEx(0),t=info.Nodes["VRTop"].GetValueEx(0),r=info.Nodes["VRRight"].GetValueEx(0),b=info.Nodes["VRBottom"].GetValueEx(0);
    rect=new Rectangle(l,t,r-l,b-t);
    var mini=img.Node.Nodes["miniMap"];
    if(mini!=null && mini.Nodes["width"].GetValueEx(0)>0 && mini.Nodes["height"].GetValueEx(0)>0)
      rect=new Rectangle(-mini.Nodes["centerX"].GetValueEx(0),-mini.Nodes["centerY"].GetValueEx(0),mini.Nodes["width"].GetValueEx(0),mini.Nodes["height"].GetValueEx(0));
    if(rect.Width<=0||rect.Height<=0)throw new Exception("No VR or minimap rectangle for "+current);
    Console.WriteLine("MAP "+current+" world rectangle "+rect);
    LoadMap(img);
  }
  protected override void Draw(GameTime time){
    var map=Read("mapData") as MapData;
    if(!capturing && map!=null && map.ID==current && Read("sceneManagerState").ToString()=="Running") {
      var env=Read("renderEnv");var camera=env.GetType().GetProperty("Camera").GetValue(env,null);
      camera.GetType().GetProperty("WorldRect").SetValue(camera,rect,null);
      typeof(FrmMapRender2).GetMethod("Capture",Private).Invoke(this,new object[]{time});capturing=true;
    }
    if(capturing) {
      var task=Read("captureTask") as Task;
      if(task!=null&&task.IsCompleted) {
        if(task.IsFaulted)throw task.Exception;
        var files=Directory.GetFiles(Environment.CurrentDirectory,"*_"+current.ToString("D9")+".png");
        if(files.Length==0)throw new Exception("Renderer did not write map "+current);
        Array.Sort(files,StringComparer.Ordinal);string png=Path.Combine(output,current+".png");
        if(File.Exists(png))throw new Exception("Refusing to overwrite "+png);
        File.Move(files[files.Length-1],png);
        File.WriteAllText(Path.Combine(output,current+".json"),String.Format("{{\"x\":{0},\"y\":{1},\"w\":{2},\"h\":{3}}}",rect.X,rect.Y,rect.Width,rect.Height));
        Console.WriteLine("SAVED "+current);Next();
      }
    }
    if((DateTime.UtcNow-started).TotalSeconds>45)throw new Exception("Map load timed out: "+current);
    base.Draw(time);
  }
  [STAThread]public static int Main(string[] args){
    try {
      if(args.Length!=3)throw new ArgumentException("Usage: ClientMapScenes.Batch.exe <client Data directory> <output directory> <comma-separated IDs>");
      dataRoot=Path.GetFullPath(args[0]);output=Path.GetFullPath(args[1]);
      if(output.Equals(dataRoot,StringComparison.OrdinalIgnoreCase)||output.StartsWith(dataRoot.TrimEnd(Path.DirectorySeparatorChar)+Path.DirectorySeparatorChar,StringComparison.OrdinalIgnoreCase))
        throw new ArgumentException("Output must be outside the read-only client Data directory");
      Directory.CreateDirectory(output);
      SetDllDirectory(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"Lib","x64"));
      Assembly.LoadFrom(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"WzComparerR2.anycpu.exe"));
      ConfigManager.RegisterAllSection(typeof(ConfigManager).Assembly);
      ConfigManager.RegisterAllSection(typeof(FrmMapRender2).Assembly);
      MapRenderConfig.Default.Volume=0f;
      var ev=typeof(PluginManager).GetEvent("WzFileFinding",BindingFlags.Static|BindingFlags.NonPublic);
      ev.GetAddMethod(true).Invoke(null,new object[]{new FindWzEventHandler(Find)});
      var queue=new Queue<int>();foreach(var id in args[2].Split(','))queue.Enqueue(int.Parse(id));
      using(var game=new BatchScenes(queue))game.Run();return 0;
    }catch(Exception e){Console.WriteLine(e);return 1;}
    finally{foreach(var s in structures.Values)s.Clear();}
  }
}
