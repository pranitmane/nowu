import "dotenv/config";

const PROD_BASE = "https://api.pranitmane.com";
const EXPECTED_WEBHOOK_URL = `${PROD_BASE}/webhook`;
const RECENT_ERROR_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

let passed = 0;
let warnings = 0;
let failed = 0;

function pass(msg: string) {
  console.log(`  PASS  ${msg}`);
  passed++;
}

function warn(msg: string) {
  console.log(`  WARN  ${msg}`);
  warnings++;
}

function fail(msg: string) {
  console.log(`  FAIL  ${msg}`);
  failed++;
}

async function checkEnv() {
  console.log("\n[ENV]");
  const botToken = process.env.BOT_TOKEN;
  const apiToken = process.env.API_TOKEN;

  if (botToken) {
    pass("BOT_TOKEN present");
  } else {
    fail("BOT_TOKEN missing from .env");
  }

  if (apiToken) {
    pass("API_TOKEN present");
  } else {
    fail("API_TOKEN missing from .env");
  }

  return { botToken, apiToken };
}

async function checkTelegram(botToken: string) {
  console.log("\n[TELEGRAM]");

  // Check 3: Bot token valid
  let getMeOk = false;
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${botToken}/getMe`
    );
    const data = (await res.json()) as { ok: boolean; result?: { username?: string } };
    if (data.ok) {
      pass(`Bot token valid (@${data.result?.username ?? "unknown"})`);
      getMeOk = true;
    } else {
      fail("Bot token invalid — Telegram rejected it");
    }
  } catch (e) {
    fail(`Bot token check failed — network error: ${(e as Error).message}`);
  }

  if (!getMeOk) return;

  // Checks 4–7: Webhook info
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${botToken}/getWebhookInfo`
    );
    const data = (await res.json()) as {
      ok: boolean;
      result: {
        url: string;
        pending_update_count: number;
        last_error_date?: number;
        last_error_message?: string;
      };
    };

    if (!data.ok) {
      fail("getWebhookInfo returned ok=false");
      return;
    }

    const { url, pending_update_count, last_error_date, last_error_message } =
      data.result;

    // Check 4: URL registered
    if (!url) {
      fail("Webhook URL not registered (empty) — bot will not receive messages");
    } else {
      pass("Webhook URL registered");

      // Check 5: URL correct
      if (url === EXPECTED_WEBHOOK_URL) {
        pass(`Webhook URL correct: ${url}`);
      } else {
        fail(`Webhook URL wrong — got: ${url}, expected: ${EXPECTED_WEBHOOK_URL}`);
      }
    }

    // Check 6: Recent delivery errors
    if (last_error_date) {
      const ageMs = Date.now() - last_error_date * 1000;
      if (ageMs < RECENT_ERROR_THRESHOLD_MS) {
        warn(
          `Recent webhook delivery error (${Math.round(ageMs / 1000)}s ago): ${last_error_message}`
        );
      } else {
        pass(
          `No recent delivery errors (last error ${Math.round(ageMs / 60000)}m ago: ${last_error_message})`
        );
      }
    } else {
      pass("No delivery errors on record");
    }

    // Check 7: Pending updates
    if (pending_update_count > 0) {
      warn(
        `Pending updates: ${pending_update_count} (bot may be catching up or webhook is broken)`
      );
    } else {
      pass("No pending updates");
    }
  } catch (e) {
    fail(`getWebhookInfo failed — network error: ${(e as Error).message}`);
  }
}

async function checkApi(apiToken: string) {
  console.log("\n[API]");

  // Check 8: Worker reachable
  let reachable = false;
  try {
    const res = await fetch(`${PROD_BASE}/posts`);
    await res.text();
    // Any HTTP response (even 401/500) means worker is up
    pass(`Worker reachable (HTTP ${res.status})`);
    reachable = true;
  } catch (e) {
    fail(`Worker unreachable — connection error: ${(e as Error).message}`);
  }

  if (!reachable) return;

  // Check 9: Bad token → 401
  try {
    const res = await fetch(`${PROD_BASE}/posts`, {
      headers: { Authorization: "Bearer invalid-token-health-check" },
    });
    await res.text();
    if (res.status === 401) {
      pass("Auth middleware working (wrong token → 401)");
    } else if (res.status === 500) {
      fail(
        "Auth returned 500 — API_TOKEN may be missing from CF Worker secrets"
      );
    } else {
      fail(`Auth check unexpected status: ${res.status}`);
    }
  } catch (e) {
    fail(`Auth check failed: ${(e as Error).message}`);
  }

  const headers = { Authorization: `Bearer ${apiToken}` };

  // Check 10: GET /posts
  try {
    const res = await fetch(`${PROD_BASE}/posts`, { headers });
    await res.text();
    if (res.status === 200) {
      pass("GET /posts → 200");
    } else {
      fail(`GET /posts → ${res.status}`);
    }
  } catch (e) {
    fail(`GET /posts failed: ${(e as Error).message}`);
  }

  // Checks 11 + 12: GET /posts/stats + shape validation
  try {
    const res = await fetch(`${PROD_BASE}/posts/stats`, { headers });
    if (res.status !== 200) {
      const body = await res.text();
      fail(`GET /posts/stats → ${res.status} — ${body}`);
    } else {
      const data = (await res.json()) as {
        total?: unknown;
        visible?: unknown;
        deleted?: unknown;
      };
      const { total, visible, deleted } = data;
      const totalN = Number(total);
      const visibleN = Number(visible);
      const deletedN = Number(deleted);
      if (!isNaN(totalN) && !isNaN(visibleN) && !isNaN(deletedN)) {
        pass(
          `GET /posts/stats → 200 (total=${totalN}, visible=${visibleN}, deleted=${deletedN})`
        );
      } else {
        fail(
          `GET /posts/stats → 200 but response shape invalid (DB may be unreachable): ${JSON.stringify(data)}`
        );
      }
    }
  } catch (e) {
    fail(`GET /posts/stats failed: ${(e as Error).message}`);
  }

  // Check 13: GET /posts/last
  try {
    const res = await fetch(`${PROD_BASE}/posts/last`, { headers });
    await res.text();
    if (res.status === 200) {
      pass("GET /posts/last → 200");
    } else {
      fail(`GET /posts/last → ${res.status}`);
    }
  } catch (e) {
    fail(`GET /posts/last failed: ${(e as Error).message}`);
  }

  // Check 14: GET /posts/trash
  try {
    const res = await fetch(`${PROD_BASE}/posts/trash`, { headers });
    await res.text();
    if (res.status === 200) {
      pass("GET /posts/trash → 200");
    } else {
      fail(`GET /posts/trash → ${res.status}`);
    }
  } catch (e) {
    fail(`GET /posts/trash failed: ${(e as Error).message}`);
  }
}

async function main() {
  console.log(`nowu health check — prod (${PROD_BASE})`);
  console.log("─".repeat(45));

  const { botToken, apiToken } = await checkEnv();

  if (botToken) {
    await checkTelegram(botToken);
  }

  if (apiToken) {
    await checkApi(apiToken);
  }

  console.log("\n" + "─".repeat(45));

  const total = passed + warnings + failed;
  if (failed > 0) {
    console.log(
      `✗ ${failed} failed, ${passed} passed, ${warnings} warning(s) — exit 1`
    );
    process.exitCode = 1;
  } else if (warnings > 0) {
    console.log(`✓ ${total} passed (${warnings} warning(s)) — exit 0`);
  } else {
    console.log(`✓ All ${total} checks passed — exit 0`);
  }
}

main().catch((e) => {
  console.error("Health check crashed:", e);
  process.exitCode = 1;
});
