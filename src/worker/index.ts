import type { HealthProbeResponse } from "../shared/models";
import { FtpService } from "./ftp";

export interface Env {
  ASSETS: Fetcher;
  SOFTEGG_API_BASE_URL: string;
  SOFTEGG_FTP_HOST: string;
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
  const apiBaseUrl = requireEnv(env.SOFTEGG_API_BASE_URL, "SOFTEGG_API_BASE_URL");
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
  const apiBaseUrl = requireEnv(env.SOFTEGG_API_BASE_URL, "SOFTEGG_API_BASE_URL");
  const companyCode = url.pathname.split("/").pop()?.trim().toUpperCase() ?? "";
  if (!/^[A-Z0-9]{5}$/.test(companyCode)) {
    return json({ message: "회사 코드는 영문/숫자 5자리여야 합니다." }, 400);
  }

  const upstreamUrl = new URL(`/api/public/software-catalog/${companyCode}`, apiBaseUrl);
  const response = await fetch(upstreamUrl, {
    headers: {
      accept: "application/json",
    },
  });
  const text = await response.text();
  return new Response(text, {
    status: response.status,
    headers: {
      "content-type": "application/json; charset=utf-8",
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

function getFtpCredentials(env: Env): {
  host: string;
  user: string;
  password: string;
} {
  return {
    host: requireEnv(env.SOFTEGG_FTP_HOST, "SOFTEGG_FTP_HOST"),
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

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}
