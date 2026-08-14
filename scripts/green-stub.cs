// DeepSeek Harness Launcher 绿色版自解压 stub
//
// 机制：本 exe = [stub 代码][zip 载荷][8 字节小端载荷长度]。
// 首次运行：若 exe 旁 "DeepSeek Harness Launcher\" 子目录未解压，
//   用 .NET ZipArchive 把内嵌 zip 解压过去（带进度窗口），然后启动应用；
// 后续运行：检测到已解压 → 直接启动应用（秒开）。
// 数据目录随应用落在解压目录内，持久保存。
//
// 编译（无需任何工具链，Windows 自带 .NET Framework）：
//   csc.exe /nologo /target:winexe /platform:x64 /optimize+ /win32icon:icon.ico
//       /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.IO.Compression.dll
//       green-stub.cs /out:green-stub.exe
using System;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.IO.Compression;
using System.Windows.Forms;

namespace DshlGreen
{
    static class Program
    {
        const string APP_DIR = "DSHL";
        const string APP_EXE = "DSHL.exe";
        const long LEN_MARKER = 8;

        [STAThread]
        static int Main(string[] args)
        {
            // 开启 .NET Framework 长路径支持（>260 字符），否则 dsh 依赖树深层文件解压失败
            try
            {
                AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling", false);
                AppContext.SetSwitch("Switch.System.IO.BlockLongPaths", false);
            }
            catch { }
            string exeDir = Path.GetDirectoryName(Application.ExecutablePath);
            string appDir = Path.Combine(exeDir, APP_DIR);
            string appExe = Path.Combine(appDir, APP_EXE);
            try
            {
                Log(exeDir, "start, exeDir=" + exeDir);
                if (!File.Exists(appExe))
                {
                    int rc = ExtractPayload(exeDir, appDir);
                    Log(exeDir, "ExtractPayload rc=" + rc);
                    if (rc != 0) return rc;
                    if (!File.Exists(appExe))
                    {
                        MessageBox.Show("解压完成但未找到应用入口：\n" + appExe,
                            "DSHL", MessageBoxButtons.OK, MessageBoxIcon.Error);
                        return 4;
                    }
                }

                Log(exeDir, "launching " + appExe);
                var psi = new ProcessStartInfo();
                psi.FileName = appExe;
                psi.WorkingDirectory = appDir;
                psi.UseShellExecute = true;
                if (args.Length > 0)
                    psi.Arguments = string.Join(" ", Array.ConvertAll(args,
                        a => "\"" + a.Replace("\"", "\\\"") + "\""));
                Process.Start(psi);
                Log(exeDir, "launched ok");
            }
            catch (Exception ex)
            {
                Log(exeDir, "FATAL: " + ex);
                MessageBox.Show("启动应用失败：\n" + ex.Message,
                    "DSHL", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 5;
            }
            return 0;
        }

        static void Log(string exeDir, string message)
        {
            try
            {
                File.AppendAllText(Path.Combine(exeDir, "green.log"),
                    DateTime.Now.ToString("HH:mm:ss") + " " + message + Environment.NewLine);
            }
            catch { }
        }

        /// <summary>给超长路径加 \\?\ 前缀，绕过 Win32 MAX_PATH（260）/目录 248 限制。</summary>
        static string LongPath(string path)
        {
            if (path.Length >= 240 && !path.StartsWith(@"\\?\"))
                return @"\\?\" + path;
            return path;
        }

        /// <summary>定位并解压内嵌 zip 载荷到 appDir。</summary>
        static int ExtractPayload(string exeDir, string appDir)
        {
            string self = Application.ExecutablePath;
            try
            {
                Directory.CreateDirectory(appDir);
                using (var fs = File.OpenRead(self))
                {
                    if (fs.Length <= LEN_MARKER) throw new InvalidDataException("载荷长度标记缺失");
                    fs.Seek(-LEN_MARKER, SeekOrigin.End);
                    byte[] lenBytes = new byte[LEN_MARKER];
                    if (fs.Read(lenBytes, 0, (int)LEN_MARKER) != LEN_MARKER)
                        throw new InvalidDataException("读取载荷长度失败");
                    long payloadLen = BitConverter.ToInt64(lenBytes, 0);
                    long payloadStart = fs.Length - LEN_MARKER - payloadLen;
                    if (payloadStart < 0) throw new InvalidDataException("载荷位置非法");

                    using (var status = new StatusForm())
                    {
                        status.Show();
                        Application.DoEvents();
                        long done = 0;
                        try
                        {
                            fs.Seek(payloadStart, SeekOrigin.Begin);
                            using (var sub = new SubStream(fs, payloadStart, payloadLen))
                            using (var zip = new ZipArchive(sub, ZipArchiveMode.Read, leaveOpen: true))
                            {
                                long total = zip.Entries.Count;
                                foreach (var entry in zip.Entries)
                                {
                                    string dest = Path.Combine(appDir, entry.FullName.Replace('/', Path.DirectorySeparatorChar));
                                    if (entry.FullName.EndsWith("/") || entry.FullName.EndsWith("\\"))
                                    {
                                        Directory.CreateDirectory(LongPath(dest));
                                        continue;
                                    }
                                    string parent = Path.GetDirectoryName(dest);
                                    if (!string.IsNullOrEmpty(parent)) Directory.CreateDirectory(LongPath(parent));
                                    using (var src = entry.Open())
                                    using (var dst = new FileStream(LongPath(dest), FileMode.Create, FileAccess.Write, FileShare.None, 1 << 16))
                                        src.CopyTo(dst);
                                    done++;
                                    if (done % 200 == 0 || done == total)
                                    {
                                        status.SetProgress(done, total);
                                        Application.DoEvents();
                                    }
                                }
                            }
                            status.SetDone();
                        }
                        catch (Exception ex)
                        {
                            status.Close();
                            Log(exeDir, "extract FAILED at done=" + done + ": " + ex);
                            MessageBox.Show("解压运行环境失败：\n" + ex.Message + "\n\n请确认磁盘空间充足后重试。",
                                "DSHL", MessageBoxButtons.OK, MessageBoxIcon.Error);
                            return 2;
                        }
                    }
                }
            }
            catch (Exception ex)
            {
                Log(exeDir, "read payload FAILED: " + ex);
                MessageBox.Show("读取自解压载荷失败：\n" + ex.Message,
                    "DSHL", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return 3;
            }
            Log(exeDir, "extract done");
            return 0;
        }
    }

    /// <summary>只读子流：把宿主流的 [start, start+length) 区间暴露为独立流，供 ZipArchive 使用。</summary>
    sealed class SubStream : Stream
    {
        readonly Stream inner;
        readonly long start;
        readonly long length;
        long pos;

        public SubStream(Stream inner, long start, long length)
        {
            this.inner = inner;
            this.start = start;
            this.length = length;
            this.pos = 0;
        }

        public override bool CanRead { get { return true; } }
        public override bool CanSeek { get { return true; } }
        public override bool CanWrite { get { return false; } }
        public override long Length { get { return length; } }
        public override long Position { get { return pos; } set { pos = value; } }

        public override int Read(byte[] buffer, int offset, int count)
        {
            long remaining = length - pos;
            if (remaining <= 0) return 0;
            int toRead = (int)Math.Min(count, remaining);
            inner.Position = start + pos;
            int n = inner.Read(buffer, offset, toRead);
            pos += n;
            return n;
        }

        public override long Seek(long offset, SeekOrigin origin)
        {
            long target;
            switch (origin)
            {
                case SeekOrigin.Begin: target = offset; break;
                case SeekOrigin.Current: target = pos + offset; break;
                default: target = length + offset; break;
            }
            if (target < 0 || target > length) throw new IOException("子流越界");
            pos = target;
            return pos;
        }

        public override void Flush() { }
        public override void SetLength(long value) { throw new NotSupportedException(); }
        public override void Write(byte[] buffer, int offset, int count) { throw new NotSupportedException(); }
    }

    /// <summary>解压进度窗口（首次启动时显示）。</summary>
    class StatusForm : Form
    {
        readonly Label label;
        public StatusForm()
        {
            Text = "DeepSeek Harness Launcher";
            FormBorderStyle = FormBorderStyle.FixedDialog;
            MaximizeBox = false;
            MinimizeBox = false;
            ShowInTaskbar = true;
            StartPosition = FormStartPosition.CenterScreen;
            ClientSize = new Size(460, 96);
            label = new Label
            {
                Text = "正在解压运行环境（首次启动约需 1-2 分钟）...",
                TextAlign = ContentAlignment.MiddleCenter,
            };
            label.SetBounds(16, 12, 428, 72);
            Controls.Add(label);
        }
        public void SetProgress(long done, long total)
        {
            if (total <= 0) return;
            if (done == total || done % 1000 == 0 || done % (total / 20 + 1) == 0)
                label.Text = string.Format("正在解压运行环境：{0} / {1} 个文件", done, total);
        }
        public void SetDone()
        {
            label.Text = "解压完成，正在启动...";
        }
    }
}
