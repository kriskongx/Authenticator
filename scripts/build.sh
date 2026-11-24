#!/bin/bash

# Extension build script
# Syntax:
#   build.sh <platform>
# Platforms:
#   'chrome', 'firefox', 'edge', 'test', or 'prod'

PLATFORM=$1
REMOTE=$(git config --get remote.origin.url)
CREDS=$(cat ./src/models/credentials.ts | tr -d '\n')
CREDREGEX='^.*".+".*".+".*".+".*".+".*".+".*$'
set -e

if [[ $PLATFORM != "chrome" ]] && [[ $PLATFORM != "firefox" ]] && [[ $PLATFORM != "edge" ]] && [[ $PLATFORM != "prod" ]] && [[ $PLATFORM != "test" ]]; then
    echo "Invalid platform type. Supported platforms are 'chrome', 'firefox', 'test', and 'prod'"
    exit 1
fi

echo "Removing old build files..."
rm -rf build dist
rm -rf firefox chrome edge release test
echo "Checking style..."
npm run format:check --silent

./node_modules/.bin/eslint . --ext .js,.ts

if ! [[ $CREDS =~ $CREDREGEX ]] ; then
    echo "Warning: Missing info in src/models/credentials.ts"
    echo "Continuing without API keys (some backup providers may not work)."
fi

if ! [[ $REMOTE = *"https://github.com/Authenticator-Extension/Authenticator.git"* || $REMOTE = *"git@github.com:Authenticator-Extension/Authenticator.git"* || $CI ]] ; then
    echo
    echo -e "\e[7m\033[33mNotice\033[0m"
    echo
    echo -e "Thanks for forking Authenticator! If you plan on redistributing your own version of Authenticator please generate your own API keys and put them in ./src/models/credentials.ts and ./manifest-chrome.json"
    echo "Clear this warning by commenting it out in ./scripts/build.sh"
    echo
    if [[ -t 0 ]]; then
        read -rsp $'Press any key to continue...\n' -n1 key
        echo
    fi
fi

echo "Compiling..."
if [[ $PLATFORM = "prod" ]]; then
    ./node_modules/webpack-cli/bin/cli.js --config webpack.prod.js
elif [[ $PLATFORM = "test" ]]; then
    ./node_modules/webpack-cli/bin/cli.js --config webpack.dev.js
    ./node_modules/.bin/tsc --target ES2015 --esModuleInterop --moduleResolution nodenext --module commonjs scripts/test-runner.ts
else
    ./node_modules/webpack-cli/bin/cli.js
fi
./node_modules/sass/sass.js sass:css
./node_modules/sass/sass.js sass/biometric.scss:css/biometric.css
cp ./sass/DroidSansMono.woff2 ./sass/mocha.css ./css/

AUTHENTICATOR_VERSION=$(node -p "require('./package.json').version")
# License generation walks the whole node_modules tree and can stall (pnpm store,
# puppeteer cache, registry lookups). Bound it, and let local builds skip it:
#   SKIP_LICENSES=1 npm run chrome
#   LICENSE_TIMEOUT=180 npm run chrome
if [[ -n "${SKIP_LICENSES:-}" ]]; then
    echo "Skipping license generation (SKIP_LICENSES=${SKIP_LICENSES})."
else
    LICENSE_TIMEOUT=${LICENSE_TIMEOUT:-15}
    echo "Generating licenses file... (timeout ${LICENSE_TIMEOUT}s)"
    ./node_modules/.bin/npm-license-generator \
        --out-path ./view/licenses.html \
        --template ./scripts/licenses-template.html \
        --error-missing=false &
    LICENSE_PID=$!
    ( sleep "$LICENSE_TIMEOUT"
      pkill -TERM -P "$LICENSE_PID" >/dev/null 2>&1 || true
      kill -TERM "$LICENSE_PID" >/dev/null 2>&1 || true ) &
    WATCHDOG_PID=$!
    LICENSE_OK=1
    if wait "$LICENSE_PID"; then
        kill -TERM "$WATCHDOG_PID" >/dev/null 2>&1 || true
    else
        kill -TERM "$WATCHDOG_PID" >/dev/null 2>&1 || true
        LICENSE_OK=0
        echo "Warning: license generation failed or timed out after ${LICENSE_TIMEOUT}s."
        echo "         Keeping the existing view/licenses.html."
        echo "         Skip it next time with: SKIP_LICENSES=1 npm run chrome"
    fi
    wait "$WATCHDOG_PID" >/dev/null 2>&1 || true
    if [[ $LICENSE_OK -eq 1 ]]; then
        node -e "const fs = require('fs'); const file = './view/licenses.html'; const version = process.argv[1]; fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/__AUTHENTICATOR_VERSION__/g, version));" "$AUTHENTICATOR_VERSION"
    fi
fi

postCompile () {
    mkdir $1
    cp -r dist css images _locales LICENSE view $1

    if [[ $PLATFORM == "test" ]]; then
        cp manifests/manifest-$1-testing.json $1/manifest.json
    else
        cp manifests/manifest-$1.json $1/manifest.json
    fi

    if [[ $1 = "chrome" ]] || [[ $1 = "edge" ]]; then
        cp manifests/schema-chrome.json $1/schema.json
    fi

    cp manifests/manifest-pwa.json $1/manifest-pwa.json
}

if [[ $PLATFORM = "prod" ]]; then
    postCompile "chrome"
    postCompile "firefox"
    postCompile "edge"
    mkdir release
    mv chrome firefox edge release
elif [[ $PLATFORM = "test" ]]; then
    postCompile "chrome"
    postCompile "firefox"
    mkdir test
    mv chrome firefox test
else
    postCompile $PLATFORM
fi

echo -e "\033[0;32mDone!\033[0m"
