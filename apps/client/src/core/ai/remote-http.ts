import { Capacitor, CapacitorHttp } from "@capacitor/core";

type RemoteLLMRequest = {
	headers: Record<string, string>;
	body: string;
	signal: AbortSignal;
	timeoutMs: number;
};

type RemoteLLMResponse = Pick<Response, "ok" | "status" | "statusText" | "headers" | "text">;

export function requestRemoteLLM(url: string, options: RemoteLLMRequest): Promise<RemoteLLMResponse> {
	const { headers, body, signal, timeoutMs } = options;
	if (!Capacitor.isNativePlatform()) {
		return fetch(url, { method: "POST", headers, body, signal });
	}
	if (signal.aborted) return Promise.reject(new Error("请求已取消"));

	// APK 中直接使用原生 HTTP，避免 WebView 的 CORS 预检和本地资源拦截。
	// 显式调用无需开启全局 fetch/XHR 补丁，也不会影响其他请求。
	const pending = CapacitorHttp.request({
		url,
		method: "POST",
		headers,
		data: body,
		responseType: "text",
		connectTimeout: timeoutMs,
		readTimeout: timeoutMs,
	});
	return new Promise<Awaited<typeof pending>>((resolve, reject) => {
		const onAbort = () => {
			signal.removeEventListener("abort", onAbort);
			reject(new Error("请求已取消"));
		};
		signal.addEventListener("abort", onAbort, { once: true });
		// 原生接口不支持 AbortSignal；及时结束本地等待，忽略迟到的结果。
		pending.then(
			(response) => {
				signal.removeEventListener("abort", onAbort);
				resolve(response);
			},
			(error) => {
				signal.removeEventListener("abort", onAbort);
				reject(error);
			},
		);
	}).then((response) => ({
		ok: response.status >= 200 && response.status < 300,
		status: response.status,
		statusText: "",
		headers: new Headers(response.headers),
		// 原生插件会按 Content-Type 自动解析 JSON，即使 responseType 为 text。
		text: async () => {
			const data = response.data;
			if (data == null) return "";
			return typeof data === "string" ? data : JSON.stringify(data) ?? "";
		},
	}));
}
