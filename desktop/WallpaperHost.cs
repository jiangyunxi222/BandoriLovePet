using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows;
using System.Windows.Automation;

internal static class WallpaperHost
{
    [StructLayout(LayoutKind.Sequential)] private struct POINT { public int X, Y; }
    [StructLayout(LayoutKind.Sequential)] private struct RECT { public int Left, Top, Right, Bottom; }
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr FindWindow(string name, string title);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr FindWindowEx(IntPtr parent, IntPtr after, string name, string title);
    [DllImport("user32.dll")] private static extern IntPtr GetParent(IntPtr window);
    [DllImport("user32.dll")] private static extern IntPtr SetParent(IntPtr window, IntPtr parent);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern IntPtr GetShellWindow();
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out RECT area);
    [DllImport("user32.dll")] private static extern bool GetCursorPos(out POINT point);
    [DllImport("user32.dll")] private static extern bool ScreenToClient(IntPtr window, ref POINT point);
    [DllImport("user32.dll")] private static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] private static extern int GetWindowLong(IntPtr window, int index);
    [DllImport("user32.dll")] private static extern int SetWindowLong(IntPtr window, int index, int value);
    [DllImport("user32.dll")] private static extern bool SetLayeredWindowAttributes(IntPtr window, uint key, byte alpha, uint flags);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll")] private static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")] private static extern bool SetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll")] private static extern IntPtr SendMessageTimeout(IntPtr window, uint message,
        IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out UIntPtr result);
    private static IntPtr progman, icons;
    private static bool stopping, lastDown, tracking, active;
    private static POINT previous;

    private static IntPtr Attach(IntPtr window, int x, int y, int width, int height)
    {
        progman = FindWindow("Progman", null);
        if (progman == IntPtr.Zero) return IntPtr.Zero;
        UIntPtr result;
        SendMessageTimeout(progman, 0x052c, new IntPtr(0x0d), new IntPtr(1), 2, 600, out result);
        icons = FindWindowEx(progman, IntPtr.Zero, "SHELLDLL_DefView", null);
        IntPtr sibling = FindWindowEx(progman, IntPtr.Zero, "WorkerW", null);
        IntPtr target = IntPtr.Zero;
        IntPtr insertAfter = IntPtr.Zero;
        if (icons != IntPtr.Zero && sibling != IntPtr.Zero)
        {
            // Recent Explorer versions compose the icon view and static wallpaper inside Progman.
            target = progman;
            insertAfter = icons;
        }
        else
        {
            IntPtr owner = IntPtr.Zero;
            for (IntPtr current = FindWindowEx(IntPtr.Zero, IntPtr.Zero, null, null); current != IntPtr.Zero;
                 current = FindWindowEx(IntPtr.Zero, current, null, null))
            {
                icons = FindWindowEx(current, IntPtr.Zero, "SHELLDLL_DefView", null);
                if (icons == IntPtr.Zero) continue;
                owner = current;
                break;
            }
            if (owner != IntPtr.Zero)
                target = FindWindowEx(IntPtr.Zero, owner, "WorkerW", null);
        }
        if (target == IntPtr.Zero) return target;
        SetWindowLong(window, -16, (GetWindowLong(window, -16) & ~unchecked((int)0x80000000)) | 0x40000000);
        SetParent(window, target);
        if (GetParent(window) != target) return IntPtr.Zero;
        if (!Place(window, target, insertAfter, x, y, width, height, 0x10 | 0x20 | 0x40)) return IntPtr.Zero;
        if (target == progman) SetWindowPos(sibling, window, 0, 0, 0, 0, 0x01 | 0x02 | 0x10);
        return target;
    }

    private static bool Place(IntPtr window, IntPtr parent, IntPtr after, int x, int y, int width, int height, uint flags)
    {
        POINT origin = new POINT { X = x, Y = y };
        return ScreenToClient(parent, ref origin)
            && SetWindowPos(window, after, origin.X, origin.Y, width, height, flags);
    }

    private static void Listen(IntPtr window, IntPtr parent)
    {
        string command;
        while ((command = Console.ReadLine()) != null)
        {
            string[] parts = command.Split(' ');
            int x, y, width, height;
            if (parts.Length == 5 && parts[0] == "bounds" &&
                int.TryParse(parts[1], out x) && int.TryParse(parts[2], out y) &&
                int.TryParse(parts[3], out width) && int.TryParse(parts[4], out height) &&
                width > 0 && height > 0)
                Place(window, parent, IntPtr.Zero, x, y, width, height, 0x04 | 0x10);
        }
        Volatile.Write(ref stopping, true);
    }

    private static bool DesktopActive()
    {
        IntPtr foreground = GetForegroundWindow();
        return foreground != IntPtr.Zero && (foreground == progman || foreground == GetShellWindow() ||
            (icons != IntPtr.Zero && foreground == GetAncestor(icons, 2)));
    }

    private static bool IsDesktopIcon(POINT point)
    {
        try
        {
            AutomationElement element = AutomationElement.FromPoint(new Point(point.X, point.Y));
            if (element == null) return true;
            ControlType type = element.Current.ControlType;
            return type == ControlType.ListItem || type == ControlType.Button || type == ControlType.MenuItem || type == ControlType.Edit;
        }
        catch (Exception error)
        {
            if (error is COMException || error is ElementNotAvailableException || error is InvalidOperationException) return true;
            throw;
        }
    }

    private static void PollPointer(IntPtr window)
    {
        bool desktop = DesktopActive();
        if (desktop != active) { active = desktop; Console.WriteLine(active ? "active 1" : "active 0"); }
        bool down = (GetAsyncKeyState(1) & 0x8000) != 0;
        POINT point;
        RECT bounds;
        if (GetCursorPos(out point) && GetWindowRect(window, out bounds))
        {
            bool inside = desktop && point.X >= bounds.Left && point.X < bounds.Right && point.Y >= bounds.Top && point.Y < bounds.Bottom;
            string action = null;
            if (inside && down && !lastDown && !IsDesktopIcon(point)) { tracking = true; action = "down"; }
            else if (tracking && !inside) { tracking = false; action = "cancel"; }
            else if (tracking && !down) { tracking = false; action = IsDesktopIcon(point) ? "cancel" : "up"; }
            else if (tracking && (point.X != previous.X || point.Y != previous.Y)) action = "move";
            if (action != null) Console.WriteLine("{0} {1} {2}", action, point.X - bounds.Left, point.Y - bounds.Top);
            previous = point;
        }
        lastDown = down;
    }

    [MTAThread]
    private static int Main(string[] args)
    {
        long handle;
        uint process, owner;
        int x, y, width, height;
        if (args.Length != 6 || !long.TryParse(args[0], out handle) || !uint.TryParse(args[1], out process) ||
            !int.TryParse(args[2], out x) || !int.TryParse(args[3], out y) || !int.TryParse(args[4], out width) ||
            !int.TryParse(args[5], out height) || width < 1 || height < 1) return 2;
        IntPtr window = new IntPtr(handle);
        if (GetWindowThreadProcessId(window, out owner) == 0 || owner != process) return 2;
        SetProcessDpiAwarenessContext(new IntPtr(-4));
        SetWindowLong(window, -20, GetWindowLong(window, -20) | 0x80000);
        if (!SetLayeredWindowAttributes(window, 0, 0, 2)) return 3;
        IntPtr parent = Attach(window, x, y, width, height);
        if (parent == IntPtr.Zero || !SetLayeredWindowAttributes(window, 0, 255, 2)) return 3;
        Console.WriteLine("ready");
        lastDown = (GetAsyncKeyState(1) & 0x8000) != 0;
        new Thread(() => Listen(window, parent)) { IsBackground = true }.Start();
        while (!Volatile.Read(ref stopping) && IsWindow(window) && IsWindow(parent))
        {
            PollPointer(window);
            Thread.Sleep(16);
        }
        return 0;
    }
}
