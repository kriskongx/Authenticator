import puppeteer from "puppeteer";
import path from "path";
import fs from "fs";
import os from "os";
import merge from "lodash/merge";

interface MochaTestResults {
  total?: number;
  tests?: StrippedTestResults[];
  completed?: boolean;
}

interface StrippedTestResults {
  title: string;
  duration: number;
  path: string[];
  err?: string;
  status: "failed" | "passed" | "pending";
}

declare global {
  interface Window {
    __mocha_test_results__: MochaTestResults;
  }
}

interface TestDisplay {
  [key: string]: TestDisplay | StrippedTestResults;
}

const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  red: "\x1b[31m",
};

const debug = (message: string) => {
  if (process.env.ENABLE_CONSOLE) {
    console.log(`[test-runner] ${message}`);
  }
};

async function closeBrowser(
  browser: Awaited<ReturnType<typeof puppeteer.launch>>
) {
  const browserProcess = browser.process();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      browser.close(),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("Browser close timed out")),
          5000
        );
      }),
    ]);
  } catch (error) {
    debug(`Browser close failed: ${String(error)}`);
    browserProcess?.kill("SIGKILL");
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

async function runTests() {
  const profileDirectory = fs.mkdtempSync(
    path.join(os.tmpdir(), "authenticator-tests-")
  );
  const extensionPath = path.resolve(__dirname, "../test/chrome");
  const puppeteerArgs: string[] = [
    `--load-extension=${extensionPath}`,
    "--no-sandbox",
    "--lang=en-US,en",
    "--disable-breakpad",
    "--disable-crash-reporter",
    "--disable-crashpad",
  ];

  let browser: Awaited<ReturnType<typeof puppeteer.launch>> | undefined;
  try {
    debug("Launching browser...");
    browser = await puppeteer.launch({
      ignoreDefaultArgs: ["--disable-extensions"],
      args: puppeteerArgs,
      headless: process.env.HEADLESS === "true",
      executablePath: process.env.PUPPETEER_EXEC_PATH,
      userDataDir: profileDirectory,
      env: { ...process.env, HOME: profileDirectory },
      timeout: 20000,
    });
    debug("Browser launched.");
    const mochaPage = await browser.newPage();
    let pageErrorDetected = false;
    mochaPage.on("pageerror", (error) => {
      pageErrorDetected = true;
      console.error(`Test page error: ${error.message}`);
    });

    if (process.env.ENABLE_CONSOLE) {
      mochaPage.on("console", (consoleMessage) => {
        console.log(consoleMessage.text());
      });
    }

    debug("Opening extension test page...");
    const manifest = JSON.parse(
      fs.readFileSync(path.join(extensionPath, "manifest.json"), "utf8")
    );
    const extensionId = manifest.key
      ? Buffer.from(
          require("crypto")
            .createHash("sha256")
            .update(Buffer.from(manifest.key, "base64"))
            .digest()
            .subarray(0, 16)
        )
          .toString("hex")
          .replace(/[0-9a-f]/g, (digit) =>
            String.fromCharCode(parseInt(digit, 16) + 97)
          )
      : "bhghoamapcdpbohphigoooaddinpkbai";
    await mochaPage.goto(`chrome-extension://${extensionId}/view/test.html`, {
      waitUntil: "load",
      timeout: 20000,
    });
    debug("Waiting for tests to finish...");

    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    const results = await Promise.race([
      mochaPage.evaluate(
        () =>
          new Promise<{ testResults: MochaTestResults }>((resolve) => {
            const finish = () =>
              resolve({ testResults: window.__mocha_test_results__ });
            window.addEventListener("testsComplete", finish, { once: true });
            if (window.__mocha_test_results__?.completed) finish();
          })
      ),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(
          () => reject(new Error("Tests did not finish within 60 seconds.")),
          60000
        );
      }),
    ]);
    if (timeoutId) clearTimeout(timeoutId);

    let failedTest = pageErrorDetected;
    let display: TestDisplay = {};
    if (results?.testResults.tests) {
      for (const test of results.testResults.tests) {
        const tmp: TestDisplay = {};
        test.path.reduce((acc, current, index) => {
          return (acc[current] = test.path.length - 1 === index ? test : {});
        }, tmp);
        display = merge(display, tmp);
      }
    }

    const printDisplayTests = (node: TestDisplay | StrippedTestResults) => {
      for (const key in node) {
        const child = node[key];
        if (typeof child.status === "string") {
          switch (child.status) {
            case "passed":
              console.log(`${colors.green}✓${colors.reset} ${child.title}`);
              break;
            case "failed":
              console.log(`${colors.red}✗ ${child.title}${colors.reset}`);
              if (child.err) console.log(child.err);
              failedTest = true;
              break;
            case "pending":
              console.log(`- ${child.title}`);
              break;
          }
        } else {
          console.log(key);
          printDisplayTests(child);
        }
      }
    };

    printDisplayTests(display);
    if (failedTest) process.exitCode = 1;
  } finally {
    if (browser) await closeBrowser(browser);
    fs.rmSync(profileDirectory, { recursive: true, force: true });
  }
}

runTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
