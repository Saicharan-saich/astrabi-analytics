import * as V from "/home/claude/astrabi-analytics/vitestShim.ts";
Object.assign(globalThis, { describe: V.describe, it: V.it, test: V.it, expect: V.expect, vi: V.vi, beforeEach: V.beforeEach, afterEach: V.afterEach, beforeAll: V.beforeAll });
await import("/home/claude/astrabi-analytics/__tests__/aiSqlChatContext.test.ts");
process.exitCode = await V.__run("__tests__/aiSqlChatContext.test.ts") ? 1 : 0;
