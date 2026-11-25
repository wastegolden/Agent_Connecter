$ErrorActionPreference = 'Stop'
# Change the existing mount point in one filesystem operation. Both links are
# ordinary, user-owned NTFS junctions created with Node's fs.symlink().
Add-Type @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class Junction {
  [DllImport("kernel32", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr sa, uint open, uint flags, IntPtr template);
  [DllImport("kernel32", SetLastError=true)]
  static extern bool DeviceIoControl(SafeFileHandle handle, uint code, byte[] input, int inSize, byte[] output, int outSize, out int bytes, IntPtr overlapped);
  public static void Replace(string current, string next) {
    const uint openReparseDirectory = 0x02200000;
    using (var src = CreateFile(next, 0, 7, IntPtr.Zero, 3, openReparseDirectory, IntPtr.Zero))
    using (var dest = CreateFile(current, 0x40000000, 7, IntPtr.Zero, 3, openReparseDirectory, IntPtr.Zero)) {
      var data = new byte[16384];
      int size, unused;
      if (!DeviceIoControl(src, 0x900a8, null, 0, data, data.Length, out size, IntPtr.Zero)
       || !DeviceIoControl(dest, 0x900a4, data, size, null, 0, out unused, IntPtr.Zero))
        throw new Win32Exception(Marshal.GetLastWin32Error());
    }
  }
}
'@
[Junction]::Replace($env:CONNECTER_CURRENT, $env:CONNECTER_NEXT)
