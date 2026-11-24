# 本地自动导入（Vaultwarden → Authenticator）

把 Vaultwarden 定期导出的 JSON 自动导入本扩展，不需要每次手动选文件。

## 1. 为什么需要一个本机助手

浏览器扩展**没有读取本地文件的能力**：`chrome.downloads` 只能知道“下载完成”、拿不到内容；File System Access API 必须由用户手势触发，而且 service worker 里不可用。

所以“文件夹 → 插件”之间需要一层桥，这里用 Chrome 的 native messaging：

```
┌──────────────┐   connectNative   ┌───────────┐   exec   ┌──────────┐
│  扩展（SW）  │ ────────────────► │  run.sh   │ ───────► │ host.js  │
│              │ ◄──────────────── │           │ ◄─────── │ (node)   │
└──────────────┘   长度前缀+JSON   └───────────┘  stdio   └──────────┘
                                                               │ 读
                                                               ▼
                                            ~/.authenticator-import/inbox/*.json
```

`host.js` 是**按需启动**的短命进程，不是守护进程：扩展每 5 分钟连一次，取到文件就导，没文件就退出。

## 2. 工作方式

| 时机 | 行为 |
| --- | --- |
| 打开「本地自动导入」开关 | 立刻尝试导入一次 |
| 每 5 分钟（`chrome.alarms`） | 有新文件就导入，没有就静默退出 |
| 每次解锁成功 | 立刻补跑，把锁定期间攒下的文件导进去 |
| 点「立即导入」 | 手动触发（用于验证安装、重试失败） |

几个关键机制：

- **只导一次**：导入成功后扩展回 `ack(name, digest)`，助手把 `文件名 → 内容摘要` 记进 `state.json`（保留最近 20 条）。同一份内容不会被重复导入；文件内容变了摘要就变，会重新导入。
- **多个文件只认最新**：按修改时间取最新的一份导入，比它旧的文件在 ack 时被标记为已过期（`deleteAfterImport` 为 true 时同时删除），因此旧导出里的过期条目不会被合并回来。想让某个旧文件重新参与，`touch` 一下改变 mtime，或删掉 `state.json`。
- **分块传输**：Chrome 对 host → 扩展的单条消息限制 1 MB，所以按 128 KB 分块读取、在扩展内拼装。
- **导入后删除源文件**：导出文件里是明文 TOTP 密钥，默认导入成功即删除（见 §6）。
- **锁定即跳过**：导入要用主密码派生的密钥写库，锁着写进去就是明文。所以锁定时只跳过，解锁后补跑。
- **失败冷却**：同一份文件导入失败后 30 分钟内不再自动重试，避免每 5 分钟刷一次错误；手动「立即导入」不受此限制。
- **去重**：Vaultwarden 导出每次都给条目生成新 UUID，直接合并会产生重复。导入前会按 `issuer + account + secret` 与库中现有条目比对，已存在的不再插入。

## 3. 前置条件

- macOS（本机助手目前只写了 macOS 的注册路径）
- Node.js（助手的运行环境，无第三方依赖）
- 扩展已构建并在浏览器中加载（`npm run chrome`）
- Vaultwarden 能导出 JSON（Vaultwarden 网页端：工具 → 导出 → `.json`）

## 4. 安装（只做一次）

### 4.1 构建并获取扩展 ID

```sh
npm run chrome
```

在 `chrome://extensions` 中加载 `chrome/` 目录（或重新加载已加载的扩展），复制卡片上的 **32 位 ID**（只含 a–p）。

### 4.2 注册本机助手

推荐用统一的管理脚本（内置扩展 ID 与 node 路径的自动推导）：

```sh
./native-host/manage.sh install
```

它按以下顺序决定扩展 ID：`--extension-id` → `AUTHENTICATOR_EXTENSION_ID` → 已注册清单里的 ID → 内置默认值；node 路径同理：`--node` → `AUTHENTICATOR_NODE` → 现有 `run.sh` 里的路径 → `~/.local/bin/node` → 当前 node。

也可以直接调用底层脚本：

```sh
node native-host/install.js --extension-id <你的扩展ID>
```

可选参数：

| 参数 | 作用 |
| --- | --- |
| `--dir <路径>` | 指定监听目录，默认 `~/.authenticator-import/inbox`；仅在首次生成 `config.json` 时生效 |
| `--node <路径>` | 指定写进 `run.sh` 的 node 绝对路径，默认见上 |
| `--uninstall` | 取消注册：删除浏览器清单与 `run.sh`，保留配置、收件箱与状态文件（详见 §10） |

脚本会写三处：

| 内容 | 位置 |
| --- | --- |
| 浏览器注册清单 | `~/Library/Application Support/{Google/Chrome,Microsoft Edge,Mozilla}/NativeMessagingHosts/com.otp_ee.authenticator_import.json` |
| 启动脚本 | `native-host/run.sh`（已被 git 忽略，内含 node 绝对路径） |
| 配置 | `~/.authenticator-import/config.json` |

要撤销这一步，见 §10「取消注册与卸载」。

### 4.3 重启浏览器

Chrome 会缓存 native host 清单，**不重启可能仍认为没有注册**。

### 4.4 打开开关

扩展弹窗 → 设置 → 备份与恢复 → 最下方的「本地自动导入」→ 打开开关。

开关那一行左边显示**监听目录**（家目录缩成 `~`），下面一行是当前状态：

| 状态 | 含义 |
| --- | --- |
| 未检测到本机助手 | 清单没注册成功，或 `run.sh` 里的 node 路径失效 |
| 待导入 `xxx.json` | 助手找到了新文件 |
| 已连接，暂无新文件 | 一切正常，等下一次导出 |

打开后会在下方展开**当前生效的配置**（即 `config.json` 的内容），不用再开终端确认：

| 行 | 含义 |
| --- | --- |
| 匹配 | 文件名规则（`pattern`）与目录内的文件数量 |
| 上限 | 单文件大小上限（`maxBytes`）与删除策略（`deleteAfterImport`） |
| 间隔 | 轮询间隔（`intervalMinutes`） |
| 上次 | 最近一次成功导入的文件名与时间（悬停可看完整时间）。从未导入时显示「还没有导入过」；旧版 `state.json` 只留了摘要、没有时间戳时显示「时间未知 · N 个文件」 |

### 4.5 在终端查看状态

```sh
./native-host/manage.sh               # 等价于 status
./native-host/manage.sh --help        # 全部命令与选项
```

输出包含四段：注册清单（三个浏览器逐个标 ✔/未注册）、运行文件（`run.sh`、`host.js`、`node` 是否都在）、生效配置（缺省项会标 `(默认)`）、导入记录，最后还会真正拉起一次助手做自检：

```
本机助手  com.otp_ee.authenticator_import
  扩展 ID  eoakhgdmgldjbddiafblclidpemcnice  (已注册清单)

注册清单
✔ Chrome   ~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.otp_ee.authenticator_import.json
✔ Edge     ...
✔ Firefox  ...

运行文件
✔ run.sh   ~/Person/github/Authenticator/native-host/run.sh
✔ host.js  ~/Person/github/Authenticator/native-host/host.js
✔ node     ~/.local/bin/node

配置      ~/.authenticator-import/config.json
  目录     ~/Person/github/auto-sync-1password/export  存在，0 个匹配文件
  匹配     \.json$
  大小上限 100 MB
  导入后   删除文件
  间隔     5 分钟  (默认)

导入记录
  上次导入 还没有导入过

自检
✔ 连接助手 正常
  监听目录 ~/Person/github/auto-sync-1password/export
  待导入   无
```

只看配置：

```sh
./native-host/manage.sh config          # 人类可读
./native-host/manage.sh config --json   # 合并默认值后的 JSON
./native-host/manage.sh config -path    # 只输出文件路径，方便 $EDITOR 打开
```

## 5. 配置

`~/.authenticator-import/config.json`：

```json
{
  "dir": "/Users/you/.authenticator-import/inbox",
  "pattern": "\\.json$",
  "maxBytes": 104857600,
  "deleteAfterImport": true,
  "intervalMinutes": 5
}
```

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `dir` | `~/.authenticator-import/inbox` | 监听目录，取**修改时间最新**的一个文件 |
| `pattern` | `\\.json$` | 文件名正则，用来过滤其他文件 |
| `maxBytes` | 100 MB | 超过则忽略，与扩展侧的导入上限一致 |
| `deleteAfterImport` | `true` | 导入成功后删除源文件；设 `false` 保留 |
| `intervalMinutes` | `5` | 轮询间隔（分钟），范围 1–1440。改完打开一次设置页即生效（不必重装） |

注意两点：

- 配置**只在文件不存在时生成**，重复运行 `install.js --dir` 不会覆盖已有 `config.json`，改目录请直接编辑该文件。
- 环境变量 `AUTHENTICATOR_IMPORT_DIR` 优先级高于 `config.json`。

`~/.authenticator-import/state.json` 是助手自己的记录（`文件名 → sha256`），删掉它会导致同一份文件被再次导入。

## 6. 让 Vaultwarden 定期导出

助手只负责“收文件”，导出方式由你决定。要求只有一条：**最终把 JSON 写进 `dir`，且文件名匹配 `pattern`**。

### 示例 A：Bitwarden CLI

```sh
#!/bin/sh
set -e
export BW_CLIENTID="user.xxxxxxxx"
export BW_CLIENTSECRET="xxxxxxxx"
export BW_PASSWORD="你的主密码"

bw login --apikey >/dev/null 2>&1 || true
SESSION=$(bw unlock --passwordenv BW_PASSWORD --raw)

OUT="$HOME/.authenticator-import/inbox/vaultwarden-$(date +%Y%m%d-%H%M).json"
bw export --format json --output "$OUT" --session "$SESSION"
bw lock >/dev/null
```

### 示例 B：cron 每天 3 点

```cron
0 3 * * * /Users/you/bin/vaultwarden-export.sh >> /tmp/vaultwarden-export.log 2>&1
```

### 关于重复导出

- 内容完全相同的重复导出：摘要一致，不会重复导入。
- 内容有变化（新增/修改了条目）：会导入，且按 `issuer + account + secret` 去重，只插入新的。
- 想固定保留一份导出做备份：把 `deleteAfterImport` 设为 `false`，并让脚本覆盖同一个文件名（否则 `inbox` 会堆积多份明文）。

## 7. 日常使用

正常情况下**不需要任何操作**：脚本导出 → 最多 5 分钟后自动出现在列表里。

唯一的人工动作是解锁密码库：

- 同一个浏览器会话内，把「自动锁定」设为 `0`（永不自动锁），解锁一次之后就不再需要；
- 浏览器退出后，密钥随内存清空，下次启动需要再解锁一次（这是加密本身决定的，见 §8）。

「立即导入」按钮只用于：验证安装是否成功、导入失败后手动重试、不想等 5 分钟。

## 8. 安全说明

**导出文件是明文。** Vaultwarden 的 JSON 导出包含全部 TOTP 密钥，一旦落到磁盘就等于裸奔。因此：

- 默认导入成功即删除，且**不进废纸篓**（`unlink`），删了不可恢复；
- 若设为保留，建议目录权限收紧：`chmod 700 ~/.authenticator-import/inbox`。

**为什么锁定状态必须拒绝导入。** 写入条目走 `EntryStorage.getImportPayload(encryption, …)`：密钥为空时它**不加密**，条目会以明文写进一个已经加密的密码库。从外部完全看不出来，但下次导出就是明文泄漏。所以锁定时直接跳过，而不是“先写进去再说”。

**密钥在哪里。** 解锁后的密钥只存在 `chrome.storage.session`（内存），浏览器退出即清空。想“连解锁都省掉”只能把密钥持久化（例如塞进 Keychain），那等于把钥匙和锁放在同一个兜里，本实现没有这么做。

**助手进程的权限。** `host.js` 以你的用户身份运行，能读写你有权限的任何文件。它本身只做三件事：列目录、按摘要读文件、删除已导入的文件。

**扩展新增的权限。** `nativeMessaging`——允许扩展启动已在系统注册的本机程序。它不能启动任意程序，只能启动清单里登记的那一个。

## 9. 排障

| 现象 | 原因 | 处理 |
| --- | --- | --- |
| 状态显示「未检测到本机助手」 | 清单没注册 / 浏览器没重启 / node 路径失效 | 重跑 `install.js`；`cat native-host/run.sh` 看 node 是否存在；重启浏览器 |
| 显示「已连接，暂无新文件」但目录里有文件 | 文件名不匹配 `pattern`、文件为空、或已被导入过 | 改名为 `*.json`；删 `state.json` 可强制重导 |
| 一直「待导入」不消失 | 密码库锁定中 | 解锁后会立刻补跑 |
| 导入报 `vaultLocked` | 解锁中途锁了 | 解锁后自动重试，无需处理 |
| 导入报 `noImportableEntries` | 导出里没有 `login.totp` 字段 | 确认 Vaultwarden 条目确实配了 TOTP |
| 导入报 `backupContentTooLarge` | 超过 100 MB | 拆分或调整 `maxBytes` |
| 列表出现重复条目 | 旧版本导入（无去重）留下的 | 手动删除重复项，之后的导入不会再产生 |

常用命令：

```sh
cat native-host/run.sh                                  # 看 node 与脚本路径
cat ~/.authenticator-import/config.json                 # 看监听目录
ls -l ~/.authenticator-import/inbox                     # 看有没有文件
ps aux | grep authenticator-import                      # 正常情况下查不到常驻进程
node native-host/test-host.js                           # 协议自测（临时目录，不动真实数据）
```

扩展侧日志：`chrome://extensions` → 本扩展 → 「服务工作进程」→ 控制台，筛 `[background]`。

## 10. 取消注册与卸载

三种程度，按需要选一种。**先关开关再卸载**：开关关掉会同时清掉定时任务，否则清单删了、扩展还会每隔几分钟尝试连接一次（失败但会在控制台留噪声）。

### 10.1 只暂停：关开关（推荐日常用）

扩展弹窗 → 设置 → 备份与恢复 → 关掉「本地自动导入」。

清单和脚本都保留，随时可以再打开；定时任务会被清除，不再轮询。

### 10.2 取消注册：删清单（保留导出目录与记录）

```sh
./native-host/manage.sh uninstall
```

等价于 `node native-host/install.js --uninstall`，只是会先检查是否真的注册过。删掉三份浏览器清单和一个启动脚本：

| 删除 | 说明 |
| --- | --- |
| `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/com.otp_ee.authenticator_import.json` | Chrome |
| `~/Library/Application Support/Microsoft Edge/NativeMessagingHosts/com.otp_ee.authenticator_import.json` | Edge |
| `~/Library/Application Support/Mozilla/NativeMessagingHosts/com.otp_ee.authenticator_import.json` | Firefox |
| `native-host/run.sh` | 生成的启动脚本（含 node 绝对路径） |

**保留**以下内容，不会丢数据也不会重导：

| 保留 | 说明 |
| --- | --- |
| `~/.authenticator-import/config.json` | 你的目录、规则、间隔等配置 |
| `~/.authenticator-import/inbox/` | 尚未导入的导出文件 |
| `~/.authenticator-import/state.json` | 已导入记录（删了会导致同一份文件被再次导入） |

仓库里的 `native-host/host.js`、`install.js`、`test-host.js` 不受影响，下次注册直接再跑一遍即可。

**需要重启浏览器**才生效（Chrome 缓存了清单）。如果扩展里的开关还开着，重开设置页会看到：

> 未检测到本机助手，请先运行 native-host/install.js。

（开关已关的话不会显示这块，属正常。）

可以用这行确认清单确实没了：

```sh
ls ~/Library/Application\ Support/Google/Chrome/NativeMessagingHosts/ | grep authenticator
```

### 10.3 彻底清理：连目录一起删

```sh
./native-host/manage.sh uninstall
rm -rf ~/.authenticator-import
```

再关掉扩展里的「本地自动导入」开关。到此为止，注册清单、启动脚本、配置、收件箱与导入记录都已清除（仓库里的 `native-host/*.js` 源码不受影响）。

如果还想把扩展侧的三个标记也清掉（可选，不影响功能；重装同一扩展 ID 时会复用这些键），在扩展页面（如弹窗）的 DevTools 控制台执行：

```js
chrome.storage.local.remove([
  "AuthenticatorLocalImportEnabled",
  "AuthenticatorLocalImportIntervalMinutes",
  "AuthenticatorLocalImportFailure",
]);
```

### 10.4 换扩展 ID / 换机器

未打包扩展的 ID 与路径绑定，换机器或换了扩展目录后旧清单会失效。正确顺序：

```sh
./native-host/manage.sh uninstall                       # 先清掉旧 ID 的清单
./native-host/manage.sh install --extension-id <新ID>    # 再用新 ID 注册
```

`inbox` 与 `state.json` 都会保留，已经导入过的文件不会被重复导入。

## 11. 已知限制

- **扩展 ID 不稳定**：未打包扩展的 ID 与路径绑定，换机器要重跑 `install.js` 传新 ID。固定 ID 需要在 manifest 加 `"key"`，但那会换掉当前 ID、现有密码库数据不会迁移。
- **5 分钟粒度**：Chrome alarm 的最小间隔，导出后最多延迟 5 分钟。
- **浏览器关闭期间不导入**：文件不会丢，下次启动并解锁后补上。
- **只在 Chromium 开放**：设置页的开关目前仅 Chromium 显示，Firefox 的注册清单虽然会写，但未做验证。
- **只处理 TOTP 字段**：登录密码、备注等非 TOTP 内容不会导入。
- **合并语义**：不提供“整体替换”。若要镜像式覆盖，需要额外开发 `clearFirst` 选项（当前固定为合并 + 去重）。

## 12. 开发者参考

### 协议

stdio，消息 = 4 字节小端长度前缀 + UTF-8 JSON。请求带自增 `id`，响应原样带回。

| 请求 | 响应 |
| --- | --- |
| `{"id":1,"type":"ping"}` | `{ok:true, dir}` |
| `{"id":2,"type":"status"}` | `{ok:true, dir, dirExists, maxBytes, pending: {name,size,mtime,digest} \| null}` |
| `{"id":3,"type":"read","name","offset","length"}` | `{ok:true, name, offset, total, length, eof, data(base64)}` |
| `{"id":4,"type":"ack","name","digest"}` | `{ok:true, name, deleted, imported[]}` |

错误统一 `{ok:false, error:"invalidName" \| "backupNotFound" \| "invalidDigest" \| "configInvalid" \| "unknownRequest"}`。

### 文件

| 路径 | 作用 |
| --- | --- |
| `native-host/host.js` | 本机助手，实现上面的协议 |
| `native-host/install.js` | 注册/卸载的底层实现，被 `manage.sh` 调用 |
| `native-host/manage.sh` | 统一入口（bash）：`status` / `install` / `uninstall` / `config` / `test`，支持 `-h/--help` |
| `native-host/test-host.js` | 协议自测 |
| `src/models/local-import.ts` | 扩展侧：连接助手、分块拉取、调用导入、ack、失败冷却 |
| `src/models/import-api.ts` | 导入执行器（解析 → 解密 → 去重 → 写库），要求密码库已解锁 |
| `src/background.ts` | alarm、解锁补跑、内部动作 `runLocalImport` / `setLocalImport` |
| `src/components/Popup/SetPasswordPage.vue` | 设置页开关与状态 |
