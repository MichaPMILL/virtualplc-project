// Exports the PLC program of an engineering project (.ap17, .ap18… or archive .zap17,
// .zap18…) as SimaticML XML files that VirtualPLC Studio imports (Projet > Importer des
// fichiers): program blocks (LAD / SCL), PLC data types and tag tables.
//
// It uses the vendor's public Openness API, on a PC where the engineering software and its
// Openness option are installed and licensed; the user must be a member of the Windows
// group created by that option. The project is opened read-only in spirit: blocks are
// compiled in memory so they can be exported, and the project is never saved.
//
//   vplc-openness-export <project.ap17 | archive.zap17> <output folder> [options]
//     --upgrade       open / retrieve a project of an older version (upgrades a copy)
//     --plc NAME      only this PLC
//     --api-dir DIR   folder of Siemens.Engineering.dll (default: build setting)
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.CompilerServices;
using Siemens.Engineering;
using Siemens.Engineering.Compiler;
using Siemens.Engineering.HW;
using Siemens.Engineering.HW.Features;
using Siemens.Engineering.SW;
using Siemens.Engineering.SW.Blocks;
using Siemens.Engineering.SW.Tags;
using Siemens.Engineering.SW.Types;

namespace VirtualPlc.OpennessExport
{
    internal sealed class Options
    {
        public string Source;
        public string Output;
        public bool Upgrade;
        public string Plc;
        public string ApiDir;
    }

    internal static class Program
    {
        private static string apiDir;

        private static int Main(string[] args)
        {
            Options o;
            try
            {
                o = Parse(args);
            }
            catch (ArgumentException e)
            {
                Console.Error.WriteLine(e.Message);
                Console.Error.WriteLine("usage: vplc-openness-export <project.apXX | archive.zapXX> <output folder> [--upgrade] [--plc NAME] [--api-dir DIR]");
                return 2;
            }
            apiDir = o.ApiDir ?? typeof(Program).Assembly.GetCustomAttributes<AssemblyMetadataAttribute>()
                .FirstOrDefault(a => a.Key == "OpennessDir")?.Value;
            AppDomain.CurrentDomain.AssemblyResolve += ResolveApi;
            try
            {
                return Run(o);
            }
            catch (Exception e)
            {
                Console.Error.WriteLine("Error: " + e.Message);
                return 1;
            }
        }

        private static Options Parse(string[] args)
        {
            var o = new Options();
            var positional = new List<string>();
            for (var i = 0; i < args.Length; i++)
            {
                switch (args[i])
                {
                    case "--upgrade": o.Upgrade = true; break;
                    case "--plc": o.Plc = Next(args, ref i); break;
                    case "--api-dir": o.ApiDir = Next(args, ref i); break;
                    default:
                        if (args[i].StartsWith("--")) throw new ArgumentException("Unknown option " + args[i]);
                        positional.Add(args[i]);
                        break;
                }
            }
            if (positional.Count != 2) throw new ArgumentException("A project (or archive) and an output folder are expected.");
            o.Source = Path.GetFullPath(positional[0]);
            o.Output = Path.GetFullPath(positional[1]);
            if (!File.Exists(o.Source)) throw new ArgumentException("File not found: " + o.Source);
            return o;
        }

        private static string Next(string[] args, ref int i)
        {
            if (i + 1 >= args.Length) throw new ArgumentException("Value missing after " + args[i]);
            return args[++i];
        }

        /// <summary>The API assemblies are loaded from the installation, never copied.</summary>
        private static Assembly ResolveApi(object sender, ResolveEventArgs e)
        {
            if (string.IsNullOrEmpty(apiDir)) return null;
            var file = Path.Combine(apiDir, new AssemblyName(e.Name).Name + ".dll");
            return File.Exists(file) ? Assembly.LoadFrom(file) : null;
        }

        // separate method: the API types are only resolved once the handler is installed
        [MethodImpl(MethodImplOptions.NoInlining)]
        private static int Run(Options o)
        {
            var exported = 0;
            var skipped = new List<string>();
            string retrieved = null;
            using (var portal = new TiaPortal(TiaPortalMode.WithoutUserInterface))
            {
                Project project;
                if (Path.GetExtension(o.Source).StartsWith(".zap", StringComparison.OrdinalIgnoreCase))
                {
                    // archives are retrieved into a temporary folder
                    retrieved = Path.Combine(Path.GetTempPath(), "vplc-export-" + Guid.NewGuid().ToString("N"));
                    Directory.CreateDirectory(retrieved);
                    Console.WriteLine("Retrieving archive " + o.Source);
                    project = o.Upgrade
                        ? portal.Projects.RetrieveWithUpgrade(new FileInfo(o.Source), new DirectoryInfo(retrieved))
                        : portal.Projects.Retrieve(new FileInfo(o.Source), new DirectoryInfo(retrieved));
                }
                else
                {
                    Console.WriteLine("Opening project " + o.Source);
                    project = o.Upgrade
                        ? portal.Projects.OpenWithUpgrade(new FileInfo(o.Source))
                        : portal.Projects.Open(new FileInfo(o.Source));
                }
                try
                {
                    foreach (var plc in PlcSoftwares(project))
                    {
                        if (o.Plc != null && !string.Equals(plc.Name, o.Plc, StringComparison.OrdinalIgnoreCase)) continue;
                        exported += ExportPlc(plc, Path.Combine(o.Output, Safe(plc.Name)), skipped);
                    }
                }
                finally
                {
                    project.Close(); // never saved
                }
            }
            if (retrieved != null)
            {
                try { Directory.Delete(retrieved, true); } catch (IOException) { /* in use: left in %TEMP% */ }
            }
            foreach (var s in skipped) Console.WriteLine("  skipped: " + s);
            Console.WriteLine(exported + " file(s) exported to " + o.Output);
            return exported > 0 ? 0 : 1;
        }

        private static IEnumerable<PlcSoftware> PlcSoftwares(Project project)
        {
            var devices = new List<Device>(project.Devices);
            var groups = new Stack<DeviceUserGroup>(project.DeviceGroups);
            while (groups.Count > 0)
            {
                var g = groups.Pop();
                devices.AddRange(g.Devices);
                foreach (DeviceUserGroup sub in g.Groups) groups.Push(sub);
            }
            devices.AddRange(project.UngroupedDevicesGroup.Devices);
            var seen = new HashSet<PlcSoftware>();
            foreach (var device in devices)
            {
                var items = new Stack<DeviceItem>(device.DeviceItems);
                while (items.Count > 0)
                {
                    var item = items.Pop();
                    if (item.GetService<SoftwareContainer>()?.Software is PlcSoftware plc && seen.Add(plc)) yield return plc;
                    foreach (DeviceItem sub in item.DeviceItems) items.Push(sub);
                }
            }
        }

        private static int ExportPlc(PlcSoftware plc, string dir, List<string> skipped)
        {
            Console.WriteLine("PLC " + plc.Name);
            // blocks must be consistent to be exported: compile (in memory, not saved)
            try
            {
                var result = plc.GetService<ICompilable>()?.Compile();
                if (result != null && result.ErrorCount > 0)
                    Console.WriteLine("  compilation: " + result.ErrorCount + " error(s), inconsistent blocks are skipped");
            }
            catch (EngineeringException e)
            {
                Console.WriteLine("  compilation failed: " + e.Message);
            }
            var count = 0;
            count += ExportBlocks(plc.BlockGroup, Path.Combine(dir, "Blocks"), skipped);
            count += ExportTypes(plc.TypeGroup, Path.Combine(dir, "Types"), skipped);
            count += ExportTagTables(plc.TagTableGroup, Path.Combine(dir, "Tags"), skipped);
            return count;
        }

        private static int ExportBlocks(PlcBlockGroup group, string dir, List<string> skipped)
        {
            var count = 0;
            foreach (PlcBlock block in group.Blocks)
            {
                if (block.IsKnowHowProtected) { skipped.Add(block.Name + " (know-how protection)"); continue; }
                if (!block.IsConsistent) { skipped.Add(block.Name + " (not consistent: compilation errors)"); continue; }
                count += Export(() => block.Export(Target(dir, block.Name), ExportOptions.WithDefaults), block.Name, skipped);
            }
            foreach (PlcBlockUserGroup sub in group.Groups) count += ExportBlocks(sub, Path.Combine(dir, Safe(sub.Name)), skipped);
            return count;
        }

        private static int ExportTypes(PlcTypeGroup group, string dir, List<string> skipped)
        {
            var count = 0;
            foreach (PlcType type in group.Types)
            {
                if (type.IsKnowHowProtected) { skipped.Add(type.Name + " (know-how protection)"); continue; }
                count += Export(() => type.Export(Target(dir, type.Name), ExportOptions.WithDefaults), type.Name, skipped);
            }
            foreach (PlcTypeUserGroup sub in group.Groups) count += ExportTypes(sub, Path.Combine(dir, Safe(sub.Name)), skipped);
            return count;
        }

        private static int ExportTagTables(PlcTagTableGroup group, string dir, List<string> skipped)
        {
            var count = 0;
            foreach (PlcTagTable table in group.TagTables)
                count += Export(() => table.Export(Target(dir, table.Name), ExportOptions.WithDefaults), table.Name, skipped);
            foreach (PlcTagTableUserGroup sub in group.Groups) count += ExportTagTables(sub, Path.Combine(dir, Safe(sub.Name)), skipped);
            return count;
        }

        private static int Export(Action export, string name, List<string> skipped)
        {
            try
            {
                export();
                Console.WriteLine("  " + name);
                return 1;
            }
            catch (EngineeringException e)
            {
                skipped.Add(name + " (" + e.Message + ")");
                return 0;
            }
        }

        /// <summary>Export target (the API refuses to overwrite a file).</summary>
        private static FileInfo Target(string dir, string name)
        {
            Directory.CreateDirectory(dir);
            var file = new FileInfo(Path.Combine(dir, Safe(name) + ".xml"));
            if (file.Exists) file.Delete();
            return file;
        }

        private static string Safe(string name)
        {
            var bad = Path.GetInvalidFileNameChars();
            return new string(name.Select(c => bad.Contains(c) ? '_' : c).ToArray()).Trim();
        }
    }
}
