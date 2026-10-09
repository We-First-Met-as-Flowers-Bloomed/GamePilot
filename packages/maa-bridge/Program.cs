using System.Runtime.InteropServices;
using System.Text.Json;

static class Native {
    const string Dll = "MaaCore";
    [UnmanagedFunctionPointer(CallingConvention.StdCall)] public delegate void Callback(int message, IntPtr details, IntPtr arg);
    [DllImport(Dll, CallingConvention=CallingConvention.StdCall)] public static extern IntPtr AsstGetVersion();
    [DllImport(Dll, CallingConvention=CallingConvention.StdCall)] public static extern byte AsstSetUserDir([MarshalAs(UnmanagedType.LPUTF8Str)] string path);
    [DllImport(Dll, CallingConvention=CallingConvention.StdCall)] public static extern byte AsstLoadResource([MarshalAs(UnmanagedType.LPUTF8Str)] string path);
    [DllImport(Dll, CallingConvention=CallingConvention.StdCall)] public static extern IntPtr AsstCreateEx(Callback callback, IntPtr arg);
    [DllImport(Dll, CallingConvention=CallingConvention.StdCall)] public static extern void AsstDestroy(IntPtr handle);
    [DllImport(Dll, CallingConvention=CallingConvention.StdCall)] public static extern byte AsstConnect(IntPtr handle, [MarshalAs(UnmanagedType.LPUTF8Str)] string adb, [MarshalAs(UnmanagedType.LPUTF8Str)] string address, [MarshalAs(UnmanagedType.LPUTF8Str)] string config);
    [DllImport(Dll, CallingConvention=CallingConvention.StdCall)] public static extern int AsstAppendTask(IntPtr handle, [MarshalAs(UnmanagedType.LPUTF8Str)] string type, [MarshalAs(UnmanagedType.LPUTF8Str)] string parameters);
    [DllImport(Dll, CallingConvention=CallingConvention.StdCall)] public static extern byte AsstStart(IntPtr handle);
    [DllImport(Dll, CallingConvention=CallingConvention.StdCall)] public static extern byte AsstStop(IntPtr handle);
    [DllImport(Dll, CallingConvention=CallingConvention.StdCall)] public static extern byte AsstRunning(IntPtr handle);
}

// Kept separate to test callback ordering without a device or native DLL.
public sealed class TaskOutcome {
    public string? Error { get; private set; }
    public bool Complete { get; private set; }
    public void Receive(int message) {
        if (message is 0 or 1 or 10000) Error ??= $"MaaCore task failed ({message})";
        if (message == 10004) Error ??= "MAA task cancelled";
        if (message == 3) Complete = true;
    }
}

// The same pinned release and Award capability table is used by the game package and installer.
static class EngineContract {
    static readonly JsonElement Contract = Load();
    static JsonElement Load() {
        using var stream = typeof(EngineContract).Assembly.GetManifestResourceStream("GamePilot.EngineContract.json")
            ?? throw new Exception("Missing MaaCore capability contract");
        using var document = JsonDocument.Parse(stream);
        return document.RootElement.Clone();
    }
    public static string Version => Contract.GetProperty("version").GetString()!;
    public static string ArchiveSha256 => Contract.GetProperty("archiveSha256").GetString()!;
    public static void ValidateTask(string type, JsonElement parameters) {
        if(parameters.ValueKind != JsonValueKind.Object) throw new Exception("MaaCore task parameters must be an object");
        if(type != "Award") return;
        var options=Contract.GetProperty("awardOptions");
        foreach(var parameter in parameters.EnumerateObject()) {
            if(!options.TryGetProperty(parameter.Name,out var capability) || !capability.GetProperty("supported").GetBoolean())
                throw new Exception($"Unsupported Award parameter {parameter.Name} for MaaCore {Version}");
            if(parameter.Value.ValueKind is not (JsonValueKind.True or JsonValueKind.False))
                throw new Exception($"Award parameter {parameter.Name} must be boolean");
        }
    }
}

class Program {
    static readonly object OutputLock = new(), StateLock = new();
    static IntPtr handle;
    static TaskOutcome? outcome;
    static Task? active;
    static bool stopping;
    static Native.Callback callback = OnCallback;
    static void Emit(object value) { lock(OutputLock) Console.WriteLine(JsonSerializer.Serialize(value)); }
    static void OnCallback(int message, IntPtr details, IntPtr arg) {
        try {
            lock(StateLock) outcome?.Receive(message);
            Emit(new { @event="callback", message, details=Marshal.PtrToStringUTF8(details) ?? "" });
        } catch { /* Exceptions must never cross the unmanaged callback boundary. */ }
    }
    static string Str(JsonElement e, string key) => e.GetProperty(key).GetString() ?? throw new Exception($"Missing {key}");
    static bool IsSupportedTaskType(string type) => type is
        "StartUp" or "Award" or "Mall" or "Fight" or "Infrast" or "Recruit" or
        "Depot" or "OperBox" or "Copilot" or "SSSCopilot" or "ParadoxCopilot" or
        "Roguelike" or "Reclamation";
    static void Check(byte value, string error) { if(value == 0) throw new Exception(error); }
    static async Task Stop() {
        lock(StateLock) { stopping = true; }
        if(handle != IntPtr.Zero) Check(Native.AsstStop(handle), "MaaCore stop failed");
        if(active != null) await active;
    }
    static async Task Main(string[] args) {
        // Node sends UTF-8 JSON lines; Windows console defaults may use a legacy code page.
        Console.InputEncoding = new System.Text.UTF8Encoding(false);
        Console.OutputEncoding = new System.Text.UTF8Encoding(false);
        var parentIndex=Array.IndexOf(args,"--parent-pid");
        if(parentIndex>=0) {
            try {
                var parent=System.Diagnostics.Process.GetProcessById(int.Parse(args[parentIndex+1]));
                // Independent watchdog: parent death must terminate even a hung native call.
                var watchdog=new Thread(() => { try { parent.WaitForExit(); } finally { Environment.Exit(73); } });
                watchdog.IsBackground=true; watchdog.Start();
            } catch { Environment.Exit(73); }
        }
        if(args.Contains("--self-test")) {
            var test = new TaskOutcome(); test.Receive(10000); test.Receive(3);
            if(test.Error == null || !test.Complete) throw new Exception("Error latch failed");
            var cancelled = new TaskOutcome(); cancelled.Receive(10004); cancelled.Receive(3);
            if(cancelled.Error == null) throw new Exception("Cancellation overwritten");
            Console.WriteLine("Callback outcome tests passed");
            foreach(var type in new[]{"Infrast","Recruit","Depot","OperBox","Copilot","SSSCopilot","ParadoxCopilot","Roguelike","Reclamation"})
                if(!IsSupportedTaskType(type)) throw new Exception($"Task type allowlist missing {type}");
            if(IsSupportedTaskType("Arbitrary")) throw new Exception("Task type allowlist failed");
            Console.WriteLine("Task type allowlist tests passed"); return;
        }
        try {
            string? line;
            while((line = await Console.In.ReadLineAsync()) != null) {
                int id = 0;
                try {
                    using var doc = JsonDocument.Parse(line); var req=doc.RootElement;
                    id=req.GetProperty("id").GetInt32(); var method=Str(req,"method");
                    if(method == "init") {
                        if(handle != IntPtr.Zero) throw new Exception("Already initialized");
                        var dir=Path.GetFullPath(Str(req,"coreDir")); var log=Path.GetFullPath(Str(req,"logDir"));
                        Directory.CreateDirectory(log);
                        using var provenance=JsonDocument.Parse(File.ReadAllText(Path.Combine(dir,"gamepilot-provenance.json")));
                        if(Str(provenance.RootElement,"version") != EngineContract.Version || Str(provenance.RootElement,"sha256") != EngineContract.ArchiveSha256)
                            throw new Exception("MaaCore resource provenance mismatch; run setup:maacore");
                        NativeLibrary.SetDllImportResolver(typeof(Native).Assembly, (name, assembly, path) => name == "MaaCore" ? NativeLibrary.Load(Path.Combine(dir,"MaaCore.dll")) : IntPtr.Zero);
                        var version=Marshal.PtrToStringUTF8(Native.AsstGetVersion()) ?? "";
                        if(version.TrimStart('v') != EngineContract.Version.TrimStart('v')) throw new Exception($"MaaCore version mismatch: {version}; expected {EngineContract.Version}");
                        Check(Native.AsstSetUserDir(log),"Cannot set MaaCore log directory");
                        Check(Native.AsstLoadResource(dir),"Cannot load matching MaaCore resources");
                        handle=Native.AsstCreateEx(callback,IntPtr.Zero);
                        if(handle == IntPtr.Zero) throw new Exception("Cannot create MaaCore instance");
                        Emit(new { id, ok=true, result=new { version } }); continue;
                    }
                    if(handle == IntPtr.Zero) throw new Exception("MaaCore not initialized");
                    if(method == "validateTask") {
                        if(active != null && !active.IsCompleted) throw new Exception("Task already running");
                        var type=Str(req,"type"); var parameters=req.GetProperty("params").GetRawText();
                        if(!IsSupportedTaskType(type)) throw new Exception("Unsupported task type");
                        EngineContract.ValidateTask(type,req.GetProperty("params"));
                        if(Native.AsstAppendTask(handle,type,parameters)==0) throw new Exception("Cannot append MaaCore task");
                        Emit(new { id, ok=true }); continue;
                    }
                    if(method == "runTask") {
                        if(active != null && !active.IsCompleted) throw new Exception("Task already running");
                        var type=Str(req,"type"); var parameters=req.GetProperty("params").GetRawText();
                        if(!IsSupportedTaskType(type)) throw new Exception("Unsupported task type");
                        EngineContract.ValidateTask(type,req.GetProperty("params"));
                        var taskId=id;
                        lock(StateLock) { outcome=new TaskOutcome(); stopping=false; }
                        if(Native.AsstAppendTask(handle,type,parameters)==0) throw new Exception("Cannot append MaaCore task");
                        Check(Native.AsstStart(handle),"Cannot start MaaCore task");
                        active=Task.Run(async () => {
                            try {
                                while(Native.AsstRunning(handle)!=0) await Task.Delay(50);
                                // Native callback delivery can trail the running flag.
                                for(int n=0;n<40;n++) {
                                    lock(StateLock) { if(stopping || outcome!.Complete || outcome.Error != null) break; }
                                    await Task.Delay(50);
                                }
                                lock(StateLock) {
                                    if(stopping) throw new Exception("MAA task cancelled");
                                    if(outcome!.Error != null) throw new Exception(outcome.Error);
                                    if(!outcome.Complete) throw new Exception("MaaCore stopped without completion callback");
                                }
                                Emit(new { id=taskId, ok=true });
                            } catch(Exception e) { Emit(new { id=taskId, ok=false, error=e.Message }); }
                        }); continue;
                    }
                    if(method == "stop" || method == "close") await Stop();
                    else if(method == "connect") {
                        if(active != null && !active.IsCompleted) throw new Exception("Task already running");
                        Check(Native.AsstConnect(handle,Str(req,"adbPath"),Str(req,"address"),"General"),"MaaCore connection failed");
                    } else throw new Exception("Unknown method");
                    if(method == "close") { Native.AsstDestroy(handle); handle=IntPtr.Zero; }
                    Emit(new { id, ok=true });
                    if(method == "close") break;
                } catch(Exception e) { Emit(new { id, ok=false, error=e.Message }); }
            }
        } finally { if(handle != IntPtr.Zero) { await Stop(); Native.AsstDestroy(handle); } GC.KeepAlive(callback); }
    }
}
