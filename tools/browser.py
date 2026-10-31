"""browser.py — the one headless browser every check script uses.

Playwright's own headless Chromium, driven in real time (no virtual-time
budget: it starves worker messaging and rAF on this app). Each run gets a
fresh browser, so tests never share state.

Pinned to playwright 1.62 because that is the release whose Chromium build
(151) is installed on Max's Mac; a newer playwright refuses the old build.
Scripts keep the house convention `uv run --no-project python tools/check_x.py`
— `ensure_playwright()` re-execs the script through uv with playwright added.

No browser installed -> SKIPPED (exit 0) with the install command, unless
CURVECUT_REQUIRE_BROWSER=1 (CI sets it), which turns that into a failure.

Install the browser once:
  uv run --no-project --with "playwright==1.62.*" python -m playwright install chromium
"""

import os
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PLAYWRIGHT = "playwright==1.62.*"
INSTALL_HINT = (f'uv run --no-project --with "{PLAYWRIGHT}" '
                "python -m playwright install chromium")


def ensure_playwright() -> None:
    """Re-exec the calling script through uv with playwright when it's missing."""
    try:
        import playwright  # noqa: F401
    except ImportError:
        if os.environ.get("CURVECUT_PLAYWRIGHT_REEXEC"):
            print("FAIL: playwright unavailable even after uv re-exec")
            sys.exit(1)
        env = dict(os.environ, CURVECUT_PLAYWRIGHT_REEXEC="1")
        os.execvpe("uv", ["uv", "run", "--no-project", "--with", PLAYWRIGHT,
                          "python", sys.argv[0], *sys.argv[1:]], env)


def page_url(relative: str) -> str:
    """file:// URL for a repo-relative path, keeping any #hash or ?query."""
    path, sep, rest = relative.partition("#")
    base, qsep, query = path.partition("?")
    url = (ROOT / base).resolve().as_uri()
    return url + (qsep + query if qsep else "") + (sep + rest if sep else "")


def finished(title: str) -> bool:
    """Default end condition: the test page set its title to a verdict."""
    return title == "PASS" or title.startswith(("FAIL", "SKIPPED"))


# Headless Chromium defaults to SwiftShader (software GL), which makes frame and
# cut timings ~15x slower than the Mac's real GPU. Perf checks pass these flags
# to get ANGLE-on-Metal, like the Brave runs the budgets were set against.
GPU_ARGS = ("--use-angle=metal", "--ignore-gpu-blocklist", "--enable-gpu")

# Chromium's fetch() refuses file:// URLs ("URL scheme file is not supported")
# even with --allow-file-access-from-files, while XMLHttpRequest still honours
# that flag. The tests fetch ../test-assets/*.stl over file://, so route those
# calls through XHR and hand back a Response (what Brave's fetch did natively).
FILE_FETCH_SHIM = """
(() => {
  const realFetch = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url, location.href);
    if (url.protocol !== 'file:') return realFetch(input, init);
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('GET', url.href);
      xhr.responseType = 'arraybuffer';
      xhr.onload = () => resolve(new Response(xhr.response, {status: 200}));
      xhr.onerror = () => reject(new TypeError('Failed to fetch ' + url.href));
      xhr.send();
    });
  };
})();
"""


@dataclass
class PageResult:
    title: str = "(no title)"
    log: str = ""
    timed_out: bool = False
    values: dict = field(default_factory=dict)
    errors: list = field(default_factory=list)
    skipped: str = ""

    def print_errors(self, limit: int = 10) -> None:
        for line in self.errors[:limit]:
            print(f"  page error: {line}")


def skip_or_fail(reason: str) -> int:
    """Print the no-browser verdict and return the exit code for main()."""
    if os.environ.get("CURVECUT_REQUIRE_BROWSER") == "1":
        print(f"FAIL: {reason} (CURVECUT_REQUIRE_BROWSER=1)")
        return 1
    print(f"SKIPPED: {reason}. Install it with: {INSTALL_HINT}")
    return 0


def run_page(url: str, timeout_s: float, *, done=finished, args=(),
             collect=None, poll_s: float = 0.5) -> PageResult:
    """Open url headless, poll document.title until done(title) or timeout.

    collect: {name: js_expression} evaluated once the page is done; results
    land in PageResult.values. The page's <pre id="log"> text lands in .log.
    """
    ensure_playwright()
    from playwright.sync_api import Error, sync_playwright

    result = PageResult()
    with sync_playwright() as p:
        try:
            browser = p.chromium.launch(headless=True, args=list(args))
        except Error as e:
            if "Executable doesn't exist" in str(e):
                result.skipped = "Playwright's Chromium is not installed"
                return result
            raise
        try:
            page = browser.new_page()
            page.add_init_script(FILE_FETCH_SHIM)
            page.on("pageerror", lambda e: result.errors.append(str(e)))
            page.on("console", lambda m: m.type == "error"
                    and result.errors.append(m.text))
            page.goto(url, wait_until="commit")
            deadline = time.monotonic() + timeout_s
            while True:
                try:
                    result.title = page.title() or "(no title)"
                except Error:
                    pass  # mid-navigation; try again next poll
                if done(result.title):
                    break
                if time.monotonic() > deadline:
                    result.timed_out = True
                    break
                time.sleep(poll_s)
            result.log = page.evaluate(
                "document.getElementById('log')?.textContent ?? ''").strip()
            for name, expression in (collect or {}).items():
                result.values[name] = page.evaluate(expression)
        finally:
            browser.close()
    return result
