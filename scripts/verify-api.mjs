import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import net from "node:net";
import { spawn } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { buildGroups, parseCompanyCatalog } from "../src/shared/models.ts";
import { computeXxHash64 } from "../src/shared/xxhash64.ts";

const cwd = process.cwd();
const devVarsPath = path.join(cwd, ".dev.vars");
const workerHost = "127.0.0.1";
const debug = process.env.DEBUG_VERIFY_API === "1";

async function main() {
  const mainBytes = Buffer.from("SoftEgg main artifact for API verification.\n", "utf8");
  const dependencyBytes = Buffer.from("SoftEgg dependency artifact for API verification.\n", "utf8");
  const mainChecksum = await computeXxHash64(new Uint8Array(mainBytes));
  const dependencyChecksum = await computeXxHash64(new Uint8Array(dependencyBytes));

  const ftpFiles = new Map([
    ["/dist/softegg-core-1.2.0.bin", mainBytes],
    ["/deps/runtime-addon-3.4.5.bin", dependencyBytes],
  ]);

  const backendPort = await findAvailablePort();
  const ftpPort = await findAvailablePort();
  const workerPort = await findAvailablePort();

  const catalogPayload = {
    company: {
      companyNodeId: "org-demo",
      companyName: "SoftEgg Demo Partner",
      companyCode: "ABCDE",
      issuedAt: "2026-03-10T12:00:00Z",
      expiresAt: "2026-12-31T23:59:59Z",
    },
    softwarePackages: [
      {
        id: "pkg-120",
        name: "SoftEgg Desktop",
        codeName: "soft-egg-desktop",
        productId: 1200,
        version: "1.2.0",
        os: "windows",
        releaseChannel: "stable",
        price: 0,
        mainBinary: {
          name: "softegg-core-1.2.0.bin",
          version: "1.2.0",
          uri: `ftp://${workerHost}:${ftpPort}/dist/softegg-core-1.2.0.bin`,
          checksum: mainChecksum,
        },
        dependencies: [
          {
            name: "runtime-addon-3.4.5.bin",
            version: "3.4.5",
            uri: `ftp://${workerHost}/deps/runtime-addon-3.4.5.bin`,
            checksum: dependencyChecksum,
          },
        ],
        installOptions: {
          desktopShortcuts: [{ target: "SoftEgg.exe", name: "SoftEgg" }],
          startupPrograms: [{ target: "SoftEggUpdater.exe", name: "SoftEgg Updater" }],
          shortcutName: "",
          desktopShortcutTargets: ["SoftEgg.exe"],
          startupTargets: ["SoftEggUpdater.exe"],
        },
      },
      {
        id: "pkg-110",
        name: "SoftEgg Desktop",
        codeName: "soft-egg-desktop",
        productId: 1200,
        version: "1.1.0",
        os: "windows",
        releaseChannel: "stable",
        price: 0,
        mainBinary: {
          name: "softegg-core-1.1.0.bin",
          version: "1.1.0",
          uri: `ftp://${workerHost}:${ftpPort}/dist/softegg-core-1.2.0.bin`,
          checksum: mainChecksum,
        },
        dependencies: [],
        installOptions: {
          desktopShortcuts: [],
          startupPrograms: [],
          shortcutName: "",
          desktopShortcutTargets: [],
          startupTargets: [],
        },
      },
    ],
    issuedAt: "2026-03-10T12:00:00Z",
    expiresAt: "2026-12-31T23:59:59Z",
  };

  let backendServer;
  let ftpServer;
  let wranglerProcess;
  let devVarsBackup = null;

  try {
    devVarsBackup = await backupDevVars();

    backendServer = await startBackendServer(backendPort, catalogPayload);
    ftpServer = await startFtpServer(ftpPort, ftpFiles);
    await writeDevVars({
      SOFTEGG_API_BASE_URL: `http://${workerHost}:${backendPort}`,
      SOFTEGG_FTP_HOST: workerHost,
      SOFTEGG_FTP_PORT: String(ftpPort),
      SOFTEGG_FTP_USER: "demo-user",
      SOFTEGG_FTP_PASSWORD: "demo-password",
    });

    wranglerProcess = startWrangler(workerPort);
    await waitForWorker(workerPort, wranglerProcess);

    await verifyHealth(workerPort);
    await verifyCatalog(workerPort);
    await verifyArtifactSize(workerPort, catalogPayload.softwarePackages[0].mainBinary.uri, mainBytes.length);
    await verifyArtifactSize(
      workerPort,
      `ftp://${workerHost}/deps/runtime-addon-3.4.5.bin`,
      dependencyBytes.length,
    );
    await verifyArtifactDownload(
      workerPort,
      catalogPayload.softwarePackages[0].mainBinary,
      mainBytes,
    );
    await verifyArtifactDownload(
      workerPort,
      catalogPayload.softwarePackages[0].dependencies[0],
      dependencyBytes,
    );

    console.log("API 검증 완료: health, catalog, artifact/size, artifact/download, 파싱 로직 모두 통과");
  } finally {
    if (wranglerProcess != null) {
      wranglerProcess.kill("SIGTERM");
      await once(wranglerProcess, "exit").catch(() => undefined);
    }
    if (ftpServer != null) {
      await ftpServer.close();
    }
    if (backendServer != null) {
      await new Promise((resolve) => backendServer.close(resolve));
    }
    await restoreDevVars(devVarsBackup);
  }
}

async function verifyHealth(workerPort) {
  const response = await fetch(`http://${workerHost}:${workerPort}/api/health`, {
    headers: { accept: "application/json" },
  });
  assert(response.ok, `/api/health 요청 실패 (${response.status})`);
  const payload = await response.json();
  assert(payload?.ok === true, "/api/health 응답 정규화가 올바르지 않습니다.");
}

async function verifyCatalog(workerPort) {
  const response = await fetch(`http://${workerHost}:${workerPort}/api/catalog/ABCDE`, {
    headers: { accept: "application/json" },
  });
  assert(response.ok, `/api/catalog/ABCDE 요청 실패 (${response.status})`);
  const payload = await response.json();
  const catalog = parseCompanyCatalog(payload);
  assert(catalog.company.companyCode === "ABCDE", "카탈로그 회사 코드 파싱이 올바르지 않습니다.");
  assert(catalog.softwarePackages.length === 2, "카탈로그 패키지 개수가 예상과 다릅니다.");
  const groups = buildGroups(catalog);
  assert(groups.length === 1, "카탈로그 그룹화 결과가 예상과 다릅니다.");
  assert(
    groups[0].packages[0]?.version === "1.2.0",
    "카탈로그 버전 정렬 결과가 예상과 다릅니다.",
  );
}

async function verifyArtifactSize(workerPort, uri, expectedSize) {
  const response = await fetch(`http://${workerHost}:${workerPort}/api/artifact/size`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({ uri }),
  });
  if (!response.ok) {
    throw new Error(
      `/api/artifact/size 요청 실패 (${response.status}) ${await response.text()}`,
    );
  }
  const payload = await response.json();
  assert(payload?.size === expectedSize, "원격 파일 크기 응답이 예상과 다릅니다.");
}

async function verifyArtifactDownload(workerPort, binary, expectedBytes) {
  const response = await fetch(`http://${workerHost}:${workerPort}/api/artifact/download`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({
      uri: binary.uri,
      checksum: binary.checksum,
      fileName: binary.name,
    }),
  });
  if (!response.ok) {
    throw new Error(
      `/api/artifact/download 요청 실패 (${response.status}) ${await response.text()}`,
    );
  }
  const body = new Uint8Array(await response.arrayBuffer());
  const checksum = await computeXxHash64(body);
  assert(Buffer.compare(Buffer.from(body), expectedBytes) === 0, "다운로드 바이트가 원본과 다릅니다.");
  assert(
    response.headers.get("x-softegg-file-name") === binary.name,
    "다운로드 파일명 헤더가 예상과 다릅니다.",
  );
  assert(
    Number.parseInt(response.headers.get("x-softegg-size") ?? "", 10) === expectedBytes.length,
    "다운로드 크기 헤더가 예상과 다릅니다.",
  );
  assert(checksum === binary.checksum, "다운로드 체크섬 검증이 실패했습니다.");
}

function startWrangler(workerPort) {
  const child = spawn(
    "npx",
    ["wrangler", "dev", "--local", "--ip", workerHost, "--port", String(workerPort)],
    {
      cwd,
      env: { ...process.env, NO_COLOR: "1", BROWSER: "none" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  child.outputBuffer = "";
  const capture = (chunk) => {
    child.outputBuffer += chunk.toString("utf8");
    if (child.outputBuffer.length > 8000) {
      child.outputBuffer = child.outputBuffer.slice(-8000);
    }
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  return child;
}

async function waitForWorker(workerPort, wranglerProcess) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (wranglerProcess.exitCode != null) {
      throw new Error(`Wrangler dev가 비정상 종료되었습니다.\n${wranglerProcess.outputBuffer}`);
    }

    try {
      const response = await fetch(`http://${workerHost}:${workerPort}/api/health`);
      if (response.ok) {
        return;
      }
    } catch {
      // wait for boot
    }

    await delay(500);
  }

  throw new Error(`Wrangler dev 기동 시간 초과\n${wranglerProcess.outputBuffer}`);
}

async function startBackendServer(port, catalogPayload) {
  const server = createHttpServer((request, response) => {
    const url = new URL(request.url ?? "/", `http://${workerHost}:${port}`);

    if (request.method === "GET" && url.pathname === "/api/health") {
      respondJson(response, 200, {
        status: "ok",
        utc: "2026-03-10T00:00:00Z",
      });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/public/software-catalog/ABCDE") {
      respondJson(response, 200, catalogPayload);
      return;
    }

    respondJson(response, 404, { message: "not found" });
  });

  server.listen(port, workerHost);
  await once(server, "listening");
  return server;
}

function respondJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}

async function startFtpServer(port, files) {
  const clientSockets = new Set();
  const server = net.createServer((socket) => {
    clientSockets.add(socket);
    socket.on("error", () => {});
    if (debug) {
      console.log("[ftp] client connected");
    }
    let currentDirectory = "/";
    let passiveServer = null;
    let passiveSocketPromise = null;

    send("220 SoftEgg FTP Ready");

    socket.setEncoding("utf8");
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const newlineIndex = buffer.indexOf("\n");
        const rawLine = buffer.slice(0, newlineIndex).replace(/\r$/, "");
        buffer = buffer.slice(newlineIndex + 1);
        void handleCommand(rawLine.trim());
      }
    });

    socket.on("close", () => {
      if (debug) {
        console.log("[ftp] client disconnected");
      }
      clientSockets.delete(socket);
      if (passiveServer != null) {
        passiveServer.close();
      }
    });

    async function handleCommand(line) {
      if (debug) {
        console.log("[ftp] >", line);
      }
      const [commandRaw, ...rest] = line.split(" ");
      const command = commandRaw?.toUpperCase() ?? "";
      const argument = rest.join(" ").trim();

      switch (command) {
        case "USER":
          send("331 Password required");
          return;
        case "PASS":
          send("230 Login successful");
          return;
        case "TYPE":
          send("200 Type set to I");
          return;
        case "CWD":
          currentDirectory = normalizeFtpPath(argument || "/");
          send(`250 Directory changed to ${currentDirectory}`);
          return;
        case "SIZE": {
          const file = files.get(resolveFtpPath(currentDirectory, argument));
          if (file == null) {
            send("550 File unavailable");
            return;
          }
          send(`213 ${file.length}`);
          return;
        }
        case "PASV": {
          if (passiveServer != null) {
            passiveServer.close();
          }
          passiveServer = net.createServer();
          passiveServer.on("error", () => {});
          passiveServer.listen(0, workerHost);
          await once(passiveServer, "listening");
          const passivePort = passiveServer.address().port;
          passiveSocketPromise = once(passiveServer, "connection").then(([dataSocket]) => {
            dataSocket.on("error", () => {});
            return dataSocket;
          });
          const p1 = Math.floor(passivePort / 256);
          const p2 = passivePort % 256;
          send(`227 Entering Passive Mode (127,0,0,1,${p1},${p2})`);
          return;
        }
        case "RETR": {
          const filePath = resolveFtpPath(currentDirectory, argument);
          const file = files.get(filePath);
          if (file == null) {
            send("550 File unavailable");
            return;
          }
          if (passiveSocketPromise == null) {
            send("425 Use PASV first");
            return;
          }
          send("150 Opening binary mode data connection");
          const dataSocket = await passiveSocketPromise;
          await new Promise((resolve) => dataSocket.end(file, resolve));
          if (passiveServer != null) {
            passiveServer.close();
            passiveServer = null;
          }
          passiveSocketPromise = null;
          send("226 Transfer complete");
          return;
        }
        case "QUIT":
          send("221 Goodbye");
          socket.end();
          return;
        default:
          send("502 Command not implemented");
      }
    }

    function send(message) {
      if (debug) {
        console.log("[ftp] <", message);
      }
      socket.write(`${message}\r\n`);
    }
  });

  server.listen(port, workerHost);
  await once(server, "listening");

  return {
    close: async () => {
      for (const socket of clientSockets) {
        socket.destroy();
      }
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

function resolveFtpPath(currentDirectory, target) {
  return normalizeFtpPath(target.startsWith("/") ? target : `${currentDirectory}/${target}`);
}

function normalizeFtpPath(value) {
  const normalized = value
    .split("/")
    .filter(Boolean)
    .join("/");
  return `/${normalized}`;
}

async function backupDevVars() {
  try {
    return await readFile(devVarsPath, "utf8");
  } catch {
    return null;
  }
}

async function writeDevVars(values) {
  const lines = Object.entries(values).map(([key, value]) => `${key}=${value}`);
  await writeFile(devVarsPath, `${lines.join("\n")}\n`, { mode: 0o600 });
}

async function restoreDevVars(previousContent) {
  if (previousContent == null) {
    await rm(devVarsPath, { force: true });
    return;
  }
  await writeFile(devVarsPath, previousContent, { mode: 0o600 });
}

async function findAvailablePort() {
  const server = net.createServer();
  server.listen(0, workerHost);
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
