export interface CompanyCatalog {
  company: CompanyInfo;
  softwarePackages: RemoteSoftwarePackage[];
}

export interface CompanyInfo {
  companyNodeId: string;
  companyName: string;
  companyCode: string;
  issuedAt: string | null;
  expiresAt: string | null;
}

export interface RemoteSoftwarePackage {
  id: string;
  name: string;
  codeName: string;
  productId: number;
  version: string;
  os: string;
  releaseChannel: string;
  price: number;
  mainBinary: RemoteSoftwareBinary;
  dependencies: RemoteSoftwareBinary[];
  installOptions: RemoteInstallOptions;
}

export interface RemoteSoftwareBinary {
  name: string;
  version: string;
  uri: string;
  checksum: string;
}

export interface RemoteInstallOptions {
  desktopShortcuts: RemoteInstallEntry[];
  startupPrograms: RemoteInstallEntry[];
  shortcutName: string;
  desktopShortcutTargets: string[];
  startupTargets: string[];
}

export interface RemoteInstallEntry {
  target: string;
  name: string;
}

export interface SoftwareGroupViewModel {
  id: string;
  name: string;
  codeName: string;
  os: string;
  releaseChannel: string;
  packages: RemoteSoftwarePackage[];
}

export interface PackagingArtifactRecord {
  kind: "main" | "dependency";
  fileName: string;
  archivePath: string;
  checksum: string;
  sizeBytes: number;
}

export interface PackagingManifest {
  company: CompanyInfo;
  softwarePackage: Pick<
    RemoteSoftwarePackage,
    | "id"
    | "name"
    | "codeName"
    | "productId"
    | "version"
    | "os"
    | "releaseChannel"
    | "price"
  >;
  mainArtifact: PackagingArtifactRecord;
  dependencyArtifacts: PackagingArtifactRecord[];
  installOptions: RemoteInstallOptions;
  packageFileName: string;
  generatedAt: string;
  tool: {
    name: string;
    schemaVersion: number;
  };
}

export interface HealthProbeResponse {
  ok: boolean;
}

export interface FtpSizeResponse {
  size: number | null;
}

export interface ArtifactDownloadResponseMeta {
  fileName: string;
  checksum: string;
  size: number;
}

export function parseCompanyCatalog(payload: unknown): CompanyCatalog {
  const input = unwrapCatalogPayload(payload);
  if (!hasField(input, "softwarePackages")) {
    throw new Error("카탈로그 응답 형식이 올바르지 않습니다.");
  }

  const softwarePackages = asArray(getField(input, "softwarePackages")).map(parseRemotePackage);
  const company = mergeRecords(
    input,
    asRecord(getField(input, "company")),
  );

  return {
    company: parseCompanyInfo(company),
    softwarePackages,
  };
}

export function buildGroups(catalog: CompanyCatalog): SoftwareGroupViewModel[] {
  const groups = new Map<string, RemoteSoftwarePackage[]>();
  for (const item of catalog.softwarePackages) {
    const key = `${item.name}|${item.codeName}|${item.os.toLowerCase()}|${item.releaseChannel.toLowerCase()}`;
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }

  return Array.from(groups.entries())
    .map(([id, packages]) => {
      const sorted = [...packages].sort((left, right) =>
        compareVersionDescending(left.version, right.version),
      );
      const first = sorted[0];
      return {
        id,
        name: first.name,
        codeName: first.codeName,
        os: first.os,
        releaseChannel: first.releaseChannel,
        packages: sorted,
      };
    })
    .sort((left, right) => {
      const byName = left.name.toLowerCase().localeCompare(right.name.toLowerCase());
      if (byName !== 0) {
        return byName;
      }
      return left.codeName.toLowerCase().localeCompare(right.codeName.toLowerCase());
    });
}

export function hasUri(binary: RemoteSoftwareBinary): boolean {
  return binary.uri.trim().length > 0;
}

export function getFileName(binary: RemoteSoftwareBinary): string {
  if (binary.name.trim()) {
    return binary.name.trim();
  }
  if (!hasUri(binary)) {
    return "unknown.bin";
  }
  const uri = new URL(binary.uri);
  const lastSegment = uri.pathname.split("/").filter(Boolean).pop() ?? "unknown.bin";
  return decodeURIComponent(lastSegment);
}

export function getDependencyKey(binary: RemoteSoftwareBinary): string {
  return `${binary.uri}|${binary.name}|${binary.version}`;
}

export function canPackage(item: RemoteSoftwarePackage, selectedKeys?: Set<string>): boolean {
  if (!hasUri(item.mainBinary)) {
    return false;
  }
  const targets =
    selectedKeys == null
      ? item.dependencies
      : item.dependencies.filter((dependency) => selectedKeys.has(getDependencyKey(dependency)));
  return targets.every(hasUri);
}

export function createManifest(input: {
  company: CompanyInfo;
  selectedPackage: RemoteSoftwarePackage;
  mainArtifact: PackagingArtifactRecord;
  dependencyArtifacts: PackagingArtifactRecord[];
  generatedAt: string;
  packageFileName: string;
}): PackagingManifest {
  const { company, selectedPackage, mainArtifact, dependencyArtifacts, generatedAt, packageFileName } =
    input;
  return {
    company,
    softwarePackage: {
      id: selectedPackage.id,
      name: selectedPackage.name,
      codeName: selectedPackage.codeName,
      productId: selectedPackage.productId,
      version: selectedPackage.version,
      os: selectedPackage.os,
      releaseChannel: selectedPackage.releaseChannel,
      price: selectedPackage.price,
    },
    mainArtifact,
    dependencyArtifacts,
    installOptions: selectedPackage.installOptions,
    packageFileName,
    generatedAt,
    tool: {
      name: "SoftEgg Packaging Tool",
      schemaVersion: 1,
    },
  };
}

export function compareVersionDescending(left: string, right: string): number {
  const leftTokens = tokenizeVersion(left);
  const rightTokens = tokenizeVersion(right);
  const maxLength = Math.max(leftTokens.length, rightTokens.length);

  for (let index = 0; index < maxLength; index += 1) {
    const leftToken = leftTokens[index] ?? "0";
    const rightToken = rightTokens[index] ?? "0";

    const leftNumber = Number.parseInt(leftToken, 10);
    const rightNumber = Number.parseInt(rightToken, 10);
    if (!Number.isNaN(leftNumber) && !Number.isNaN(rightNumber)) {
      if (leftNumber !== rightNumber) {
        return rightNumber - leftNumber;
      }
      continue;
    }

    const comparison = rightToken.toLowerCase().localeCompare(leftToken.toLowerCase());
    if (comparison !== 0) {
      return comparison;
    }
  }

  return 0;
}

function tokenizeVersion(value: string): string[] {
  return value.split(/[^A-Za-z0-9]+/).filter(Boolean);
}

function parseCompanyInfo(payload: unknown): CompanyInfo {
  const input = asRecord(payload);
  return {
    companyNodeId: toStringValue(getField(input, "companyNodeId")),
    companyName: toStringValue(getField(input, "companyName")),
    companyCode: toStringValue(getField(input, "companyCode")),
    issuedAt: toNullableString(getField(input, "issuedAt")),
    expiresAt: toNullableString(getField(input, "expiresAt")),
  };
}

function parseRemotePackage(payload: unknown): RemoteSoftwarePackage {
  const input = asRecord(payload);
  return {
    id: toStringValue(getField(input, "id")),
    name: toStringValue(getField(input, "name")),
    codeName: toStringValue(getField(input, "codeName")),
    productId: toNumberValue(getField(input, "productId")),
    version: toStringValue(getField(input, "version")),
    os: toStringValue(getField(input, "os"), "all"),
    releaseChannel: toStringValue(getField(input, "releaseChannel"), "stable"),
    price: toNumberValue(getField(input, "price")),
    mainBinary: parseRemoteBinary(getField(input, "mainBinary")),
    dependencies: asArray(getField(input, "dependencies")).map(parseRemoteBinary),
    installOptions: parseInstallOptions(getField(input, "installOptions")),
  };
}

function parseRemoteBinary(payload: unknown): RemoteSoftwareBinary {
  const input = asRecord(payload);
  return {
    name: toStringValue(getField(input, "name")),
    version: toStringValue(getField(input, "version")),
    uri: toStringValue(getField(input, "uri")),
    checksum: toStringValue(getField(input, "checksum")),
  };
}

function parseInstallOptions(payload: unknown): RemoteInstallOptions {
  const input = asRecord(payload);
  return {
    desktopShortcuts: asArray(getField(input, "desktopShortcuts")).map(parseInstallEntry),
    startupPrograms: asArray(getField(input, "startupPrograms")).map(parseInstallEntry),
    shortcutName: toStringValue(getField(input, "shortcutName")),
    desktopShortcutTargets: asArray(getField(input, "desktopShortcutTargets")).map((item) =>
      toStringValue(item),
    ),
    startupTargets: asArray(getField(input, "startupTargets")).map((item) => toStringValue(item)),
  };
}

function parseInstallEntry(payload: unknown): RemoteInstallEntry {
  const input = asRecord(payload);
  return {
    target: toStringValue(getField(input, "target")),
    name: toStringValue(getField(input, "name")),
  };
}

function unwrapCatalogPayload(payload: unknown): Record<string, unknown> {
  const input = asRecord(payload);
  const nested = asRecord(getField(input, "data"));
  if (hasField(nested, "softwarePackages") || hasField(nested, "company")) {
    return nested;
  }
  return input;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value == null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function mergeRecords(...records: Record<string, unknown>[]): Record<string, unknown> {
  return Object.assign({}, ...records);
}

function hasField(record: Record<string, unknown>, key: string): boolean {
  return getField(record, key) !== undefined;
}

function getField(record: Record<string, unknown>, key: string): unknown {
  if (key in record) {
    return record[key];
  }

  const normalizedKey = key.toLowerCase();
  for (const [entryKey, value] of Object.entries(record)) {
    if (entryKey.toLowerCase() === normalizedKey) {
      return value;
    }
  }

  return undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function toStringValue(value: unknown, fallback = ""): string {
  if (value == null) {
    return fallback;
  }
  return String(value);
}

function toNullableString(value: unknown): string | null {
  const normalized = toStringValue(value).trim();
  return normalized ? normalized : null;
}

function toNumberValue(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }
  const parsed = Number.parseFloat(toStringValue(value));
  return Number.isFinite(parsed) ? parsed : 0;
}
