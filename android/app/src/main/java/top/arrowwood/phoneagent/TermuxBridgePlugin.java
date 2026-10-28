package top.arrowwood.phoneagent;

import android.Manifest;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

@CapacitorPlugin(
    name = "TermuxBridge",
    permissions = {
        @Permission(alias = "termux", strings = { "com.termux.permission.RUN_COMMAND" }),
        @Permission(alias = "storage", strings = { Manifest.permission.WRITE_EXTERNAL_STORAGE })
    }
)
public class TermuxBridgePlugin extends Plugin {

    private static final String TERMUX_PACKAGE = "com.termux";
    private static final String RUN_COMMAND_SERVICE = "com.termux.app.RunCommandService";
    private static final String RUN_COMMAND_ACTION = "com.termux.RUN_COMMAND";
    private static final String BASH = "/data/data/com.termux/files/usr/bin/bash";
    private static final String TERMUX_HOME = "/data/data/com.termux/files/home";

    private boolean isTermuxInstalled() {
        try {
            getContext().getPackageManager().getPackageInfo(TERMUX_PACKAGE, 0);
            return true;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        }
    }

    @PluginMethod
    public void getInfo(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("termuxInstalled", isTermuxInstalled());
        ret.put("model", Build.MODEL);
        ret.put("android", Build.VERSION.RELEASE);
        ret.put("sdkInt", Build.VERSION.SDK_INT);
        call.resolve(ret);
    }

    @PluginMethod
    public void startServer(PluginCall call) {
        runCommand(call, "bash " + TERMUX_HOME + "/phone-agent/start.sh");
    }

    @PluginMethod
    public void stopServer(PluginCall call) {
        runCommand(call, "bash " + TERMUX_HOME + "/phone-agent/stop.sh");
    }

    @PluginMethod
    public void installDependencies(PluginCall call) {
        runCommand(call, "bash " + TERMUX_HOME + "/phone-agent/install.sh");
    }

    private void runCommand(PluginCall call, String command) {
        if (!isTermuxInstalled()) {
            call.reject("termux_not_installed", "请先安装 Termux");
            return;
        }
        lastCommandForPermission = command;
        if (getPermissionState("termux") != PermissionState.GRANTED) {
            requestPermissionForAlias("termux", call, "termuxPermissionCallback");
        } else {
            sendRunCommand(call, command);
        }
    }

    @PermissionCallback
    private void termuxPermissionCallback(PluginCall call) {
        if (getPermissionState("termux") != PermissionState.GRANTED) {
            call.reject("permission_denied", "需要 Termux 运行命令权限，请在系统设置中允许");
            return;
        }
        String command = lastCommandForPermission;
        if (command == null) {
            call.reject("no_command", "没有待执行的命令");
            return;
        }
        sendRunCommand(call, command);
    }

    private String lastCommandForPermission;

    private void sendRunCommand(PluginCall call, String command) {
        lastCommandForPermission = command;
        Intent intent = new Intent();
        intent.setClassName(TERMUX_PACKAGE, RUN_COMMAND_SERVICE);
        intent.setAction(RUN_COMMAND_ACTION);
        intent.putExtra("com.termux.RUN_COMMAND_PATH", BASH);
        intent.putExtra("com.termux.RUN_COMMAND_ARGUMENTS", new String[] { "-lc", command });
        intent.putExtra("com.termux.RUN_COMMAND_WORKDIR", TERMUX_HOME);
        intent.putExtra("com.termux.RUN_COMMAND_BACKGROUND", true);
        intent.putExtra("com.termux.RUN_COMMAND_SESSION_ACTION", "0");
        try {
            getContext().startService(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("run_command_failed", "无法调用 Termux：" + e.getMessage());
        }
    }

    @PluginMethod
    public void openTermux(PluginCall call) {
        if (!isTermuxInstalled()) {
            call.reject("termux_not_installed", "请先安装 Termux");
            return;
        }
        Intent intent = getContext().getPackageManager().getLaunchIntentForPackage(TERMUX_PACKAGE);
        if (intent == null) {
            call.reject("no_launch_intent", "无法打开 Termux");
            return;
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        getContext().startActivity(intent);
        call.resolve();
    }

    @PluginMethod
    public void openUrl(PluginCall call) {
        String url = call.getString("url");
        if (url == null || url.isEmpty()) {
            call.reject("no_url");
            return;
        }
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("open_failed", e.getMessage());
        }
    }

    @PluginMethod
    public void openBatterySettings(PluginCall call) {
        try {
            Intent intent = new Intent(android.provider.Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            intent.setData(Uri.parse("package:" + TERMUX_PACKAGE));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            try {
                Intent fallback = new Intent(android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
                fallback.setData(Uri.parse("package:" + TERMUX_PACKAGE));
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(fallback);
                call.resolve();
            } catch (Exception e2) {
                call.reject("open_failed", e2.getMessage());
            }
        }
    }

    @PluginMethod
    public void exportBundle(PluginCall call) {
        try {
            File zip = new File(getContext().getCacheDir(), "phone-agent.zip");
            try (ZipOutputStream zos = new ZipOutputStream(new FileOutputStream(zip))) {
                addAssetTree(zos, "public/bundle", "");
            }
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                saveZipToDownloads(zip);
            } else {
                if (getPermissionState("storage") != PermissionState.GRANTED) {
                    requestPermissionForAlias("storage", call, "storagePermissionCallback");
                    return;
                }
                File downloads = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
                if (!downloads.exists()) downloads.mkdirs();
                File target = new File(downloads, "phone-agent.zip");
                copyFile(zip, target);
            }
            JSObject ret = new JSObject();
            ret.put("path", "Download/phone-agent.zip");
            ret.put("size", zip.length());
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("export_failed", e.getMessage());
        }
    }

    @PermissionCallback
    private void storagePermissionCallback(PluginCall call) {
        if (getPermissionState("storage") != PermissionState.GRANTED) {
            call.reject("permission_denied", "需要存储权限才能导出安装包");
            return;
        }
        try {
            File zip = new File(getContext().getCacheDir(), "phone-agent.zip");
            File downloads = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS);
            if (!downloads.exists()) downloads.mkdirs();
            copyFile(zip, new File(downloads, "phone-agent.zip"));
            JSObject ret = new JSObject();
            ret.put("path", "Download/phone-agent.zip");
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("export_failed", e.getMessage());
        }
    }

    private void saveZipToDownloads(File zip) throws IOException {
        ContentResolver resolver = getContext().getContentResolver();
        Uri collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI;
        String relativePath = Environment.DIRECTORY_DOWNLOADS + "/";
        resolver.delete(
            collection,
            MediaStore.MediaColumns.DISPLAY_NAME + "=? AND " + MediaStore.MediaColumns.RELATIVE_PATH + "=?",
            new String[] { "phone-agent.zip", relativePath }
        );
        ContentValues values = new ContentValues();
        values.put(MediaStore.MediaColumns.DISPLAY_NAME, "phone-agent.zip");
        values.put(MediaStore.MediaColumns.MIME_TYPE, "application/zip");
        values.put(MediaStore.MediaColumns.RELATIVE_PATH, relativePath);
        Uri item = resolver.insert(collection, values);
        if (item == null) throw new IOException("无法写入 Download 目录");
        try (InputStream is = new java.io.FileInputStream(zip);
             OutputStream os = resolver.openOutputStream(item)) {
            if (os == null) throw new IOException("无法打开输出流");
            byte[] buffer = new byte[8192];
            int n;
            while ((n = is.read(buffer)) > 0) os.write(buffer, 0, n);
        }
    }

    private void addAssetTree(ZipOutputStream zos, String assetPath, String entryPrefix) throws IOException {
        InputStream fileStream = null;
        try {
            fileStream = getContext().getAssets().open(assetPath);
        } catch (IOException ignored) {
        }
        if (fileStream != null) {
            try (InputStream is = fileStream) {
                zos.putNextEntry(new ZipEntry(entryPrefix));
                byte[] buffer = new byte[8192];
                int n;
                while ((n = is.read(buffer)) > 0) zos.write(buffer, 0, n);
                zos.closeEntry();
            }
            return;
        }
        String[] children = getContext().getAssets().list(assetPath);
        if (children == null || children.length == 0) return;
        for (String child : children) {
            String childPath = assetPath + "/" + child;
            String childEntry = entryPrefix.isEmpty() ? child : entryPrefix + child;
            addAssetTree(zos, childPath, childEntry);
        }
    }

    private void copyFile(File src, File dst) throws IOException {
        try (InputStream is = new java.io.FileInputStream(src);
             OutputStream os = new FileOutputStream(dst)) {
            byte[] buffer = new byte[8192];
            int n;
            while ((n = is.read(buffer)) > 0) os.write(buffer, 0, n);
        }
    }
}
