using System;
using System.Runtime.InteropServices;

internal static class PetWindow
{
    [StructLayout(LayoutKind.Sequential)]
    private struct Rect { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] private static extern IntPtr GetTopWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("user32.dll")] private static extern IntPtr GetShellWindow();
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] private static extern int GetWindowLong(IntPtr window, int index);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string windowClass, string caption);
    [DllImport("user32.dll")]
    private static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);

    private const uint NoSize = 0x01, NoMove = 0x02, NoZOrder = 0x04, NoActivate = 0x10, NoOwnerZOrder = 0x200;
    private const uint NextWindow = 2;
    private const int ExtendedStyle = -20, TopmostStyle = 0x08;
    private static readonly IntPtr Topmost = new IntPtr(-1), NotTopmost = new IntPtr(-2), Bottom = new IntPtr(1);

    private static void ChooseLayer(IntPtr window, bool top)
    {
        const uint flags = NoSize | NoMove | NoActivate | NoOwnerZOrder;
        if (top)
        {
            SetWindowPos(window, Topmost, 0, 0, 0, 0, flags);
            return;
        }

        SetWindowPos(window, NotTopmost, 0, 0, 0, 0, flags);
        // Keep the pet above Explorer's icon/wallpaper surface and below regular windows.
        IntPtr shell = GetShellWindow();
        IntPtr previous = IntPtr.Zero;
        for (IntPtr other = GetTopWindow(IntPtr.Zero); other != IntPtr.Zero; other = GetWindow(other, NextWindow))
        {
            if (other == window || !IsWindowVisible(other)) continue;
            if (other == shell || FindWindowEx(other, IntPtr.Zero, "SHELLDLL_DefView", null) != IntPtr.Zero)
            {
                if (previous != IntPtr.Zero && (GetWindowLong(previous, ExtendedStyle) & TopmostStyle) == 0)
                    SetWindowPos(window, previous, 0, 0, 0, 0, flags);
                return;
            }
            previous = other;
        }
        SetWindowPos(window, Bottom, 0, 0, 0, 0, flags);
    }

    private static int Main(string[] args)
    {
        long handle;
        uint parent, owner;
        if (args.Length != 2 || !long.TryParse(args[0], out handle) || !uint.TryParse(args[1], out parent)) return 2;
        IntPtr window = new IntPtr(handle);
        if (GetWindowThreadProcessId(window, out owner) == 0 || owner != parent) return 2;

        // Coordinates from Electron are converted to physical pixels before entering the pipe.
        SetProcessDpiAwarenessContext(new IntPtr(-4));
        bool dragging = false;
        int startX = 0, startY = 0;
        Rect original = new Rect();
        string input;
        while ((input = Console.ReadLine()) != null && GetWindowThreadProcessId(window, out owner) != 0 && owner == parent)
        {
            if (input == "top" || input == "bottom") { ChooseLayer(window, input == "top"); continue; }
            if (input == "end") { dragging = false; continue; }

            string[] command = input.Split(' ');
            int x, y;
            if (command.Length != 3 || !int.TryParse(command[1], out x) || !int.TryParse(command[2], out y)) continue;
            if (command[0] == "begin")
            {
                dragging = GetWindowRect(window, out original);
                startX = x;
                startY = y;
            }
            else if (command[0] == "move" && dragging)
            {
                SetWindowPos(window, IntPtr.Zero, original.Left + x - startX, original.Top + y - startY,
                    original.Right - original.Left, original.Bottom - original.Top, NoZOrder | NoActivate | NoOwnerZOrder);
            }
        }
        return 0;
    }
}
