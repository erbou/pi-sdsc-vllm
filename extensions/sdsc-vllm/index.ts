import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";

/**
 * SDSC Authentik Device Flow + OpenAI-compatible vLLM gateway provider for pi.
 *
 * Environment variables:
 *   SDSC_AUTHENTIK_ISSUER            OIDC issuer URL
 *   SDSC_AUTHENTIK_CLIENT_ID         OIDC client id
 *   SDSC_AUTHENTIK_CLIENT_SECRET     Optional, only for confidential clients
 *   SDSC_AUTHENTIK_SCOPES            Defaults to "openid profile email"
 *
 *   SDSC_VLLM_BASE_URL               OpenAI-compatible base URL, e.g. https://host/v1
 *   SDSC_VLLM_PROVIDER               Provider id, defaults to "sdsc-vllm"
 *   SDSC_VLLM_PROVIDER_NAME          Display name
 *   SDSC_VLLM_API_KEY                Optional startup/discovery token or fallback key
 *   SDSC_VLLM_MODELS                 Manual model list; disables auto-discovery
 *   SDSC_VLLM_DISCOVER_MODELS=false  Disable /models discovery
 *   SDSC_VLLM_CONTEXT_WINDOW         Fallback context window
 *   SDSC_VLLM_MAX_TOKENS             Fallback max output tokens
 */

type DiscoveryDocument = {
	device_authorization_endpoint?: string;
	token_endpoint?: string;
};

type DeviceAuthorizationResponse = {
	device_code: string;
	user_code: string;
	verification_uri?: string;
	verification_url?: string;
	verification_uri_complete?: string;
	expires_in: number;
	interval?: number;
};

type TokenResponse = {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	error?: string;
	error_description?: string;
};

type OpenAIModelsResponse = {
	data?: Array<{
		id?: string;
		name?: string;
		context_window?: number;
		contextWindow?: number;
		context_length?: number;
		max_model_len?: number;
		max_tokens?: number;
		maxTokens?: number;
		reasoning?: boolean;
		input?: ("text" | "image")[];
		compat?: Record<string, unknown>;
	}>;
};

type ModelConfig = {
	id: string;
	name?: string;
	reasoning?: boolean;
	input?: ("text" | "image")[];
	contextWindow?: number;
	maxTokens?: number;
	compat?: Record<string, unknown>;
};

const DEFAULT_AUTHENTIK_ISSUER = "https://authentik-server-runai-sharedllm-ralf.inference.compute.datascience.ch/application/o/vllm/";
const DEFAULT_AUTHENTIK_CLIENT_ID = "P8dW2vrNPDa8d43qd4BK49eEDYJFtvYk";
const DEFAULT_VLLM_BASE_URL = "https://vllm-gateway-runai-sharedllm-ralf.inference.compute.datascience.ch/v1";

const DEFAULT_OPENAI_COMPAT = {
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
	supportsUsageInStreaming: false,
	supportsStrictMode: false,
	maxTokensField: "max_tokens",
};

const DEFAULT_MODELS: ModelConfig[] = [
	{
		id: "Qwen/Qwen3.5-35B-A3B-GPTQ-Int4",
		reasoning: true,
		contextWindow: 262144,
		input: ["text"],
		compat: { thinkingFormat: "qwen" },
	},
	{
		id: "cyankiwi/Qwen3-Coder-30B-A3B-Instruct-AWQ-4bit",
		reasoning: true,
		contextWindow: 192064,
		input: ["text"],
		compat: { thinkingFormat: "qwen" },
	},
	{
		id: "cyankiwi/gemma-4-31B-it-AWQ-4bit",
		reasoning: true,
		contextWindow: 256000,
		input: ["text"],
	},
];

const CONFIG = {
	issuer: env("SDSC_AUTHENTIK_ISSUER", DEFAULT_AUTHENTIK_ISSUER),
	clientId: env("SDSC_AUTHENTIK_CLIENT_ID", DEFAULT_AUTHENTIK_CLIENT_ID),
	clientSecret: process.env.SDSC_AUTHENTIK_CLIENT_SECRET,
	scopes: env("SDSC_AUTHENTIK_SCOPES", "openid profile email"),
	provider: env("SDSC_VLLM_PROVIDER", "sdsc-vllm"),
	providerName: env("SDSC_VLLM_PROVIDER_NAME", "SDSC vLLM Gateway"),
	baseUrl: env("SDSC_VLLM_BASE_URL", DEFAULT_VLLM_BASE_URL),
	apiKey: process.env.SDSC_VLLM_API_KEY,
	models: process.env.SDSC_VLLM_MODELS,
	discoverModels: process.env.SDSC_VLLM_DISCOVER_MODELS !== "false",
	contextWindow: numberEnv("SDSC_VLLM_CONTEXT_WINDOW", 128000),
	maxTokens: numberEnv("SDSC_VLLM_MAX_TOKENS", 8192),
};

let oidcDiscoveryPromise: Promise<Required<Pick<DiscoveryDocument, "device_authorization_endpoint" | "token_endpoint">>> | undefined;
let registeredPi: ExtensionAPI | undefined;
let currentModels: ModelConfig[] | undefined;

function env(name: string, fallback: string): string {
	return process.env[name]?.trim() || fallback;
}

function numberEnv(name: string, fallback: number): number {
	const value = Number(process.env[name]);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

function trimTrailingSlash(value: string): string {
	return value.replace(/\/+$/, "");
}

function providerLog(message: string) {
	console.warn(`[${CONFIG.provider}] ${message}`);
}

function mergeCompat(modelCompat?: Record<string, unknown>) {
	return { ...DEFAULT_OPENAI_COMPAT, ...(modelCompat ?? {}) };
}

async function discoverOidcEndpoints() {
	if (oidcDiscoveryPromise) return oidcDiscoveryPromise;
	if (!CONFIG.issuer) throw new Error("Set SDSC_AUTHENTIK_ISSUER to your Authentik OIDC issuer URL");

	oidcDiscoveryPromise = (async () => {
		const response = await fetch(`${trimTrailingSlash(CONFIG.issuer)}/.well-known/openid-configuration`);
		if (!response.ok) throw new Error(`OIDC discovery failed: ${response.status} ${await response.text()}`);

		const doc = (await response.json()) as DiscoveryDocument;
		if (!doc.device_authorization_endpoint) {
			throw new Error("Authentik discovery document has no device_authorization_endpoint; enable device flow for this application");
		}
		if (!doc.token_endpoint) throw new Error("Authentik discovery document has no token_endpoint");

		return {
			device_authorization_endpoint: doc.device_authorization_endpoint,
			token_endpoint: doc.token_endpoint,
		};
	})();

	return oidcDiscoveryPromise;
}

function addClientAuth(params: URLSearchParams) {
	params.set("client_id", CONFIG.clientId);
	if (CONFIG.clientSecret) params.set("client_secret", CONFIG.clientSecret);
}

async function parseJsonOrError<T extends { error?: string; error_description?: string }>(response: Response): Promise<T> {
	const text = await response.text();
	try {
		return JSON.parse(text) as T;
	} catch {
		return { error: response.ok ? undefined : "invalid_response", error_description: text } as T;
	}
}

async function loginAuthentik(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	if (!CONFIG.clientId) throw new Error("Set SDSC_AUTHENTIK_CLIENT_ID to your Authentik OIDC client id");
	const endpoints = await discoverOidcEndpoints();

	const deviceParams = new URLSearchParams({ scope: CONFIG.scopes });
	addClientAuth(deviceParams);

	const deviceResponse = await fetch(endpoints.device_authorization_endpoint, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: deviceParams.toString(),
	});
	if (!deviceResponse.ok) {
		throw new Error(`Device authorization failed: ${deviceResponse.status} ${await deviceResponse.text()}`);
	}

	const device = (await deviceResponse.json()) as DeviceAuthorizationResponse;
	const verificationUri = device.verification_uri ?? device.verification_url;
	if (!verificationUri) throw new Error("Device authorization response did not include verification_uri");

	callbacks.onAuth({
		url: device.verification_uri_complete ?? verificationUri,
		instructions: `Open the URL and enter device code: ${device.user_code}`,
	});

	return pollForAccessToken(endpoints.token_endpoint, device);
}

async function pollForAccessToken(tokenEndpoint: string, device: DeviceAuthorizationResponse): Promise<OAuthCredentials> {
	const expiresAt = Date.now() + device.expires_in * 1000;
	let intervalMs = Math.max(device.interval ?? 5, 1) * 1000;

	while (Date.now() < expiresAt) {
		await new Promise((resolve) => setTimeout(resolve, intervalMs));

		const tokenParams = new URLSearchParams({
			grant_type: "urn:ietf:params:oauth:grant-type:device_code",
			device_code: device.device_code,
		});
		addClientAuth(tokenParams);

		const response = await fetch(tokenEndpoint, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: tokenParams.toString(),
		});
		const token = await parseJsonOrError<TokenResponse>(response);

		if (response.ok && token.access_token) return credentialsFromToken(token);

		switch (token.error) {
			case "authorization_pending":
				break;
			case "slow_down":
				intervalMs += 5000;
				break;
			case "access_denied":
				throw new Error("Device authorization was denied");
			case "expired_token":
				throw new Error("Device authorization expired; run /login again");
			default:
				throw new Error(`Token polling failed: ${token.error ?? response.status} ${token.error_description ?? ""}`.trim());
		}
	}

	throw new Error("Device authorization expired; run /login again");
}

async function refreshAuthentikToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	if (!credentials.refresh) throw new Error("No refresh token stored; run /login again");
	const endpoints = await discoverOidcEndpoints();
	const params = new URLSearchParams({ grant_type: "refresh_token", refresh_token: credentials.refresh });
	addClientAuth(params);

	const response = await fetch(endpoints.token_endpoint, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: params.toString(),
	});
	const token = await parseJsonOrError<TokenResponse>(response);
	if (!response.ok || !token.access_token) {
		throw new Error(`Token refresh failed: ${token.error ?? response.status} ${token.error_description ?? ""}`.trim());
	}

	return credentialsFromToken(token, credentials.refresh);
}

function credentialsFromToken(token: TokenResponse, previousRefresh = ""): OAuthCredentials {
	if (token.access_token) void refreshDiscoveredModels(token.access_token);
	return {
		access: token.access_token ?? "",
		refresh: token.refresh_token ?? previousRefresh,
		expires: Date.now() + (token.expires_in ?? 3600) * 1000 - 60_000,
	};
}

function modelsEndpoint(): string {
	return `${trimTrailingSlash(CONFIG.baseUrl)}/models`;
}

async function discoverVllmModels(accessToken?: string): Promise<ModelConfig[]> {
	if (!CONFIG.discoverModels || CONFIG.models) return configuredModels();

	const headers: Record<string, string> = {};
	const bearer = accessToken ?? CONFIG.apiKey;
	if (bearer) headers.Authorization = `Bearer ${bearer}`;

	const response = await fetch(modelsEndpoint(), { headers });
	if (!response.ok) throw new Error(`vLLM model discovery failed: ${response.status} ${await response.text()}`);

	const payload = (await response.json()) as OpenAIModelsResponse;
	const defaults = new Map(DEFAULT_MODELS.map((model) => [model.id, model]));
	const discovered = (payload.data ?? [])
		.map((remote) => normalizeDiscoveredModel(remote, defaults.get(remote.id ?? "")))
		.filter((model): model is ModelConfig => Boolean(model));

	if (discovered.length === 0) throw new Error("vLLM model discovery returned no models");
	return discovered;
}

function normalizeDiscoveredModel(remote: NonNullable<OpenAIModelsResponse["data"]>[number], fallback?: ModelConfig): ModelConfig | undefined {
	if (!remote.id) return undefined;
	return {
		...fallback,
		id: remote.id,
		name: remote.name ?? fallback?.name ?? remote.id,
		reasoning: remote.reasoning ?? fallback?.reasoning,
		input: remote.input ?? fallback?.input,
		contextWindow: remote.contextWindow ?? remote.context_window ?? remote.context_length ?? remote.max_model_len ?? fallback?.contextWindow,
		maxTokens: remote.maxTokens ?? remote.max_tokens ?? fallback?.maxTokens,
		compat: remote.compat ? { ...(fallback?.compat ?? {}), ...remote.compat } : fallback?.compat,
	};
}

async function initialModels(): Promise<ModelConfig[]> {
	if (!CONFIG.discoverModels || CONFIG.models) return configuredModels();
	try {
		return await discoverVllmModels();
	} catch (error) {
		providerLog(`${error instanceof Error ? error.message : error}; falling back to configured defaults`);
		return DEFAULT_MODELS;
	}
}

async function refreshDiscoveredModels(accessToken: string): Promise<ModelConfig[] | undefined> {
	if (!registeredPi || !CONFIG.discoverModels || CONFIG.models) return undefined;
	try {
		const models = await discoverVllmModels(accessToken);
		registerProvider(registeredPi, models);
		return models;
	} catch (error) {
		providerLog(`${error instanceof Error ? error.message : error}; keeping existing model list`);
		return undefined;
	}
}

function configuredModels(): ModelConfig[] {
	if (!CONFIG.models) return DEFAULT_MODELS;

	const raw = CONFIG.models.trim();
	if (raw.startsWith("[")) return JSON.parse(raw) as ModelConfig[];
	return raw
		.split(",")
		.map((id) => id.trim())
		.filter(Boolean)
		.map((id) => ({ id, name: id }));
}

function registerProvider(pi: ExtensionAPI, models: ModelConfig[]) {
	currentModels = models;
	pi.registerProvider(CONFIG.provider, {
		name: CONFIG.providerName,
		baseUrl: CONFIG.baseUrl,
		apiKey: CONFIG.apiKey,
		api: "openai-completions",
		authHeader: true,
		compat: DEFAULT_OPENAI_COMPAT,
		models: models.map(toProviderModel),
		oauth: {
			name: `${CONFIG.providerName} (Authentik)`,
			login: loginAuthentik,
			refreshToken: refreshAuthentikToken,
			getApiKey: (credentials) => credentials.access,
		},
	});
}

function toProviderModel(model: ModelConfig) {
	return {
		id: model.id,
		name: model.name ?? model.id,
		reasoning: model.reasoning ?? false,
		input: model.input ?? ["text"],
		contextWindow: model.contextWindow ?? CONFIG.contextWindow,
		maxTokens: model.maxTokens ?? CONFIG.maxTokens,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: mergeCompat(model.compat),
	};
}

function registerConfigCommand(pi: ExtensionAPI) {
	pi.registerCommand("sdsc-vllm-config", {
		description: "Show detailed SDSC vLLM model configuration as JSON",
		handler: async (args, ctx) => {
			const query = args.trim();
			const providerModels = ctx.modelRegistry.getAll().filter((model) => model.provider === CONFIG.provider);
			const selected = query
				? providerModels.filter((model) => model.id.includes(query) || model.name?.includes(query))
				: ctx.model?.provider === CONFIG.provider
					? providerModels.filter((model) => model.id === ctx.model?.id)
					: providerModels;

			const payload = selected.map((model) => ({
				id: model.id,
				name: model.name,
				provider: model.provider,
				api: model.api,
				baseUrl: model.baseUrl,
				reasoning: model.reasoning,
				thinkingLevelMap: model.thinkingLevelMap,
				input: model.input,
				contextWindow: model.contextWindow,
				maxTokens: model.maxTokens,
				cost: model.cost,
				compat: model.compat,
			}));

			pi.sendMessage({
				customType: "sdsc-vllm-config",
				display: true,
				content: payload.length > 0 ? `\`\`\`json\n${JSON.stringify(payload, null, 2)}\n\`\`\`` : `No ${CONFIG.provider} models matched: ${query}`,
			});
		},
	});
}

export default async function sdscVllmExtension(pi: ExtensionAPI) {
	registeredPi = pi;
	registerConfigCommand(pi);
	if (!CONFIG.baseUrl) {
		pi.on("session_start", (_event, ctx) => {
			ctx.ui.notify("SDSC vLLM extension loaded, but SDSC_VLLM_BASE_URL is not set", "info");
		});
		return;
	}

	registerProvider(pi, currentModels ?? (await initialModels()));

	pi.on("session_start", async (_event, ctx) => {
		if (!CONFIG.discoverModels || CONFIG.models) return;
		const token = await ctx.modelRegistry.getApiKeyForProvider(CONFIG.provider);
		if (!token) return;

		const activeModelId = ctx.model?.provider === CONFIG.provider ? ctx.model.id : undefined;
		const models = await refreshDiscoveredModels(token);
		if (!models || !activeModelId) return;

		const refreshedActiveModel = ctx.modelRegistry.find(CONFIG.provider, activeModelId);
		if (refreshedActiveModel) await pi.setModel(refreshedActiveModel);
	});
}
