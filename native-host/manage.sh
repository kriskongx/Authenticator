#!/usr/bin/env bash
#
# 本机导入助手的管理入口。
#
#   ./manage.sh                     等同 status
#   ./manage.sh install [选项]      注册助手
#   ./manage.sh uninstall          取消注册
#   ./manage.sh config [--json|-path]
#   ./manage.sh test               协议自测
#   ./manage.sh -h | --help        帮助
#
# 注册与协议自测复用同目录下的 install.js / test-host.js；
# 读取 config.json 与调用助手（native messaging 的二进制帧）交给 node，
# 其余输出格式全部由本脚本负责。

set -u

# `./manage.sh status | head` closes stdout early. The printf builtin then
# prints "write error: Broken pipe" for every line; the external binary simply
# dies on SIGPIPE, which is what a well-behaved CLI should do.
printf() {
  /usr/bin/printf "$@"
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST_NAME="com.otp_ee.authenticator_import"
BASE_DIR="$HOME/.authenticator-import"
CONFIG_PATH="$BASE_DIR/config.json"
STATE_PATH="$BASE_DIR/state.json"
RUNNER="$SCRIPT_DIR/run.sh"
HOST_JS="$SCRIPT_DIR/host.js"
DEFAULT_EXTENSION_ID="eoakhgdmgldjbddiafblclidpemcnice"

usage() {
  cat <<'EOF'
用法：./manage.sh <命令> [选项]

命令：
  status                     查看注册状态、运行文件、配置、导入记录并自检（默认）
  install                    注册助手
  uninstall                  取消注册（保留配置、收件箱与导入记录）
  config                     查看生效配置
  test                       运行 native-host 协议自测
  help                       显示本帮助

选项：
  -h, --help                 显示本帮助
  --extension-id <id>        install 用：指定扩展 ID（32 位，a–p）
  --dir <path>               install 用：监听目录（仅首次生成 config.json 时生效）
  --node <path>              install 用：写进 run.sh 的 node 绝对路径
  --json                     config 用：输出合并默认值后的 JSON
  -path, --path              config 用：只输出配置文件路径

环境变量：
  AUTHENTICATOR_EXTENSION_ID  等价于 --extension-id
  AUTHENTICATOR_NODE          等价于 --node

示例：
  ./manage.sh
  ./manage.sh install
  ./manage.sh install --node /usr/local/bin/node
  ./manage.sh config --json
EOF
}

die() {
  printf '%s\n' "$*" >&2
  exit 1
}

manifest_path() {
  case "$1" in
    chrome) printf '%s' "$HOME/Library/Application Support/Google/Chrome/NativeMessagingHosts/$HOST_NAME.json" ;;
    edge) printf '%s' "$HOME/Library/Application Support/Microsoft Edge/NativeMessagingHosts/$HOST_NAME.json" ;;
    firefox) printf '%s' "$HOME/Library/Application Support/Mozilla/NativeMessagingHosts/$HOST_NAME.json" ;;
  esac
}

browser_label() {
  case "$1" in
    chrome) printf 'Chrome ' ;;
    edge) printf 'Edge   ' ;;
    firefox) printf 'Firefox' ;;
  esac
}

registered_id() {
  local browser manifest found
  for browser in chrome edge firefox; do
    manifest="$(manifest_path "$browser")"
    [ -f "$manifest" ] || continue
    found="$(grep -oE 'chrome-extension://[a-p]{32}' "$manifest" 2>/dev/null | head -1)"
    if [ -n "$found" ]; then
      printf '%s' "${found#chrome-extension://}"
      return 0
    fi
  done
  return 0
}

runner_node() {
  [ -f "$RUNNER" ] || return 0
  sed -n 's/^exec "\([^"]*\)".*/\1/p' "$RUNNER" | head -1
}

short_path() {
  case "$1" in
    "" ) printf '%s' "" ;;
    "$HOME"/*) printf '~%s' "${1#"$HOME"}" ;;
    *) printf '%s' "$1" ;;
  esac
}

format_bytes() {
  local bytes="${1:-0}"
  if [ "$bytes" -ge 1048576 ]; then
    local tenths=$(((bytes * 10 + 524288) / 1048576))
    if [ $((tenths % 10)) -eq 0 ]; then
      printf '%d MB' $((tenths / 10))
    else
      printf '%d.%d MB' $((tenths / 10)) $((tenths % 10))
    fi
  elif [ "$bytes" -ge 1024 ]; then
    printf '%d KB' $((bytes / 1024))
  else
    printf '%d B' "$bytes"
  fi
}

format_time() {
  local millis="${1:-0}" seconds
  [ "$millis" -gt 0 ] || return 0
  seconds=$((millis / 1000))
  if date -r 0 +%s >/dev/null 2>&1; then
    date -r "$seconds" '+%m/%d %H:%M'
  else
    date -d "@$seconds" '+%m/%d %H:%M'
  fi
}

# 读取生效配置与收件箱状态，输出制表符分隔的键值对。
gather_facts() {
  HOST_DIR="$SCRIPT_DIR" node - <<'NODE'
const fs = require("fs");
const os = require("os");
const path = require("path");

const base = path.join(os.homedir(), ".authenticator-import");
const configPath = path.join(base, "config.json");
const statePath = path.join(base, "state.json");
const defaults = {
  dir: path.join(base, "inbox"),
  pattern: "\\.json$",
  maxBytes: 100 * 1024 * 1024,
  deleteAfterImport: true,
  intervalMinutes: 5,
};

const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

const raw = readJson(configPath) || {};
const config = { ...defaults, ...raw };
const emit = (key, value) => process.stdout.write(`${key}\t${value}\n`);

emit("config_path", configPath);
emit("config_exists", fs.existsSync(configPath) ? 1 : 0);
emit("dir", config.dir);
emit("dir_exists", fs.existsSync(config.dir) ? 1 : 0);
emit("pattern", String(config.pattern));
emit("pattern_default", raw.pattern === undefined ? 1 : 0);
emit("max_bytes", Number(config.maxBytes) || 0);
emit("max_bytes_default", raw.maxBytes === undefined ? 1 : 0);
emit("delete_after", config.deleteAfterImport === false ? 0 : 1);
emit("delete_default", raw.deleteAfterImport === undefined ? 1 : 0);
emit("interval", Number(config.intervalMinutes) || 0);
emit("interval_default", raw.intervalMinutes === undefined ? 1 : 0);

let files = [];
try {
  const re = new RegExp(config.pattern);
  files = fs
    .readdirSync(config.dir)
    .filter((name) => re.test(name))
    .map((name) => {
      try {
        const stat = fs.statSync(path.join(config.dir, name));
        return stat.isFile() && stat.size > 0
          ? { name, size: stat.size, mtime: stat.mtimeMs }
          : null;
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .sort((left, right) => right.mtime - left.mtime);
} catch {}

emit("file_count", files.length);
emit("latest_name", files.length ? files[0].name : "");
emit("latest_size", files.length ? files[0].size : 0);
emit("latest_mtime", files.length ? Math.round(files[0].mtime) : 0);

const state = readJson(statePath) || {};
emit("imported_count", Object.keys(state.imported || {}).length);
emit("last_name", state.lastImported ? state.lastImported.name : "");
emit("last_at", state.lastImported ? Math.round(state.lastImported.at) : 0);
NODE
}

# 真的拉起一次助手，按 Chrome 的协议发一帧 status。
check_host() {
  RUNNER="$RUNNER" node - <<'NODE'
const { spawn } = require("child_process");

const runner = process.env.RUNNER;
const emit = (key, value) => process.stdout.write(`${key}\t${value}\n`);
let settled = false;

const finish = (payload) => {
  if (settled) {
    return;
  }
  settled = true;
  for (const [key, value] of Object.entries(payload)) {
    emit(key, value);
  }
};

// stdin scripts are evaluated as scripts, not modules: no top-level return.
let child = null;
try {
  child = spawn(runner, [], { stdio: ["pipe", "pipe", "pipe"] });
} catch (error) {
  finish({ check: "fail", check_detail: error.message });
  process.exit(0);
}

let buffered = Buffer.alloc(0);
let stderr = "";
const timer = setTimeout(() => {
  finish({ check: "fail", check_detail: "助手在 6 秒内没有响应" });
  child.kill();
}, 6000);

child.on("error", (error) => {
  clearTimeout(timer);
  finish({ check: "fail", check_detail: error.message });
});
child.on("exit", (code) => {
  clearTimeout(timer);
  finish({
    check: "fail",
    check_detail: `助手退出（code ${code}）${stderr ? `: ${stderr.trim()}` : ""}`,
  });
});
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});
child.stdout.on("data", (chunk) => {
  buffered = Buffer.concat([buffered, chunk]);
  if (buffered.length < 4) {
    return;
  }
  const length = buffered.readUInt32LE(0);
  if (buffered.length < 4 + length) {
    return;
  }
  clearTimeout(timer);
  let response;
  try {
    response = JSON.parse(buffered.subarray(4, 4 + length).toString("utf8"));
  } catch (error) {
    finish({ check: "fail", check_detail: error.message });
    child.kill();
    return;
  }
  if (response.ok === false) {
    finish({ check: "fail", check_detail: response.error || "助手返回错误" });
  } else {
    finish({
      check: "ok",
      check_dir: response.dir || "",
      check_dir_exists: response.dirExists === false ? 0 : 1,
      check_pending: response.pending ? response.pending.name : "",
    });
  }
  child.kill();
});

const body = Buffer.from(JSON.stringify({ id: 1, type: "status" }), "utf8");
const header = Buffer.alloc(4);
header.writeUInt32LE(body.length, 0);
child.stdin.write(Buffer.concat([header, body]));
NODE
}

print_config_block() {
  local key value
  local cfg_path="" cfg_exists=0 dir="" dir_exists=0 pattern="" pattern_default=0
  local max_bytes=0 max_bytes_default=0 delete_after=1 delete_default=0
  local interval=0 interval_default=0 file_count=0
  local latest_name="" latest_size=0 latest_mtime=0

  while IFS=$'\t' read -r key value; do
    case "$key" in
      config_path) cfg_path="$value" ;;
      config_exists) cfg_exists="$value" ;;
      dir) dir="$value" ;;
      dir_exists) dir_exists="$value" ;;
      pattern) pattern="$value" ;;
      pattern_default) pattern_default="$value" ;;
      max_bytes) max_bytes="$value" ;;
      max_bytes_default) max_bytes_default="$value" ;;
      delete_after) delete_after="$value" ;;
      delete_default) delete_default="$value" ;;
      interval) interval="$value" ;;
      interval_default) interval_default="$value" ;;
      file_count) file_count="$value" ;;
      latest_name) latest_name="$value" ;;
      latest_size) latest_size="$value" ;;
      latest_mtime) latest_mtime="$value" ;;
    esac
  done < <(gather_facts)

  if [ "$cfg_exists" = "1" ]; then
    printf '配置      %s\n' "$(short_path "$cfg_path")"
    printf '          （改完打开一次扩展设置页即可生效，不必重装）\n'
  else
    printf '配置      %s（不存在，全部使用默认值）\n' "$(short_path "$cfg_path")"
  fi
  printf '\n'

  local dir_note="目录不存在"
  [ "$dir_exists" = "1" ] && dir_note="存在，${file_count} 个匹配文件"
  printf '  目录      %s  %s\n' "$(short_path "$dir")" "$dir_note"

  local suffix=""
  [ "$pattern_default" = "1" ] && suffix="  (默认)"
  printf '  匹配      %s%s\n' "$pattern" "$suffix"

  suffix=""
  [ "$max_bytes_default" = "1" ] && suffix="  (默认)"
  printf '  大小上限  %s%s\n' "$(format_bytes "$max_bytes")" "$suffix"

  suffix=""
  [ "$delete_default" = "1" ] && suffix="  (默认)"
  if [ "$delete_after" = "1" ]; then
    printf '  导入后    删除文件%s\n' "$suffix"
  else
    printf '  导入后    保留文件%s\n' "$suffix"
  fi

  suffix=""
  [ "$interval_default" = "1" ] && suffix="  (默认)"
  printf '  间隔      %s 分钟%s\n' "$interval" "$suffix"

  if [ -n "$latest_name" ]; then
    printf '  最新文件  %s  %s  %s\n' \
      "$latest_name" "$(format_bytes "$latest_size")" "$(format_time "$latest_mtime")"
  fi
}

cmd_status() {
  local id id_source registered
  registered="$(registered_id)"
  if [ -n "${AUTHENTICATOR_EXTENSION_ID:-}" ]; then
    id="$AUTHENTICATOR_EXTENSION_ID"
    id_source="环境变量"
  elif [ -n "$registered" ]; then
    id="$registered"
    id_source="已注册清单"
  else
    id="$DEFAULT_EXTENSION_ID"
    id_source="内置默认"
  fi

  printf '本机助手  %s\n' "$HOST_NAME"
  printf '  扩展 ID  %s  (%s)\n\n' "$id" "$id_source"

  printf '注册清单\n'
  local browser manifest total=0 target
  for browser in chrome edge firefox; do
    manifest="$(manifest_path "$browser")"
    if [ ! -f "$manifest" ]; then
      printf '· %s  未注册\n' "$(browser_label "$browser")"
      continue
    fi
    total=$((total + 1))
    target="$(sed -n 's/.*"path": *"\(.*\)".*/\1/p' "$manifest" | head -1)"
    if [ -n "$target" ] && [ -e "$target" ]; then
      printf '✔ %s  %s\n' "$(browser_label "$browser")" "$(short_path "$manifest")"
    else
      printf '✖ %s  %s  → 指向的脚本不存在\n' "$(browser_label "$browser")" "$(short_path "$manifest")"
    fi
  done
  if [ "$total" -eq 0 ]; then
    printf '\n  还没有注册。运行：%s install\n' "$(basename "$0")"
  fi
  printf '\n'

  printf '运行文件\n'
  local node_path node_state
  node_path="$(runner_node)"
  if [ -f "$RUNNER" ]; then
    printf '✔ run.sh    %s\n' "$(short_path "$RUNNER")"
  else
    printf '✖ run.sh    %s\n' "$(short_path "$RUNNER")"
  fi
  if [ -f "$HOST_JS" ]; then
    printf '✔ host.js   %s\n' "$(short_path "$HOST_JS")"
  else
    printf '✖ host.js   %s\n' "$(short_path "$HOST_JS")"
  fi
  if [ -z "$node_path" ]; then
    printf '· node      run.sh 未生成，无法确定\n'
  elif [ -x "$node_path" ]; then
    printf '✔ node      %s\n' "$(short_path "$node_path")"
  else
    printf '✖ node      %s  (不存在或不可执行)\n' "$(short_path "$node_path")"
  fi
  printf '\n'

  print_config_block
  printf '\n'

  printf '导入记录\n'
  local imported_count=0 last_name="" last_at=0 key value
  while IFS=$'\t' read -r key value; do
    case "$key" in
      imported_count) imported_count="$value" ;;
      last_name) last_name="$value" ;;
      last_at) last_at="$value" ;;
    esac
  done < <(gather_facts)

  if [ -n "$last_name" ]; then
    printf '  上次导入  %s  %s\n' "$last_name" "$(format_time "$last_at")"
  elif [ "$imported_count" -gt 0 ]; then
    printf '  上次导入  时间未知 · 已记录 %s 个文件\n' "$imported_count"
  else
    printf '  上次导入  还没有导入过\n'
  fi
  printf '\n'

  printf '自检\n'
  if [ ! -f "$RUNNER" ]; then
    printf '· 连接助手  跳过（run.sh 不存在，先运行 install）\n'
    return 0
  fi

  local check="" check_detail="" check_dir="" check_dir_exists=1 check_pending=""
  while IFS=$'\t' read -r key value; do
    case "$key" in
      check) check="$value" ;;
      check_detail) check_detail="$value" ;;
      check_dir) check_dir="$value" ;;
      check_dir_exists) check_dir_exists="$value" ;;
      check_pending) check_pending="$value" ;;
    esac
  done < <(check_host)

  if [ "$check" != "ok" ]; then
    printf '✖ 连接助手  失败：%s\n' "${check_detail:-未知错误}"
    return 0
  fi
  printf '✔ 连接助手  正常\n'
  if [ "$check_dir_exists" = "1" ]; then
    printf '  监听目录  %s\n' "$(short_path "$check_dir")"
  else
    printf '  监听目录  %s  (不存在)\n' "$(short_path "$check_dir")"
  fi
  if [ -n "$check_pending" ]; then
    printf '  待导入    %s\n' "$check_pending"
  else
    printf '  待导入    无\n'
  fi
}

cmd_config() {
  if [ "${PATH_ONLY:-0}" = "1" ]; then
    printf '%s\n' "$CONFIG_PATH"
    return 0
  fi
  if [ "${JSON_MODE:-0}" = "1" ]; then
    CONFIG_PATH="$CONFIG_PATH" node - <<'NODE'
const fs = require("fs");
const os = require("os");
const path = require("path");

const base = path.join(os.homedir(), ".authenticator-import");
const defaults = {
  dir: path.join(base, "inbox"),
  pattern: "\\.json$",
  maxBytes: 100 * 1024 * 1024,
  deleteAfterImport: true,
  intervalMinutes: 5,
};
let raw = {};
try {
  raw = JSON.parse(fs.readFileSync(process.env.CONFIG_PATH, "utf8"));
} catch {}
process.stdout.write(`${JSON.stringify({ ...defaults, ...raw }, null, 2)}\n`);
NODE
    return 0
  fi
  print_config_block
}

cmd_install() {
  local id registered
  registered="$(registered_id)"
  if [ -n "${EXT_ID_ARG:-}" ]; then
    id="$EXT_ID_ARG"
  elif [ -n "${AUTHENTICATOR_EXTENSION_ID:-}" ]; then
    id="$AUTHENTICATOR_EXTENSION_ID"
  elif [ -n "$registered" ]; then
    id="$registered"
  else
    id="$DEFAULT_EXTENSION_ID"
  fi

  local node_bin
  if [ -n "${NODE_ARG:-}" ]; then
    node_bin="$NODE_ARG"
  elif [ -n "${AUTHENTICATOR_NODE:-}" ]; then
    node_bin="$AUTHENTICATOR_NODE"
  elif [ -n "$(runner_node)" ] && [ -x "$(runner_node)" ]; then
    node_bin="$(runner_node)"
  elif [ -x "$HOME/.local/bin/node" ]; then
    node_bin="$HOME/.local/bin/node"
  else
    node_bin="$(command -v node || true)"
  fi
  [ -n "$node_bin" ] || die "找不到 node，请用 --node 指定路径"

  local -a install_args=(--extension-id "$id" --node "$node_bin")
  [ -n "${DIR_ARG:-}" ] && install_args+=(--dir "$DIR_ARG")

  printf '安装助手：扩展 ID %s\n' "$id"
  printf '          node %s\n\n' "$node_bin"
  node "$SCRIPT_DIR/install.js" "${install_args[@]}"
  printf '下一步：重启浏览器（Chrome 会缓存清单），然后在扩展设置里打开「本地自动导入」。\n'
}

cmd_uninstall() {
  local browser manifest found=0
  for browser in chrome edge firefox; do
    manifest="$(manifest_path "$browser")"
    [ -f "$manifest" ] && found=1
  done
  if [ "$found" -eq 0 ] && [ ! -f "$RUNNER" ]; then
    printf '没有已注册的助手，无需卸载。\n'
    return 0
  fi
  node "$SCRIPT_DIR/install.js" --uninstall
  printf '\n已取消注册。配置、收件箱与导入记录都保留在 %s\n' "$(short_path "$BASE_DIR")"
  printf '要彻底清理，再执行：rm -rf %s\n' "$(short_path "$BASE_DIR")"
  printf '记得在扩展设置里关掉「本地自动导入」开关，重启浏览器后生效。\n'
}

cmd_test() {
  node "$SCRIPT_DIR/test-host.js"
}

main() {
  local cmd="status" ext_id_arg="" dir_arg="" node_arg=""
  JSON_MODE=0
  PATH_ONLY=0

  while [ $# -gt 0 ]; do
    case "$1" in
      -h|--help|help|usage)
        usage
        exit 0
        ;;
      status|install|uninstall|config|test)
        cmd="$1"
        shift
        ;;
      --extension-id)
        ext_id_arg="${2:-}"
        [ -n "$ext_id_arg" ] || die "--extension-id 需要一个值"
        shift 2
        ;;
      --dir)
        dir_arg="${2:-}"
        [ -n "$dir_arg" ] || die "--dir 需要一个值"
        shift 2
        ;;
      --node)
        node_arg="${2:-}"
        [ -n "$node_arg" ] || die "--node 需要一个值"
        shift 2
        ;;
      --json)
        JSON_MODE=1
        shift
        ;;
      -path|--path)
        PATH_ONLY=1
        shift
        ;;
      *)
        printf '未知参数：%s\n\n' "$1" >&2
        usage >&2
        exit 1
        ;;
    esac
  done

  EXT_ID_ARG="$ext_id_arg"
  DIR_ARG="$dir_arg"
  NODE_ARG="$node_arg"

  command -v node >/dev/null 2>&1 || die "需要 node（助手本身也是 node 程序）"

  case "$cmd" in
    status) cmd_status ;;
    install) cmd_install ;;
    uninstall) cmd_uninstall ;;
    config) cmd_config ;;
    test) cmd_test ;;
  esac
}

main "$@"
