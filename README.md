# 随身 Agent

一个 Capacitor Android 界面，连接手机 Termux 中运行的 Claude Agent SDK 服务。应用和服务的源码均在本仓库；本仓库不包含个人记忆、密钥、签名证书或预构建 APK。

## 准备

需要 Node.js、Android SDK、Termux，以及在手机上安装的 Termux:API。运行 `npm ci` 安装 Android 前端依赖；`bundle/` 下是需要放到手机 `~/phone-agent` 的服务端源码。

在手机上运行 `bash ~/phone-agent/install.sh`。安装脚本会把 `config.example.json` 复制到 `~/.phone-agent/config.json`；在启动前填写自己的 API 地址、令牌和模型。示例配置不包含有效凭据。如果要同步自己的私有记忆仓库，通过 `AGENT_MEMORY_REMOTE` 环境变量提供 URL，并自行设置安全的 Git 凭据，不要写进项目文件。

修改 `bundle/` 后，运行 `node tools/pack.mjs`，再运行 `npx cap sync android`。在 Android Studio 中构建应用；`android/app/src/main/java/top/arrowwood/phoneagent/TermuxBridgePlugin.java` 是需要保留的原生桥接代码。正式签名使用自己的 `android/keystore.properties` 和证书，这些文件已被忽略。

默认权限模式为 `default`。本地桥接服务监听 `127.0.0.1:7777`；不要把它暴露到公网。开始构建前检查打包生成的 `www/bundle/` 中没有任何私人资料。

## 许可

本仓库的原创源码使用 MIT 许可证，见 `LICENSE`。
