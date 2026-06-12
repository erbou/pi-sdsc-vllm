# SDSC vLLM Pi Extension

Pi package for the SDSC Authentik-protected, OpenAI-compatible vLLM gateway.

It registers a provider, supports `/login` via Authentik OIDC device flow, and discovers available models from the gateway's `/v1/models` endpoint when possible.

## Install from git

```bash
pi install npm:pi-sdsc-vllm
```

For project-local installation, run:

```bash
pi install -l npm:pi-sdsc-vllm
```

## Use

Start Pi and log in:

```text
/login sdsc-vllm
```

Pi will show the Authentik device code and verification URL. After login, choose a model with `/model`.

To inspect the full registered configuration for the current SDSC model, run:

```text
/sdsc-vllm-config
```

You can also filter by model id substring:

```text
/sdsc-vllm-config Qwen
```

Requests are sent to the vLLM gateway with:

```http
Authorization: Bearer <authentik-access-token>
```

## Defaults

The package is preconfigured for the SDSC RunAI shared vLLM gateway:

- Authentik issuer: `https://authentik-server-runai-sharedllm-ralf.inference.compute.datascience.ch/application/o/vllm/`
- vLLM base URL: `https://vllm-gateway-runai-sharedllm-ralf.inference.compute.datascience.ch/v1`
- Provider id: `sdsc-vllm`

Models are auto-discovered from the gateway's OpenAI-compatible `/models` endpoint. If unauthenticated startup discovery fails, Pi falls back to bundled defaults until `/login sdsc-vllm` succeeds, then refreshes the model list using the access token. On later Pi startup/resume, the extension also asks Pi for the stored OAuth API key, letting Pi refresh the token if needed, and then re-fetches `/models` with that token.

The extension consumes these optional per-model metadata fields from `/models` when present:

```json
{
  "id": "Qwen/Qwen3.6-35B-A3B-FP8",
  "name": "Qwen 3.6 35B FP8",
  "context_window": 262144,
  "contextWindow": 262144,
  "context_length": 262144,
  "max_model_len": 262144,
  "max_tokens": 8192,
  "maxTokens": 8192,
  "reasoning": true,
  "input": ["text"],
  "compat": {
    "thinkingFormat": "qwen"
  }
}
```

## Configuration

Optional environment variables:

```bash
export SDSC_AUTHENTIK_ISSUER="https://.../application/o/vllm/"
export SDSC_AUTHENTIK_CLIENT_ID="<client-id>"
export SDSC_AUTHENTIK_CLIENT_SECRET="<secret>"        # only for confidential clients
export SDSC_AUTHENTIK_SCOPES="openid profile email"  # default

export SDSC_VLLM_BASE_URL="https://.../v1"
export SDSC_VLLM_PROVIDER="sdsc-vllm"
export SDSC_VLLM_PROVIDER_NAME="SDSC vLLM Gateway"
export SDSC_VLLM_API_KEY="<fallback-token>"          # optional startup discovery/fallback key
export SDSC_VLLM_CONTEXT_WINDOW=128000
export SDSC_VLLM_MAX_TOKENS=8192
export SDSC_VLLM_DISCOVER_MODELS=false               # disable auto-discovery
```

Set `SDSC_VLLM_MODELS` to override auto-discovery entirely:

```bash
export SDSC_VLLM_MODELS="model-a,model-b"
```

or JSON:

```bash
export SDSC_VLLM_MODELS='[{"id":"llama-3.3-70b","name":"Llama 3.3 70B","contextWindow":128000,"maxTokens":8192}]'
```

## Development

This repo is also usable directly while developing:

```bash
pi -e ./extensions/sdsc-vllm/index.ts --list-models
```

The `.pi/extensions/authentik-vllm/index.ts` file is only a local development shim that re-exports the packaged extension.
