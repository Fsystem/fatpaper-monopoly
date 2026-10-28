const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");
const ts = require("typescript");
const vue = require("vue");
const clientRoot = path.resolve(__dirname, "../..");

function evaluate(relative, dependencies = {}, globals = {}) {
	const module = { exports: {} };
	const compiled = ts.transpileModule(fs.readFileSync(path.join(clientRoot, relative), "utf8"), {
		fileName: relative,
		compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
	});
	vm.runInNewContext(compiled.outputText, {
		module, exports: module.exports, AbortController, setTimeout, clearTimeout,
		console: { error() {} }, window: { setTimeout },
		require: name => {
			if (name === "./remote-http") {
				return evaluate("src/core/ai/remote-http.ts", {
					"@capacitor/core": {
						Capacitor: { isNativePlatform: () => Boolean(globals.nativeRequest) },
						CapacitorHttp: { request: globals.nativeRequest },
					},
				}, { Headers, ...globals });
			}
			assert.ok(name in dependencies, "Unexpected dependency: " + name);
			return dependencies[name];
		},
		...globals,
	}, { filename: relative });
	return module.exports;
}

function harness(fetch, provider = "openai-compatible", timeoutMs = 1000, nativeRequest) {
	const stats = evaluate("src/core/ai/remote-usage-stats.ts", { vue });
	const readable = evaluate("src/core/ai/ReadableAIPrompt.ts");
	const remote = evaluate("src/core/ai/OpenAICompatibleDecisionProvider.ts", {
		"./remote-usage-stats": stats, "./ReadableAIPrompt": readable,
	}, { fetch, nativeRequest });
	const config = { provider, baseUrl: "https://example.test?api_key=top-secret", apiKey: "top-secret", model: "test-model", timeoutMs };
	return { stats, decide: remote.createRemoteAIDecisionProvider(config).decide.bind(remote.createRemoteAIDecisionProvider(config)) };
}

function request(playerId = "player-a", traceId = "same-decision") {
	const player = { id: playerId, user: { userId: playerId, username: playerId === "player-a" ? "小明" : "小红" }, money: 100, stop: 0, properties: [], chanceCards: [] };
	return {
		playerId, title: "购买地产", scene: "confirm-dialog", operationType: "confirm-dialog",
		options: [{ id: "buy", label: "购买", actionType: "confirm" }], metadata: { decisionId: traceId },
		context: {
			player, players: [player], properties: [], mapItems: [], mapIndex: [], mapEvents: [], currentRound: 3,
			currentMultiplier: 1, currentPlayerIdInRound: playerId, map: { id: "map", name: "自定义地图" },
			playerRoles: [{ playerId, roleName: playerId === "player-a" ? "商人" : "冒险家" }],
		},
	};
}

const longText = "完整模型内容。".repeat(2000) + "保留结尾";
function successResponse(provider = "openai-compatible", extra = {}) {
	const output = JSON.stringify({ optionId: "buy", reason: longText, unrecognizedModelField: { nested: "额外字段" } });
	return new Response(JSON.stringify(provider === "anthropic"
		? { content: [{ type: "text", text: output }, { type: "thinking", thinking: "附加思考字段" }], usage: { input_tokens: 80, output_tokens: 20 }, ...extra }
		: { choices: [{ message: { content: output, reasoning_content: "附加思考字段" } }], usage: { prompt_tokens: 80, completion_tokens: 20, total_tokens: 100 }, ...extra }),
		{ status: 200, headers: { "content-type": "application/json", "x-request-id": "provider-trace" } });
}

for (const provider of ["openai-compatible", "anthropic"]) {
	test(`${provider}: records in-flight input then complete raw response and adopted selection`, async () => {
		let finish, sent;
		const h = harness((url, init) => {
			sent = { url, init };
			return new Promise(resolve => { finish = resolve; });
		}, provider);
		const promise = h.decide(request());
		let snapshot = h.stats.getAIRemoteUsageSnapshot();
		assert.equal(snapshot.summary.requestCount, 1);
		assert.equal(snapshot.summary.missingUsageCount, 0);
		const id = snapshot.records[0].id;
		const pending = h.stats.getAIRemoteCallDetail(id);
		assert.equal(pending.record.status, "pending");
		assert.equal(pending.record.playerName, "小明");
		assert.equal(pending.record.roleName, "商人");
		assert.equal(pending.request.body, sent.init.body);
		assert.ok(!JSON.stringify(pending).includes("top-secret"));
		assert.ok(JSON.stringify(sent.init.headers).includes("top-secret"));
		assert.ok(!("request" in snapshot.records[0]));
		finish(successResponse(provider, { additionalResponseField: { full: longText } }));
		const selection = await promise;
		const detail = h.stats.getAIRemoteCallDetail(id);
		assert.equal(detail.record.status, "success");
		assert.equal(detail.record.round, 3);
		assert.equal(detail.response.status, 200);
		assert.equal(detail.response.headers["x-request-id"], "provider-trace");
		assert.ok(detail.modelOutput.includes("unrecognizedModelField"));
		assert.equal(JSON.parse(detail.response.body).additionalResponseField.full, longText);
		assert.equal(detail.selection.reason, longText);
		assert.equal(detail.selection.optionId, selection.optionId);
		snapshot = h.stats.getAIRemoteUsageSnapshot();
		assert.equal(snapshot.summary.requestCount, 1);
		assert.equal(snapshot.summary.usageCount, 1);
		assert.equal(snapshot.summary.totalTokens, 100);
		assert.equal(snapshot.byPlayer["player-a"].summary.totalTokens, 100);
		assert.ok(!JSON.stringify(snapshot).includes("additionalResponseField"));
		detail.request.body = "mutated copy";
		assert.equal(h.stats.getAIRemoteCallDetail(id).request.body, sent.init.body);
	});
}

test("HTTP errors retain full body, status and headers even without valid JSON", async () => {
	const raw = "<html><script>untrusted()</script>" + longText + "</html>";
	const h = harness(async () => new Response(raw, { status: 502, statusText: "Bad Gateway", headers: { "x-error": "gateway" } }));
	assert.deepEqual(JSON.parse(JSON.stringify(await h.decide(request()))), {});
	const snapshot = h.stats.getAIRemoteUsageSnapshot();
	const detail = h.stats.getAIRemoteCallDetail(snapshot.records[0].id);
	assert.equal(detail.record.status, "error");
	assert.equal(detail.response.body, raw);
	assert.equal(detail.response.status, 502);
	assert.ok(detail.record.error.includes("HTTP 502"));
	assert.equal(snapshot.summary.requestCount, 1);
	assert.equal(snapshot.summary.missingUsageCount, 1);
});

test("invalid model JSON retains usage, model output and raw API response", async () => {
	const h = harness(async () => new Response(JSON.stringify({ choices: [{ message: { content: longText } }], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 } })));
	await h.decide(request());
	const snapshot = h.stats.getAIRemoteUsageSnapshot();
	const detail = h.stats.getAIRemoteCallDetail(snapshot.records[0].id);
	assert.equal(detail.record.status, "error");
	assert.equal(detail.modelOutput, longText);
	assert.equal(snapshot.summary.totalTokens, 6);
	assert.ok(detail.record.error);
});

test("network failures and timeouts have their own inspectable records", async () => {
	for (const kind of ["network", "timeout"]) {
		const h = harness(async (url, init) => {
			if (kind === "network") throw new Error("network unavailable");
			await new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
		}, "openai-compatible", 5);
		await h.decide(request());
		const snapshot = h.stats.getAIRemoteUsageSnapshot();
		const detail = h.stats.getAIRemoteCallDetail(snapshot.records[0].id);
		assert.equal(detail.record.status, "error");
		assert.ok(detail.request.body.includes("自定义地图"));
		assert.equal(detail.response, undefined);
		assert.ok(detail.record.error.includes(kind === "network" ? "network unavailable" : "请求超时"));
	}
});

test("every call stays accessible beyond the former 30-record limit and duplicate decision IDs", async () => {
	const h = harness(async () => successResponse());
	for (let index = 0; index < 35; index++) await h.decide(request(index % 2 ? "player-b" : "player-a"));
	const snapshot = h.stats.getAIRemoteUsageSnapshot();
	assert.equal(snapshot.records.length, 35);
	assert.equal(new Set(snapshot.records.map(record => record.id)).size, 35);
	assert.equal(snapshot.summary.requestCount, 35);
	assert.equal(snapshot.summary.totalTokens, 3500);
	assert.equal(snapshot.byPlayer["player-a"].summary.requestCount, 18);
	assert.equal(snapshot.byPlayer["player-b"].summary.requestCount, 17);
	for (const record of snapshot.records) assert.equal(h.stats.getAIRemoteCallDetail(record.id).record.playerId, record.playerId);
});

test("clearing usage releases details and a late response cannot resurrect cleared records", async () => {
	let finish;
	const h = harness(() => new Promise(resolve => { finish = resolve; }));
	const pending = h.decide(request());
	const id = h.stats.getAIRemoteUsageSnapshot().records[0].id;
	h.stats.clearAIRemoteUsageStats();
	assert.equal(h.stats.getAIRemoteCallDetail(id), null);
	finish(successResponse());
	await pending;
	const snapshot = h.stats.getAIRemoteUsageSnapshot();
	assert.equal(snapshot.records.length, 0);
	assert.equal(snapshot.summary.requestCount, 0);
	assert.equal(snapshot.summary.totalTokens, 0);
	assert.equal(h.stats.getAIRemoteCallDetail(id), null);
});

for (const provider of ["openai-compatible", "anthropic"]) {
	for (const encoding of ["object", "text"]) {
		test(`APK ${provider}: native HTTP sends credentials and JSON body without WebView fetch (${encoding})`, async () => {
			let webCalls = 0, nativeCalls = 0, sent, finish;
			const h = harness(async () => {
				webCalls++;
				return new Response("<html>intercepted by WebView</html>".padEnd(204, " "));
			}, provider, 90000, options => {
				nativeCalls++;
				sent = options;
				return new Promise(resolve => { finish = resolve; });
			});
			const pending = h.decide(request());
			const snapshot = h.stats.getAIRemoteUsageSnapshot();
			assert.equal(snapshot.records[0].status, "pending");
			assert.equal(webCalls, 0);
			assert.equal(nativeCalls, 1);
			assert.equal(sent.method, "POST");
			assert.equal(sent.connectTimeout, 90000);
			assert.equal(sent.readTimeout, 90000);
			assert.equal(sent.responseType, "text");
			assert.equal(sent.headers["Content-Type"], "application/json");
			assert.equal(sent.headers[provider === "anthropic" ? "x-api-key" : "Authorization"],
				provider === "anthropic" ? "top-secret" : "Bearer top-secret");
			if (provider === "anthropic") assert.equal(sent.headers["anthropic-version"], "2023-06-01");
			assert.ok(sent.url.endsWith(provider === "anthropic" ? "/v1/messages" : "/chat/completions"));
			const detail = h.stats.getAIRemoteCallDetail(snapshot.records[0].id);
			assert.equal(sent.data, detail.request.body);
			assert.equal(JSON.parse(sent.data).model, "test-model");
			assert.ok(!JSON.stringify(detail).includes("top-secret"));
			const response = await successResponse(provider).text();
			finish({ status: 200, headers: { "Content-Type": "application/json", "X-Request-ID": "native-trace" },
				data: encoding === "object" ? JSON.parse(response) : response });
			assert.equal((await pending).optionId, "buy");
			const completed = h.stats.getAIRemoteCallDetail(snapshot.records[0].id);
			assert.equal(completed.record.status, "success");
			assert.equal(completed.record.totalTokens, 100);
			assert.equal(completed.response.status, 200);
			assert.equal(completed.response.headers["x-request-id"], "native-trace");
			assert.deepEqual(JSON.parse(completed.response.body), JSON.parse(response));
			assert.equal(webCalls, 0);
			assert.equal(nativeCalls, 1);
		});
	}
}

test("APK HTTP errors retain the actual 204-character gateway response without retrying via fetch", async () => {
	const raw = "<html>Request blocked before reaching model API</html>".padEnd(204, " ");
	let nativeCalls = 0;
	const h = harness(() => assert.fail("must not retry through WebView"), "openai-compatible", 1000, async () => {
		nativeCalls++;
		return { status: 403, headers: { "Content-Type": "text/html" }, data: raw };
	});
	await h.decide(request());
	const snapshot = h.stats.getAIRemoteUsageSnapshot();
	const detail = h.stats.getAIRemoteCallDetail(snapshot.records[0].id);
	assert.equal(detail.record.status, "error");
	assert.equal(detail.record.responseChars, 204);
	assert.equal(detail.response.body, raw);
	assert.equal(detail.response.status, 403);
	assert.match(detail.record.error, /HTTP 403/);
	assert.equal(nativeCalls, 1);
});

test("APK native failures retain the error and never duplicate the request through fetch", async () => {
	const h = harness(() => assert.fail("must not retry through WebView"), "anthropic", 1000, async () => {
		throw new Error("native connection failed");
	});
	await h.decide(request());
	const detail = h.stats.getAIRemoteCallDetail(h.stats.getAIRemoteUsageSnapshot().records[0].id);
	assert.equal(detail.record.status, "error");
	assert.match(detail.record.error, /native connection failed/);
	assert.equal(detail.response, undefined);
});

test("APK total timeout releases the caller and ignores a late native response", async () => {
	let finish;
	const h = harness(() => assert.fail("must not use WebView"), "openai-compatible", 5,
		() => new Promise(resolve => { finish = resolve; }));
	await h.decide(request());
	const id = h.stats.getAIRemoteUsageSnapshot().records[0].id;
	const detail = h.stats.getAIRemoteCallDetail(id);
	assert.equal(detail.record.status, "error");
	assert.match(detail.record.error, /请求超时（5ms）/);
	finish({ status: 200, headers: {}, data: JSON.parse(await successResponse().text()) });
	await new Promise(resolve => setImmediate(resolve));
	assert.deepEqual(h.stats.getAIRemoteCallDetail(id), detail);
	assert.equal(h.stats.getAIRemoteUsageSnapshot().summary.requestCount, 1);
});

for (const native of [false, true]) {
	test(`${native ? "APK" : "Web"}: empty HTTP 204 and fixed-length HTML report actual response errors`, async () => {
		for (const [body, status, expected] of [[null, 204, /空响应（HTTP 204）/],
			["<html>not a model response</html>".padEnd(204, " "), 200, /不是有效 JSON（HTTP 200）/]]) {
			const h = harness(async () => new Response(body, { status }), "openai-compatible", 1000,
				native ? async () => ({ status, headers: {}, data: body }) : undefined);
			await h.decide(request());
			const detail = h.stats.getAIRemoteCallDetail(h.stats.getAIRemoteUsageSnapshot().records[0].id);
			assert.equal(detail.record.status, "error");
			assert.match(detail.record.error, expected);
			assert.equal(detail.response.body, body || "");
		}
	});
}
