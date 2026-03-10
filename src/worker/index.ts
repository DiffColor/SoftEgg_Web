import type { HealthProbeResponse } from "../shared/models";
import { FtpService } from "./ftp";

export interface Env {
  ASSETS: Fetcher;
  SOFTEGG_API_BASE_URL: string;
  SOFTEGG_FTP_HOST: string;
  SOFTEGG_FTP_PORT?: string;
  SOFTEGG_FTP_USER: string;
  SOFTEGG_FTP_PASSWORD: string;
}

const ftpService = new FtpService();

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/api/health") {
        return await handleHealth(env);
      }

      if (url.pathname.startsWith("/api/catalog/")) {
        return await handleCatalog(url, env);
      }

      if (url.pathname === "/api/artifact/size" && request.method === "POST") {
        return await handleArtifactSize(request, env);
      }

      if (url.pathname === "/api/artifact/download" && request.method === "POST") {
        return await handleArtifactDownload(request, env);
      }
    } catch (error) {
      return json(
        {
          message: error instanceof Error ? error.message : "예상하지 못한 오류가 발생했습니다.",
        },
        500,
      );
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;

async function handleHealth(env: Env): Promise<Response> {
  const apiBaseUrl = getApiBaseUrl(env);
  const response = await fetch(new URL("/api/health", apiBaseUrl));
  if (!response.ok) {
    const message = await response.text();
    return json(
      {
        ok: false,
        message: message.trim() || "카탈로그 서버 상태 확인에 실패했습니다.",
      },
      response.status,
    );
  }

  const payload: HealthProbeResponse = { ok: true };
  return json(payload);
}

async function handleCatalog(url: URL, env: Env): Promise<Response> {
  const apiBaseUrl = getApiBaseUrl(env);
  const companyCode = normalizeCompanyCode(url.pathname.split("/").pop() ?? "");
  if (!companyCode) {
    return json({ message: "회사 코드를 입력해 주세요." }, 400);
  }

  const upstreamUrl = new URL(`/api/public/software-catalog/${companyCode}`, apiBaseUrl);
  const response = await fetch(upstreamUrl, {
    headers: {
      accept: "application/json",
      "content-type": "application/json; charset=utf-8",
    },
  });
  const text = await response.text();
  return new Response(text, {
    status: response.status,
    headers: {
      "content-type": response.headers.get("content-type") || "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function handleArtifactSize(request: Request, env: Env): Promise<Response> {
  const ftpCredentials = getFtpCredentials(env);
  const body = await request.json<{ uri?: string }>();
  const uri = body.uri?.trim();
  if (!uri) {
    return json({ message: "원격 URI가 필요합니다." }, 400);
  }

  const size = await ftpService.fetchRemoteSize(uri, {
    host: ftpCredentials.host,
    port: ftpCredentials.port,
    user: ftpCredentials.user,
    password: ftpCredentials.password,
  });
  return json({ size });
}

async function handleArtifactDownload(request: Request, env: Env): Promise<Response> {
  const ftpCredentials = getFtpCredentials(env);
  const body = await request.json<{ uri?: string; checksum?: string; fileName?: string }>();
  const uri = body.uri?.trim();
  if (!uri) {
    return json({ message: "원격 URI가 필요합니다." }, 400);
  }

  const data = await ftpService.downloadFile(uri, {
    host: ftpCredentials.host,
    port: ftpCredentials.port,
    user: ftpCredentials.user,
    password: ftpCredentials.password,
  });
  const fileName = (body.fileName?.trim() || "artifact.bin").replaceAll(/["\r\n]/g, "_");

  const payload = data.slice();
  return new Response(payload.buffer, {
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(data.byteLength),
      "content-disposition": `attachment; filename="${encodeURIComponent(fileName)}"`,
      "x-softegg-file-name": fileName,
      "x-softegg-size": String(data.byteLength),
      "x-softegg-checksum": body.checksum?.trim().toLowerCase() ?? "",
      "cache-control": "no-store",
    },
  });
}

function getApiBaseUrl(env: Env): URL {
  const rawValue = requireEnv(env.SOFTEGG_API_BASE_URL, "SOFTEGG_API_BASE_URL");
  const normalized = /^[a-z][a-z0-9+.-]*:\/\//i.test(rawValue) ? rawValue : `https://${rawValue}`;

  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new Error("SOFTEGG_API_BASE_URL 형식이 올바르지 않습니다.");
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error("SOFTEGG_API_BASE_URL은 http 또는 https URL이어야 합니다.");
  }

  return parsed;
}

function getFtpCredentials(env: Env): {
  host: string;
  port: number;
  user: string;
  password: string;
} {
  const endpoint = parseFtpEndpoint(
    requireEnv(env.SOFTEGG_FTP_HOST, "SOFTEGG_FTP_HOST"),
    env.SOFTEGG_FTP_PORT,
  );
  return {
    host: endpoint.host,
    port: endpoint.port,
    user: requireEnv(env.SOFTEGG_FTP_USER, "SOFTEGG_FTP_USER"),
    password: requireEnv(env.SOFTEGG_FTP_PASSWORD, "SOFTEGG_FTP_PASSWORD"),
  };
}

function requireEnv(value: string | undefined, key: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    throw new Error(`${key} 설정이 필요합니다.`);
  }
  return normalized;
}

function normalizeCompanyCode(value: string): string {
  return value
    .trim()
    .replace(/\s+/g, "")
    .toUpperCase();
}

function parseFtpEndpoint(hostValue: string, portValue?: string): {
  host: string;
  port: number;
} {
  const normalizedHost = hostValue.trim();
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(normalizedHost)
    ? normalizedHost
    : `ftp://${normalizedHost}`;

  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error("SOFTEGG_FTP_HOST 형식이 올바르지 않습니다.");
  }

  if (parsed.protocol !== "ftp:") {
    throw new Error("SOFTEGG_FTP_HOST는 FTP 주소여야 합니다.");
  }

  const host = parsed.hostname.trim();
  if (!host) {
    throw new Error("SOFTEGG_FTP_HOST 형식이 올바르지 않습니다.");
  }

  const rawPort = portValue?.trim() || parsed.port || "21";
  const port = Number.parseInt(rawPort, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("SOFTEGG_FTP_PORT 형식이 올바르지 않습니다.");
  }

  return {
    host,
    port,
  };
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
