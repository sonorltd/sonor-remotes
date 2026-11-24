package uk.co.sonor.skyremote;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.Socket;
import java.util.Collections;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Direct TCP to Sky boxes (Sky Q / Q Mini on 49160, Sky+HD on 5900).
 * Mirrors lib/sky.js: read the 12-byte "SKY 000.001\n" banner, echo it, echo the first byte of each
 * short reply, and once a reply of 24+ bytes arrives send the 8-byte KeyEvent press then release.
 */
@CapacitorPlugin(name = "SkyTcp")
public class SkyTcpPlugin extends Plugin {
    private final ExecutorService pool = Executors.newFixedThreadPool(48);

    /** probe({host, port, timeout}) -> {open, banner} */
    @PluginMethod
    public void probe(PluginCall call) {
        final String host = call.getString("host");
        final int port = call.getInt("port", 49160);
        final int timeout = call.getInt("timeout", 600);
        pool.execute(() -> {
            JSObject ret = new JSObject();
            try (Socket s = new Socket()) {
                s.connect(new InetSocketAddress(host, port), timeout);
                ret.put("open", true);
                s.setSoTimeout(1200);
                byte[] buf = new byte[12];
                int n = readUpTo(s.getInputStream(), buf, 12);
                ret.put("banner", n > 0 ? new String(buf, 0, n, "ISO-8859-1").trim() : "");
            } catch (Exception e) {
                if (!ret.has("open")) ret.put("open", false);
                if (!ret.has("banner")) ret.put("banner", "");
            }
            call.resolve(ret);
        });
    }

    /** sendKeys({host, port, codes:[int], gapMs}) — one connection per key, like the official protocol users. */
    @PluginMethod
    public void sendKeys(PluginCall call) {
        final String host = call.getString("host");
        final int port = call.getInt("port", 49160);
        final int gap = call.getInt("gapMs", 350);
        final JSArray codes = call.getArray("codes");
        pool.execute(() -> {
            try {
                for (int i = 0; i < codes.length(); i++) {
                    sendKey(host, port, codes.getInt(i));
                    if (i < codes.length() - 1) Thread.sleep(gap);
                }
                call.resolve();
            } catch (Exception e) {
                call.reject(e.getMessage() == null ? e.toString() : e.getMessage());
            }
        });
    }

    /** localAddresses() -> {addresses:[ipv4...]} so the page knows which /24 to sweep. */
    @PluginMethod
    public void localAddresses(PluginCall call) {
        JSArray arr = new JSArray();
        try {
            for (NetworkInterface ni : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!ni.isUp() || ni.isLoopback()) continue;
                for (InetAddress a : Collections.list(ni.getInetAddresses())) {
                    if (a instanceof Inet4Address) arr.put(a.getHostAddress());
                }
            }
        } catch (Exception ignored) { }
        JSObject ret = new JSObject();
        ret.put("addresses", arr);
        call.resolve(ret);
    }

    private static void sendKey(String host, int port, int code) throws Exception {
        try (Socket s = new Socket()) {
            s.connect(new InetSocketAddress(host, port), 3000);
            s.setSoTimeout(3000);
            InputStream in = s.getInputStream();
            OutputStream out = s.getOutputStream();
            byte[] banner = new byte[12];
            if (readUpTo(in, banner, 12) < 12 || banner[0] != 'S' || banner[1] != 'K' || banner[2] != 'Y') {
                throw new Exception(host + ":" + port + " is not a Sky box");
            }
            out.write(banner);
            byte[] buf = new byte[1024];
            while (true) {
                int n = in.read(buf);
                if (n <= 0) throw new Exception("Sky box closed the connection during handshake");
                if (n < 24) { out.write(buf, 0, 1); continue; }
                byte hi = (byte) (224 + code / 16), lo = (byte) (code % 16);
                out.write(new byte[]{4, 1, 0, 0, 0, 0, hi, lo});
                out.write(new byte[]{4, 0, 0, 0, 0, 0, hi, lo});
                out.flush();
                return;
            }
        }
    }

    private static int readUpTo(InputStream in, byte[] buf, int len) throws Exception {
        int got = 0;
        while (got < len) {
            int n = in.read(buf, got, len - got);
            if (n < 0) break;
            got += n;
        }
        return got;
    }
}
