import { connect } from "cloudflare:sockets";

export interface FtpCredentials {
  host: string;
  user: string;
  password: string;
}

export interface RemoteTarget {
  host: string;
  absolutePath: string;
  fileName: string;
}

interface FtpResponse {
  code: number;
  message: string;
}

export class FtpService {
  async fetchRemoteSize(uri: string, credentials: FtpCredentials): Promise<number | null> {
    const target = parseRemoteTarget(uri, credentials.host);
    const client = new FtpClient(target.host);
    try {
      await client.connect(credentials.user, credentials.password);
      await client.changeToParentDirectory(target.absolutePath);
      return await client.size(target.fileName);
    } finally {
      await client.close();
    }
  }

  async downloadFile(uri: string, credentials: FtpCredentials): Promise<Uint8Array> {
    const target = parseRemoteTarget(uri, credentials.host);
    const client = new FtpClient(target.host);
    try {
      await client.connect(credentials.user, credentials.password);
      await client.changeToParentDirectory(target.absolutePath);
      return await client.download(target.fileName);
    } finally {
      await client.close();
    }
  }
}

class FtpClient {
  private readonly host: string;
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();
  private socket: Socket | null = null;
  private reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  private writer: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private lineBuffer = "";

  constructor(host: string) {
    this.host = host;
  }

  async connect(user: string, password: string): Promise<void> {
    this.socket = connect({
      hostname: this.host,
      port: 21,
    });
    this.reader = this.socket.readable.getReader();
    this.writer = this.socket.writable.getWriter();

    const greeting = await this.readResponse();
    if (greeting.code >= 400) {
      throw new Error(`FTP 서버 연결 실패: ${greeting.message}`);
    }

    const userResponse = await this.command(`USER ${user}`);
    if (userResponse.code === 331) {
      const passResponse = await this.command(`PASS ${password}`);
      if (passResponse.code >= 400) {
        throw new Error(`FTP 로그인 실패: ${passResponse.message}`);
      }
    } else if (userResponse.code >= 400) {
      throw new Error(`FTP 로그인 실패: ${userResponse.message}`);
    }

    const binaryResponse = await this.command("TYPE I");
    if (binaryResponse.code >= 400) {
      throw new Error(`FTP 전송 모드 전환 실패: ${binaryResponse.message}`);
    }
  }

  async changeToParentDirectory(absolutePath: string): Promise<void> {
    const segments = absolutePath.split("/").filter(Boolean);
    if (segments.length <= 1) {
      return;
    }
    const parentDirectory = `/${segments.slice(0, -1).join("/")}`;
    const response = await this.command(`CWD ${parentDirectory}`);
    if (response.code >= 400) {
      throw new Error(`FTP 디렉터리 이동 실패: ${parentDirectory}`);
    }
  }

  async size(fileName: string): Promise<number | null> {
    const response = await this.command(`SIZE ${fileName}`);
    if (response.code >= 400) {
      return null;
    }
    const normalized = response.message.replace(/^213\s+/, "").trim();
    const size = Number.parseInt(normalized, 10);
    return Number.isFinite(size) ? size : null;
  }

  async download(fileName: string): Promise<Uint8Array> {
    const pasvResponse = await this.command("PASV");
    if (pasvResponse.code >= 400) {
      throw new Error(`FTP 데이터 채널 생성 실패: ${pasvResponse.message}`);
    }
    const dataChannel = parsePassiveAddress(pasvResponse.message, this.host);
    const dataSocket = connect({
      hostname: dataChannel.host,
      port: dataChannel.port,
    });

    try {
      const transferResponsePromise = this.command(`RETR ${fileName}`);
      const dataBytesPromise = collectStream(dataSocket.readable);
      const transferResponse = await transferResponsePromise;
      if (transferResponse.code !== 125 && transferResponse.code !== 150) {
        throw new Error(`FTP 다운로드 시작 실패: ${transferResponse.message}`);
      }

      const data = await dataBytesPromise;
      const completion = await this.readResponse();
      if (completion.code >= 400) {
        throw new Error(`FTP 다운로드 완료 실패: ${completion.message}`);
      }
      return data;
    } finally {
      try {
        await dataSocket.close();
      } catch {
        // ignore socket close errors
      }
    }
  }

  async close(): Promise<void> {
    try {
      if (this.writer != null) {
        await this.writer.write(this.encoder.encode("QUIT\r\n"));
      }
    } catch {
      // ignore quit errors
    }

    try {
      await this.writer?.close();
    } catch {
      // ignore close errors
    }
    this.writer?.releaseLock();
    this.reader?.releaseLock();

    if (this.socket != null) {
      try {
        await this.socket.close();
      } catch {
        // ignore socket close errors
      }
    }

    this.socket = null;
    this.reader = null;
    this.writer = null;
    this.lineBuffer = "";
  }

  private async command(rawCommand: string): Promise<FtpResponse> {
    if (this.writer == null) {
      throw new Error("FTP writer가 초기화되지 않았습니다.");
    }
    await this.writer.write(this.encoder.encode(`${rawCommand}\r\n`));
    return this.readResponse();
  }

  private async readResponse(): Promise<FtpResponse> {
    let code: number | null = null;
    let message = "";

    while (true) {
      const line = await this.readLine();
      if (line == null) {
        throw new Error("FTP 응답이 비정상적으로 종료되었습니다.");
      }
      if (code == null) {
        const match = line.match(/^(\d{3})([\s-])(.*)$/);
        if (match == null) {
          continue;
        }
        code = Number.parseInt(match[1], 10);
        message = line;
        if (match[2] === " ") {
          return { code, message };
        }
        continue;
      }

      message = `${message}\n${line}`;
      if (line.startsWith(`${String(code)} `)) {
        return { code, message };
      }
    }
  }

  private async readLine(): Promise<string | null> {
    while (true) {
      const lineBreakIndex = this.lineBuffer.indexOf("\n");
      if (lineBreakIndex >= 0) {
        const rawLine = this.lineBuffer.slice(0, lineBreakIndex);
        this.lineBuffer = this.lineBuffer.slice(lineBreakIndex + 1);
        return rawLine.replace(/\r$/, "");
      }

      if (this.reader == null) {
        return null;
      }
      const result = await this.reader.read();
      if (result.done) {
        if (!this.lineBuffer) {
          return null;
        }
        const tail = this.lineBuffer;
        this.lineBuffer = "";
        return tail.replace(/\r$/, "");
      }
      this.lineBuffer += this.decoder.decode(result.value, { stream: true });
    }
  }
}

async function collectStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }

  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

function parseRemoteTarget(uriValue: string, fallbackHost: string): RemoteTarget {
  const uri = new URL(uriValue);
  if (uri.protocol.replace(":", "").toLowerCase() !== "ftp") {
    throw new Error(`FTP URI 형식이 아닙니다: ${uriValue}`);
  }

  const decodedSegments = uri.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => decodeURIComponent(segment))
    .filter((segment) => segment.trim().length > 0);

  if (decodedSegments.length === 0) {
    throw new Error(`FTP 파일 경로가 비어 있습니다: ${uriValue}`);
  }

  return {
    host: uri.hostname || fallbackHost,
    absolutePath: `/${decodedSegments.join("/")}`,
    fileName: decodedSegments[decodedSegments.length - 1],
  };
}

function parsePassiveAddress(message: string, fallbackHost: string): { host: string; port: number } {
  const match = message.match(/\((\d+,\d+,\d+,\d+,\d+,\d+)\)/);
  if (match == null) {
    throw new Error(`FTP PASV 응답을 해석하지 못했습니다: ${message}`);
  }
  const parts = match[1].split(",").map((value) => Number.parseInt(value, 10));
  const host = parts.slice(0, 4).join(".");
  const port = parts[4] * 256 + parts[5];
  return {
    host: host === "0.0.0.0" ? fallbackHost : host,
    port,
  };
}
